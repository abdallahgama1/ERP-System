#!/usr/bin/env node
/**
 * Healthchecks.io-compatible Dead-Man's-Switch Ping Helper.
 *
 * Supports:
 *   - Success ping: POST <HEALTHCHECK_PING_URL> with short summary body
 *   - Failure ping: POST <HEALTHCHECK_PING_URL>/fail with redacted error body
 *
 * Also usable directly from shell scripts (e.g. scripts/backup-db.sh):
 *   node scripts/lib/healthcheck-ping.mjs --url <url> --status ok|fail [--message <text>]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_BYTES = 8192;

export function redactSensitiveText(raw) {
  return String(raw ?? "")
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi, "$1:[REDACTED]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|secret|token|key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function normalizeHealthcheckUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export async function pingHealthcheck({
  url,
  ok,
  body = "",
  timeoutMs = 10_000,
  retries = 1,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = normalizeHealthcheckUrl(url);
  if (!baseUrl) {
    return { skipped: true, sent: false, ok: false, targetUrl: null, status: null, error: null };
  }

  const targetUrl = ok ? baseUrl : `${baseUrl}/fail`;
  const cleanBody = redactSensitiveText(body).slice(0, MAX_BODY_BYTES);

  let lastError = null;
  let lastStatus = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "user-agent": "count-it-keep-it-erp-healthcheck/1.0",
        },
        body: cleanBody,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.ok) {
        return { skipped: false, sent: true, ok: true, targetUrl, status: res.status, error: null };
      }
      lastError = `HTTP ${res.status}`;
      if (res.status < 500) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return {
    skipped: false,
    sent: false,
    ok: false,
    targetUrl,
    status: lastStatus,
    error: lastError,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    }
  }
  return opts;
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseCliArgs(process.argv.slice(2));
  const url = opts.url ?? process.env.HEALTHCHECK_PING_URL ?? "";
  const ok = String(opts.status ?? "ok").toLowerCase() !== "fail";
  const body = String(opts.message ?? "");
  pingHealthcheck({ url, ok, body })
    .then((res) => {
      if (!res.skipped && !res.sent) {
        console.error(`[healthcheck-ping] Warning: ping to ${res.targetUrl} failed (${res.error})`);
      }
    })
    .catch((err) => {
      console.error(`[healthcheck-ping] Warning: ${err instanceof Error ? err.message : String(err)}`);
    });
}
