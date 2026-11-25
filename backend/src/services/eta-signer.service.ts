import { createHash } from "node:crypto";
import type { EtaInvoiceVersion, EtaSignatureStatus } from "@erp/shared";
import { env } from "../config.ts";
import { createModuleLogger } from "../logging/logger.ts";

const log = createModuleLogger("eta-signer");

export class EtaSignerError extends Error {
  public readonly statusCode: number;
  public readonly retryable: boolean;

  constructor(message: string, statusCode = 502, retryable = true) {
    super(message);
    this.name = "EtaSignerError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Canonicalizes an ETA Egypt e-Invoice v1.0 / e-Receipt v1.2 JSON object
 * per Egyptian Tax Authority canonical serialization rules (excluding `signatures` when signing).
 */
export function serializeEtaCanonicalForSigning(
  node: unknown,
  opts: { excludeSignatures?: boolean } = { excludeSignatures: true }
): string {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") {
    return `"${String(node)}"`;
  }
  if (Array.isArray(node)) {
    return node.map((item) => serializeEtaCanonicalForSigning(item, opts)).join("");
  }

  let result = "";
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (opts.excludeSignatures && key === "signatures") continue;
    const upperKey = `"${key.toUpperCase()}"`;
    if (Array.isArray(value)) {
      result += upperKey;
      for (const item of value) {
        result += upperKey;
        result += serializeEtaCanonicalForSigning(item, opts);
      }
    } else if (typeof value === "object") {
      result += upperKey;
      result += serializeEtaCanonicalForSigning(value, opts);
    } else {
      result += upperKey;
      result += `"${String(value)}"`;
    }
  }
  return result;
}

export function computeEtaDocumentCanonicalDigest(document: Record<string, unknown>): {
  canonicalString: string;
  canonicalSha256: string;
} {
  const canonicalString = serializeEtaCanonicalForSigning(document, { excludeSignatures: true });
  const canonicalSha256 = createHash("sha256").update(canonicalString, "utf8").digest("hex");
  return { canonicalString, canonicalSha256 };
}

export function resolveEtaInvoiceVersion(): EtaInvoiceVersion {
  const raw = (process.env.ETA_INVOICE_VERSION ?? env.ETA_INVOICE_VERSION ?? "").trim();
  return raw === "0.9" ? "0.9" : "1.0";
}

export function resolveEtaSignerUrl(): string {
  return (process.env.ETA_SIGNER_URL ?? env.ETA_SIGNER_URL ?? "").trim().replace(/\/+$/, "");
}

export function isEtaSignerConfigured(): boolean {
  return resolveEtaSignerUrl().length > 0;
}

export interface EtaSignerOptions {
  fetchImpl?: typeof fetch;
  signerUrl?: string;
  signerToken?: string;
  timeoutMs?: number;
}

export interface EtaSignDocumentResult {
  signed: boolean;
  signatureStatus: EtaSignatureStatus;
  document: Record<string, unknown>;
  canonicalString: string;
  canonicalSha256: string;
  pendingReason?: string;
}

/**
 * Signs an ETA Egypt B2B e-Invoice (`I` / `C` / `D`) via an external HTTP CAdES-BES token bridge
 * when `documentTypeVersion === "1.0"`, or passes through unsigned when `"0.9"` (preprod).
 */
export async function signEtaInvoiceIfNeeded(
  rawDocument: Record<string, unknown>,
  opts?: EtaSignerOptions
): Promise<EtaSignDocumentResult> {
  const docClone = structuredClone(rawDocument);
  const { canonicalString, canonicalSha256 } = computeEtaDocumentCanonicalDigest(docClone);

  const version =
    typeof docClone.documentTypeVersion === "string"
      ? docClone.documentTypeVersion.trim()
      : resolveEtaInvoiceVersion();

  if (version === "0.9") {
    delete docClone.signatures;
    return {
      signed: false,
      signatureStatus: "unsigned_v0_9",
      document: docClone,
      canonicalString,
      canonicalSha256,
    };
  }

  const existingSigs = Array.isArray(docClone.signatures) ? docClone.signatures : [];
  const hasExistingSig = existingSigs.some(
    (s) =>
      Boolean(s && typeof s === "object") &&
      typeof (s as Record<string, unknown>).value === "string" &&
      ((s as Record<string, unknown>).value as string).trim().length > 0
  );
  if (hasExistingSig) {
    return {
      signed: true,
      signatureStatus: "signed",
      document: docClone,
      canonicalString,
      canonicalSha256,
    };
  }

  const signerUrl = (opts?.signerUrl ?? resolveEtaSignerUrl()).trim();
  if (!signerUrl) {
    return {
      signed: false,
      signatureStatus: "pending_signature",
      document: docClone,
      canonicalString,
      canonicalSha256,
      pendingReason:
        "ETA e-Invoice v1.0 CAdES-BES signer (ETA_SIGNER_URL) is not configured; configure ETA_SIGNER_URL or set ETA_INVOICE_VERSION=0.9 for preprod.",
    };
  }

  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const signerToken = (opts?.signerToken ?? process.env.ETA_SIGNER_TOKEN ?? env.ETA_SIGNER_TOKEN ?? "").trim();
  const timeoutMs = opts?.timeoutMs ?? env.ETA_SIGNER_TIMEOUT_MS ?? 10_000;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (signerToken) {
    headers.Authorization = `Bearer ${signerToken}`;
  }

  const docWithoutSigs = structuredClone(docClone);
  delete docWithoutSigs.signatures;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(signerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        canonicalString,
        canonicalSha256,
        document: docWithoutSigs,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reach ETA CAdES-BES signer";
    log.warn({ err }, "eta.signer.unreachable");
    throw new EtaSignerError(`ETA CAdES-BES signer request failed: ${msg}`, 503, true);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let parsed: Record<string, unknown> = {};
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = { raw: rawText };
    }
  }

  if (!response.ok) {
    const errMsg =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : `Signer returned HTTP ${response.status}`;
    log.warn({ statusCode: response.status }, "eta.signer.rejected");
    throw new EtaSignerError(
      `ETA CAdES-BES signer failed (${response.status}): ${errMsg}`,
      response.status,
      response.status >= 500 || response.status === 429
    );
  }

  const sigValue =
    typeof parsed.value === "string"
      ? parsed.value.trim()
      : typeof parsed.signatureValue === "string"
        ? parsed.signatureValue.trim()
        : typeof parsed.signature === "string"
          ? parsed.signature.trim()
          : "";
  if (!sigValue) {
    throw new EtaSignerError("ETA CAdES-BES signer response did not contain a signature value", 502, true);
  }

  const signatureType = parsed.signatureType === "S" ? "S" : "I";
  docClone.signatures = [{ signatureType, value: sigValue }];

  return {
    signed: true,
    signatureStatus: "signed",
    document: docClone,
    canonicalString,
    canonicalSha256,
  };
}
