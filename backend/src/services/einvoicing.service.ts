import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  branches,
  companySettings,
  customers,
  einvoiceSubmissions,
  posTerminals,
  salesInvoiceLines,
  salesInvoices,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { env } from "../config.ts";
import { num } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { createModuleLogger } from "../logging/logger.ts";

const log = createModuleLogger("einvoicing");

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

export interface EtaReceiptBuildInput {
  receiptNumber: string;
  dateTimeIssuedIso: string;
  previousUuid: string;
  currency: string;
  sellerName: string;
  sellerTaxNumber: string;
  branchCode: string;
  branchAddress: string;
  posSerialNumber: string;
  buyerName: string;
  buyerTaxNumber?: string;
  paymentMethod: "C" | "V" | "CC" | "O";
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  lines: Array<{
    description: string;
    itemCode: string;
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
  const basePayload: Record<string, unknown> = {
    header: {
      dateTimeIssued,
      receiptNumber: input.receiptNumber,
      uuid: "",
      previousUUID: input.previousUuid,
      currency: input.currency || "EGP",
      orderdeliveryMode: "FC",
    },
    documentType: {
      receiptType: "S",
      typeVersion: "1.2",
    },
    seller: {
      rin: input.sellerTaxNumber || "000000000",
      companyTradeName: input.sellerName,
      branchCode: input.branchCode || "0",
      branchAddress: {
        country: "EG",
        governate: "Cairo",
        regionCity: "Cairo",
        street: input.branchAddress || "Main Branch",
        buildingNumber: "1",
      },
      deviceSerialNumber: input.posSerialNumber || "POS-DEV-01",
      activityCode: "4711",
    },
    buyer: {
      type: input.buyerTaxNumber ? "B" : "P",
      id: input.buyerTaxNumber || "",
      name: input.buyerName || "Walk-in Customer",
    },
    itemData: input.lines.map((line) => {
      const netSale = Math.max(0, Number((line.lineTotal - line.taxAmount).toFixed(5)));
      return {
        internalCode: line.itemCode || "ITEM",
        description: line.description || "POS Item",
        itemType: "EGS",
        itemCode: line.itemCode || "EG-000000000-ITEM",
        unitType: "EA",
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

/**
 * Computes ICV sequence, chained SHA-256 hash, ZATCA TLV QR or ETA Egypt e-Receipt v1.2 payload
 * & submission queue entry whenever companySettings.einvoicingMode !== 'none'.
 */
export async function applyInvoiceEInvoiceMetadata(
  tx: DbOrTx,
  invoiceId: string
): Promise<{
  eInvoiceStatus: string;
  icv: number | null;
  invoiceHash: string | null;
  prevInvoiceHash: string | null;
  qrTlv: string | null;
  etaDocumentUuid: string | null;
  etaReceiptStatus: string;
}> {
  const [company] = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
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

  const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, invoiceId)).limit(1);
  if (!inv) {
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

  // Serialize ICV + prevInvoiceHash allocation across concurrent ERP/POS checkouts
  await tx.execute(sql`SELECT pg_advisory_xact_lock(882411)`);

  const [{ maxIcv }] = await tx
    .select({ maxIcv: sql<number>`coalesce(max(${salesInvoices.icv}), 0)::int` })
    .from(salesInvoices);
  const lastHashed = await tx
    .select({
      invoiceHash: salesInvoices.invoiceHash,
      etaDocumentUuid: salesInvoices.etaDocumentUuid,
    })
    .from(salesInvoices)
    .where(isNotNull(salesInvoices.invoiceHash))
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
    const [branchRow] = await tx.select().from(branches).where(eq(branches.id, inv.branchId)).limit(1);
    const [custRow] = await tx.select().from(customers).where(eq(customers.id, inv.customerId)).limit(1);
    const [termRow] = inv.posTerminalId
      ? await tx.select().from(posTerminals).where(eq(posTerminals.id, inv.posTerminalId)).limit(1)
      : [undefined];
    const lines = await tx.select().from(salesInvoiceLines).where(eq(salesInvoiceLines.invoiceId, inv.id));

    const { payload, etaUuid, qrUrl } = buildEtaEgyptReceiptPayload({
      receiptNumber: inv.invoiceNumber,
      dateTimeIssuedIso: timestampIso,
      previousUuid: lastHashed[0]?.etaDocumentUuid ?? "",
      currency: inv.currency || company.baseCurrency || "EGP",
      sellerName,
      sellerTaxNumber: taxNumber,
      branchCode: branchRow?.code ?? "0",
      branchAddress: branchRow?.address || branchRow?.location || company.address || "Main Branch",
      posSerialNumber: termRow?.etaPosSerial || termRow?.code || "POS-01",
      buyerName: custRow?.name || "Walk-in Customer",
      buyerTaxNumber: custRow?.taxNumber || undefined,
      paymentMethod: "C",
      subtotal: num(inv.subtotal),
      taxTotal: num(inv.taxTotal),
      totalAmount: num(inv.totalAmount),
      lines: lines.map((l) => ({
        description: l.description || "Item",
        itemCode: l.productId ?? l.id,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice),
        taxRate: num(l.taxRate),
        taxAmount: num(l.taxAmount),
        lineTotal: num(l.lineTotal),
      })),
    });

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
      .where(eq(salesInvoices.id, invoiceId));

    await tx
      .insert(einvoiceSubmissions)
      .values({
        invoiceId: inv.id,
        provider: "eta_egypt",
        documentType: inv.sourceChannel === "pos" ? "receipt" : "invoice",
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
    .where(eq(salesInvoices.id, invoiceId));

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

/**
 * Background submission worker scaffold for Egyptian Tax Authority (ETA e-Receipt v1.2).
 * Safely no-ops until ETA_CLIENT_ID and ETA_CLIENT_SECRET are configured.
 */
export async function processPendingEtaSubmissions(db: AppDatabase, batchLimit = 25): Promise<{
  processed: number;
  skipped: boolean;
}> {
  if (!env.ETA_CLIENT_ID || !env.ETA_CLIENT_SECRET) {
    log.debug("eta.worker.skipped_unconfigured");
    return { processed: 0, skipped: true };
  }

  const now = new Date();
  const pending = await db
    .select()
    .from(einvoiceSubmissions)
    .where(
      and(
        eq(einvoiceSubmissions.provider, "eta_egypt"),
        or(eq(einvoiceSubmissions.status, "pending"), eq(einvoiceSubmissions.status, "failed")),
        or(sql`${einvoiceSubmissions.nextRetryAt} IS NULL`, lte(einvoiceSubmissions.nextRetryAt, now))
      )
    )
    .limit(batchLimit);

  if (pending.length === 0) {
    return { processed: 0, skipped: false };
  }

  log.info({ count: pending.length, etaBaseUrl: env.ETA_API_BASE_URL }, "eta.worker.batch_ready");
  return { processed: 0, skipped: false };
}
