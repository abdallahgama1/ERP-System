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

export function resolveMfaEncryptionKey(): Buffer {
  const configured = env.MFA_ENCRYPTION_KEY;
  if (configured) {
    if (/^[0-9a-fA-F]{64}$/.test(configured)) {
      return Buffer.from(configured, "hex");
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(configured)) {
      const decoded = Buffer.from(configured, "base64");
      if (decoded.length === 32 && decoded.toString("base64") === configured) {
        return decoded;
      }
    }
    throw new Error("MFA_ENCRYPTION_KEY must be a 64-character hex string or base64-encoded 32-byte key.");
  }

  if (env.NODE_ENV === "production") {
    throw new Error("MFA_ENCRYPTION_KEY must be a 32-byte hex or base64 key when NODE_ENV=production.");
  }

  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env.AUTH_COOKIE_SECRET, "utf8"),
      Buffer.from("count-it-keep-it-mfa-v1", "utf8"),
      Buffer.from("totp-aes-256-gcm", "utf8"),
      32
    )
  );
}
