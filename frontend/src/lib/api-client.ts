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
    super(payload.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code ?? "API_ERROR";
    this.details = payload.details;
    this.response = { status, data: payload };
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

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(buildApiUrl(path), {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    credentials: "include",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
