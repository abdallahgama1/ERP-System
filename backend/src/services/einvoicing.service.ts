import { createHash } from "node:crypto";
import {
  buildOffsetPageInfo,
  einvoiceQueueQuerySchema,
  einvoiceRetrySchema,
  type EinvoiceDocumentType,
  type EinvoiceProvider,
  type EinvoiceQueueSummaryDto,
  type EinvoiceRetryInput,
  type EinvoiceSubmissionStatus,
  type EtaDocumentTypeCode,
  type EtaReceiptType,
  type EtaSignatureStatus,
  type EtaSubmissionDetailDto,
  type EtaSubmissionListItemDto,
  type OffsetPageInfo,
} from "@erp/shared";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_COMPANY_ID,
  branches,
  companies,
  companySettings,
  customers,
  einvoiceSubmissions,
  posReturnLines,
  posReturns,
  posTenders,
  posTerminals,
  products,
  salesInvoiceLines,
  salesInvoices,
  salesReturnLines,
  salesReturns,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num } from "../db/helpers.ts";
import { getDb, type AppDatabase } from "../db/index.ts";
import { createModuleLogger } from "../logging/logger.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import {
  getEtaDocumentSubmissionStatus,
  getEtaSubmissionStatus,
  isEtaConfigured,
  submitEtaDocuments,
  submitEtaReceipts,
} from "./eta-client.service.ts";
import {
  computeEtaDocumentCanonicalDigest,
  isEtaSignerConfigured,
  resolveEtaInvoiceVersion,
  signEtaInvoiceIfNeeded,
} from "./eta-signer.service.ts";
import { actorCompanyId, parseOrThrow, type RequestActor } from "./stock-locks.ts";

const log = createModuleLogger("einvoicing");

function companyEinvoiceLockKey(companyId: string): number {
  return createHash("sha256").update(companyId).digest().readInt32BE(0);
}

interface CompanyEinvoiceConfig {
  companyName: string;
  legalName: string;
  taxRegistrationNumber: string;
  baseCurrency: string;
  einvoicingMode: "none" | "zatca_qr" | "zatca_phase2" | "eta_egypt";
  address: string;
}

async function loadCompanyEinvoiceConfig(
  tx: DbOrTx,
  companyId: string
): Promise<CompanyEinvoiceConfig | null> {
  const [comp] = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (companyId === DEFAULT_COMPANY_ID) {
    const [legacy] = await tx
      .select()
      .from(companySettings)
      .where(eq(companySettings.id, 1))
      .limit(1);

    if (!comp && legacy) {
      return {
        companyName: legacy.companyName,
        legalName: legacy.legalName,
        taxRegistrationNumber: legacy.taxRegistrationNumber,
        baseCurrency: legacy.baseCurrency,
        einvoicingMode: legacy.einvoicingMode,
        address: legacy.address,
      };
    }

    if (comp && legacy && comp.einvoicingMode === "none" && legacy.einvoicingMode !== "none") {
      return {
        companyName: legacy.companyName || comp.name,
        legalName: legacy.legalName || comp.legalName,
        taxRegistrationNumber: legacy.taxRegistrationNumber || comp.taxRegistrationNumber,
        baseCurrency: legacy.baseCurrency || comp.baseCurrency,
        einvoicingMode: legacy.einvoicingMode,
        address: legacy.address || comp.address,
      };
    }
  }

  if (!comp) return null;
  return {
    companyName: comp.name,
    legalName: comp.legalName,
    taxRegistrationNumber: comp.taxRegistrationNumber,
    baseCurrency: comp.baseCurrency,
    einvoicingMode: comp.einvoicingMode,
    address: comp.address,
  };
}

export interface ZatcaQrInput {
  sellerName: string;
  taxNumber: string;
  timestampIso: string;
  totalWithVat: string;
  vatTotal: string;
}

/**
 * Encodes ZATCA Phase-1 standard TLV (Tags 1-5) into Base64 QR payload.
 */
export function encodeZatcaTlvQr(input: ZatcaQrInput): string {
  const fields: Array<[number, string]> = [
    [1, input.sellerName],
    [2, input.taxNumber],
    [3, input.timestampIso],
    [4, input.totalWithVat],
    [5, input.vatTotal],
  ];

  const chunks: Buffer[] = [];
  for (const [tag, value] of fields) {
    const valBuf = Buffer.from(value, "utf8");
    const header = Buffer.from([tag, Math.min(255, valBuf.length)]);
    chunks.push(header, valBuf.subarray(0, 255));
  }
  return Buffer.concat(chunks).toString("base64");
}

export function computeInvoiceHash(payload: {
  invoiceNumber: string;
  invoiceDateIso: string;
  totalAmount: string;
  taxTotal: string;
  prevHash: string;
}): string {
  return createHash("sha256")
    .update(
      `${payload.prevHash}|${payload.invoiceNumber}|${payload.invoiceDateIso}|${payload.totalAmount}|${payload.taxTotal}`
    )
    .digest("hex");
}

/**
 * ETA Egypt canonical document serialization algorithm (e-Receipt v1.2 specification):
 * Recursively emits UPPERCASE property names followed by serialized primitive values or array elements.
 */
export function serializeEtaCanonicalDocument(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") {
    return `"${String(node)}"`;
  }
  if (Array.isArray(node)) {
    return node.map((item) => serializeEtaCanonicalDocument(item)).join("");
  }

  let result = "";
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const upperKey = `"${key.toUpperCase()}"`;
    if (Array.isArray(value)) {
      result += upperKey;
      for (const item of value) {
        result += upperKey;
        result += serializeEtaCanonicalDocument(item);
      }
    } else if (typeof value === "object") {
      result += upperKey;
      result += serializeEtaCanonicalDocument(value);
    } else {
      result += upperKey;
      result += `"${String(value)}"`;
    }
  }
  return result;
}

/**
 * Computes the deterministic ETA Egypt SHA-256 receipt UUID from canonical receipt JSON
 * (with header.uuid blanked per ETA spec).
 */
export function computeEtaReceiptUuid(receiptPayload: Record<string, unknown>): string {
  const clone = structuredClone(receiptPayload);
  if (clone.header && typeof clone.header === "object") {
    (clone.header as Record<string, unknown>).uuid = "";
  }
  const canonical = serializeEtaCanonicalDocument(clone);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildEtaEgyptQrUrl(etaUuid: string, dateTimeIssuedIso: string): string {
  const formattedDate = dateTimeIssuedIso.replace(/\.\d{3}Z$/, "Z");
  return `https://invoicing.eta.gov.eg/receipts/search/${etaUuid}/share/${encodeURIComponent(formattedDate)}`;
}

export function buildEtaEgyptInvoiceShareUrl(etaUuid: string, dateTimeIssuedIso: string): string {
  const formattedDate = dateTimeIssuedIso.replace(/\.\d{3}Z$/, "Z");
  return `https://invoicing.eta.gov.eg/documents/${etaUuid}/share/${encodeURIComponent(formattedDate)}`;
}

export function mapPosPaymentMethodToEta(method?: string | null): "C" | "V" | "CC" | "O" {
  if (method === "card") return "CC";
  if (method === "mobile_wallet") return "V";
  return "C";
}

export interface EtaReceiptBuildInput {
  receiptNumber: string;
  dateTimeIssuedIso: string;
  previousUuid: string;
  referenceUUID?: string;
  receiptType?: "S" | "R";
  currency: string;
  sellerName: string;
  sellerTaxNumber: string;
  branchCode: string;
  branchAddress: string;
  branchCountry?: string;
  branchGovernorate?: string;
  branchRegionCity?: string;
  branchBuildingNumber?: string;
  branchPostalCode?: string;
  posSerialNumber: string;
  buyerName: string;
  buyerTaxNumber?: string;
  buyerType?: "B" | "P" | "F";
  paymentMethod: "C" | "V" | "CC" | "O";
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  lines: Array<{
    description: string;
    itemCode: string;
    internalCode?: string;
    itemType?: "EGS" | "GS1";
    unitType?: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    taxAmount: number;
    lineTotal: number;
  }>;
}

export function buildEtaEgyptReceiptPayload(input: EtaReceiptBuildInput): {
  payload: Record<string, unknown>;
  etaUuid: string;
  qrUrl: string;
} {
  const dateTimeIssued = input.dateTimeIssuedIso.replace(/\.\d{3}Z$/, "Z");
  const receiptType = input.receiptType ?? "S";
  const headerObj: Record<string, unknown> = {
    dateTimeIssued,
    receiptNumber: input.receiptNumber,
    uuid: "",
    previousUUID: input.previousUuid,
    ...(input.referenceUUID !== undefined ? { referenceUUID: input.referenceUUID } : {}),
    ...(receiptType === "R" ? { receiptType: "R" } : {}),
    currency: input.currency || "EGP",
    orderdeliveryMode: "FC",
  };
  const branchAddressObj: Record<string, unknown> = {
    country: input.branchCountry || "EG",
    governate: input.branchGovernorate || "Cairo",
    regionCity: input.branchRegionCity || "Cairo",
    street: input.branchAddress || "Main Branch",
    buildingNumber: input.branchBuildingNumber || "1",
    ...(input.branchPostalCode ? { postalCode: input.branchPostalCode } : {}),
  };
  const resolvedBuyerType = input.buyerType ?? (input.buyerTaxNumber ? "B" : "P");
  const basePayload: Record<string, unknown> = {
    header: headerObj,
    documentType: {
      receiptType,
      typeVersion: "1.2",
    },
    seller: {
      rin: input.sellerTaxNumber || "000000000",
      companyTradeName: input.sellerName,
      branchCode: input.branchCode || "0",
      branchAddress: branchAddressObj,
      deviceSerialNumber: input.posSerialNumber || "POS-DEV-01",
      activityCode: "4711",
    },
    buyer: {
      type: resolvedBuyerType,
      id: input.buyerTaxNumber || "",
      name: input.buyerName || "Walk-in Customer",
    },
    itemData: input.lines.map((line) => {
      const netSale = Math.max(0, Number((line.lineTotal - line.taxAmount).toFixed(5)));
      return {
        internalCode: line.internalCode || line.itemCode || "ITEM",
        description: line.description || "POS Item",
        itemType: line.itemType || "EGS",
        itemCode: line.itemCode || "EG-000000000-ITEM",
        unitType: line.unitType || "EA",
        quantity: Number(line.quantity.toFixed(5)),
        unitPrice: Number(line.unitPrice.toFixed(5)),
        netSale,
        totalSale: netSale,
        total: Number(line.lineTotal.toFixed(5)),
        taxableItems:
          line.taxRate > 0
            ? [
                {
                  taxType: "T1",
                  amount: Number(line.taxAmount.toFixed(5)),
                  subType: "V009",
                  rate: Number(line.taxRate.toFixed(2)),
                },
              ]
            : [],
      };
    }),
    totalSales: Number(input.subtotal.toFixed(5)),
    netAmount: Number(input.subtotal.toFixed(5)),
    totalAmount: Number(input.totalAmount.toFixed(5)),
    taxTotals:
      input.taxTotal > 0
        ? [
            {
              taxType: "T1",
              amount: Number(input.taxTotal.toFixed(5)),
            },
          ]
        : [],
    paymentMethod: input.paymentMethod,
  };

  const etaUuid = computeEtaReceiptUuid(basePayload);
  (basePayload.header as Record<string, unknown>).uuid = etaUuid;
  const qrUrl = buildEtaEgyptQrUrl(etaUuid, dateTimeIssued);

  return { payload: basePayload, etaUuid, qrUrl };
}

export interface EtaB2bInvoiceBuildInput {
  internalId: string;
  dateTimeIssuedIso: string;
  documentType?: "I" | "C" | "D";
  documentTypeVersion?: "1.0" | "0.9";
  references?: string[];
  currency: string;
  exchangeRate?: number;
  issuerName: string;
  issuerRin: string;
  branchId: string;
  branchCountry?: string;
  branchGovernorate?: string;
  branchRegionCity?: string;
  branchStreet?: string;
  branchBuildingNumber?: string;
  branchPostalCode?: string;
  activityCode?: string;
  receiverType: "B" | "P" | "F";
  receiverId?: string;
  receiverName: string;
  receiverStreet?: string;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  lines: Array<{
    description: string;
    internalCode: string;
    itemType?: "EGS" | "GS1";
    itemCode: string;
    unitType?: string;
    quantity: number;
    unitPrice: number;
    discount?: number;
    taxRate: number;
    taxAmount: number;
    lineTotal: number;
  }>;
}

/**
 * Builds an Egyptian Tax Authority (ETA) B2B e-Invoice v1.0 / v0.9 JSON document
 * (`"I"` Invoice, `"C"` Credit Note, `"D"` Debit Note) and its deterministic SHA-256 digest.
 */
export function buildEtaB2bInvoicePayload(input: EtaB2bInvoiceBuildInput): {
  payload: Record<string, unknown>;
  etaUuid: string;
  qrUrl: string;
} {
  const dateTimeIssued = input.dateTimeIssuedIso.replace(/\.\d{3}Z$/, "Z");
  const documentType = input.documentType ?? "I";
  const documentTypeVersion = input.documentTypeVersion ?? resolveEtaInvoiceVersion();
  const currencySold = (input.currency || "EGP").toUpperCase();
  const fxRate = input.exchangeRate && input.exchangeRate > 0 ? input.exchangeRate : 1;
  const isForeign = currencySold !== "EGP";
  const rinClean = input.issuerRin || "000000000";

  let totalDiscountAmount = 0;
  let totalSalesAmount = 0;

  const invoiceLines = input.lines.map((line) => {
    const qty = Number(line.quantity.toFixed(5));
    const unitSold = Number(line.unitPrice.toFixed(5));
    const unitEgp = isForeign ? Number((line.unitPrice * fxRate).toFixed(5)) : unitSold;
    const discountEgp = Number(((line.discount ?? 0) * (isForeign ? fxRate : 1)).toFixed(5));
    const salesTotal = Number((qty * unitEgp).toFixed(5));
    const netTotal = Math.max(0, Number((salesTotal - discountEgp).toFixed(5)));
    const taxEgp = Number((line.taxAmount * (isForeign ? fxRate : 1)).toFixed(5));
    const lineTotalEgp = Number((netTotal + taxEgp).toFixed(5));

    totalDiscountAmount += discountEgp;
    totalSalesAmount += salesTotal;

    const unitValue: Record<string, unknown> = {
      currencySold,
      amountEGP: unitEgp,
      ...(isForeign
        ? {
            amountSold: unitSold,
            currencyExchangeRate: Number(fxRate.toFixed(5)),
          }
        : {}),
    };

    const resolvedCodeType = line.itemType || "EGS";
    const resolvedItemCode =
      line.itemCode?.trim() ||
      (resolvedCodeType === "GS1" ? line.internalCode : `EG-${rinClean}-${line.internalCode || "ITEM"}`);

    return {
      description: line.description || "Invoice Line",
      itemType: resolvedCodeType,
      itemCode: resolvedItemCode,
      unitType: line.unitType || "EA",
      quantity: qty,
      internalCode: line.internalCode || "ITEM",
      salesTotal,
      total: lineTotalEgp,
      valueDifference: 0,
      totalTaxableFees: 0,
      netTotal,
      itemsDiscount: 0,
      unitValue,
      discount: {
        rate: 0,
        amount: discountEgp,
      },
      taxableItems:
        line.taxRate > 0
          ? [
              {
                taxType: "T1",
                amount: taxEgp,
                subType: "V009",
                rate: Number(line.taxRate.toFixed(2)),
              },
            ]
          : [],
    };
  });

  const netAmountEgp = Number((input.subtotal * (isForeign ? fxRate : 1)).toFixed(5));
  const taxTotalEgp = Number((input.taxTotal * (isForeign ? fxRate : 1)).toFixed(5));
  const totalAmountEgp = Number((input.totalAmount * (isForeign ? fxRate : 1)).toFixed(5));

  const payload: Record<string, unknown> = {
    issuer: {
      address: {
        branchID: input.branchId || "0",
        country: input.branchCountry || "EG",
        governate: input.branchGovernorate || "Cairo",
        regionCity: input.branchRegionCity || "Cairo",
        street: input.branchStreet || "Main Street",
        buildingNumber: input.branchBuildingNumber || "1",
        ...(input.branchPostalCode ? { postalCode: input.branchPostalCode } : {}),
      },
      type: "B",
      id: rinClean,
      name: input.issuerName,
    },
    receiver: {
      address: {
        country: input.receiverType === "F" ? "US" : "EG",
        governate: "Cairo",
        regionCity: "Cairo",
        street: input.receiverStreet || "Customer Address",
        buildingNumber: "1",
      },
      type: input.receiverType,
      id: input.receiverId || "",
      name: input.receiverName || "B2B Customer",
    },
    documentType,
    documentTypeVersion,
    dateTimeIssued,
    taxpayerActivityCode: input.activityCode || "4690",
    internalID: input.internalId,
    ...(input.references && input.references.length > 0 ? { references: input.references } : {}),
    invoiceLines,
    totalDiscountAmount: Number(totalDiscountAmount.toFixed(5)),
    totalSalesAmount: Number(totalSalesAmount.toFixed(5)),
    netAmount: netAmountEgp,
    taxTotals:
      taxTotalEgp > 0
        ? [
            {
              taxType: "T1",
              amount: taxTotalEgp,
            },
          ]
        : [],
    totalAmount: totalAmountEgp,
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
  };

  const { canonicalSha256: etaUuid } = computeEtaDocumentCanonicalDigest(payload);
  const qrUrl = buildEtaEgyptInvoiceShareUrl(etaUuid, dateTimeIssued);

  return { payload, etaUuid, qrUrl };
}

/**
 * Computes ICV sequence, chained SHA-256 hash, ZATCA TLV QR or ETA Egypt e-Receipt v1.2 / B2B e-Invoice v1.0 payload
 * & submission queue entry whenever company einvoicingMode !== 'none'.
 */
export async function applyInvoiceEInvoiceMetadata(
  tx: DbOrTx,
  invoiceId: string,
  companyId?: string
): Promise<{
  eInvoiceStatus: string;
  icv: number | null;
  invoiceHash: string | null;
  prevInvoiceHash: string | null;
  qrTlv: string | null;
  etaDocumentUuid: string | null;
  etaReceiptStatus: string;
}> {
  const [inv] = await tx
    .select()
    .from(salesInvoices)
    .where(
      companyId
        ? and(eq(salesInvoices.id, invoiceId), eq(salesInvoices.companyId, companyId))
        : eq(salesInvoices.id, invoiceId)
    )
    .limit(1);
  if (!inv || inv.source === "opening_balance") {
    return {
      eInvoiceStatus: "not_applicable",
      icv: null,
      invoiceHash: null,
      prevInvoiceHash: null,
      qrTlv: null,
      etaDocumentUuid: null,
      etaReceiptStatus: "not_applicable",
    };
  }

  const effectiveCompanyId = companyId || inv.companyId || DEFAULT_COMPANY_ID;
  const company = await loadCompanyEinvoiceConfig(tx, effectiveCompanyId);
  if (!company || company.einvoicingMode === "none") {
    return {
      eInvoiceStatus: "not_applicable",
      icv: null,
      invoiceHash: null,
      prevInvoiceHash: null,
      qrTlv: null,
      etaDocumentUuid: null,
      etaReceiptStatus: "not_applicable",
    };
  }

  // Serialize ICV + prevInvoiceHash allocation per company across concurrent ERP/POS checkouts
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(882411, ${companyEinvoiceLockKey(effectiveCompanyId)})`
  );

  const [{ maxIcv }] = await tx
    .select({ maxIcv: sql<number>`coalesce(max(${salesInvoices.icv}), 0)::int` })
    .from(salesInvoices)
    .where(eq(salesInvoices.companyId, effectiveCompanyId));
  const lastHashed = await tx
    .select({
      invoiceHash: salesInvoices.invoiceHash,
      etaDocumentUuid: salesInvoices.etaDocumentUuid,
    })
    .from(salesInvoices)
    .where(and(eq(salesInvoices.companyId, effectiveCompanyId), isNotNull(salesInvoices.invoiceHash)))
    .orderBy(desc(salesInvoices.icv))
    .limit(1);

  const icv = maxIcv + 1;
  const prevInvoiceHash = lastHashed[0]?.invoiceHash ?? "0".repeat(64);
  const totalStr = num(inv.totalAmount).toFixed(2);
  const vatStr = num(inv.taxTotal).toFixed(2);
  const timestampIso = inv.invoiceDate.toISOString();

  const invoiceHash = computeInvoiceHash({
    invoiceNumber: inv.invoiceNumber,
    invoiceDateIso: timestampIso,
    totalAmount: totalStr,
    taxTotal: vatStr,
    prevHash: prevInvoiceHash,
  });

  const sellerName = company.legalName || company.companyName || "ERP Company";
  const taxNumber = company.taxRegistrationNumber || "000000000000000";

  if (company.einvoicingMode === "eta_egypt") {
    const [branchRow] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, inv.branchId), eq(branches.companyId, effectiveCompanyId)))
      .limit(1);
    const [custRow] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, inv.customerId), eq(customers.companyId, effectiveCompanyId)))
      .limit(1);
    const lines = await tx.select().from(salesInvoiceLines).where(eq(salesInvoiceLines.invoiceId, inv.id));
    const lineProdIds = Array.from(
      new Set(lines.map((l) => l.productId).filter((pid): pid is string => Boolean(pid)))
    );
    const prodRows =
      lineProdIds.length > 0
        ? await tx
            .select()
            .from(products)
            .where(and(eq(products.companyId, effectiveCompanyId), inArray(products.id, lineProdIds)))
        : [];
    const prodMap = new Map(prodRows.map((p) => [p.id, p]));

    const effectiveEtaBranchId =
      branchRow?.etaBranchId && branchRow.etaBranchId !== "0"
        ? branchRow.etaBranchId
        : (branchRow?.etaBranchId ?? branchRow?.code ?? "0");
    const effectiveBranchStreet =
      branchRow?.street || branchRow?.address || branchRow?.location || company.address || "Main Branch";

    let built: { payload: Record<string, unknown>; etaUuid: string; qrUrl: string };
    const isPosReceipt = inv.sourceChannel === "pos";

    if (isPosReceipt) {
      const [termRow] = inv.posTerminalId
        ? await tx
            .select()
            .from(posTerminals)
            .where(and(eq(posTerminals.id, inv.posTerminalId), eq(posTerminals.companyId, effectiveCompanyId)))
            .limit(1)
        : [undefined];
      const tenders = await tx.select().from(posTenders).where(eq(posTenders.invoiceId, inv.id));
      const primaryPaymentMethod = mapPosPaymentMethodToEta(tenders[0]?.method);

      built = buildEtaEgyptReceiptPayload({
        receiptNumber: inv.invoiceNumber,
        dateTimeIssuedIso: timestampIso,
        previousUuid: lastHashed[0]?.etaDocumentUuid ?? "",
        currency: inv.currency || company.baseCurrency || "EGP",
        sellerName,
        sellerTaxNumber: taxNumber,
        branchCode: effectiveEtaBranchId,
        branchAddress: effectiveBranchStreet,
        branchCountry: branchRow?.country || "EG",
        branchGovernorate: branchRow?.governorate || "Cairo",
        branchRegionCity: branchRow?.regionCity || "Cairo",
        branchBuildingNumber: branchRow?.buildingNumber || "1",
        branchPostalCode: branchRow?.postalCode || undefined,
        posSerialNumber: termRow?.etaPosSerial || termRow?.code || "POS-01",
        buyerName: custRow?.name || "Walk-in Customer",
        buyerTaxNumber: custRow?.taxNumber || undefined,
        buyerType: custRow?.isWalkIn ? "P" : (custRow?.etaReceiverType ?? (custRow?.taxNumber ? "B" : "P")),
        paymentMethod: primaryPaymentMethod,
        subtotal: num(inv.subtotal),
        taxTotal: num(inv.taxTotal),
        totalAmount: num(inv.totalAmount),
        lines: lines.map((l) => {
          const prod = l.productId ? prodMap.get(l.productId) : undefined;
          const internalCode = prod?.sku || l.productId || l.id;
          return {
            description: l.description || prod?.name || "Item",
            internalCode,
            itemType: prod?.etaCodeType ?? "EGS",
            itemCode: prod?.etaItemCode || internalCode,
            unitType: prod?.etaUnitType || "EA",
            quantity: num(l.quantity),
            unitPrice: num(l.unitPrice),
            taxRate: num(l.taxRate),
            taxAmount: num(l.taxAmount),
            lineTotal: num(l.lineTotal),
          };
        }),
      });
    } else {
      const receiverType: "B" | "P" | "F" =
        custRow?.etaReceiverType ?? (custRow?.taxNumber || custRow?.company ? "B" : "P");
      built = buildEtaB2bInvoicePayload({
        internalId: inv.invoiceNumber,
        dateTimeIssuedIso: timestampIso,
        documentType: "I",
        documentTypeVersion: resolveEtaInvoiceVersion(),
        currency: inv.currency || company.baseCurrency || "EGP",
        exchangeRate: num(inv.fxRate) || 1,
        issuerName: sellerName,
        issuerRin: taxNumber,
        branchId: effectiveEtaBranchId,
        branchCountry: branchRow?.country || "EG",
        branchGovernorate: branchRow?.governorate || "Cairo",
        branchRegionCity: branchRow?.regionCity || "Cairo",
        branchStreet: effectiveBranchStreet,
        branchBuildingNumber: branchRow?.buildingNumber || "1",
        branchPostalCode: branchRow?.postalCode || undefined,
        receiverType,
        receiverId: custRow?.taxNumber || "",
        receiverName: custRow?.company || custRow?.name || "Customer",
        receiverStreet: custRow?.billingAddress || "Cairo",
        subtotal: num(inv.subtotal),
        taxTotal: num(inv.taxTotal),
        totalAmount: num(inv.totalAmount),
        lines: lines.map((l) => {
          const prod = l.productId ? prodMap.get(l.productId) : undefined;
          const internalCode = prod?.sku || l.productId || l.id;
          return {
            description: l.description || prod?.name || "Item",
            internalCode,
            itemType: prod?.etaCodeType ?? "EGS",
            itemCode: prod?.etaItemCode || `EG-${taxNumber}-${internalCode}`,
            unitType: prod?.etaUnitType || "EA",
            quantity: num(l.quantity),
            unitPrice: num(l.unitPrice),
            discount: num(l.discount),
            taxRate: num(l.taxRate),
            taxAmount: num(l.taxAmount),
            lineTotal: num(l.lineTotal),
          };
        }),
      });
    }

    const { payload, etaUuid, qrUrl } = built;

    await tx
      .update(salesInvoices)
      .set({
        icv,
        invoiceHash,
        prevInvoiceHash,
        qrTlv: qrUrl,
        etaDocumentUuid: etaUuid,
        etaReceiptStatus: "pending_submission",
        eInvoiceStatus: "pending_submission",
        eInvoicePayloadJson: payload,
      })
      .where(and(eq(salesInvoices.id, invoiceId), eq(salesInvoices.companyId, effectiveCompanyId)));

    await tx
      .insert(einvoiceSubmissions)
      .values({
        companyId: effectiveCompanyId,
        invoiceId: inv.id,
        provider: "eta_egypt",
        documentType: isPosReceipt ? "receipt" : "invoice",
        documentUuid: etaUuid,
        status: "pending",
        requestPayloadJson: payload,
      })
      .onConflictDoNothing();

    return {
      eInvoiceStatus: "pending_submission",
      icv,
      invoiceHash,
      prevInvoiceHash,
      qrTlv: qrUrl,
      etaDocumentUuid: etaUuid,
      etaReceiptStatus: "pending_submission",
    };
  }

  const qrTlv = encodeZatcaTlvQr({
    sellerName,
    taxNumber,
    timestampIso,
    totalWithVat: totalStr,
    vatTotal: vatStr,
  });

  await tx
    .update(salesInvoices)
    .set({
      icv,
      invoiceHash,
      prevInvoiceHash,
      qrTlv,
      eInvoiceStatus: "generated",
      eInvoicePayloadJson: {
        mode: company.einvoicingMode,
        icv,
        sellerName,
        taxNumber,
        timestampIso,
        totalWithVat: totalStr,
        vatTotal: vatStr,
      },
    })
    .where(and(eq(salesInvoices.id, invoiceId), eq(salesInvoices.companyId, effectiveCompanyId)));

  return {
    eInvoiceStatus: "generated",
    icv,
    invoiceHash,
    prevInvoiceHash,
    qrTlv,
    etaDocumentUuid: null,
    etaReceiptStatus: "not_applicable",
  };
}

export async function applyPosReturnEInvoiceMetadata(
  tx: DbOrTx,
  posReturnId: string,
  companyId?: string
): Promise<{
  etaDocumentUuid: string | null;
  etaReceiptStatus: string;
  qrTlv: string | null;
  eInvoicePayloadJson: Record<string, unknown> | null;
}> {
  const [posRet] = await tx
    .select()
    .from(posReturns)
    .where(
      companyId
        ? and(eq(posReturns.id, posReturnId), eq(posReturns.companyId, companyId))
        : eq(posReturns.id, posReturnId)
    )
    .limit(1);
  if (!posRet) {
    return {
      etaDocumentUuid: null,
      etaReceiptStatus: "not_applicable",
      qrTlv: null,
      eInvoicePayloadJson: null,
    };
  }

  const effectiveCompanyId = companyId || posRet.companyId || DEFAULT_COMPANY_ID;
  const company = await loadCompanyEinvoiceConfig(tx, effectiveCompanyId);
  if (!company || company.einvoicingMode !== "eta_egypt") {
    return {
      etaDocumentUuid: null,
      etaReceiptStatus: "not_applicable",
      qrTlv: null,
      eInvoicePayloadJson: null,
    };
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(882411, ${companyEinvoiceLockKey(effectiveCompanyId)})`
  );

  const [origInv] = await tx
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.id, posRet.originalInvoiceId), eq(salesInvoices.companyId, effectiveCompanyId)))
    .limit(1);

  const lastSub = await tx
    .select({ documentUuid: einvoiceSubmissions.documentUuid })
    .from(einvoiceSubmissions)
    .where(
      and(
        eq(einvoiceSubmissions.companyId, effectiveCompanyId),
        eq(einvoiceSubmissions.provider, "eta_egypt")
      )
    )
    .orderBy(desc(einvoiceSubmissions.createdAt), desc(einvoiceSubmissions.id))
    .limit(1);

  const [branchRow] = await tx
    .select()
    .from(branches)
    .where(and(eq(branches.id, posRet.branchId), eq(branches.companyId, effectiveCompanyId)))
    .limit(1);
  const [custRow] = origInv?.customerId
    ? await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, origInv.customerId), eq(customers.companyId, effectiveCompanyId)))
        .limit(1)
    : [undefined];
  const [termRow] = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, posRet.terminalId), eq(posTerminals.companyId, effectiveCompanyId)))
    .limit(1);
  const retLines = await tx
    .select({
      line: posReturnLines,
      productName: products.name,
      productSku: products.sku,
      etaCodeType: products.etaCodeType,
      etaItemCode: products.etaItemCode,
      etaUnitType: products.etaUnitType,
    })
    .from(posReturnLines)
    .leftJoin(products, eq(products.id, posReturnLines.productId))
    .where(eq(posReturnLines.posReturnId, posRet.id));

  const sellerName = company.legalName || company.companyName || "ERP Company";
  const taxNumber = company.taxRegistrationNumber || "000000000000000";
  const effectiveEtaBranchId =
    branchRow?.etaBranchId && branchRow.etaBranchId !== "0"
      ? branchRow.etaBranchId
      : (branchRow?.etaBranchId ?? branchRow?.code ?? "0");
  const effectiveBranchStreet =
    branchRow?.street || branchRow?.address || branchRow?.location || company.address || "Main Branch";

  const { payload, etaUuid, qrUrl } = buildEtaEgyptReceiptPayload({
    receiptNumber: posRet.returnNumber,
    dateTimeIssuedIso: posRet.createdAt.toISOString(),
    previousUuid: lastSub[0]?.documentUuid ?? origInv?.etaDocumentUuid ?? "",
    referenceUUID: origInv?.etaDocumentUuid ?? "",
    receiptType: "R",
    currency: origInv?.currency || company.baseCurrency || "EGP",
    sellerName,
    sellerTaxNumber: taxNumber,
    branchCode: effectiveEtaBranchId,
    branchAddress: effectiveBranchStreet,
    branchCountry: branchRow?.country || "EG",
    branchGovernorate: branchRow?.governorate || "Cairo",
    branchRegionCity: branchRow?.regionCity || "Cairo",
    branchBuildingNumber: branchRow?.buildingNumber || "1",
    branchPostalCode: branchRow?.postalCode || undefined,
    posSerialNumber: termRow?.etaPosSerial || termRow?.code || "POS-01",
    buyerName: custRow?.name || "Walk-in Customer",
    buyerTaxNumber: custRow?.taxNumber || undefined,
    buyerType: custRow?.isWalkIn ? "P" : (custRow?.etaReceiverType ?? (custRow?.taxNumber ? "B" : "P")),
    paymentMethod: mapPosPaymentMethodToEta(posRet.refundMethod),
    subtotal: num(posRet.subtotal),
    taxTotal: num(posRet.taxAmount),
    totalAmount: num(posRet.totalAmount),
    lines: retLines.map(({ line, productName, productSku, etaCodeType, etaItemCode, etaUnitType }) => {
      const internalCode = productSku || line.productId;
      return {
        description: productName || "Returned Item",
        internalCode,
        itemType: etaCodeType ?? "EGS",
        itemCode: etaItemCode || internalCode,
        unitType: etaUnitType || "EA",
        quantity: num(line.quantity),
        unitPrice: num(line.unitPrice),
        taxRate: num(line.taxRate),
        taxAmount: num(line.taxAmount),
        lineTotal: num(line.lineTotal),
      };
    }),
  });

  await tx
    .update(posReturns)
    .set({
      etaDocumentUuid: etaUuid,
      etaReceiptStatus: "pending_submission",
      eInvoicePayloadJson: payload,
    })
    .where(and(eq(posReturns.id, posRet.id), eq(posReturns.companyId, effectiveCompanyId)));

  await tx
    .insert(einvoiceSubmissions)
    .values({
      companyId: effectiveCompanyId,
      invoiceId: null,
      posReturnId: posRet.id,
      provider: "eta_egypt",
      documentType: "receipt",
      documentUuid: etaUuid,
      status: "pending",
      requestPayloadJson: payload,
    })
    .onConflictDoNothing();

  return {
    etaDocumentUuid: etaUuid,
    etaReceiptStatus: "pending_submission",
    qrTlv: qrUrl,
    eInvoicePayloadJson: payload,
  };
}

/**
 * Generates an ETA Egypt B2B Credit Note (`documentType: "C"`) when a back-office Sales Return
 * is created while `einvoicingMode === "eta_egypt"`.
 */
export async function applySalesReturnEInvoiceMetadata(
  tx: DbOrTx,
  salesReturnId: string,
  companyId?: string
): Promise<{
  etaDocumentUuid: string | null;
  eInvoiceStatus: string;
  eInvoicePayloadJson: Record<string, unknown> | null;
}> {
  const [ret] = await tx
    .select()
    .from(salesReturns)
    .where(
      companyId
        ? and(eq(salesReturns.id, salesReturnId), eq(salesReturns.companyId, companyId))
        : eq(salesReturns.id, salesReturnId)
    )
    .limit(1);
  if (!ret) {
    return {
      etaDocumentUuid: null,
      eInvoiceStatus: "not_applicable",
      eInvoicePayloadJson: null,
    };
  }

  const effectiveCompanyId = companyId || ret.companyId || DEFAULT_COMPANY_ID;
  const company = await loadCompanyEinvoiceConfig(tx, effectiveCompanyId);
  if (!company || company.einvoicingMode !== "eta_egypt") {
    return {
      etaDocumentUuid: null,
      eInvoiceStatus: "not_applicable",
      eInvoicePayloadJson: null,
    };
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(882411, ${companyEinvoiceLockKey(effectiveCompanyId)})`
  );

  const [origInv] = ret.invoiceId
    ? await tx
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.id, ret.invoiceId), eq(salesInvoices.companyId, effectiveCompanyId)))
        .limit(1)
    : [undefined];

  const [branchRow] = await tx
    .select()
    .from(branches)
    .where(and(eq(branches.id, ret.branchId), eq(branches.companyId, effectiveCompanyId)))
    .limit(1);
  const [custRow] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, ret.customerId), eq(customers.companyId, effectiveCompanyId)))
    .limit(1);
  const retLines = await tx
    .select({
      line: salesReturnLines,
      productName: products.name,
      productSku: products.sku,
      etaCodeType: products.etaCodeType,
      etaItemCode: products.etaItemCode,
      etaUnitType: products.etaUnitType,
    })
    .from(salesReturnLines)
    .leftJoin(products, eq(products.id, salesReturnLines.productId))
    .where(eq(salesReturnLines.returnId, ret.id));

  const sellerName = company.legalName || company.companyName || "ERP Company";
  const taxNumber = company.taxRegistrationNumber || "000000000000000";
  const effectiveEtaBranchId =
    branchRow?.etaBranchId && branchRow.etaBranchId !== "0"
      ? branchRow.etaBranchId
      : (branchRow?.etaBranchId ?? branchRow?.code ?? "0");
  const effectiveBranchStreet =
    branchRow?.street || branchRow?.address || branchRow?.location || company.address || "Main Branch";
  const receiverType: "B" | "P" | "F" =
    custRow?.etaReceiverType ?? (custRow?.taxNumber || custRow?.company ? "B" : "P");

  const { payload, etaUuid } = buildEtaB2bInvoicePayload({
    internalId: ret.creditNoteNumber || ret.returnNumber,
    dateTimeIssuedIso: ret.returnDate.toISOString(),
    documentType: "C",
    documentTypeVersion: resolveEtaInvoiceVersion(),
    references: origInv?.etaDocumentUuid ? [origInv.etaDocumentUuid] : undefined,
    currency: origInv?.currency || company.baseCurrency || "EGP",
    exchangeRate: origInv ? num(origInv.fxRate) || 1 : 1,
    issuerName: sellerName,
    issuerRin: taxNumber,
    branchId: effectiveEtaBranchId,
    branchCountry: branchRow?.country || "EG",
    branchGovernorate: branchRow?.governorate || "Cairo",
    branchRegionCity: branchRow?.regionCity || "Cairo",
    branchStreet: effectiveBranchStreet,
    branchBuildingNumber: branchRow?.buildingNumber || "1",
    branchPostalCode: branchRow?.postalCode || undefined,
    receiverType,
    receiverId: custRow?.taxNumber || "",
    receiverName: custRow?.company || custRow?.name || "Customer",
    receiverStreet: custRow?.billingAddress || "Cairo",
    subtotal: num(ret.subtotal),
    taxTotal: num(ret.taxTotal),
    totalAmount: num(ret.totalAmount),
    lines: retLines.map(({ line, productName, productSku, etaCodeType, etaItemCode, etaUnitType }) => {
      const internalCode = productSku || line.productId;
      return {
        description: productName || "Returned Item",
        internalCode,
        itemType: etaCodeType ?? "EGS",
        itemCode: etaItemCode || `EG-${taxNumber}-${internalCode}`,
        unitType: etaUnitType || "EA",
        quantity: num(line.quantity),
        unitPrice: num(line.unitPrice),
        taxRate: num(line.taxRate),
        taxAmount: num(line.taxAmount),
        lineTotal: num(line.lineTotal),
      };
    }),
  });

  await tx
    .update(salesReturns)
    .set({
      etaDocumentUuid: etaUuid,
      eInvoiceStatus: "pending_submission",
      eInvoicePayloadJson: payload,
    })
    .where(and(eq(salesReturns.id, ret.id), eq(salesReturns.companyId, effectiveCompanyId)));

  await tx
    .insert(einvoiceSubmissions)
    .values({
      companyId: effectiveCompanyId,
      invoiceId: null,
      posReturnId: null,
      salesReturnId: ret.id,
      provider: "eta_egypt",
      documentType: "invoice",
      documentUuid: etaUuid,
      status: "pending",
      requestPayloadJson: payload,
    })
    .onConflictDoNothing();

  return {
    etaDocumentUuid: etaUuid,
    eInvoiceStatus: "pending_submission",
    eInvoicePayloadJson: payload,
  };
}

export const MAX_ETA_SUBMISSION_ATTEMPTS = 5;

const RETRY_DELAY_SCHEDULE_MS = [
  60_000, // attempt 1 -> 1 min
  5 * 60_000, // attempt 2 -> 5 min
  15 * 60_000, // attempt 3 -> 15 min
  60 * 60_000, // attempt 4 -> 60 min
  6 * 60 * 60_000, // attempt 5+ -> 6 hours
] as const;

export function computeNextEtaRetryDelayMs(attempts: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempts || 1));
  const index = Math.min(safeAttempt - 1, RETRY_DELAY_SCHEDULE_MS.length - 1);
  return RETRY_DELAY_SCHEDULE_MS[index];
}

function extractReceiptType(
  payload: Record<string, unknown> | null | undefined,
  documentType: string,
  posReturnId: string | null,
  invoiceId: string | null
): EtaReceiptType | null {
  if (documentType === "invoice") {
    return null;
  }
  const headerObj = payload?.header as Record<string, unknown> | undefined;
  if (headerObj?.receiptType === "S" || headerObj?.receiptType === "R") {
    return headerObj.receiptType;
  }
  const docTypeObj = payload?.documentType as Record<string, unknown> | undefined;
  if (docTypeObj?.receiptType === "S" || docTypeObj?.receiptType === "R") {
    return docTypeObj.receiptType;
  }
  if (posReturnId) return "R";
  if (invoiceId) return "S";
  return null;
}

function extractEtaDocumentTypeCode(
  payload: Record<string, unknown> | null | undefined,
  receiptType: EtaReceiptType | null,
  salesReturnId: string | null
): EtaDocumentTypeCode | null {
  if (payload?.documentType === "I" || payload?.documentType === "C" || payload?.documentType === "D") {
    return payload.documentType;
  }
  if (receiptType === "S" || receiptType === "R") {
    return receiptType;
  }
  if (salesReturnId) return "C";
  return null;
}

function extractSignatureStatus(
  payload: Record<string, unknown> | null | undefined,
  documentType: string
): EtaSignatureStatus {
  if (documentType !== "invoice") {
    return "not_required";
  }
  const sigs = Array.isArray(payload?.signatures) ? payload.signatures : [];
  const hasSig = sigs.some(
    (s) =>
      Boolean(s && typeof s === "object") &&
      typeof (s as Record<string, unknown>).value === "string" &&
      ((s as Record<string, unknown>).value as string).trim().length > 0
  );
  if (hasSig) return "signed";
  if (payload?.documentTypeVersion === "0.9") return "unsigned_v0_9";
  return "pending_signature";
}

function extractPayloadDocumentNumber(payload: Record<string, unknown> | null | undefined): string | null {
  const headerObj = payload?.header as Record<string, unknown> | undefined;
  if (typeof headerObj?.receiptNumber === "string" && headerObj.receiptNumber.trim()) {
    return headerObj.receiptNumber.trim();
  }
  if (typeof payload?.internalID === "string" && payload.internalID.trim()) {
    return payload.internalID.trim();
  }
  return null;
}

function extractPayloadTotalAmount(payload: Record<string, unknown> | null | undefined): number | null {
  if (typeof payload?.totalAmount === "number" && Number.isFinite(payload.totalAmount)) {
    return payload.totalAmount;
  }
  return null;
}

function extractPayloadCurrency(payload: Record<string, unknown> | null | undefined): string | null {
  const headerObj = payload?.header as Record<string, unknown> | undefined;
  if (typeof headerObj?.currency === "string" && headerObj.currency.trim()) {
    return headerObj.currency.trim();
  }
  const lines = Array.isArray(payload?.invoiceLines) ? payload.invoiceLines : [];
  const firstUnitVal = (lines[0] as Record<string, unknown> | undefined)?.unitValue as
    | Record<string, unknown>
    | undefined;
  if (typeof firstUnitVal?.currencySold === "string" && firstUnitVal.currencySold.trim()) {
    return firstUnitVal.currencySold.trim();
  }
  return null;
}

function extractPayloadIssuedAt(payload: Record<string, unknown> | null | undefined): string | null {
  const headerObj = payload?.header as Record<string, unknown> | undefined;
  if (typeof headerObj?.dateTimeIssued === "string" && headerObj.dateTimeIssued.trim()) {
    return headerObj.dateTimeIssued.trim();
  }
  if (typeof payload?.dateTimeIssued === "string" && payload.dateTimeIssued.trim()) {
    return payload.dateTimeIssued.trim();
  }
  return null;
}

interface JoinedSubmissionRow {
  sub: typeof einvoiceSubmissions.$inferSelect;
  invoiceNumber: string | null;
  invoiceBranchId: string | null;
  invoiceTotalAmount: string | null;
  invoiceCurrency: string | null;
  invoiceDate: Date | null;
  returnNumber: string | null;
  returnBranchId: string | null;
  returnTotalAmount: string | null;
  returnCreatedAt: Date | null;
  salesReturnCreditNoteNumber: string | null;
  salesReturnNumber: string | null;
  salesReturnBranchId: string | null;
  salesReturnTotalAmount: string | null;
  salesReturnDate: Date | null;
  branchName: string | null;
}

function mapSubmissionRowToListItem(row: JoinedSubmissionRow): EtaSubmissionListItemDto {
  const { sub } = row;
  const payload = sub.requestPayloadJson ?? {};
  const documentNumber =
    row.invoiceNumber ??
    row.returnNumber ??
    row.salesReturnCreditNoteNumber ??
    row.salesReturnNumber ??
    extractPayloadDocumentNumber(payload);
  const branchId = row.invoiceBranchId ?? row.returnBranchId ?? row.salesReturnBranchId ?? null;
  const receiptType = extractReceiptType(payload, sub.documentType, sub.posReturnId, sub.invoiceId);
  const etaDocumentTypeCode = extractEtaDocumentTypeCode(
    payload,
    receiptType,
    sub.salesReturnId ?? null
  );
  const documentVersion =
    typeof payload.documentTypeVersion === "string"
      ? payload.documentTypeVersion
      : typeof (payload.documentType as Record<string, unknown> | undefined)?.typeVersion === "string"
        ? ((payload.documentType as Record<string, unknown>).typeVersion as string)
        : null;
  const signatureStatus = extractSignatureStatus(payload, sub.documentType);
  const totalAmount =
    row.invoiceTotalAmount !== null
      ? num(row.invoiceTotalAmount)
      : row.returnTotalAmount !== null
        ? num(row.returnTotalAmount)
        : row.salesReturnTotalAmount !== null
          ? num(row.salesReturnTotalAmount)
          : extractPayloadTotalAmount(payload);
  const currency = row.invoiceCurrency ?? extractPayloadCurrency(payload) ?? "EGP";
  const issuedAt = row.invoiceDate
    ? row.invoiceDate.toISOString()
    : row.returnCreatedAt
      ? row.returnCreatedAt.toISOString()
      : row.salesReturnDate
        ? row.salesReturnDate.toISOString()
        : (extractPayloadIssuedAt(payload) ?? sub.createdAt.toISOString());

  return {
    id: sub.id,
    invoiceId: sub.invoiceId ?? null,
    posReturnId: sub.posReturnId ?? null,
    salesReturnId: sub.salesReturnId ?? null,
    documentNumber,
    branchId,
    branchName: row.branchName ?? null,
    provider: sub.provider as EinvoiceProvider,
    documentType: sub.documentType as EinvoiceDocumentType,
    receiptType,
    etaDocumentTypeCode,
    documentVersion,
    signatureStatus,
    documentUuid: sub.documentUuid,
    submissionUuid: sub.submissionUuid ?? null,
    status: sub.status as EinvoiceSubmissionStatus,
    attempts: sub.attempts,
    nextRetryAt: sub.nextRetryAt ? sub.nextRetryAt.toISOString() : null,
    lastError: sub.lastError ?? null,
    totalAmount,
    currency,
    issuedAt,
    createdAt: sub.createdAt.toISOString(),
    updatedAt: sub.updatedAt.toISOString(),
  };
}

function buildSubmissionBranchScopeSql(
  actor: RequestActor,
  requestedBranchId?: string
): SQL | null | "EMPTY" {
  const effectiveBranchExpr = sql`coalesce(${salesInvoices.branchId}, ${posReturns.branchId}, ${salesReturns.branchId})`;
  if (requestedBranchId) {
    assertBranchAccess(actor, requestedBranchId);
    return sql`${effectiveBranchExpr} = ${requestedBranchId}`;
  }
  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    return null;
  }
  if (actor.branchIds.length === 0) {
    return "EMPTY";
  }
  return or(
    sql`${effectiveBranchExpr} IS NULL`,
    inArray(salesInvoices.branchId, actor.branchIds),
    inArray(posReturns.branchId, actor.branchIds),
    inArray(salesReturns.branchId, actor.branchIds)
  )!;
}

export async function getEinvoiceQueueSummary(
  actor: RequestActor,
  opts?: { branchId?: string; provider?: EinvoiceProvider; db?: AppDatabase }
): Promise<EinvoiceQueueSummaryDto> {
  const db = opts?.db ?? getDb();
  const companyId = actorCompanyId(actor);
  const etaConfigured = isEtaConfigured();
  const signerConfigured = isEtaSignerConfigured();
  const invoiceVersion = resolveEtaInvoiceVersion();
  const scopeCond = buildSubmissionBranchScopeSql(actor, opts?.branchId);
  if (scopeCond === "EMPTY") {
    return {
      pending: 0,
      submitted: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      total: 0,
      etaConfigured,
      signerConfigured,
      invoiceVersion,
    };
  }

  const conditions: SQL[] = [eq(einvoiceSubmissions.companyId, companyId)];
  if (scopeCond) conditions.push(scopeCond);
  if (opts?.provider) conditions.push(eq(einvoiceSubmissions.provider, opts.provider));

  const statusCounts = await db
    .select({
      status: einvoiceSubmissions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(einvoiceSubmissions)
    .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
    .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
    .leftJoin(salesReturns, eq(salesReturns.id, einvoiceSubmissions.salesReturnId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(einvoiceSubmissions.status);

  const summary: EinvoiceQueueSummaryDto = {
    pending: 0,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    total: 0,
    etaConfigured,
    signerConfigured,
    invoiceVersion,
  };

  for (const row of statusCounts) {
    const cnt = Number(row.count) || 0;
    if (row.status === "pending") summary.pending += cnt;
    else if (row.status === "submitted") summary.submitted += cnt;
    else if (row.status === "accepted") summary.accepted += cnt;
    else if (row.status === "rejected") summary.rejected += cnt;
    else if (row.status === "failed") summary.failed += cnt;
    summary.total += cnt;
  }

  return summary;
}

export async function listEinvoiceSubmissions(
  actor: RequestActor,
  rawQuery?: unknown,
  db: AppDatabase = getDb()
): Promise<{
  items: EtaSubmissionListItemDto[];
  submissions: EtaSubmissionListItemDto[];
  summary: EinvoiceQueueSummaryDto;
  pageInfo: OffsetPageInfo;
}> {
  const companyId = actorCompanyId(actor);
  const query = parseOrThrow(einvoiceQueueQuerySchema, rawQuery ?? {}, "Invalid E-Invoice queue query");
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;

  const scopeCond = buildSubmissionBranchScopeSql(actor, query.branchId);
  const summary = await getEinvoiceQueueSummary(actor, {
    branchId: query.branchId,
    provider: query.provider,
    db,
  });

  if (scopeCond === "EMPTY") {
    return {
      items: [],
      submissions: [],
      summary,
      pageInfo: buildOffsetPageInfo(page, pageSize, 0),
    };
  }

  const conditions: SQL[] = [eq(einvoiceSubmissions.companyId, companyId)];
  if (scopeCond) conditions.push(scopeCond);
  if (query.status) conditions.push(eq(einvoiceSubmissions.status, query.status));
  if (query.provider) conditions.push(eq(einvoiceSubmissions.provider, query.provider));
  if (query.documentType) conditions.push(eq(einvoiceSubmissions.documentType, query.documentType));
  if (query.fromDate) conditions.push(gte(einvoiceSubmissions.createdAt, new Date(query.fromDate)));
  if (query.toDate) conditions.push(lte(einvoiceSubmissions.createdAt, new Date(query.toDate)));

  const searchTerm = (query.q ?? query.search)?.trim();
  if (searchTerm) {
    const pattern = `%${searchTerm}%`;
    conditions.push(
      or(
        ilike(einvoiceSubmissions.documentUuid, pattern),
        ilike(einvoiceSubmissions.submissionUuid, pattern),
        ilike(salesInvoices.invoiceNumber, pattern),
        ilike(posReturns.returnNumber, pattern),
        ilike(salesReturns.creditNoteNumber, pattern),
        ilike(salesReturns.returnNumber, pattern),
        ilike(einvoiceSubmissions.lastError, pattern)
      )!
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(einvoiceSubmissions)
    .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
    .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
    .leftJoin(salesReturns, eq(salesReturns.id, einvoiceSubmissions.salesReturnId))
    .where(whereClause);

  const pageInfo = buildOffsetPageInfo(page, pageSize, total);
  if (total === 0) {
    return {
      items: [],
      submissions: [],
      summary,
      pageInfo,
    };
  }

  const sortDir = query.sortDir === "asc" ? asc : desc;
  const sortCol =
    query.sortBy === "updatedAt"
      ? einvoiceSubmissions.updatedAt
      : query.sortBy === "nextRetryAt"
        ? einvoiceSubmissions.nextRetryAt
        : query.sortBy === "attempts"
          ? einvoiceSubmissions.attempts
          : query.sortBy === "status"
            ? einvoiceSubmissions.status
            : einvoiceSubmissions.createdAt;

  const rows = await db
    .select({
      sub: einvoiceSubmissions,
      invoiceNumber: salesInvoices.invoiceNumber,
      invoiceBranchId: salesInvoices.branchId,
      invoiceTotalAmount: salesInvoices.totalAmount,
      invoiceCurrency: salesInvoices.currency,
      invoiceDate: salesInvoices.invoiceDate,
      returnNumber: posReturns.returnNumber,
      returnBranchId: posReturns.branchId,
      returnTotalAmount: posReturns.totalAmount,
      returnCreatedAt: posReturns.createdAt,
      salesReturnCreditNoteNumber: salesReturns.creditNoteNumber,
      salesReturnNumber: salesReturns.returnNumber,
      salesReturnBranchId: salesReturns.branchId,
      salesReturnTotalAmount: salesReturns.totalAmount,
      salesReturnDate: salesReturns.returnDate,
      branchName: branches.name,
    })
    .from(einvoiceSubmissions)
    .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
    .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
    .leftJoin(salesReturns, eq(salesReturns.id, einvoiceSubmissions.salesReturnId))
    .leftJoin(
      branches,
      sql`${branches.id} = coalesce(${salesInvoices.branchId}, ${posReturns.branchId}, ${salesReturns.branchId})`
    )
    .where(whereClause)
    .orderBy(sortDir(sortCol), desc(einvoiceSubmissions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const items = rows.map(mapSubmissionRowToListItem);

  return {
    items,
    submissions: items,
    summary,
    pageInfo,
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getEinvoiceSubmissionDetail(
  actor: RequestActor,
  submissionId: string,
  db: AppDatabase = getDb()
): Promise<EtaSubmissionDetailDto> {
  if (!UUID_REGEX.test(submissionId)) {
    throw new AppError(404, "E-Invoice submission not found", "NOT_FOUND");
  }
  const companyId = actorCompanyId(actor);

  const rows = await db
    .select({
      sub: einvoiceSubmissions,
      invoiceNumber: salesInvoices.invoiceNumber,
      invoiceBranchId: salesInvoices.branchId,
      invoiceTotalAmount: salesInvoices.totalAmount,
      invoiceCurrency: salesInvoices.currency,
      invoiceDate: salesInvoices.invoiceDate,
      returnNumber: posReturns.returnNumber,
      returnBranchId: posReturns.branchId,
      returnTotalAmount: posReturns.totalAmount,
      returnCreatedAt: posReturns.createdAt,
      salesReturnCreditNoteNumber: salesReturns.creditNoteNumber,
      salesReturnNumber: salesReturns.returnNumber,
      salesReturnBranchId: salesReturns.branchId,
      salesReturnTotalAmount: salesReturns.totalAmount,
      salesReturnDate: salesReturns.returnDate,
      branchName: branches.name,
    })
    .from(einvoiceSubmissions)
    .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
    .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
    .leftJoin(salesReturns, eq(salesReturns.id, einvoiceSubmissions.salesReturnId))
    .leftJoin(
      branches,
      sql`${branches.id} = coalesce(${salesInvoices.branchId}, ${posReturns.branchId}, ${salesReturns.branchId})`
    )
    .where(and(eq(einvoiceSubmissions.id, submissionId), eq(einvoiceSubmissions.companyId, companyId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new AppError(404, "E-Invoice submission not found", "NOT_FOUND");
  }

  const branchId =
    row.invoiceBranchId ?? row.returnBranchId ?? row.salesReturnBranchId ?? null;
  assertBranchAccess(actor, branchId);

  const base = mapSubmissionRowToListItem(row);
  return {
    ...base,
    requestPayloadJson: row.sub.requestPayloadJson ?? {},
    responsePayloadJson: row.sub.responsePayloadJson ?? null,
  };
}

export async function retryEinvoiceSubmissions(
  actor: RequestActor,
  rawInput?: Partial<EinvoiceRetryInput> | unknown,
  db: AppDatabase = getDb()
): Promise<{
  queued: number;
  processed: number;
  accepted?: number;
  rejected?: number;
  failed?: number;
  etaConfigured: boolean;
  message: string;
}> {
  const companyId = actorCompanyId(actor);
  const input = parseOrThrow(einvoiceRetrySchema, rawInput ?? {}, "Invalid E-Invoice retry payload");
  const targetIds = input.submissionIds?.length
    ? input.submissionIds
    : input.submissionId
      ? [input.submissionId]
      : [];

  const scopeCond = buildSubmissionBranchScopeSql(actor);
  if (scopeCond === "EMPTY") {
    if (input.submissionId) {
      throw new AppError(404, "E-Invoice submission not found", "NOT_FOUND");
    }
    return {
      queued: 0,
      processed: 0,
      etaConfigured: isEtaConfigured(),
      message: "No accessible E-Invoice submissions to retry",
    };
  }

  const conditions: SQL[] = [eq(einvoiceSubmissions.companyId, companyId)];
  if (scopeCond) conditions.push(scopeCond);

  if (targetIds.length > 0) {
    conditions.push(inArray(einvoiceSubmissions.id, targetIds));
  } else if (!input.force) {
    conditions.push(inArray(einvoiceSubmissions.status, ["pending", "rejected", "failed"]));
  } else {
    conditions.push(inArray(einvoiceSubmissions.status, ["pending", "submitted", "rejected", "failed"]));
  }

  const candidateRows = await db
    .select({
      id: einvoiceSubmissions.id,
      invoiceId: einvoiceSubmissions.invoiceId,
      posReturnId: einvoiceSubmissions.posReturnId,
      salesReturnId: einvoiceSubmissions.salesReturnId,
      status: einvoiceSubmissions.status,
      attempts: einvoiceSubmissions.attempts,
      branchId: sql<string | null>`coalesce(${salesInvoices.branchId}, ${posReturns.branchId}, ${salesReturns.branchId})`,
    })
    .from(einvoiceSubmissions)
    .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
    .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
    .leftJoin(salesReturns, eq(salesReturns.id, einvoiceSubmissions.salesReturnId))
    .where(and(...conditions));

  if (input.submissionId && candidateRows.length === 0) {
    throw new AppError(404, "E-Invoice submission not found", "NOT_FOUND");
  }

  for (const row of candidateRows) {
    assertBranchAccess(actor, row.branchId);
  }

  const now = new Date();
  if (candidateRows.length > 0) {
    await db.transaction(async (tx) => {
      for (const row of candidateRows) {
        const shouldResetAttempts =
          input.resetAttempts ||
          row.status === "failed" ||
          row.status === "rejected" ||
          row.attempts >= MAX_ETA_SUBMISSION_ATTEMPTS;

        await tx
          .update(einvoiceSubmissions)
          .set({
            status: "pending",
            nextRetryAt: now,
            lastError: null,
            ...(shouldResetAttempts ? { attempts: 0 } : {}),
            updatedAt: now,
          })
          .where(and(eq(einvoiceSubmissions.id, row.id), eq(einvoiceSubmissions.companyId, companyId)));

        if (row.invoiceId) {
          await tx
            .update(salesInvoices)
            .set({
              etaReceiptStatus: "pending_submission",
              eInvoiceStatus: "pending_submission",
              updatedAt: now,
            })
            .where(and(eq(salesInvoices.id, row.invoiceId), eq(salesInvoices.companyId, companyId)));
        }
        if (row.posReturnId) {
          await tx
            .update(posReturns)
            .set({
              etaReceiptStatus: "pending_submission",
            })
            .where(and(eq(posReturns.id, row.posReturnId), eq(posReturns.companyId, companyId)));
        }
        if (row.salesReturnId) {
          await tx
            .update(salesReturns)
            .set({
              eInvoiceStatus: "pending_submission",
            })
            .where(and(eq(salesReturns.id, row.salesReturnId), eq(salesReturns.companyId, companyId)));
        }
      }
    });
  }

  const count = candidateRows.length;
  if (!isEtaConfigured()) {
    return {
      queued: count,
      processed: 0,
      etaConfigured: false,
      message: "ETA credentials not configured; submissions queued as pending",
    };
  }

  const workerResult = await processPendingEtaSubmissions({
    limit: Math.max(10, count),
    companyId,
    db,
  });
  return {
    queued: count,
    processed: workerResult.processed,
    accepted: workerResult.accepted,
    rejected: workerResult.rejected,
    failed: workerResult.failed,
    etaConfigured: true,
    message: "Submissions queued and processed",
  };
}

export interface ProcessPendingEtaOptions {
  limit?: number;
  companyId?: string;
  fetchImpl?: typeof fetch;
  db?: AppDatabase;
}

export interface ProcessPendingEtaResult {
  skipped: boolean;
  reason?: "eta_not_configured" | "lock_busy";
  processed: number;
  accepted: number;
  rejected: number;
  failed: number;
  etaConfigured: boolean;
}

function isDatabaseInstance(val: unknown): val is AppDatabase {
  return Boolean(val && typeof val === "object" && "select" in val && "transaction" in val);
}

/**
 * Advisory-locked background worker for Egyptian Tax Authority (ETA e-Receipt v1.2 & B2B e-Invoice v1.0).
 * Safely no-ops with `skipped: true, reason: "eta_not_configured"` when ETA credentials are absent.
 */
export async function processPendingEtaSubmissions(
  dbOrOpts?: AppDatabase | ProcessPendingEtaOptions,
  batchLimitOrOpts?: number | ProcessPendingEtaOptions
): Promise<ProcessPendingEtaResult> {
  let db: AppDatabase;
  let opts: ProcessPendingEtaOptions;

  if (isDatabaseInstance(dbOrOpts)) {
    db = dbOrOpts;
    opts =
      typeof batchLimitOrOpts === "number"
        ? { limit: batchLimitOrOpts }
        : (batchLimitOrOpts ?? {});
  } else {
    opts = dbOrOpts ?? {};
    db = opts.db ?? getDb();
  }

  if (!isEtaConfigured()) {
    log.debug("eta.worker.skipped_unconfigured");
    return {
      skipped: true,
      reason: "eta_not_configured",
      processed: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      etaConfigured: false,
    };
  }

  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));

  return db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(948271, 202) AS locked`
    );
    if (!lockRows[0]?.locked) {
      return {
        skipped: true,
        reason: "lock_busy",
        processed: 0,
        accepted: 0,
        rejected: 0,
        failed: 0,
        etaConfigured: true,
      };
    }

    const now = new Date();
    const pendingConds: SQL[] = [
      eq(einvoiceSubmissions.provider, "eta_egypt"),
      eq(einvoiceSubmissions.status, "pending"),
      or(sql`${einvoiceSubmissions.nextRetryAt} IS NULL`, lte(einvoiceSubmissions.nextRetryAt, now))!,
    ];
    if (opts.companyId) {
      pendingConds.push(eq(einvoiceSubmissions.companyId, opts.companyId));
    }

    const duePendingRows = await tx
      .select({
        sub: einvoiceSubmissions,
        invTerminalId: salesInvoices.posTerminalId,
        retTerminalId: posReturns.terminalId,
      })
      .from(einvoiceSubmissions)
      .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
      .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
      .where(and(...pendingConds))
      .orderBy(asc(einvoiceSubmissions.createdAt))
      .limit(limit);

    const submittedConds: SQL[] = [
      eq(einvoiceSubmissions.provider, "eta_egypt"),
      eq(einvoiceSubmissions.status, "submitted"),
      isNotNull(einvoiceSubmissions.submissionUuid),
      or(sql`${einvoiceSubmissions.nextRetryAt} IS NULL`, lte(einvoiceSubmissions.nextRetryAt, now))!,
    ];
    if (opts.companyId) {
      submittedConds.push(eq(einvoiceSubmissions.companyId, opts.companyId));
    }

    const dueSubmittedRows = await tx
      .select({
        sub: einvoiceSubmissions,
        invTerminalId: salesInvoices.posTerminalId,
        retTerminalId: posReturns.terminalId,
      })
      .from(einvoiceSubmissions)
      .leftJoin(salesInvoices, eq(salesInvoices.id, einvoiceSubmissions.invoiceId))
      .leftJoin(posReturns, eq(posReturns.id, einvoiceSubmissions.posReturnId))
      .where(and(...submittedConds))
      .orderBy(asc(einvoiceSubmissions.updatedAt))
      .limit(limit);

    if (duePendingRows.length === 0 && dueSubmittedRows.length === 0) {
      return {
        skipped: false,
        processed: 0,
        accepted: 0,
        rejected: 0,
        failed: 0,
        etaConfigured: true,
      };
    }

    const terminalIds = Array.from(
      new Set(
        [...duePendingRows, ...dueSubmittedRows]
          .map((r) => r.invTerminalId ?? r.retTerminalId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const terminalRows =
      terminalIds.length > 0
        ? await tx.select().from(posTerminals).where(inArray(posTerminals.id, terminalIds))
        : [];
    const terminalMap = new Map(terminalRows.map((t) => [t.id, t]));

    let processed = 0;
    let accepted = 0;
    let rejected = 0;
    let failed = 0;

    const updateLinkedDocStatus = async (
      sub: typeof einvoiceSubmissions.$inferSelect,
      etaReceiptStatus: string,
      submissionUuid?: string | null,
      etaDocumentUuid?: string | null
    ) => {
      if (sub.invoiceId) {
        await tx
          .update(salesInvoices)
          .set({
            etaReceiptStatus,
            eInvoiceStatus: etaReceiptStatus,
            ...(submissionUuid !== undefined ? { etaSubmissionUuid: submissionUuid } : {}),
            ...(etaDocumentUuid ? { etaDocumentUuid } : {}),
            updatedAt: new Date(),
          })
          .where(eq(salesInvoices.id, sub.invoiceId));
      }
      if (sub.posReturnId) {
        await tx
          .update(posReturns)
          .set({
            etaReceiptStatus,
            ...(submissionUuid !== undefined ? { etaSubmissionUuid: submissionUuid } : {}),
          })
          .where(eq(posReturns.id, sub.posReturnId));
      }
      if (sub.salesReturnId) {
        await tx
          .update(salesReturns)
          .set({
            eInvoiceStatus: etaReceiptStatus,
            ...(submissionUuid !== undefined ? { etaSubmissionUuid: submissionUuid } : {}),
            ...(etaDocumentUuid ? { etaDocumentUuid } : {}),
          })
          .where(eq(salesReturns.id, sub.salesReturnId));
      }
    };

    for (const { sub, invTerminalId, retTerminalId } of duePendingRows) {
      const terminal = terminalMap.get(invTerminalId ?? retTerminalId ?? "");
      const payloadSeller = (sub.requestPayloadJson?.seller ?? {}) as Record<string, unknown>;
      const posSerial =
        terminal?.etaPosSerial ||
        (typeof payloadSeller.deviceSerialNumber === "string" ? payloadSeller.deviceSerialNumber : null);
      const posOsVersion = terminal?.etaPosOsVersion || null;

      try {
        let payloadToSend = sub.requestPayloadJson;
        let result;

        if (sub.documentType === "invoice") {
          const signRes = await signEtaInvoiceIfNeeded(sub.requestPayloadJson, {
            fetchImpl: opts.fetchImpl,
          });
          if (!signRes.signed && signRes.signatureStatus === "pending_signature") {
            await tx
              .update(einvoiceSubmissions)
              .set({
                status: "pending",
                lastError: signRes.pendingReason ?? null,
                updatedAt: new Date(),
              })
              .where(eq(einvoiceSubmissions.id, sub.id));
            continue;
          }
          payloadToSend = signRes.document;
          result = await submitEtaDocuments([payloadToSend], {
            fetchImpl: opts.fetchImpl,
          });
        } else {
          result = await submitEtaReceipts([payloadToSend], {
            posSerial,
            posOsVersion,
            fetchImpl: opts.fetchImpl,
          });
        }

        const nextAttempts = sub.attempts + 1;
        const internalId =
          typeof payloadToSend?.internalID === "string" ? payloadToSend.internalID : null;
        const matchedAccepted =
          result.accepted.find(
            (a) => a.uuid === sub.documentUuid || (internalId && a.receiptNumber === internalId)
          ) ?? (result.accepted.length > 0 && result.rejected.length === 0 ? result.accepted[0] : undefined);

        if (matchedAccepted) {
          const finalDocUuid = matchedAccepted.uuid || sub.documentUuid;
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "accepted",
              documentUuid: finalDocUuid,
              submissionUuid: result.submissionUuid ?? sub.submissionUuid,
              requestPayloadJson: payloadToSend,
              responsePayloadJson: result.rawResponse,
              lastError: null,
              nextRetryAt: null,
              attempts: nextAttempts,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(
            sub,
            "accepted",
            result.submissionUuid ?? sub.submissionUuid,
            finalDocUuid
          );
          accepted++;
          processed++;
        } else if (result.rejected.length > 0) {
          const errMsg = result.rejected[0]?.errorMessage || "Rejected by ETA validator";
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "rejected",
              submissionUuid: result.submissionUuid ?? sub.submissionUuid,
              requestPayloadJson: payloadToSend,
              responsePayloadJson: result.rawResponse,
              lastError: errMsg,
              nextRetryAt: null,
              attempts: nextAttempts,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "rejected", result.submissionUuid ?? sub.submissionUuid);
          rejected++;
          processed++;
        } else {
          // Queued asynchronously on ETA side with submissionUuid
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "submitted",
              submissionUuid: result.submissionUuid ?? sub.submissionUuid,
              requestPayloadJson: payloadToSend,
              responsePayloadJson: result.rawResponse,
              lastError: null,
              nextRetryAt: new Date(Date.now() + 30_000),
              attempts: nextAttempts,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "submitted", result.submissionUuid ?? sub.submissionUuid);
          processed++;
        }
      } catch (err) {
        const nextAttempts = sub.attempts + 1;
        const errMsg = err instanceof Error ? err.message : "ETA submission error";
        if (nextAttempts >= MAX_ETA_SUBMISSION_ATTEMPTS) {
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "failed",
              attempts: nextAttempts,
              lastError: errMsg,
              nextRetryAt: null,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "failed");
          failed++;
          processed++;
        } else {
          const delayMs = computeNextEtaRetryDelayMs(nextAttempts);
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "pending",
              attempts: nextAttempts,
              lastError: errMsg,
              nextRetryAt: new Date(Date.now() + delayMs),
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          processed++;
        }
      }
    }

    for (const { sub, invTerminalId, retTerminalId } of dueSubmittedRows) {
      if (!sub.submissionUuid) continue;
      const terminal = terminalMap.get(invTerminalId ?? retTerminalId ?? "");
      const payloadSeller = (sub.requestPayloadJson?.seller ?? {}) as Record<string, unknown>;
      const posSerial =
        terminal?.etaPosSerial ||
        (typeof payloadSeller.deviceSerialNumber === "string" ? payloadSeller.deviceSerialNumber : null);
      const posOsVersion = terminal?.etaPosOsVersion || null;

      try {
        const pollRes =
          sub.documentType === "invoice"
            ? await getEtaDocumentSubmissionStatus(sub.submissionUuid, {
                fetchImpl: opts.fetchImpl,
              })
            : await getEtaSubmissionStatus(sub.submissionUuid, {
                posSerial,
                posOsVersion,
                fetchImpl: opts.fetchImpl,
              });

        if (pollRes.status === "Accepted" || pollRes.status === "Valid") {
          const polledUuid = pollRes.accepted[0]?.uuid || sub.documentUuid;
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "accepted",
              documentUuid: polledUuid,
              responsePayloadJson: pollRes.rawResponse,
              lastError: null,
              nextRetryAt: null,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "accepted", sub.submissionUuid, polledUuid);
          accepted++;
          processed++;
        } else if (pollRes.status === "Invalid" || pollRes.status === "Rejected") {
          const errMsg = pollRes.rejected[0]?.errorMessage || "Rejected by ETA submission status check";
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "rejected",
              responsePayloadJson: pollRes.rawResponse,
              lastError: errMsg,
              nextRetryAt: null,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "rejected", sub.submissionUuid);
          rejected++;
          processed++;
        } else {
          // Still InProgress
          await tx
            .update(einvoiceSubmissions)
            .set({
              responsePayloadJson: pollRes.rawResponse,
              nextRetryAt: new Date(Date.now() + 60_000),
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          processed++;
        }
      } catch (err) {
        const nextAttempts = sub.attempts + 1;
        const errMsg = err instanceof Error ? err.message : "ETA status poll error";
        if (nextAttempts >= MAX_ETA_SUBMISSION_ATTEMPTS) {
          await tx
            .update(einvoiceSubmissions)
            .set({
              status: "failed",
              attempts: nextAttempts,
              lastError: errMsg,
              nextRetryAt: null,
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          await updateLinkedDocStatus(sub, "failed");
          failed++;
          processed++;
        } else {
          const delayMs = computeNextEtaRetryDelayMs(nextAttempts);
          await tx
            .update(einvoiceSubmissions)
            .set({
              attempts: nextAttempts,
              lastError: errMsg,
              nextRetryAt: new Date(Date.now() + delayMs),
              updatedAt: new Date(),
            })
            .where(eq(einvoiceSubmissions.id, sub.id));
          processed++;
        }
      }
    }

    return {
      skipped: false,
      processed,
      accepted,
      rejected,
      failed,
      etaConfigured: true,
    };
  });
}
