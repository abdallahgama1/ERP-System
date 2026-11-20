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

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseIntEnv(process.env.PORT, 3001),
  HOST: process.env.HOST ?? "127.0.0.1",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:8080",
  DATABASE_URL: (process.env.DATABASE_URL ?? "").trim(),
  SESSION_COOKIE_NAME: (process.env.SESSION_COOKIE_NAME ?? "erp_session").trim() || "erp_session",
  SESSION_TTL_DAYS: parseIntEnv(process.env.SESSION_TTL_DAYS, 30),
  AUTH_COOKIE_SECRET: (process.env.AUTH_COOKIE_SECRET ?? "dev-cookie-secret-change-in-production").trim(),
};
