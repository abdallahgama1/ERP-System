import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Load backend/.env reliably even when launched from repository root or external process managers
loadDotenv({ path: path.resolve(currentDir, "../.env") });

const parseIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

export const DEV_COOKIE_SECRET_PLACEHOLDER = "dev-cookie-secret-change-in-production";

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
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
  COOKIE_SECURE: cookieSecureMode,
  SMTP_HOST: (process.env.SMTP_HOST ?? "").trim(),
  SMTP_PORT: parseIntEnv(process.env.SMTP_PORT, 587),
  SMTP_SECURE: parseBoolEnv(process.env.SMTP_SECURE, false),
  SMTP_USER: (process.env.SMTP_USER ?? "").trim(),
  SMTP_PASS: (process.env.SMTP_PASS ?? "").trim(),
  SMTP_FROM: (process.env.SMTP_FROM ?? "Count It Keep It ERP <no-reply@localhost>").trim(),
};
