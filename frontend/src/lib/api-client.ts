import type { ExportQuery, ExportResource } from "@erp/shared";

export interface ApiErrorPayload {
  message?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;
  // Keeps compatibility with callers reading error.response.data.message
  public readonly response: { status: number; data: ApiErrorPayload };

  constructor(status: number, payload: ApiErrorPayload) {
    const details = payload.details as { messageEn?: string; messageAr?: string } | undefined;
    const isAr = typeof document !== "undefined" && (document.documentElement.lang || "").startsWith("ar");
    const localized =
      (isAr ? details?.messageAr : details?.messageEn) ?? payload.message ?? `Request failed (${status})`;
    super(localized);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code ?? "API_ERROR";
    this.details = payload.details;
    this.response = { status, data: { ...payload, message: localized } };
  }
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return (configured ?? "").replace(/\/$/, "");
}

export function buildApiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalized}`;
}

export function buildExportUrl(resource: ExportResource, query: Partial<ExportQuery> = {}): string {
  const params = new URLSearchParams();
  params.set("format", query.format ?? "csv");
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.search?.trim()) params.set("search", query.search.trim());
  if (query.status && query.status !== "all") params.set("status", query.status);
  if (query.branchId && query.branchId !== "all") params.set("branchId", query.branchId);
  if (query.fromDate) params.set("fromDate", query.fromDate);
  if (query.toDate) params.set("toDate", query.toDate);
  return buildApiUrl(`/api/exports/${resource}?${params.toString()}`);
}

async function parseErrorResponse(response: Response): Promise<ApiError> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  const payload: ApiErrorPayload =
    parsed && typeof parsed === "object" ? (parsed as ApiErrorPayload) : { message: response.statusText };
  return new ApiError(response.status, payload);
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Scoped synchronous idempotency key slot so wrapper helpers (e.g. useInventoryScope.addBranch)
// automatically inherit the user-action key started by useIdempotentAction/useIdempotentSubmit
// without needing every intermediate signature to be rewritten.
let activeActionIdempotencyKey: string | null = null;

export function runWithIdempotencyKey<T>(key: string, fn: () => T): T {
  const prev = activeActionIdempotencyKey;
  activeActionIdempotencyKey = key;
  try {
    return fn();
  } finally {
    activeActionIdempotencyKey = prev;
  }
}

export function getActiveIdempotencyKey(): string | null {
  return activeActionIdempotencyKey;
}

export function formatApiErrorMessage(
  error: unknown,
  t?: (key: string, fallback?: string) => string,
  language?: string
): string {
  if (error instanceof ApiError) {
    const details = error.details as { messageEn?: string; messageAr?: string } | undefined;
    const isAr = (language ?? (typeof document !== "undefined" ? document.documentElement.lang : "")).startsWith("ar");
    if (isAr && details?.messageAr) return details.messageAr;
    if (!isAr && details?.messageEn) return details.messageEn;
    if (t && error.code) {
      const translated = t(`errors.${error.code}`, "");
      if (translated && translated !== `errors.${error.code}`) return translated;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "Request failed");
}

function shouldAttachAutoIdempotencyKey(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith("/api/auth/")) return false;
  if (normalized.startsWith("/api/pos/override/")) return false;
  if (normalized === "/api/pos/manager-override") return false;
  if (normalized.startsWith("/api/pos/terminal/")) return false;
  if (normalized.startsWith("/api/notifications/")) return false;
  return true;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const method = (options.method ?? (options.body !== undefined ? "POST" : "GET")).toUpperCase();

  const headers: Record<string, string> = {
    ...(options.body !== undefined && !isFormData ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };

  const hasExplicitHeader = Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key");
  if (!hasExplicitHeader) {
    const resolvedKey =
      options.idempotencyKey ??
      (shouldAttachAutoIdempotencyKey(method, path) ? activeActionIdempotencyKey ?? generateIdempotencyKey() : undefined);
    if (resolvedKey) {
      headers["Idempotency-Key"] = resolvedKey;
    }
  }

  const body: BodyInit | undefined =
    options.body === undefined
      ? undefined
      : isFormData
        ? (options.body as FormData)
        : JSON.stringify(options.body);

  const response = await fetch(buildApiUrl(path), {
    method,
    headers,
    credentials: "include",
    body,
    signal: options.signal,
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }

  if (!response.ok) {
    const payload: ApiErrorPayload =
      parsed && typeof parsed === "object" ? (parsed as ApiErrorPayload) : { message: response.statusText };
    throw new ApiError(response.status, payload);
  }

  return parsed as T;
}

export async function apiMultipartRequest<T>(
  path: string,
  formData: FormData,
  options: {
    method?: "POST" | "PUT" | "PATCH";
    headers?: Record<string, string>;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  return apiRequest<T>(path, {
    method: options.method ?? "POST",
    body: formData,
    headers: options.headers,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  });
}

function parseContentDispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      return utf8Match[1].trim();
    }
  }
  const basicMatch = header.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const raw = basicMatch?.[1] ?? basicMatch?.[2];
  return raw ? raw.trim() : null;
}

export async function apiDownloadBlob(
  path: string,
  options: {
    fallbackFileName?: string;
    signal?: AbortSignal;
  } = {}
): Promise<{ blob: Blob; fileName: string | null; contentType: string | null }> {
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : buildApiUrl(path);
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    signal: options.signal,
  });

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const blob = await response.blob();
  const parsedName = parseContentDispositionFileName(response.headers.get("content-disposition"));
  return {
    blob,
    fileName: parsedName ?? options.fallbackFileName ?? null,
    contentType: response.headers.get("content-type"),
  };
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
