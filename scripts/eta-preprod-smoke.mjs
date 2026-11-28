#!/usr/bin/env node
/**
 * ETA Egypt Pre-Production Smoke Test (`npm run eta:preprod-smoke`)
 *
 * Submits a fixed set of 6 sample B2B e-Invoice documents to ETA Preprod when
 * credentials (ETA_CLIENT_ID & ETA_CLIENT_SECRET) are present:
 *   1. standard_invoice    — Standard B2B invoice (14% VAT T1/V009)
 *   2. discounted_invoice  — Invoice with a line discount (10% discount + 14% VAT)
 *   3. multi_vat_invoice   — Invoice with multiple VAT rates (14% V009 + 5% V008)
 *   4. zero_rated_invoice  — Invoice with a zero-rated line (0% T1/V001)
 *   5. exempt_invoice      — Invoice with a VAT-exempt line (0% T1/V003)
 *   6. credit_note         — Credit note ('C') referencing the standard invoice UUID
 *
 * Prints ETA's validation errors clearly (including nested details[]) and exits
 * non-zero on any rejection, mock-signature refusal, or HTTP error.
 *
 * Flags:
 *   --dry-run              Build and print all 6 canonical payloads without contacting ETA
 *   --require-credentials  Exit non-zero if ETA_CLIENT_ID / ETA_CLIENT_SECRET are missing
 *   --allow-prod           Override safety guard blocking production ETA URLs (not recommended)
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const STRICT_BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function serializeEtaCanonical(node) {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return `"${String(node)}"`;
  if (Array.isArray(node)) return node.map((i) => serializeEtaCanonical(i)).join("");
  let result = "";
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null || key === "signatures") continue;
    const upperKey = `"${key.toUpperCase()}"`;
    if (Array.isArray(value)) {
      result += upperKey;
      for (const item of value) {
        result += upperKey + serializeEtaCanonical(item);
      }
    } else if (typeof value === "object") {
      result += upperKey + serializeEtaCanonical(value);
    } else {
      result += upperKey + `"${String(value)}"`;
    }
  }
  return result;
}

export function computeCanonicalDigest(doc) {
  const canonicalString = serializeEtaCanonical(doc);
  const canonicalSha256 = createHash("sha256").update(canonicalString, "utf8").digest("hex");
  return { canonicalString, canonicalSha256 };
}

export function validateRealCadesSignature(sigValue) {
  const value = String(sigValue ?? "").trim();
  if (!value || value.length < 44) return false;
  if (/^mock/i.test(value) || /mock[_-]?sig/i.test(value)) return false;
  if (!STRICT_BASE64_REGEX.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length >= 32 && decoded[0] === 0x30;
}

function round5(n) {
  return Number(Number(n).toFixed(5));
}

function buildB2bDoc({
  internalID,
  documentType = "I",
  documentTypeVersion,
  dateTimeIssued,
  issuerRin,
  issuerName,
  branchID,
  activityCode,
  receiverRin,
  receiverName,
  references,
  lines,
}) {
  let totalSalesAmount = 0;
  let totalDiscountAmount = 0;
  let netAmount = 0;
  const taxTotalsByType = new Map();

  const invoiceLines = lines.map((line) => {
    const qty = round5(line.quantity);
    const unitEgp = round5(line.unitPrice);
    const salesTotal = round5(qty * unitEgp);
    const discountAmount = round5(line.discountAmount ?? 0);
    const discountRate =
      salesTotal > 0 && discountAmount > 0 ? Number(((discountAmount / salesTotal) * 100).toFixed(2)) : 0;
    const netTotal = round5(Math.max(0, salesTotal - discountAmount));
    const taxRate = Number(line.taxRate ?? 0);
    const taxAmount = round5((netTotal * taxRate) / 100);
    const lineTotal = round5(netTotal + taxAmount);

    totalSalesAmount = round5(totalSalesAmount + salesTotal);
    totalDiscountAmount = round5(totalDiscountAmount + discountAmount);
    netAmount = round5(netAmount + netTotal);

    const taxType = line.taxType || "T1";
    const subType = line.taxSubType || "V009";
    taxTotalsByType.set(taxType, round5((taxTotalsByType.get(taxType) ?? 0) + taxAmount));

    return {
      description: line.description,
      itemType: line.itemType || "EGS",
      itemCode: line.itemCode,
      unitType: line.unitType || "EA",
      quantity: qty,
      internalCode: line.internalCode,
      salesTotal,
      total: lineTotal,
      valueDifference: 0,
      totalTaxableFees: 0,
      netTotal,
      itemsDiscount: 0,
      unitValue: {
        currencySold: "EGP",
        amountEGP: unitEgp,
      },
      discount: {
        rate: discountRate,
        amount: discountAmount,
      },
      taxableItems: [
        {
          taxType,
          amount: taxAmount,
          subType,
          rate: Number(taxRate.toFixed(2)),
        },
      ],
    };
  });

  const taxTotals = Array.from(taxTotalsByType.entries()).map(([taxType, amount]) => ({
    taxType,
    amount: round5(amount),
  }));
  const totalTax = taxTotals.reduce((acc, t) => round5(acc + t.amount), 0);
  const totalAmount = round5(netAmount + totalTax);

  return {
    issuer: {
      address: {
        branchID: branchID || "0",
        country: "EG",
        governate: "Cairo",
        regionCity: "New Cairo",
        street: "90th North Street",
        buildingNumber: "10",
      },
      type: "B",
      id: issuerRin,
      name: issuerName,
    },
    receiver: {
      address: {
        country: "EG",
        governate: "Cairo",
        regionCity: "Nasr City",
        street: "Abbas El Akkad St",
        buildingNumber: "12",
      },
      type: "B",
      id: receiverRin,
      name: receiverName,
    },
    documentType,
    documentTypeVersion,
    dateTimeIssued,
    taxpayerActivityCode: activityCode || "4690",
    internalID,
    ...(references && references.length > 0 ? { references } : {}),
    invoiceLines,
    totalDiscountAmount,
    totalSalesAmount,
    netAmount,
    taxTotals,
    totalAmount,
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
  };
}

/**
 * Builds the 6 fixed ETA preprod smoke test documents:
 *   1. standard_invoice    (14% VAT T1/V009)
 *   2. discounted_invoice  (10% line discount + 14% VAT T1/V009)
 *   3. multi_vat_invoice   (14% T1/V009 + 5% T1/V008)
 *   4. zero_rated_invoice  (0% zero-rated T1/V001)
 *   5. exempt_invoice      (0% VAT-exempt T1/V003)
 *   6. credit_note         (documentType 'C' referencing standard_invoice UUID)
 */
export function buildPreprodSmokeDocuments({
  runId = Date.now().toString(36).toUpperCase(),
  dateTimeIssued = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  documentTypeVersion = "1.0",
  issuerRin = "100000001",
  issuerName = "Count It Keep It ERP Preprod Test",
  branchID = "0",
  activityCode = "4690",
  receiverRin = "200000002",
  receiverName = "Preprod Sample Buyer SAE",
  itemCodeStandard = `EG-${issuerRin}-SMOKE1`,
  itemCodeReduced = `EG-${issuerRin}-SMOKE2`,
  itemCodeZeroRated = `EG-${issuerRin}-SMOKE3`,
  itemCodeExempt = `EG-${issuerRin}-SMOKE4`,
  standardInvoiceReferenceUuid = null,
} = {}) {
  const base = {
    documentTypeVersion,
    dateTimeIssued,
    issuerRin,
    issuerName,
    branchID,
    activityCode,
    receiverRin,
    receiverName,
  };

  const standardInvoice = buildB2bDoc({
    ...base,
    internalID: `SMOKE-STD-${runId}`,
    documentType: "I",
    lines: [
      {
        description: "Standard 14% VAT Industrial Component",
        internalCode: "SMOKE-STD-1",
        itemCode: itemCodeStandard,
        quantity: 2,
        unitPrice: 500,
        taxRate: 14,
        taxSubType: "V009",
      },
    ],
  });

  const discountedInvoice = buildB2bDoc({
    ...base,
    internalID: `SMOKE-DISC-${runId}`,
    documentType: "I",
    lines: [
      {
        description: "Discounted Industrial Component (10% line discount)",
        internalCode: "SMOKE-DISC-1",
        itemCode: itemCodeStandard,
        quantity: 4,
        unitPrice: 500,
        discountAmount: 200,
        taxRate: 14,
        taxSubType: "V009",
      },
    ],
  });

  const multiVatInvoice = buildB2bDoc({
    ...base,
    internalID: `SMOKE-MVAT-${runId}`,
    documentType: "I",
    lines: [
      {
        description: "Standard 14% VAT Line",
        internalCode: "SMOKE-STD-1",
        itemCode: itemCodeStandard,
        quantity: 1,
        unitPrice: 1000,
        taxRate: 14,
        taxSubType: "V009",
      },
      {
        description: "Reduced 5% VAT Machinery Line",
        internalCode: "SMOKE-RED-5",
        itemCode: itemCodeReduced,
        quantity: 1,
        unitPrice: 2000,
        taxRate: 5,
        taxSubType: "V008",
      },
    ],
  });

  const zeroRatedInvoice = buildB2bDoc({
    ...base,
    internalID: `SMOKE-ZERO-${runId}`,
    documentType: "I",
    lines: [
      {
        description: "Zero-Rated Export Goods (0% V001)",
        internalCode: "SMOKE-ZERO-1",
        itemCode: itemCodeZeroRated,
        quantity: 1,
        unitPrice: 1500,
        taxRate: 0,
        taxSubType: "V001",
      },
    ],
  });

  const exemptInvoice = buildB2bDoc({
    ...base,
    internalID: `SMOKE-EXEMPT-${runId}`,
    documentType: "I",
    lines: [
      {
        description: "VAT-Exempt Goods/Services (0% V003)",
        internalCode: "SMOKE-EXEMPT-1",
        itemCode: itemCodeExempt,
        quantity: 1,
        unitPrice: 800,
        taxRate: 0,
        taxSubType: "V003",
      },
    ],
  });

  const stdDigest = computeCanonicalDigest(standardInvoice).canonicalSha256;
  const creditNote = buildB2bDoc({
    ...base,
    internalID: `SMOKE-CN-${runId}`,
    documentType: "C",
    references: [standardInvoiceReferenceUuid || stdDigest],
    lines: [
      {
        description: "Credit Note Return for Standard 14% VAT Component",
        internalCode: "SMOKE-STD-1",
        itemCode: itemCodeStandard,
        quantity: 1,
        unitPrice: 500,
        taxRate: 14,
        taxSubType: "V009",
      },
    ],
  });

  return [
    { caseName: "standard_invoice", document: standardInvoice },
    { caseName: "discounted_invoice", document: discountedInvoice },
    { caseName: "multi_vat_invoice", document: multiVatInvoice },
    { caseName: "zero_rated_invoice", document: zeroRatedInvoice },
    { caseName: "exempt_invoice", document: exemptInvoice },
    { caseName: "credit_note", document: creditNote },
  ];
}

export function formatEtaValidationErrors(rejectedDocs) {
  if (!Array.isArray(rejectedDocs) || rejectedDocs.length === 0) return [];
  const lines = [];
  for (const doc of rejectedDocs) {
    const id = doc.internalId ?? doc.receiptNumber ?? doc.uuid ?? "unknown";
    const err = doc.error ?? doc;
    const details = Array.isArray(err?.details) ? err.details : [];
    if (details.length > 0) {
      for (const d of details) {
        const code = d?.code ? `[${d.code}] ` : "";
        const loc = d?.propertyPath || d?.target || "";
        const msg = d?.message || err?.message || "Validation error";
        lines.push(`${id}: ${code}${loc ? `${loc} — ` : ""}${msg}`);
      }
    } else {
      const code = err?.code ? `[${err.code}] ` : "";
      const msg = err?.message || err?.error || JSON.stringify(err);
      lines.push(`${id}: ${code}${msg}`);
    }
  }
  return lines;
}

async function signDocumentIfV1(doc, { signerUrl, signerToken, timeoutMs = 10_000, fetchImpl = fetch }) {
  if (doc.documentTypeVersion === "0.9") {
    return doc;
  }
  if (!signerUrl) {
    throw new Error(
      "ETA_INVOICE_VERSION=1.0 requires ETA_SIGNER_URL pointing to a real CAdES-BES signer (or set ETA_INVOICE_VERSION=0.9 for unsigned preprod smoke tests)."
    );
  }
  const { canonicalString, canonicalSha256 } = computeCanonicalDigest(doc);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (signerToken) headers.Authorization = `Bearer ${signerToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(signerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ canonicalString, canonicalSha256, document: doc }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Signer bridge failed (HTTP ${res.status}): ${parsed?.error || parsed?.message || "unknown error"}`);
  }
  const mockHeader = (res.headers.get("x-eta-mock-signer") ?? "").trim().toLowerCase();
  if (mockHeader === "true" || mockHeader === "1" || parsed.isMock === true || parsed.signerKind === "mock") {
    throw new Error("Refused mock signature from development signer — a real CAdES-BES signature is required for ETA submission.");
  }
  const sigValue = String(parsed.value ?? parsed.signatureValue ?? parsed.signature ?? "").trim();
  if (!validateRealCadesSignature(sigValue)) {
    throw new Error("Refused invalid or mock signature from signer bridge (expected Base64 ASN.1 DER CMS signature).");
  }
  return {
    ...doc,
    signatures: [{ signatureType: parsed.signatureType === "S" ? "S" : "I", value: sigValue }],
  };
}

export async function runEtaPreprodSmoke({
  envVars = process.env,
  dryRun = false,
  requireCredentials = false,
  allowProd = false,
  fetchImpl = fetch,
} = {}) {
  const clientId = (envVars.ETA_CLIENT_ID ?? "").trim();
  const clientSecret = (envVars.ETA_CLIENT_SECRET ?? "").trim();
  const idBaseUrl = (envVars.ETA_ID_BASE_URL ?? "https://id.preprod.eta.gov.eg").trim().replace(/\/+$/, "");
  const tokenUrl = (envVars.ETA_TOKEN_URL ?? `${idBaseUrl}/connect/token`).trim();
  const apiBaseUrl = (envVars.ETA_API_BASE_URL ?? "https://api.preprod.invoicing.eta.gov.eg").trim().replace(/\/+$/, "");
  const invoiceVersion = (envVars.ETA_INVOICE_VERSION ?? "1.0").trim() === "0.9" ? "0.9" : "1.0";
  const signerUrl = (envVars.ETA_SIGNER_URL ?? "").trim().replace(/\/+$/, "");
  const signerToken = (envVars.ETA_SIGNER_TOKEN ?? "").trim();
  const issuerRin = (envVars.ETA_ISSUER_RIN ?? "100000001").trim();
  const receiverRin = (envVars.ETA_PREPROD_RECEIVER_RIN ?? "200000002").trim();

  const isProdTarget =
    /id\.eta\.gov\.eg/i.test(tokenUrl) || /api\.invoicing\.eta\.gov\.eg/i.test(apiBaseUrl);
  if (isProdTarget && !allowProd && !dryRun) {
    throw new Error(
      "Refusing to run eta:preprod-smoke against ETA Production URLs. Point ETA_ID_BASE_URL/ETA_API_BASE_URL to preprod or pass --allow-prod explicitly."
    );
  }

  const allCases = buildPreprodSmokeDocuments({
    documentTypeVersion: invoiceVersion,
    issuerRin,
    receiverRin,
    itemCodeStandard: envVars.ETA_PREPROD_ITEM_STANDARD || undefined,
    itemCodeReduced: envVars.ETA_PREPROD_ITEM_REDUCED || undefined,
    itemCodeZeroRated: envVars.ETA_PREPROD_ITEM_ZERO_RATED || undefined,
    itemCodeExempt: envVars.ETA_PREPROD_ITEM_EXEMPT || undefined,
  });

  if (dryRun) {
    return {
      ok: true,
      mode: "dry_run",
      skipped: false,
      invoiceVersion,
      cases: allCases.map((c) => ({
        caseName: c.caseName,
        internalID: c.document.internalID,
        documentType: c.document.documentType,
        totalAmount: c.document.totalAmount,
        canonicalSha256: computeCanonicalDigest(c.document).canonicalSha256,
      })),
    };
  }

  if (!clientId || !clientSecret) {
    if (requireCredentials) {
      throw new Error("ETA_CLIENT_ID and ETA_CLIENT_SECRET are required when --require-credentials is set.");
    }
    return {
      ok: true,
      mode: "skipped_unconfigured",
      skipped: true,
      reason:
        "ETA_CLIENT_ID and ETA_CLIENT_SECRET are not set. Configure ETA preprod credentials (see docs/ETA_GO_LIVE.md) to submit the 6 smoke documents.",
      casesCount: allCases.length,
    };
  }

  // 1. Acquire ETA Preprod OAuth2 access token
  const tokenRes = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "InvoicingAPI",
    }).toString(),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new Error(
      `ETA OAuth2 token acquisition failed (HTTP ${tokenRes.status}): ${tokenJson?.error_description || tokenJson?.error || "unknown error"}`
    );
  }
  const accessToken = tokenJson.access_token;

  const submitBatch = async (docs) => {
    const res = await fetchImpl(`${apiBaseUrl}/api/v1/documentsubmissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ documents: docs }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errs = formatEtaValidationErrors([{ internalId: "batch", error: json?.error ?? json }]);
      throw new Error(`ETA /api/v1/documentsubmissions HTTP ${res.status}: ${errs.join("; ")}`);
    }
    return json;
  };

  // 2. Sign & submit the 5 invoice cases first so we get ETA's UUID for the standard invoice
  const invoiceCases = allCases.slice(0, 5);
  const signedInvoices = [];
  for (const c of invoiceCases) {
    signedInvoices.push(await signDocumentIfV1(c.document, { signerUrl, signerToken, fetchImpl }));
  }
  const invBatchRes = await submitBatch(signedInvoices);
  const accepted = [...(invBatchRes.acceptedDocuments ?? [])];
  const rejected = [...(invBatchRes.rejectedDocuments ?? [])];

  // 3. Build, sign & submit the credit note referencing the accepted standard invoice UUID
  const stdInternalId = invoiceCases[0].document.internalID;
  const acceptedStd = accepted.find((a) => a.internalId === stdInternalId);
  const creditNoteCase = allCases[5];
  const creditNoteDoc = {
    ...creditNoteCase.document,
    references: [acceptedStd?.uuid || creditNoteCase.document.references[0]],
  };
  const signedCn = await signDocumentIfV1(creditNoteDoc, { signerUrl, signerToken, fetchImpl });
  const cnBatchRes = await submitBatch([signedCn]);
  accepted.push(...(cnBatchRes.acceptedDocuments ?? []));
  rejected.push(...(cnBatchRes.rejectedDocuments ?? []));

  const formattedErrors = formatEtaValidationErrors(rejected);
  return {
    ok: rejected.length === 0 && accepted.length === allCases.length,
    mode: "submitted",
    skipped: false,
    invoiceVersion,
    submittedCount: allCases.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    accepted: accepted.map((a) => ({ internalId: a.internalId, uuid: a.uuid, longId: a.longId ?? null })),
    rejectedErrors: formattedErrors,
  };
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  dotenv.config({ path: path.resolve(repoRoot, "backend/.env") });
  const args = new Set(process.argv.slice(2));
  if (args.has("-h") || args.has("--help")) {
    console.log("Usage: npm run eta:preprod-smoke -- [--dry-run] [--require-credentials] [--allow-prod]");
    process.exit(0);
  }

  runEtaPreprodSmoke({
    dryRun: args.has("--dry-run"),
    requireCredentials: args.has("--require-credentials"),
    allowProd: args.has("--allow-prod"),
  })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      if (res.skipped) {
        console.log(`\n[eta:preprod-smoke] SKIPPED: ${res.reason}`);
        return;
      }
      if (!res.ok) {
        console.error("\n[eta:preprod-smoke] ETA VALIDATION REJECTIONS:");
        for (const line of res.rejectedErrors ?? []) {
          console.error(`  - ${line}`);
        }
        process.exit(1);
      }
      console.log(`\n[eta:preprod-smoke] SUCCESS (${res.mode})`);
    })
    .catch((err) => {
      console.error(`[eta:preprod-smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
