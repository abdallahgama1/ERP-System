#!/usr/bin/env node
/**
 * Full Go-Live Cutover Rehearsal Script (Scratch Database Only)
 *
 * Runs the complete 8-step migration sequence (dry-run + atomic commit) on an isolated
 * scratch PostgreSQL database and prints:
 *   1. Opening Trial Balance
 *   2. All 8 Subledger-to-GL Reconciliation Controls
 *   3. Accounting Setup Health
 *   4. Audit-Log Hash Chain Verification
 *
 * Usage:
 *   npm run rehearse:cutover
 *   npm run rehearse:cutover -- --dir ./cutover-data --cutover-date 2026-01-01
 *   npm run rehearse:cutover -- --dir ./cutover-data --allow-pnl
 *
 * Safety:
 *   - NEVER runs against production DATABASE_URL or backend/.env DATABASE_URL.
 *   - Refuses non-local database hosts unless ALLOW_REMOTE_SCRATCH_DB=1 is explicitly set.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const backendEnvPath = path.resolve(repoRoot, "backend/.env");
const DEFAULT_LOCAL_TEST_DB_URL = "postgresql://erp:erp_test_password@127.0.0.1:5439/erp_test";

function readEnvFileVar(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

const stripQuotes = (v) => (v ?? "").trim().replace(/^['"]|['"]$/g, "");

// Parse CLI flags
const args = process.argv.slice(2);
let fixtureDir = path.resolve(repoRoot, "scripts/fixtures/cutover");
let cutoverDate = "2026-01-01";
let allowPnlAccounts = false;
let currency = "EGP";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--dir" || arg === "-d") && args[i + 1]) {
    fixtureDir = path.resolve(process.cwd(), args[++i]);
  } else if (arg === "--cutover-date" && args[i + 1]) {
    cutoverDate = args[++i];
  } else if (arg === "--currency" && args[i + 1]) {
    currency = args[++i].toUpperCase();
  } else if (arg === "--allow-pnl") {
    allowPnlAccounts = true;
  } else if (!arg.startsWith("-")) {
    fixtureDir = path.resolve(process.cwd(), arg);
  }
}

if (!fs.existsSync(fixtureDir) || !fs.statSync(fixtureDir).isDirectory()) {
  console.error(`ERROR: Cutover CSV directory not found: ${fixtureDir}`);
  process.exit(1);
}

// Capture production / caller DB URLs BEFORE loading backend/.env so an old remote
// TEST_DATABASE_URL in backend/.env never hijacks local Docker scratch rehearsals.
const callerProdDbUrl = stripQuotes(process.env.DATABASE_URL);
const callerTestDbUrl = stripQuotes(process.env.TEST_DATABASE_URL || process.env.SCRATCH_DATABASE_URL);
const envFileDbUrl = readEnvFileVar(backendEnvPath, "DATABASE_URL");
dotenv.config({ path: backendEnvPath });

let targetDbUrl = callerTestDbUrl;
if (!targetDbUrl) {
  console.log("[rehearse:cutover] Starting local Docker Postgres 18 scratch container...");
  execFileSync("docker", ["compose", "-f", path.resolve(repoRoot, "docker-compose.test.yml"), "up", "-d", "--wait"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  targetDbUrl = DEFAULT_LOCAL_TEST_DB_URL;
}

// Strict production DB refusal checks
if (envFileDbUrl && targetDbUrl === envFileDbUrl) {
  console.error("REFUSING TO RUN: target scratch DB URL matches DATABASE_URL in backend/.env.");
  process.exit(1);
}
if (callerProdDbUrl && targetDbUrl === callerProdDbUrl && !process.env.TEST_DATABASE_URL && !process.env.SCRATCH_DATABASE_URL) {
  console.error("REFUSING TO RUN: rehearsal must not run against production DATABASE_URL. Provide TEST_DATABASE_URL or use the local Docker scratch DB.");
  process.exit(1);
}
if (callerProdDbUrl && process.env.TEST_DATABASE_URL && stripQuotes(process.env.TEST_DATABASE_URL) === callerProdDbUrl && !/127\.0\.0\.1|localhost|postgres-test/i.test(targetDbUrl)) {
  console.error("REFUSING TO RUN: TEST_DATABASE_URL equals production DATABASE_URL on a non-local host.");
  process.exit(1);
}

try {
  const parsedUrl = new URL(targetDbUrl);
  const host = parsedUrl.hostname.toLowerCase();
  const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "postgres-test";
  if (!isLocalHost && process.env.ALLOW_REMOTE_SCRATCH_DB !== "1") {
    console.error(
      `REFUSING TO RUN: target host '${host}' is not a local scratch Postgres instance.\n` +
        "Use the local Docker Postgres container or explicitly pass ALLOW_REMOTE_SCRATCH_DB=1 for a disposable scratch DB."
    );
    process.exit(1);
  }
} catch {
  console.error("REFUSING TO RUN: invalid target scratch database URL.");
  process.exit(1);
}

process.env.DATABASE_URL = targetDbUrl;
process.env.TEST_DATABASE_URL = targetDbUrl;
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

function resolveCsvFile(candidates, required = true) {
  for (const name of candidates) {
    const full = path.join(fixtureDir, name);
    if (fs.existsSync(full)) {
      return { path: full, content: fs.readFileSync(full, "utf8") };
    }
  }
  if (required) {
    throw new Error(`Missing required CSV file in ${fixtureDir}. Tried: ${candidates.join(", ")}`);
  }
  return null;
}

const unregisterTsx = register();

function extractCookie(res, name = "erp_session") {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const prefix = `${name}=`;
  const match = list.find((c) => c.startsWith(prefix));
  return match ? match.split(";")[0] : "";
}

function authHeaders(res) {
  const sessionCookie = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrfToken = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrfToken ? `${sessionCookie}; erp_csrf=${csrfToken}` : sessionCookie,
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  };
}

async function injectJson(app, method, url, headers, payload) {
  const effectiveHeaders =
    method === "POST" && !url.startsWith("/api/auth/")
      ? { "idempotency-key": randomUUID(), ...headers }
      : headers;
  const res = await app.inject({
    method,
    url,
    headers: effectiveHeaders,
    ...(payload !== undefined ? { payload } : {}),
  });
  if (res.statusCode >= 400) {
    throw new Error(`${method} ${url} failed with HTTP ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

const fmt = (n) => Number(n ?? 0).toFixed(2);

async function main() {
  const { runMigrations } = await import("../backend/src/db/migrate.ts");
  const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
  const { buildApp } = await import("../backend/src/app.ts");
  const { sql } = await import("drizzle-orm");

  console.log(`[rehearse:cutover] CSV directory : ${fixtureDir}`);
  console.log(`[rehearse:cutover] Cutover date  : ${cutoverDate} (currency=${currency}, allowPnl=${allowPnlAccounts})`);
  console.log("[rehearse:cutover] Applying Drizzle migrations to scratch DB...");
  await runMigrations(targetDbUrl);

  const db = getDb();
  console.log("[rehearse:cutover] Resetting scratch DB tables...");
  const tableRows = await db.execute(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '__drizzle%'
  `);
  const tables = tableRows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length > 0) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`));
  }

  const app = await buildApp({ logger: false, enableRateLimit: false });
  await app.ready();

  try {
    // 0. Bootstrap first admin and company currency + fiscal year covering cutoverDate
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Cutover Admin",
        email: "cutover-admin@rehearsal.local",
        password: "RehearsalPassword123!",
      },
    });
    assert.equal(signupRes.statusCode, 201, `Admin signup failed: ${signupRes.body}`);
    const adminHeaders = authHeaders(signupRes);

    await injectJson(app, "PUT", "/api/settings/company", adminHeaders, {
      companyName: "Cutover Rehearsal Co",
      baseCurrency: currency,
      einvoicingMode: "eta_egypt",
    });

    const cutoverYear = Number(cutoverDate.slice(0, 4));
    const fyList = await injectJson(app, "GET", "/api/accounting/fiscal-years", adminHeaders);
    const hasYear = (fyList.fiscalYears ?? []).some(
      (y) => y.startDate.slice(0, 10) <= cutoverDate && y.endDate.slice(0, 10) >= cutoverDate
    );
    if (!hasYear) {
      await injectJson(app, "POST", "/api/accounting/fiscal-years", adminHeaders, {
        name: `FY ${cutoverYear}`,
        startDate: `${cutoverYear}-01-01`,
        endDate: `${cutoverYear}-12-31`,
      });
    }

    // Steps 1-7: Standard CSV datasets (dry-run first, then atomic commit)
    const steps = [
      { kind: "chart_of_accounts", files: ["01-chart-of-accounts.csv", "chart_of_accounts.csv"], required: true },
      { kind: "customers", files: ["02-customers.csv", "customers.csv"], required: true },
      { kind: "vendors", files: ["03-vendors.csv", "vendors.csv"], required: true },
      { kind: "products", files: ["04-products.csv", "products.csv"], required: true },
      { kind: "opening_stock", files: ["05-opening-stock.csv", "opening_stock.csv"], required: false },
      { kind: "opening_fixed_assets", files: ["06-opening-fixed-assets.csv", "opening_fixed_assets.csv"], required: false },
      { kind: "opening_treasury", files: ["07-opening-treasury.csv", "opening_treasury.csv"], required: false },
    ];

    console.log("\n=== CUTOVER IMPORT SEQUENCE (DRY-RUN -> COMMIT) ===");
    for (const step of steps) {
      const file = resolveCsvFile(step.files, step.required);
      if (!file) {
        console.log(`  [SKIP] ${step.kind} (optional CSV not present)`);
        continue;
      }

      const dry = await injectJson(app, "POST", `/api/imports/${step.kind}`, adminHeaders, {
        csv: file.content,
        dryRun: true,
      });
      if (!dry.valid) {
        console.error(`  [FAIL] ${step.kind} dry-run failed (${dry.errors.length} errors):`);
        for (const e of dry.errors) {
          console.error(`         Row ${e.row} [${e.column}]: ${e.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const committed = await injectJson(app, "POST", `/api/imports/${step.kind}`, adminHeaders, {
        csv: file.content,
        dryRun: false,
      });
      assert.equal(committed.valid, true, `${step.kind} commit must succeed`);
      console.log(
        `  [OK]   ${step.kind.padEnd(22)} | rows=${String(committed.totalRows).padStart(3)} | created=${committed.createdCount} updated=${committed.updatedCount} warnings=${committed.warnings.length}`
      );
    }

    // Step 8: Unified Opening Balances (TB + Open AR + Open AP)
    const tbFile = resolveCsvFile(["08-opening-trial-balance.csv", "opening_trial_balance.csv"], true);
    const arFile = resolveCsvFile(["09-opening-ar.csv", "opening_ar.csv"], false);
    const apFile = resolveCsvFile(["10-opening-ap.csv", "opening_ap.csv"], false);

    const openDry = await injectJson(app, "POST", "/api/imports/opening-balances", adminHeaders, {
      cutoverDate,
      allowPnlAccounts,
      trialBalanceCsv: tbFile.content,
      openArCsv: arFile?.content ?? "",
      openApCsv: apFile?.content ?? "",
      dryRun: true,
    });
    if (!openDry.valid) {
      console.error(`  [FAIL] opening_balances dry-run failed (${openDry.errors.length} errors):`);
      for (const e of openDry.errors) {
        console.error(`         Row ${e.row} [${e.column}]: ${e.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const openCommit = await injectJson(app, "POST", "/api/imports/opening-balances", adminHeaders, {
      cutoverDate,
      allowPnlAccounts,
      trialBalanceCsv: tbFile.content,
      openArCsv: arFile?.content ?? "",
      openApCsv: apFile?.content ?? "",
      dryRun: false,
    });
    assert.equal(openCommit.valid, true, "opening_balances commit must succeed");
    console.log(
      `  [OK]   ${"opening_balances".padEnd(22)} | JE=${openCommit.journalEntryNumber} | Dr=${fmt(openCommit.totalDebits)} Cr=${fmt(openCommit.totalCredits)} ${currency}`
    );

    // Fetch verification reports
    const [tb, reconciliation, setupHealth, auditChain] = await Promise.all([
      injectJson(app, "GET", "/api/accounting/reports/trial-balance", adminHeaders),
      injectJson(app, "GET", "/api/accounting/reports/reconciliation", adminHeaders),
      injectJson(app, "GET", "/api/accounting/setup-health", adminHeaders),
      injectJson(app, "GET", "/api/audit-logs/verify", adminHeaders),
    ]);

    console.log("\n================================================================================");
    console.log(`1. OPENING TRIAL BALANCE (${currency}, CUTOVER ${cutoverDate})`);
    console.log("================================================================================");
    for (const r of tb.rows) {
      if (r.debit === 0 && r.credit === 0) continue;
      console.log(
        `  ${r.code.padEnd(6)} ${r.name.padEnd(36)} | DR ${fmt(r.debit).padStart(12)} | CR ${fmt(r.credit).padStart(12)}`
      );
    }
    console.log(`  ${"TOTAL".padEnd(43)} | DR ${fmt(tb.totalDebit).padStart(12)} | CR ${fmt(tb.totalCredit).padStart(12)} | Balanced=${tb.isBalanced}`);

    console.log("\n================================================================================");
    console.log(`2. SUBLEDGER-TO-GL RECONCILIATION (ALL 8 CONTROLS — ${currency})`);
    console.log("================================================================================");
    for (const item of reconciliation.items) {
      const status = item.isReconciled ? "PASS" : "FAIL";
      console.log(
        `  [${status}] ${item.key.padEnd(25)} (${item.glAccountCode.padEnd(10)}) | Sub=${fmt(item.subledgerBalance).padStart(11)} | GL=${fmt(item.glBalance).padStart(11)} | Var=${fmt(item.variance).padStart(8)}`
      );
    }
    console.log(`  All 8 Controls Reconciled: ${reconciliation.allReconciled}`);

    console.log("\n================================================================================");
    console.log("3. ACCOUNTING SETUP HEALTH");
    console.log("================================================================================");
    console.log(`  Healthy       : ${setupHealth.healthy}`);
    console.log(`  Valid Mappings: ${setupHealth.validMappings} / ${setupHealth.totalMappings}`);
    for (const issue of setupHealth.issues) {
      console.log(`  [ISSUE] ${issue.mappingKey} (${issue.status}): ${issue.instructions}`);
    }

    console.log("\n================================================================================");
    console.log("4. AUDIT LOG HASH CHAIN VERIFICATION");
    console.log("================================================================================");
    console.log(`  Chain Valid   : ${auditChain.valid}`);
    console.log(`  Chained Rows  : ${auditChain.totalChainedRows}`);
    console.log(`  First Broken  : ${auditChain.firstBrokenId ?? "None"}`);

    // Hard assertions
    assert.equal(tb.isBalanced, true, "Opening Trial Balance must be balanced");
    assert.equal(reconciliation.items.length, 8, "Reconciliation report must contain all 8 controls");
    assert.equal(reconciliation.allReconciled, true, "All 8 reconciliation controls must PASS after opening cutover");
    assert.equal(setupHealth.healthy, true, "Accounting setup health must be healthy after cutover");
    assert.equal(auditChain.valid, true, "Audit log hash chain must remain valid after cutover");

    console.log("\n[rehearse:cutover] ALL CHECKS PASSED (Trial Balance, 8/8 Reconciliation, Setup Health, Audit Chain).");
  } finally {
    await app.close();
    await closeDatabase();
    unregisterTsx();
  }
}

main().catch((err) => {
  console.error("[rehearse:cutover] FAILED:", err);
  process.exit(1);
});
