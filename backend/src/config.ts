import { config as loadDotenv } from "dotenv";
import { hkdfSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Load backend/.env reliably even when launched from repository root or external process managers
loadDotenv({ path: path.resolve(currentDir, "../.env") });

const parseIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseRateEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

const parseBoolEnv = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
};

const rawCookieSecure = (process.env.COOKIE_SECURE ?? "auto").trim().toLowerCase();
const cookieSecureMode: "auto" | "true" | "false" =
  rawCookieSecure === "true" || rawCookieSecure === "false" ? rawCookieSecure : "auto";

const rawStorageDriver = (process.env.STORAGE_DRIVER?.trim() || "local").toLowerCase();
if (rawStorageDriver !== "local" && rawStorageDriver !== "s3") {
  throw new Error(`Invalid STORAGE_DRIVER "${rawStorageDriver}". Expected "local" or "s3".`);
}
const storageDriver: "local" | "s3" = rawStorageDriver;

const nodeEnv = process.env.NODE_ENV ?? "development";
const defaultStorageLocalDir =
  nodeEnv === "production" ? "/app/uploads" : path.resolve(currentDir, "../uploads");
const rawStorageLocalDir = (process.env.STORAGE_LOCAL_DIR ?? "").trim();

export const DEV_COOKIE_SECRET_PLACEHOLDER = "dev-cookie-secret-change-in-production";

export const env = {
  NODE_ENV: nodeEnv,
  LOG_LEVEL: (process.env.LOG_LEVEL ?? (nodeEnv === "production" ? "info" : "debug")).trim(),
  PORT: parseIntEnv(process.env.PORT, 3001),
  HOST: process.env.HOST ?? "127.0.0.1",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:8080",
  APP_BASE_URL: (process.env.APP_BASE_URL ?? process.env.CORS_ORIGIN?.split(",")[0] ?? "http://localhost:8080")
    .trim()
    .replace(/\/+$/, ""),
  TRUST_PROXY: parseBoolEnv(process.env.TRUST_PROXY, false),
  DISABLE_RATE_LIMIT: parseBoolEnv(process.env.DISABLE_RATE_LIMIT, false),
  DATABASE_URL: (process.env.DATABASE_URL ?? "").trim(),
  SESSION_COOKIE_NAME: (process.env.SESSION_COOKIE_NAME ?? "erp_session").trim() || "erp_session",
  SESSION_TTL_DAYS: parseIntEnv(process.env.SESSION_TTL_DAYS, 30),
  AUTH_COOKIE_SECRET: (process.env.AUTH_COOKIE_SECRET ?? DEV_COOKIE_SECRET_PLACEHOLDER).trim(),
  MFA_ENCRYPTION_KEY: (process.env.MFA_ENCRYPTION_KEY ?? "").trim(),
  MFA_ENCRYPTION_KEY_VERSION: parseIntEnv(process.env.MFA_ENCRYPTION_KEY_VERSION, 1),
  MFA_ENCRYPTION_PREVIOUS_KEYS: (process.env.MFA_ENCRYPTION_PREVIOUS_KEYS ?? "").trim(),
  AUTH_RATE_LIMIT_MAX: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX, 20),
  AUTH_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60_000),
  AUTH_MFA_RATE_LIMIT_MAX: parseIntEnv(process.env.AUTH_MFA_RATE_LIMIT_MAX, 10),
  AUTH_MFA_RATE_LIMIT_WINDOW_MS: parseIntEnv(process.env.AUTH_MFA_RATE_LIMIT_WINDOW_MS, 60_000),
  AUTH_PASSWORD_RESET_RATE_LIMIT_MAX: parseIntEnv(process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX, 10),
  AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS: parseIntEnv(
    process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
    900_000
  ),
  AUTH_LOCKOUT_MAX_ATTEMPTS: parseIntEnv(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS, 5),
  AUTH_LOCKOUT_WINDOW_MS: parseIntEnv(process.env.AUTH_LOCKOUT_WINDOW_MS, 900_000),
  AUTH_LOCKOUT_DURATION_MS: parseIntEnv(process.env.AUTH_LOCKOUT_DURATION_MS, 900_000),
  ATTACHMENT_VIRUS_SCAN_ENABLED: parseBoolEnv(process.env.ATTACHMENT_VIRUS_SCAN_ENABLED, false),
  ATTACHMENT_VIRUS_SCAN_CLAMAV_HOST: (process.env.ATTACHMENT_VIRUS_SCAN_CLAMAV_HOST ?? "127.0.0.1").trim(),
  ATTACHMENT_VIRUS_SCAN_CLAMAV_PORT: parseIntEnv(process.env.ATTACHMENT_VIRUS_SCAN_CLAMAV_PORT, 3310),
  ATTACHMENT_VIRUS_SCAN_TIMEOUT_MS: parseIntEnv(process.env.ATTACHMENT_VIRUS_SCAN_TIMEOUT_MS, 10_000),
  ATTACHMENT_VIRUS_SCAN_FAIL_CLOSED: parseBoolEnv(process.env.ATTACHMENT_VIRUS_SCAN_FAIL_CLOSED, true),
  COOKIE_SECURE: cookieSecureMode,
  STORAGE_DRIVER: storageDriver,
  STORAGE_LOCAL_DIR: rawStorageLocalDir ? path.resolve(rawStorageLocalDir) : defaultStorageLocalDir,
  S3_BUCKET: (process.env.S3_BUCKET ?? "").trim(),
  S3_REGION: (process.env.S3_REGION ?? "us-east-1").trim() || "us-east-1",
  S3_ENDPOINT: (process.env.S3_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
  S3_ACCESS_KEY_ID: (process.env.S3_ACCESS_KEY_ID ?? "").trim(),
  S3_SECRET_ACCESS_KEY: (process.env.S3_SECRET_ACCESS_KEY ?? "").trim(),
  S3_FORCE_PATH_STYLE: parseBoolEnv(process.env.S3_FORCE_PATH_STYLE, false),
  SMTP_HOST: (process.env.SMTP_HOST ?? "").trim(),
  SMTP_PORT: parseIntEnv(process.env.SMTP_PORT, 587),
  SMTP_SECURE: parseBoolEnv(process.env.SMTP_SECURE, false),
  SMTP_USER: (process.env.SMTP_USER ?? "").trim(),
  SMTP_PASS: (process.env.SMTP_PASS ?? "").trim(),
  SMTP_FROM: (process.env.SMTP_FROM ?? "Count It Keep It ERP <no-reply@localhost>").trim(),
  ETA_CLIENT_ID: (process.env.ETA_CLIENT_ID ?? "").trim(),
  ETA_CLIENT_SECRET: (process.env.ETA_CLIENT_SECRET ?? "").trim(),
  ETA_ID_BASE_URL: (process.env.ETA_ID_BASE_URL ?? "https://id.preprod.eta.gov.eg").trim().replace(/\/+$/, ""),
  ETA_TOKEN_URL: (
    process.env.ETA_TOKEN_URL ??
    `${(process.env.ETA_ID_BASE_URL ?? "https://id.preprod.eta.gov.eg").trim().replace(/\/+$/, "")}/connect/token`
  ).trim(),
  ETA_API_BASE_URL: (process.env.ETA_API_BASE_URL ?? "https://api.preprod.invoicing.eta.gov.eg")
    .trim()
    .replace(/\/+$/, ""),
  METRICS_TOKEN: (process.env.METRICS_TOKEN ?? "").trim(),
  SENTRY_DSN: (process.env.SENTRY_DSN ?? "").trim(),
  SENTRY_ENVIRONMENT: (process.env.SENTRY_ENVIRONMENT ?? "").trim() || nodeEnv,
  SENTRY_TRACES_SAMPLE_RATE: parseRateEnv(process.env.SENTRY_TRACES_SAMPLE_RATE, 0),
};

export interface AuthHardeningConfig {
  loginRateLimitMax: number;
  loginRateLimitWindowMs: number;
  mfaRateLimitMax: number;
  mfaRateLimitWindowMs: number;
  passwordResetRateLimitMax: number;
  passwordResetRateLimitWindowMs: number;
  lockoutMaxAttempts: number;
  lockoutWindowMs: number;
  lockoutDurationMs: number;
}

export function getAuthHardeningConfig(): AuthHardeningConfig {
  return {
    loginRateLimitMax: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX, env.AUTH_RATE_LIMIT_MAX),
    loginRateLimitWindowMs: parseIntEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, env.AUTH_RATE_LIMIT_WINDOW_MS),
    mfaRateLimitMax: parseIntEnv(process.env.AUTH_MFA_RATE_LIMIT_MAX, env.AUTH_MFA_RATE_LIMIT_MAX),
    mfaRateLimitWindowMs: parseIntEnv(
      process.env.AUTH_MFA_RATE_LIMIT_WINDOW_MS,
      env.AUTH_MFA_RATE_LIMIT_WINDOW_MS
    ),
    passwordResetRateLimitMax: parseIntEnv(
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX,
      env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX
    ),
    passwordResetRateLimitWindowMs: parseIntEnv(
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
      env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS
    ),
    lockoutMaxAttempts: parseIntEnv(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS, env.AUTH_LOCKOUT_MAX_ATTEMPTS),
    lockoutWindowMs: parseIntEnv(process.env.AUTH_LOCKOUT_WINDOW_MS, env.AUTH_LOCKOUT_WINDOW_MS),
    lockoutDurationMs: parseIntEnv(process.env.AUTH_LOCKOUT_DURATION_MS, env.AUTH_LOCKOUT_DURATION_MS),
  };
}

export function parseRawMfaKey(raw: string, label = "MFA_ENCRYPTION_KEY"): Buffer {
  const configured = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(configured)) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length === 32 && decoded.toString("base64") === configured) {
      return decoded;
    }
  }
  throw new Error(`${label} must be a 64-character hex string or base64-encoded 32-byte key.`);
}

export interface MfaKeyRing {
  currentVersion: number;
  currentKey: Buffer;
  keys: Map<number, Buffer>;
}

function parsePreviousMfaKeys(raw: string): Map<number, Buffer> {
  const result = new Map<number, Buffer>();
  const trimmed = raw.trim();
  if (!trimmed) return result;

  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS must be valid JSON or comma-separated 'version:key' pairs.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS JSON must be an object mapping version numbers to keys.");
    }
    for (const [verStr, keyVal] of Object.entries(parsed as Record<string, unknown>)) {
      const version = Number.parseInt(verStr, 10);
      if (!Number.isInteger(version) || version <= 0 || String(version) !== verStr.trim()) {
        throw new Error(`Invalid MFA key version '${verStr}' in MFA_ENCRYPTION_PREVIOUS_KEYS.`);
      }
      if (typeof keyVal !== "string") {
        throw new Error(`MFA key for version ${version} in MFA_ENCRYPTION_PREVIOUS_KEYS must be a string.`);
      }
      result.set(version, parseRawMfaKey(keyVal, `MFA_ENCRYPTION_PREVIOUS_KEYS[${version}]`));
    }
    return result;
  }

  for (const entry of trimmed.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sepIdx = entry.indexOf(":");
    if (sepIdx <= 0) {
      throw new Error(
        "MFA_ENCRYPTION_PREVIOUS_KEYS entries must use 'version:key' format (e.g. '1:<64-hex>')."
      );
    }
    const verStr = entry.slice(0, sepIdx).trim();
    const keyVal = entry.slice(sepIdx + 1).trim();
    const version = Number.parseInt(verStr, 10);
    if (!Number.isInteger(version) || version <= 0 || String(version) !== verStr) {
      throw new Error(`Invalid MFA key version '${verStr}' in MFA_ENCRYPTION_PREVIOUS_KEYS.`);
    }
    result.set(version, parseRawMfaKey(keyVal, `MFA_ENCRYPTION_PREVIOUS_KEYS[${version}]`));
  }

  return result;
}

export function resolveMfaKeyRing(): MfaKeyRing {
  const currentVersion = parseIntEnv(
    process.env.MFA_ENCRYPTION_KEY_VERSION,
    env.MFA_ENCRYPTION_KEY_VERSION
  );
  const configuredCurrent = (process.env.MFA_ENCRYPTION_KEY ?? env.MFA_ENCRYPTION_KEY).trim();

  let currentKey: Buffer;
  if (configuredCurrent) {
    currentKey = parseRawMfaKey(configuredCurrent, "MFA_ENCRYPTION_KEY");
  } else if ((process.env.NODE_ENV ?? env.NODE_ENV) === "production") {
    throw new Error("MFA_ENCRYPTION_KEY must be a 32-byte hex or base64 key when NODE_ENV=production.");
  } else {
    currentKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(env.AUTH_COOKIE_SECRET, "utf8"),
        Buffer.from("count-it-keep-it-mfa-v1", "utf8"),
        Buffer.from("totp-aes-256-gcm", "utf8"),
        32
      )
    );
  }

  const keys = parsePreviousMfaKeys(
    process.env.MFA_ENCRYPTION_PREVIOUS_KEYS ?? env.MFA_ENCRYPTION_PREVIOUS_KEYS
  );
  keys.set(currentVersion, currentKey);

  return { currentVersion, currentKey, keys };
}

export function resolveMfaEncryptionKey(): Buffer {
  return resolveMfaKeyRing().currentKey;
}
