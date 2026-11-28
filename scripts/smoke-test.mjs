#!/usr/bin/env node
/**
 * Production & Staging Deployment Smoke Test
 *
 * Verifies a running ERP deployment end-to-end in strictly read-only mode:
 *   1. GET /api/health/live   -> 200 OK
 *   2. GET /api/health/ready  -> 200 OK (db=ok, storage=ok)
 *   3. GET /api/status        -> 200 OK (when UPTIME_STATUS_TOKEN / --status-token is supplied; zero DB writes)
 *   4. POST /api/auth/login   -> 200 OK (dedicated least-privilege "Smoke Monitor" user, MFA-exempt & read-only)
 *   5. GET /api/accounting/reports/reconciliation -> 200 OK, allReconciled === true (8/8 controls)
 *   6. GET /api/accounting/setup-health           -> 200 OK, healthy === true
 *   7. GET /api/audit-logs/verify                 -> 200 OK, valid === true
 *   8. GET /api/admin/backups/freshness           -> 200 OK (fails when --require-fresh-backup and stale/missing)
 *   9. POST /api/auth/logout  -> 200 OK (revokes ephemeral smoke session)
 *
 * Modes:
 *   - production (default): Strictly read-only. Refuses admin accounts, blocks all mutating HTTP
 *     methods except login/logout, and detects MFA challenges explicitly.
 *   - staging: Same read-only checks, permits non-smoke credentials if explicitly needed in staging.
 *
 * Usage:
 *   node scripts/smoke-test.mjs --base-url https://erp.example.com --email smoke-monitor@internal.local --password '...'
 *   SMOKE_BASE_URL=... SMOKE_USER_EMAIL=... SMOKE_USER_PASSWORD=... UPTIME_STATUS_TOKEN=... npm run smoke-test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_AUTH_POST_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

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
  const list =
    typeof res.headers.getSetCookie === "function"
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
  email = process.env.SMOKE_USER_EMAIL ?? process.env.SMOKE_ADMIN_EMAIL ?? "",
  password = process.env.SMOKE_USER_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? "",
  statusToken = process.env.UPTIME_STATUS_TOKEN ?? "",
  mode = process.env.SMOKE_MODE ?? "production",
  requireFreshBackup = false,
  timeoutMs = 15_000,
} = {}) {
  const cleanBase = String(baseUrl).trim().replace(/\/+$/, "");
  if (!cleanBase) {
    throw new Error("baseUrl (or SMOKE_BASE_URL) is required.");
  }

  const normalizedMode = String(mode).trim().toLowerCase() === "staging" ? "staging" : "production";
  const strictProduction = normalizedMode === "production";

  const fetchJson = async (relPath, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const pathOnly = relPath.split("?")[0] ?? relPath;
    if (method !== "GET" && method !== "HEAD" && !ALLOWED_AUTH_POST_PATHS.has(pathOnly)) {
      throw new Error(
        `Smoke test strictly forbids mutating requests in ${normalizedMode} mode (attempted ${method} ${pathOnly}).`
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cleanBase}${relPath}`, { ...init, method, signal: controller.signal });
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

  // 1. Liveness (read-only, zero DB writes)
  const live = await fetchJson("/api/health/live");
  if (live.res.status !== 200 || live.json?.status !== "live") {
    throw new Error(`/api/health/live failed (HTTP ${live.res.status}): ${JSON.stringify(live.json)}`);
  }

  // 2. Readiness (read-only, zero DB writes)
  const ready = await fetchJson("/api/health/ready");
  if (
    ready.res.status !== 200 ||
    ready.json?.ok !== true ||
    ready.json?.db !== "ok" ||
    ready.json?.storage !== "ok"
  ) {
    throw new Error(`/api/health/ready failed (HTTP ${ready.res.status}): ${JSON.stringify(ready.json)}`);
  }

  const summary = {
    ok: true,
    mode: normalizedMode,
    readOnly: true,
    baseUrl: cleanBase,
    checkedAt: new Date().toISOString(),
    live: { status: live.res.status },
    ready: { status: ready.res.status, db: ready.json.db, storage: ready.json.storage },
    uptimeStatus: null,
    auth: { skipped: true },
    reconciliation: null,
    setupHealth: null,
    auditChain: null,
    backupFreshness: null,
  };

  // 3. Token-authenticated /api/status probe (strictly read-only, zero DB writes)
  const cleanStatusToken = String(statusToken ?? "").trim();
  if (cleanStatusToken) {
    const statusRes = await fetchJson("/api/status", {
      headers: { authorization: `Bearer ${cleanStatusToken}` },
    });
    const statusBody = statusRes.json ?? {};
    summary.uptimeStatus = {
      status: statusRes.res.status,
      ready: Boolean(statusBody.ready),
      database: Boolean(statusBody.database),
      storage: Boolean(statusBody.storage),
      backupFresh: Boolean(statusBody.backupFresh),
    };
    if (statusRes.res.status !== 200 && (requireFreshBackup || !statusBody.ready)) {
      throw new Error(`/api/status failed (HTTP ${statusRes.res.status}): ${JSON.stringify(statusBody)}`);
    }
  }

  // 4. Dedicated least-privilege Smoke Monitor login + read-only integrity checks
  if (email && password) {
    const login = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (login.res.status !== 200) {
      throw new Error(`/api/auth/login failed (HTTP ${login.res.status}): ${JSON.stringify(login.json)}`);
    }
    if (login.json?.mfaRequired) {
      throw new Error(
        `/api/auth/login returned mfaRequired=true for '${email}'. ` +
          `Human/admin accounts with MFA enabled cannot be used for automated smoke tests; ` +
          `provision the dedicated least-privilege MFA-exempt Smoke Monitor user with: npm run smoke:create-user`
      );
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

    try {
      const loggedInUser = login.json?.user ?? null;
      if (!loggedInUser || !cookieHeader) {
        throw new Error("/api/auth/login succeeded without returning a valid user session cookie.");
      }

      if (strictProduction && (loggedInUser.role === "admin" || loggedInUser.customRoleName !== "Smoke Monitor")) {
        throw new Error(
          `Production smoke test refuses privileged or non-smoke account '${loggedInUser.email}' ` +
            `(role=${loggedInUser.role}, customRole=${loggedInUser.customRoleName ?? "none"}). ` +
            `Provision a dedicated least-privilege 'Smoke Monitor' user with: npm run smoke:create-user`
        );
      }

      summary.auth = {
        skipped: false,
        userEmail: loggedInUser.email ?? email,
        role: loggedInUser.role ?? null,
        customRoleName: loggedInUser.customRoleName ?? null,
        mfaEnabled: Boolean(loggedInUser.mfaEnabled),
      };

      // 5. Reconciliation (all 8 controls)
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

      // 6. Setup Health
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

      // 7. Audit Chain
      const audit = await fetchJson("/api/audit-logs/verify", { headers: authHeaders });
      if (audit.res.status !== 200 || audit.json?.valid !== true) {
        throw new Error(`/api/audit-logs/verify failed (HTTP ${audit.res.status}): ${JSON.stringify(audit.json)}`);
      }
      summary.auditChain = {
        valid: true,
        totalChainedRows: audit.json.totalChainedRows,
      };

      // 8. Backup Freshness
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
    } finally {
      // 9. Always revoke the ephemeral smoke session cleanly
      if (cookieHeader) {
        await fetchJson("/api/auth/logout", { method: "POST", headers: authHeaders }).catch(() => {});
      }
    }
  }

  return summary;
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      `Usage: node scripts/smoke-test.mjs --base-url <url> [--email <smoke-user>] [--password <pass>] [--status-token <token>] [--mode production|staging] [--require-fresh-backup]`
    );
    process.exit(0);
  }
  const mode = opts.staging ? "staging" : opts.production ? "production" : (opts.mode ?? process.env.SMOKE_MODE ?? "production");
  runSmokeTest({
    baseUrl: opts["base-url"] ?? process.env.SMOKE_BASE_URL ?? "",
    email: opts.email ?? process.env.SMOKE_USER_EMAIL ?? process.env.SMOKE_ADMIN_EMAIL ?? "",
    password: opts.password ?? process.env.SMOKE_USER_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? "",
    statusToken: opts["status-token"] ?? process.env.UPTIME_STATUS_TOKEN ?? "",
    mode,
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
