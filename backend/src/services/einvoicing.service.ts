import { createHash } from "node:crypto";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import { companySettings, salesInvoices } from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { num } from "../db/helpers.ts";

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
 * Computes ICV sequence, chained SHA-256 hash, and TLV QR code for posted sales invoices
 * whenever companySettings.einvoicingMode !== 'none'.
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
}> {
  const [company] = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
  if (!company || company.einvoicingMode === "none") {
    return {
      eInvoiceStatus: "not_applicable",
      icv: null,
      invoiceHash: null,
      prevInvoiceHash: null,
      qrTlv: null,
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
    };
  }

  const [{ maxIcv }] = await tx
    .select({ maxIcv: sql<number>`coalesce(max(${salesInvoices.icv}), 0)::int` })
    .from(salesInvoices);
  const lastHashed = await tx
    .select({ invoiceHash: salesInvoices.invoiceHash })
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
  };
}
