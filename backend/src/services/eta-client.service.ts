import { env } from "../config.ts";
import { createModuleLogger } from "../logging/logger.ts";

const log = createModuleLogger("eta-client");

export class EtaClientError extends Error {
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly responseBody?: unknown;

  constructor(message: string, statusCode = 500, retryable = true, responseBody?: unknown) {
    super(message);
    this.name = "EtaClientError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.responseBody = responseBody;
  }
}

export interface EtaClientOptions {
  posSerial?: string | null;
  posOsVersion?: string | null;
  fetchImpl?: typeof fetch;
}

export interface EtaAcceptedDocument {
  uuid: string;
  longId: string | null;
  receiptNumber: string | null;
  hashKey: string | null;
}

export interface EtaRejectedDocument {
  uuid: string | null;
  receiptNumber: string | null;
  errorMessage: string;
  rawError: unknown;
}

export interface EtaReceiptSubmissionResult {
  submissionUuid: string | null;
  accepted: EtaAcceptedDocument[];
  rejected: EtaRejectedDocument[];
  rawResponse: Record<string, unknown>;
}

export type EtaRemoteSubmissionStatus = "Accepted" | "Valid" | "Invalid" | "Rejected" | "InProgress";

export interface EtaSubmissionStatusResult {
  submissionUuid: string;
  status: EtaRemoteSubmissionStatus;
  accepted: EtaAcceptedDocument[];
  rejected: EtaRejectedDocument[];
  rawResponse: Record<string, unknown>;
}

interface CachedTokenEntry {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedTokenEntry>();

export function clearEtaTokenCache(): void {
  tokenCache.clear();
}

export function isEtaConfigured(): boolean {
  const clientId = (env.ETA_CLIENT_ID || process.env.ETA_CLIENT_ID || "").trim();
  const clientSecret = (env.ETA_CLIENT_SECRET || process.env.ETA_CLIENT_SECRET || "").trim();
  return clientId.length > 0 && clientSecret.length > 0;
}

function resolveEtaTokenUrl(): string {
  if (env.ETA_TOKEN_URL && env.ETA_TOKEN_URL.trim().length > 0) {
    return env.ETA_TOKEN_URL.trim();
  }
  const idBase = (env.ETA_ID_BASE_URL || "https://id.preprod.eta.gov.eg").trim().replace(/\/+$/, "");
  return `${idBase}/connect/token`;
}

function resolveEtaApiBaseUrl(): string {
  return (env.ETA_API_BASE_URL || "https://api.preprod.invoicing.eta.gov.eg").trim().replace(/\/+$/, "");
}

function extractEtaErrorDetails(errorObj: unknown): string {
  if (!errorObj || typeof errorObj !== "object") {
    return typeof errorObj === "string" && errorObj.trim() ? errorObj.trim() : "Rejected by ETA validator";
  }
  const err = errorObj as Record<string, unknown>;
  const details = Array.isArray(err.details) ? err.details : [];
  const detailMessages = details
    .map((d) => {
      if (!d || typeof d !== "object") return null;
      const item = d as Record<string, unknown>;
      const msg = typeof item.message === "string" ? item.message.trim() : "";
      const target = typeof item.target === "string" ? item.target.trim() : "";
      const prop = typeof item.propertyPath === "string" ? item.propertyPath.trim() : "";
      const prefix = prop || target;
      return msg ? (prefix ? `${prefix}: ${msg}` : msg) : null;
    })
    .filter((m): m is string => Boolean(m));

  if (detailMessages.length > 0) {
    return detailMessages.join("; ");
  }
  if (typeof err.message === "string" && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err.error === "string" && err.error.trim()) {
    return err.error.trim();
  }
  return "Rejected by ETA validator";
}

function parseAcceptedDocuments(rawDocs: unknown): EtaAcceptedDocument[] {
  if (!Array.isArray(rawDocs)) return [];
  return rawDocs
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
    .map((d) => ({
      uuid: typeof d.uuid === "string" ? d.uuid : "",
      longId: typeof d.longId === "string" ? d.longId : null,
      receiptNumber: typeof d.receiptNumber === "string" ? d.receiptNumber : null,
      hashKey: typeof d.hashKey === "string" ? d.hashKey : null,
    }))
    .filter((d) => d.uuid.length > 0);
}

function parseRejectedDocuments(rawDocs: unknown): EtaRejectedDocument[] {
  if (!Array.isArray(rawDocs)) return [];
  return rawDocs
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
    .map((d) => ({
      uuid: typeof d.uuid === "string" ? d.uuid : null,
      receiptNumber: typeof d.receiptNumber === "string" ? d.receiptNumber : null,
      errorMessage: extractEtaErrorDetails(d.error ?? d),
      rawError: d.error ?? d,
    }));
}

/**
 * Acquires and caches an OAuth2 access token from the Egyptian Tax Authority identity server.
 * Caches token in memory until `expires_in - 60` seconds per POS device header combination.
 */
export async function getEtaAccessToken(opts?: EtaClientOptions): Promise<string> {
  if (!isEtaConfigured()) {
    throw new EtaClientError("ETA Egypt credentials (ETA_CLIENT_ID / ETA_CLIENT_SECRET) are not configured", 503, false);
  }

  const clientId = (env.ETA_CLIENT_ID || process.env.ETA_CLIENT_ID || "").trim();
  const clientSecret = (env.ETA_CLIENT_SECRET || process.env.ETA_CLIENT_SECRET || "").trim();
  const posSerial = opts?.posSerial?.trim() || "";
  const posOsVersion = opts?.posOsVersion?.trim() || "";
  const cacheKey = `${clientId}::${posSerial}::${posOsVersion}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const tokenUrl = resolveEtaTokenUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (posSerial) {
    headers.posserial = posSerial;
  }
  if (posOsVersion) {
    headers.pososversion = posOsVersion;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const response = await fetchFn(tokenUrl, {
    method: "POST",
    headers,
    body,
  });

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
      typeof parsed.error_description === "string"
        ? parsed.error_description
        : typeof parsed.error === "string"
          ? parsed.error
          : `ETA token request failed with status ${response.status}`;
    log.warn({ statusCode: response.status, posSerial }, "eta.oauth.failed");
    throw new EtaClientError(errMsg, response.status, response.status >= 500 || response.status === 429, parsed);
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  if (!accessToken) {
    throw new EtaClientError("ETA token response did not include access_token", 502, true, parsed);
  }

  const expiresInSec = Number(parsed.expires_in);
  const effectiveTtlSec = Number.isFinite(expiresInSec) && expiresInSec > 60 ? expiresInSec - 60 : 300;
  tokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + effectiveTtlSec * 1000,
  });

  return accessToken;
}

/**
 * Submits one or more e-Receipt v1.2 documents to ETA `/api/v1/receiptsubmissions`.
 */
export async function submitEtaReceipts(
  receipts: Array<Record<string, unknown>>,
  opts?: EtaClientOptions
): Promise<EtaReceiptSubmissionResult> {
  const token = await getEtaAccessToken(opts);
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const url = `${resolveEtaApiBaseUrl()}/api/v1/receiptsubmissions`;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ receipts }),
  });

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
    const errMsg = extractEtaErrorDetails(parsed.error ?? parsed);
    throw new EtaClientError(
      `ETA receipt submission failed (${response.status}): ${errMsg}`,
      response.status,
      response.status >= 500 || response.status === 429 || response.status === 401,
      parsed
    );
  }

  const submissionUuid =
    typeof parsed.submissionId === "string"
      ? parsed.submissionId
      : typeof parsed.submissionUUID === "string"
        ? parsed.submissionUUID
        : typeof parsed.submissionUuid === "string"
          ? parsed.submissionUuid
          : null;

  const accepted = parseAcceptedDocuments(parsed.acceptedDocuments);
  const rejected = parseRejectedDocuments(parsed.rejectedDocuments);

  return {
    submissionUuid,
    accepted,
    rejected,
    rawResponse: parsed,
  };
}

function normalizeRemoteSubmissionStatus(rawStatus: unknown): EtaRemoteSubmissionStatus {
  if (typeof rawStatus !== "string") return "InProgress";
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === "accepted") return "Accepted";
  if (normalized === "valid") return "Valid";
  if (normalized === "invalid") return "Invalid";
  if (normalized === "rejected") return "Rejected";
  return "InProgress";
}

/**
 * Polls an asynchronous ETA receipt submission status by `submissionUuid`.
 */
export async function getEtaSubmissionStatus(
  submissionUuid: string,
  opts?: EtaClientOptions
): Promise<EtaSubmissionStatusResult> {
  const token = await getEtaAccessToken(opts);
  const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
  const url = `${resolveEtaApiBaseUrl()}/api/v1/receiptsubmissions/${encodeURIComponent(submissionUuid)}`;

  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

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
    const errMsg = extractEtaErrorDetails(parsed.error ?? parsed);
    throw new EtaClientError(
      `ETA submission status poll failed (${response.status}): ${errMsg}`,
      response.status,
      response.status >= 500 || response.status === 429 || response.status === 401,
      parsed
    );
  }

  const status = normalizeRemoteSubmissionStatus(parsed.status ?? parsed.overallStatus);
  const accepted = parseAcceptedDocuments(parsed.acceptedDocuments ?? parsed.receipts);
  const rejected = parseRejectedDocuments(parsed.rejectedDocuments);

  return {
    submissionUuid,
    status,
    accepted,
    rejected,
    rawResponse: parsed,
  };
}
