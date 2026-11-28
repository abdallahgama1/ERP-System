#!/usr/bin/env node
/**
 * Production & Staging Deployment Smoke Test
 *
 * Verifies a running ERP deployment end-to-end:
 *   1. GET /api/health/live   -> 200 OK
 *   2. GET /api/health/ready  -> 200 OK (db=ok, storage=ok)
 *   3. POST /api/auth/login   -> 200 OK (admin credentials, captures session + CSRF cookies)
 *   4. GET /api/accounting/reports/reconciliation -> 200 OK, allReconciled === true (8/8 controls)
 *   5. GET /api/accounting/setup-health           -> 200 OK, healthy === true
 *   6. GET /api/audit-logs/verify                 -> 200 OK, valid === true
 *   7. GET /api/admin/backups/freshness           -> 200 OK (fails only when --require-fresh-backup)
 *
 * Usage:
 *   node scripts/smoke-test.mjs --base-url https://staging.erp.example.com --email admin@co.eg --password '...'
 *   SMOKE_BASE_URL=... SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... npm run smoke-test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        opts[k] = true;
      } else {
        opts[k] = next;
        i += 1;
      }
    }
  }
  return opts;
}

function extractCookies(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  const map = new Map();
  for (const raw of list) {
    const pair = String(raw).split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) {
      map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return map;
}

export async function runSmokeTest({
  baseUrl = process.env.SMOKE_BASE_URL ?? "",
  email = process.env.SMOKE_ADMIN_EMAIL ?? "",
  password = process.env.SMOKE_ADMIN_PASSWORD ?? "",
  requireFreshBackup = false,
  timeoutMs = 15_000,
} = {}) {
  const cleanBase = String(baseUrl).trim().replace(/\/+$/, "");
  if (!cleanBase) {
    throw new Error("baseUrl (or SMOKE_BASE_URL) is required.");
  }

  const fetchJson = async (relPath, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cleanBase}${relPath}`, { ...init, signal: controller.signal });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return { res, json };
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. Liveness
  const live = await fetchJson("/api/health/live");
  if (live.res.status !== 200 || live.json?.status !== "live") {
    throw new Error(`/api/health/live failed (HTTP ${live.res.status}): ${JSON.stringify(live.json)}`);
  }

  // 2. Readiness
  const ready = await fetchJson("/api/health/ready");
  if (ready.res.status !== 200 || ready.json?.ok !== true || ready.json?.db !== "ok" || ready.json?.storage !== "ok") {
    throw new Error(`/api/health/ready failed (HTTP ${ready.res.status}): ${JSON.stringify(ready.json)}`);
  }

  const summary = {
    ok: true,
    baseUrl: cleanBase,
    checkedAt: new Date().toISOString(),
    live: { status: live.res.status },
    ready: { status: ready.res.status, db: ready.json.db, storage: ready.json.storage },
    auth: { skipped: true },
    reconciliation: null,
    setupHealth: null,
    auditChain: null,
    backupFreshness: null,
  };

  // 3. Login + Reconciliation + Setup Health + Audit Chain (when admin credentials are provided)
  if (email && password) {
    const login = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (login.res.status !== 200) {
      throw new Error(`/api/auth/login failed (HTTP ${login.res.status}): ${JSON.stringify(login.json)}`);
    }
    const cookies = extractCookies(login.res);
    const cookieHeader = Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const csrfToken = cookies.get("erp_csrf") ? decodeURIComponent(cookies.get("erp_csrf")) : "";
    const authHeaders = {
      cookie: cookieHeader,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    };
    summary.auth = { skipped: false, userEmail: login.json?.user?.email ?? email, role: login.json?.user?.role ?? null };

    // 4. Reconciliation (all 8 controls)
    const recon = await fetchJson("/api/accounting/reports/reconciliation", { headers: authHeaders });
    if (recon.res.status !== 200 || recon.json?.allReconciled !== true) {
      throw new Error(
        `/api/accounting/reports/reconciliation failed (HTTP ${recon.res.status}, allReconciled=${recon.json?.allReconciled}): ${JSON.stringify(
          recon.json?.items?.filter?.((i) => !i.isReconciled) ?? recon.json
        )}`
      );
    }
    summary.reconciliation = {
      allReconciled: true,
      controls: Array.isArray(recon.json.items) ? recon.json.items.length : 0,
    };

    // 5. Setup Health
    const setup = await fetchJson("/api/accounting/setup-health", { headers: authHeaders });
    if (setup.res.status !== 200 || setup.json?.healthy !== true) {
      throw new Error(
        `/api/accounting/setup-health failed (HTTP ${setup.res.status}): ${JSON.stringify(setup.json?.issues ?? setup.json)}`
      );
    }
    summary.setupHealth = {
      healthy: true,
      validMappings: setup.json.validMappings,
      totalMappings: setup.json.totalMappings,
    };

    // 6. Audit Chain
    const audit = await fetchJson("/api/audit-logs/verify", { headers: authHeaders });
    if (audit.res.status !== 200 || audit.json?.valid !== true) {
      throw new Error(`/api/audit-logs/verify failed (HTTP ${audit.res.status}): ${JSON.stringify(audit.json)}`);
    }
    summary.auditChain = {
      valid: true,
      totalChainedRows: audit.json.totalChainedRows,
    };

    // 7. Backup Freshness
    const freshness = await fetchJson("/api/admin/backups/freshness", { headers: authHeaders });
    if (freshness.res.status !== 200) {
      throw new Error(`/api/admin/backups/freshness failed (HTTP ${freshness.res.status})`);
    }
    summary.backupFreshness = {
      ok: freshness.json.ok,
      status: freshness.json.status,
      ageHours: freshness.json.ageHours,
      maxAgeHours: freshness.json.maxAgeHours,
    };
    if (requireFreshBackup && !freshness.json.ok) {
      throw new Error(`Backup freshness check failed: ${freshness.json.message}`);
    }

    // Best-effort logout to avoid leaking a session row
    await fetchJson("/api/auth/logout", { method: "POST", headers: authHeaders }).catch(() => {});
  }

  return summary;
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      `Usage: node scripts/smoke-test.mjs --base-url <url> [--email <admin>] [--password <pass>] [--require-fresh-backup]`
    );
    process.exit(0);
  }
  runSmokeTest({
    baseUrl: opts["base-url"] ?? process.env.SMOKE_BASE_URL ?? "",
    email: opts.email ?? process.env.SMOKE_ADMIN_EMAIL ?? "",
    password: opts.password ?? process.env.SMOKE_ADMIN_PASSWORD ?? "",
    requireFreshBackup: Boolean(opts["require-fresh-backup"]),
  })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error(`[smoke-test] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
