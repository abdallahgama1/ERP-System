import type { Breadcrumb, BrowserOptions, ErrorEvent, Event } from "@sentry/react";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(?:^|[^a-z])(password|passwd|pwd|pin|pins|pos_pin|pin_hash|password_hash|token|tokens|raw_token|reset_token|token_hash|secret|secrets|eta_client_secret|cookie|cookies|set_cookie|authorization|proxy_authorization|api_key|x_api_key|private_key|session_id)(?:$|[^a-z])/i;

const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:token|resetToken|reset_token|rawToken|raw_token|password|passwd|pwd|pin|posPin|pos_pin|secret|apiKey|api_key|authorization|cookie)=)([^&\s#]+)/gi;

export function isSensitiveKey(key: string): boolean {
  const snakeKey = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(snakeKey);
}

export function scrubSensitiveText(input: string): string {
  return input
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, `$1${REDACTED}:${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, `$1${REDACTED}`);
}

export function scrubUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const withoutQueryOrHash = trimmed.split(/[?#]/)[0] ?? "";
    return scrubSensitiveText(withoutQueryOrHash);
  }
}

export function scrubUnknownValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          return JSON.stringify(scrubUnknownValue(parsed, depth + 1, seen));
        }
      } catch {
        // Fall back to plain text scrubbing if not valid JSON
      }
    }
    return scrubSensitiveText(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth > 8) {
    return "[Truncated]";
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubUnknownValue(item, depth + 1, seen));
  }

  const record = value as Record<string, unknown>;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      scrubbed[key] = REDACTED;
    } else {
      scrubbed[key] = scrubUnknownValue(entryValue, depth + 1, seen);
    }
  }
  return scrubbed;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const copy: Breadcrumb = { ...breadcrumb };
  if (typeof copy.message === "string") {
    copy.message = scrubSensitiveText(copy.message);
  }
  if (copy.data && typeof copy.data === "object") {
    const scrubbedData = scrubUnknownValue(copy.data) as Record<string, unknown>;
    for (const urlField of ["url", "from", "to"] as const) {
      if (typeof scrubbedData[urlField] === "string") {
        scrubbedData[urlField] = scrubUrl(scrubbedData[urlField]);
      }
    }
    copy.data = scrubbedData;
  }
  return copy;
}

export function scrubSentryEvent<T extends ErrorEvent | Event>(event: T): T {
  const copy: T = { ...event };

  if (copy.user && typeof copy.user === "object") {
    const { email: _email, ip_address: _ip, username: _username, ...restUser } = copy.user;
    copy.user = restUser;
  }

  if (copy.request && typeof copy.request === "object") {
    const reqCopy = { ...copy.request };
    if (typeof reqCopy.url === "string") {
      reqCopy.url = scrubUrl(reqCopy.url);
    }
    delete reqCopy.cookies;
    delete reqCopy.query_string;
    if (reqCopy.headers) {
      reqCopy.headers = scrubUnknownValue(reqCopy.headers) as Record<string, string>;
    }
    if (reqCopy.data !== undefined) {
      reqCopy.data = scrubUnknownValue(reqCopy.data);
    }
    if (reqCopy.env) {
      reqCopy.env = scrubUnknownValue(reqCopy.env) as Record<string, string>;
    }
    copy.request = reqCopy;
  }

  if (typeof copy.message === "string") {
    copy.message = scrubSensitiveText(copy.message);
  }

  if (copy.logentry && typeof copy.logentry === "object") {
    copy.logentry = {
      ...copy.logentry,
      ...(typeof copy.logentry.message === "string"
        ? { message: scrubSensitiveText(copy.logentry.message) }
        : {}),
      ...(Array.isArray(copy.logentry.params)
        ? { params: scrubUnknownValue(copy.logentry.params) as unknown[] }
        : {}),
    };
  }

  if (copy.exception?.values && Array.isArray(copy.exception.values)) {
    copy.exception = {
      ...copy.exception,
      values: copy.exception.values.map((ex) => ({
        ...ex,
        ...(typeof ex.value === "string" ? { value: scrubSensitiveText(ex.value) } : {}),
      })),
    };
  }

  if (copy.tags && typeof copy.tags === "object") {
    copy.tags = scrubUnknownValue(copy.tags) as T["tags"];
  }

  if (copy.extra && typeof copy.extra === "object") {
    copy.extra = scrubUnknownValue(copy.extra) as T["extra"];
  }

  if (copy.contexts && typeof copy.contexts === "object") {
    copy.contexts = scrubUnknownValue(copy.contexts) as T["contexts"];
  }

  if (Array.isArray(copy.breadcrumbs)) {
    copy.breadcrumbs = copy.breadcrumbs.map((b) => scrubSentryBreadcrumb(b));
  }

  return copy;
}

export function getFrontendSentryConfig(): { dsn: string; environment: string } {
  const dsn = String(import.meta.env.VITE_SENTRY_DSN ?? "").trim();
  const environment =
    String(import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "").trim() || import.meta.env.MODE;
  return { dsn, environment };
}

type SentryReactModule = typeof import("@sentry/react");

let sentryModulePromise: Promise<SentryReactModule> | null = null;
let frontendSentryInitialized = false;

async function loadSentrySdk(): Promise<SentryReactModule> {
  if (!sentryModulePromise) {
    sentryModulePromise = import("@sentry/react");
  }
  return sentryModulePromise;
}

export async function initFrontendSentry(): Promise<boolean> {
  const { dsn, environment } = getFrontendSentryConfig();
  if (!dsn) {
    return false;
  }
  if (frontendSentryInitialized) {
    return true;
  }

  const Sentry = await loadSentrySdk();
  const options: BrowserOptions = {
    dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  };
  Sentry.init(options);
  frontendSentryInitialized = true;
  return true;
}

export async function captureFrontendException(
  error: unknown,
  errorInfo?: { componentStack?: string | null }
): Promise<string | undefined> {
  if (!getFrontendSentryConfig().dsn) {
    return undefined;
  }
  const ready = await initFrontendSentry();
  if (!ready) {
    return undefined;
  }
  const Sentry = await loadSentrySdk();
  if (errorInfo?.componentStack) {
    return Sentry.captureReactException(error, { componentStack: errorInfo.componentStack });
  }
  return Sentry.captureException(error);
}
