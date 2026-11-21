import type { FastifyRequest } from "fastify";
import { env } from "../config.ts";
import { AppError } from "../db/helpers.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function normalizeOrigin(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "null") {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAllowedOrigins(req: Pick<FastifyRequest, "protocol" | "host">): Set<string> {
  const allowed = new Set<string>();
  const rawCors = process.env.CORS_ORIGIN ?? env.CORS_ORIGIN;
  const rawAppBase = process.env.APP_BASE_URL ?? env.APP_BASE_URL;

  for (const candidate of [...rawCors.split(","), ...rawAppBase.split(",")]) {
    const normalized = normalizeOrigin(candidate);
    if (normalized) {
      allowed.add(normalized);
    }
  }

  const host = typeof req.host === "string" ? req.host.trim() : "";
  if (host) {
    const sameOrigin = normalizeOrigin(`${req.protocol}://${host}`);
    if (sameOrigin) {
      allowed.add(sameOrigin);
    }
  }

  return allowed;
}

export async function csrfProtectionHook(req: FastifyRequest): Promise<void> {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return;
  }

  const fetchSite = firstHeaderValue(req.headers["sec-fetch-site"])?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    throw new AppError(403, "Cross-site requests are forbidden", "CSRF_ORIGIN_FORBIDDEN");
  }

  const allowedOrigins = buildAllowedOrigins(req);

  if (req.headers.origin !== undefined) {
    const originHeader = firstHeaderValue(req.headers.origin);
    const normalizedOrigin = normalizeOrigin(originHeader);
    if (!normalizedOrigin || !allowedOrigins.has(normalizedOrigin)) {
      throw new AppError(403, "Origin not allowed for mutating request", "CSRF_ORIGIN_FORBIDDEN");
    }
    return;
  }

  if (req.headers.referer !== undefined) {
    const refererHeader = firstHeaderValue(req.headers.referer);
    const normalizedReferer = normalizeOrigin(refererHeader);
    if (!normalizedReferer || !allowedOrigins.has(normalizedReferer)) {
      throw new AppError(403, "Referer not allowed for mutating request", "CSRF_ORIGIN_FORBIDDEN");
    }
    return;
  }
}
