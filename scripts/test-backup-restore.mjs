#!/usr/bin/env node
/**
 * Automated PostgreSQL backup/restore (including erp_uploads volume/dir)
 * and Migration 0007 upgrade verification test.
 *
 * Works in two environments automatically:
 *  1. CI / Linux / macOS with RESTORE_TEST_ADMIN_URL + native pg_dump/pg_restore
 *  2. Local workstations (including Windows) via ephemeral postgres:17-alpine Docker container
 *
 * Optional flags:
 *  --dev-copy   Also pg_dump the current dev DATABASE_URL (from backend/.env or env)
 *               into an isolated scratch database, run Drizzle migrations, and verify
 *               row counts, COMP-01 backfill, and balanced trial balance.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const migrationsDir = path.resolve(repoRoot, "backend/drizzle/migrations");
const journalPath = path.join(migrationsDir, "meta/_journal.json");

const DEFAULT_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const INCLUDE_DEV_COPY = process.argv.includes("--dev-copy");

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function getPgClientMajorVersion(cmd) {
  const res = spawnSync(cmd, ["--version"], { stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) return 0;
  const m = String(res.stdout ?? "").match(/(\d+)\./);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function resolveDockerBin() {
  const candidates = [
    "docker",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "DockerDesktop",
      "resources",
      "bin",
      "docker.exe"
    ),
  ];
  for (const bin of candidates) {
    if (!bin) continue;
    const res = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (res.status === 0) return bin;
  }
  return null;
}

function splitDrizzleSql(rawSql) {
  return rawSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildDbUrlWithName(baseUrl, dbName) {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function waitForPostgres(url, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sql = postgres(url, { max: 1, connect_timeout: 3 });
    try {
      await sql`SELECT 1`;
      await sql.end();
      return;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw new Error("Timed out waiting for scratch PostgreSQL to accept connections");
}

async function applyJournalMigrations(sql, entries) {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const appliedRows = await sql.unsafe(
    `SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`
  );
  const lastApplied = appliedRows[0] ? Number(appliedRows[0].created_at) : -1;

  for (const entry of entries) {
    if (entry.when <= lastApplied) continue;
    const sqlFile = path.join(migrationsDir, `${entry.tag}.sql`);
    const raw = fs.readFileSync(sqlFile, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    const statements = splitDrizzleSql(raw);

    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx.unsafe(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
        [hash, entry.when]
      );
    });
  }
}

async function seedRealisticPre0007Data(sql) {
  const adminId = "11111111-1111-4111-8111-111111111111";
  const clerkId = "22222222-2222-4222-8222-222222222222";
  const hqBranchId = "33333333-3333-4333-8333-333333333331";
  const retailBranchId = "33333333-3333-4333-8333-333333333332";
  const prodAId = "44444444-4444-4444-8444-444444444441";
  const prodBId = "44444444-4444-4444-8444-444444444442";
  const custId = "55555555-5555-4555-8555-555555555551";
  const vendId = "66666666-6666-4666-8666-666666666661";
  const coaCashId = "77777777-7777-4777-8777-777777777701";
  const coaArId = "77777777-7777-4777-8777-777777777702";
  const coaInvId = "77777777-7777-4777-8777-777777777703";
  const coaApId = "77777777-7777-4777-8777-777777777704";
  const coaRevId = "77777777-7777-4777-8777-777777777705";
  const coaCogsId = "77777777-7777-4777-8777-777777777706";
  const invId = "88888888-8888-4888-8888-888888888801";
  const poId = "88888888-8888-4888-8888-888888888802";
  const je1Id = "99999999-9999-4999-8999-999999999901";
  const je2Id = "99999999-9999-4999-8999-999999999902";

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO public.branches (id, code, name, branch_type, is_default, is_active)
      VALUES
        (${hqBranchId}, 'HQ-01', 'Headquarters Warehouse', 'hq_warehouse', true, true),
        (${retailBranchId}, 'RET-01', 'Downtown Retail', 'retail', false, true)
    `;

    await tx`
      INSERT INTO public.company_settings (id, company_name, legal_name, base_currency, default_branch_id)
      VALUES (1, 'Acme Pre-0007 Trading', 'Acme Trading LLC', 'USD', ${hqBranchId})
      ON CONFLICT (id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        legal_name = EXCLUDED.legal_name,
        default_branch_id = EXCLUDED.default_branch_id
    `;

    await tx`
      INSERT INTO public.users (id, email, name, password_hash, email_verified, is_active, default_branch_id)
      VALUES
        (${adminId}, 'admin@pre0007.local', 'Legacy Admin', 'scrypt$test$hash1', true, true, ${hqBranchId}),
        (${clerkId}, 'clerk@pre0007.local', 'Legacy Clerk', 'scrypt$test$hash2', true, true, ${retailBranchId})
    `;

    await tx`
      INSERT INTO public.user_roles (user_id, role)
      VALUES (${adminId}, 'admin'), (${clerkId}, 'user')
    `;

    await tx`
      INSERT INTO public.products (id, sku, name, category, unit, cost_price, selling_price)
      VALUES
        (${prodAId}, 'SKU-PRE-001', 'Industrial Valve A', 'Hardware', 'pcs', '40.0000', '75.0000'),
        (${prodBId}, 'SKU-PRE-002', 'Hydraulic Hose B', 'Hardware', 'pcs', '15.0000', '30.0000')
    `;

    await tx`
      INSERT INTO public.branch_products (branch_id, product_id, qty_on_hand, avg_cost)
      VALUES
        (${hqBranchId}, ${prodAId}, '50.0000', '40.0000'),
        (${hqBranchId}, ${prodBId}, '100.0000', '15.0000'),
        (${retailBranchId}, ${prodAId}, '12.0000', '40.0000')
    `;

    await tx`
      INSERT INTO public.customers (id, code, name, email, currency)
      VALUES (${custId}, 'CUS-PRE-001', 'Atlas Construction', 'ap@atlas.local', 'USD')
    `;

    await tx`
      INSERT INTO public.vendors (id, code, name, email, currency)
      VALUES (${vendId}, 'VND-PRE-001', 'Global Parts Supply', 'ar@globalparts.local', 'USD')
    `;

    await tx`
      INSERT INTO public.purchase_orders (id, po_number, vendor_id, branch_id, status, subtotal, tax_total, total_amount, created_by)
      VALUES (${poId}, 'PO-PRE-0001', ${vendId}, ${hqBranchId}, 'Issued', '3500.0000', '0.0000', '3500.0000', ${adminId})
    `;

    await tx`
      INSERT INTO public.sales_invoices (id, invoice_number, customer_id, branch_id, status, due_date, subtotal, tax_total, total_amount, created_by)
      VALUES (${invId}, 'INV-PRE-0001', ${custId}, ${retailBranchId}, 'Sent', now() + interval '30 days', '750.0000', '0.0000', '750.0000', ${adminId})
    `;

    await tx`
      INSERT INTO public.stock_movements (branch_id, product_id, movement_type, qty_delta, unit_cost, balance_after, avg_cost_after, reference_type, reference_id, reference_number, created_by)
      VALUES
        (${hqBranchId}, ${prodAId}, 'purchase_receive', '50.0000', '40.0000', '50.0000', '40.0000', 'purchase_order', ${poId}, 'PO-PRE-0001', ${adminId}),
        (${retailBranchId}, ${prodAId}, 'sales_invoice', '-10.0000', '40.0000', '12.0000', '40.0000', 'sales_invoice', ${invId}, 'INV-PRE-0001', ${adminId})
    `;

    await tx`
      INSERT INTO public.chart_of_accounts (id, code, name, account_type, normal_balance, is_system)
      VALUES
        (${coaCashId}, '1000', 'Cash & Bank', 'asset', 'debit', true),
        (${coaArId}, '1100', 'Accounts Receivable', 'asset', 'debit', true),
        (${coaInvId}, '1200', 'Inventory Asset', 'asset', 'debit', true),
        (${coaApId}, '2000', 'Accounts Payable', 'liability', 'credit', true),
        (${coaRevId}, '4000', 'Sales Revenue', 'revenue', 'credit', true),
        (${coaCogsId}, '5000', 'Cost of Goods Sold', 'expense', 'debit', true)
    `;

    await tx`
      INSERT INTO public.journal_entries (id, entry_number, branch_id, source_type, source_id, reference_number, memo, status, created_by)
      VALUES
        (${je1Id}, 'JE-PRE-0001', ${hqBranchId}, 'purchase_receive', ${poId}, 'PO-PRE-0001', 'Initial stock receipt', 'posted', ${adminId}),
        (${je2Id}, 'JE-PRE-0002', ${retailBranchId}, 'sales_invoice', ${invId}, 'INV-PRE-0001', 'Customer invoice + COGS', 'posted', ${adminId})
    `;

    await tx`
      INSERT INTO public.journal_lines (entry_id, account_id, branch_id, debit_base, credit_base, debit_tx, credit_tx, description)
      VALUES
        (${je1Id}, ${coaInvId}, ${hqBranchId}, '3500.0000', '0.0000', '3500.0000', '0.0000', 'Inventory received'),
        (${je1Id}, ${coaApId}, ${hqBranchId}, '0.0000', '3500.0000', '0.0000', '3500.0000', 'Vendor accrual'),
        (${je2Id}, ${coaArId}, ${retailBranchId}, '750.0000', '0.0000', '750.0000', '0.0000', 'AR from INV-PRE-0001'),
        (${je2Id}, ${coaRevId}, ${retailBranchId}, '0.0000', '750.0000', '0.0000', '750.0000', 'Revenue from INV-PRE-0001'),
        (${je2Id}, ${coaCogsId}, ${retailBranchId}, '400.0000', '0.0000', '400.0000', '0.0000', 'COGS for 10 units'),
        (${je2Id}, ${coaInvId}, ${retailBranchId}, '0.0000', '400.0000', '0.0000', '400.0000', 'Inventory reduction')
    `;

    await tx`
      INSERT INTO public.audit_logs (user_id, user_name, user_role, branch_id, action, entity_type, entity_id, entity_label)
      VALUES
        (${adminId}, 'Legacy Admin', 'admin', ${hqBranchId}, 'purchase_order.created', 'purchase_order', ${poId}, 'PO-PRE-0001'),
        (${adminId}, 'Legacy Admin', 'admin', ${retailBranchId}, 'sales_invoice.created', 'sales_invoice', ${invId}, 'INV-PRE-0001')
    `;
  });
}

const VERIFY_TABLES = [
  "users",
  "user_roles",
  "branches",
  "products",
  "branch_products",
  "customers",
  "vendors",
  "purchase_orders",
  "sales_invoices",
  "stock_movements",
  "chart_of_accounts",
  "journal_entries",
  "journal_lines",
  "audit_logs",
];

const COMPANY_SCOPED_TABLES = [
  "branches",
  "products",
  "branch_products",
  "customers",
  "vendors",
  "purchase_orders",
  "sales_invoices",
  "stock_movements",
  "chart_of_accounts",
  "journal_entries",
  "audit_logs",
];

async function captureSnapshot(sql) {
  const counts = {};
  for (const t of VERIFY_TABLES) {
    const [{ cnt }] = await sql.unsafe(`SELECT count(*)::int AS cnt FROM public."${t}"`);
    counts[t] = cnt;
  }
  const [tb] = await sql`
    SELECT
      coalesce(sum(jl.debit_base), 0)::numeric(18,4) AS total_debit,
      coalesce(sum(jl.credit_base), 0)::numeric(18,4) AS total_credit,
      count(*)::int AS line_count
    FROM public.journal_lines jl
    INNER JOIN public.journal_entries je ON je.id = jl.entry_id
    WHERE je.status = 'posted'
  `;
  const totalDebit = Number(tb.total_debit);
  const totalCredit = Number(tb.total_credit);
  return {
    counts,
    trialBalance: {
      totalDebit,
      totalCredit,
      lineCount: tb.line_count,
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.0001,
    },
  };
}

async function verifyComp01Backfill(sql) {
  const [comp] = await sql`
    SELECT id, code, name, is_default, is_active
    FROM public.companies
    WHERE id = ${DEFAULT_COMPANY_ID}
  `;
  assert.ok(comp, "Default company COMP-01 must exist after migration 0007");
  assert.equal(comp.code, "COMP-01");
  assert.equal(comp.is_default, true);

  const nullChecks = {};
  for (const t of COMPANY_SCOPED_TABLES) {
    const [{ null_cnt, comp01_cnt }] = await sql.unsafe(
      `SELECT
        count(*) FILTER (WHERE company_id IS NULL)::int AS null_cnt,
        count(*) FILTER (WHERE company_id = '${DEFAULT_COMPANY_ID}')::int AS comp01_cnt
       FROM public."${t}"`
    );
    assert.equal(null_cnt, 0, `Table public.${t} has ${null_cnt} rows with NULL company_id`);
    nullChecks[t] = { nullCount: null_cnt, comp01Count: comp01_cnt };
  }

  const [{ uc_cnt }] = await sql`
    SELECT count(*)::int AS uc_cnt FROM public.user_companies WHERE company_id = ${DEFAULT_COMPANY_ID}
  `;
  const [{ user_cnt }] = await sql`SELECT count(*)::int AS user_cnt FROM public.users`;
  assert.ok(uc_cnt >= user_cnt, `Expected user_companies (${uc_cnt}) >= users (${user_cnt})`);

  return { company: comp, userCompaniesCount: uc_cnt, tableChecks: nullChecks };
}

function redactUrls(text) {
  return String(text ?? "").replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi, "$1:[REDACTED]@");
}

function runCmd(bin, args, opts = {}) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  } catch (err) {
    const stderr = err?.stderr ? redactUrls(err.stderr) : "";
    const msg = redactUrls(err?.message ?? String(err));
    throw new Error(`${msg}${stderr ? `\n${stderr}` : ""}`);
  }
}

async function main() {
  const runTag = `${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-restore-test-${runTag}-`));
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const pre0007Entries = journal.entries.filter((e) => e.idx <= 6);
  const mig0007Entry = journal.entries.find((e) => e.idx === 7);
  assert.ok(pre0007Entries.length === 7, "Expected migrations 0000..0006 in _journal.json");
  assert.ok(mig0007Entry, "Expected migration 0007 in _journal.json");

  const nativePgDumpMajor = getPgClientMajorVersion("pg_dump");
  const nativePgRestoreMajor = getPgClientMajorVersion("pg_restore");
  const hasNativePg18Tools = nativePgDumpMajor >= 18 && nativePgRestoreMajor >= 18;
  const adminEnvUrl = (process.env.RESTORE_TEST_ADMIN_URL ?? "").trim();
  const dockerBin = resolveDockerBin();

  let mode = "native";
  let containerName = null;
  let adminUrl = adminEnvUrl;
  const createdDbs = [];

  try {
    if (adminEnvUrl && hasNativePg18Tools) {
      mode = "native";
    } else if (adminEnvUrl && dockerBin) {
      // CI service container (PG 18) with older host postgresql-client -> run PG 18 client via Docker
      mode = "ci-docker-client";
    } else {
      if (!dockerBin) {
        throw new Error(
          "Neither native pg_dump/pg_restore (>= 18) + RESTORE_TEST_ADMIN_URL nor Docker Desktop is available."
        );
      }
      mode = "docker";
      containerName = `erp_restore_test_${runTag}`;
      const port = 55400 + Math.floor(Math.random() * 400);
      runCmd(dockerBin, [
        "run",
        "-d",
        "--name",
        containerName,
        "-e",
        "POSTGRES_USER=erp",
        "-e",
        "POSTGRES_PASSWORD=erp_scratch_pw",
        "-e",
        "POSTGRES_DB=postgres",
        "-p",
        `127.0.0.1:${port}:5432`,
        "-v",
        `${tmpDir}:/work`,
        "postgres:18-alpine",
      ]);
      adminUrl = `postgresql://erp:erp_scratch_pw@127.0.0.1:${port}/postgres`;
      await waitForPostgres(adminUrl);
    }

    const adminSql = postgres(adminUrl, { max: 1 });
    const srcDbName = `erp_pre0007_src_${runTag}`;
    const dstDbName = `erp_post0007_dst_${runTag}`;
    const devDstDbName = `erp_devcopy_dst_${runTag}`;

    const createScratchDb = async (name) => {
      await adminSql.unsafe(`CREATE DATABASE "${name}"`);
      createdDbs.push(name);
      return buildDbUrlWithName(adminUrl, name);
    };

    const pgDumpToFile = (dbName, outFileName, externalUrl = null) => {
      const hostPath = path.join(tmpDir, outFileName);
      if (mode === "native") {
        runCmd("pg_dump", [
          "-Fc",
          "--no-owner",
          "--no-privileges",
          `--dbname=${externalUrl ?? buildDbUrlWithName(adminUrl, dbName)}`,
          `--file=${hostPath}`,
        ]);
      } else if (mode === "ci-docker-client") {
        const target = externalUrl ?? buildDbUrlWithName(adminUrl, dbName);
        runCmd(dockerBin, [
          "run",
          "--rm",
          "--network",
          "host",
          "-v",
          `${tmpDir}:/work`,
          "postgres:18-alpine",
          "pg_dump",
          "-Fc",
          "--no-owner",
          "--no-privileges",
          `--dbname=${target}`,
          `--file=/work/${outFileName}`,
        ]);
      } else {
        const target = externalUrl ?? `postgresql://erp:erp_scratch_pw@127.0.0.1:5432/${dbName}`;
        runCmd(dockerBin, [
          "exec",
          containerName,
          "pg_dump",
          "-Fc",
          "--no-owner",
          "--no-privileges",
          `--dbname=${target}`,
          `--file=/work/${outFileName}`,
        ]);
      }
      assert.ok(fs.existsSync(hostPath) && fs.statSync(hostPath).size > 0, "Backup dump file must be non-empty");
      if (mode === "native") {
        runCmd("pg_restore", ["-l", hostPath]);
      } else if (mode === "ci-docker-client") {
        runCmd(dockerBin, [
          "run",
          "--rm",
          "-v",
          `${tmpDir}:/work`,
          "postgres:18-alpine",
          "pg_restore",
          "-l",
          `/work/${outFileName}`,
        ]);
      } else {
        runCmd(dockerBin, ["exec", containerName, "pg_restore", "-l", `/work/${outFileName}`]);
      }
      return { hostPath, sizeBytes: fs.statSync(hostPath).size, sha256: sha256File(hostPath) };
    };

    const pgRestoreFromFile = (dbName, inFileName) => {
      if (mode === "native") {
        runCmd("pg_restore", [
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=${buildDbUrlWithName(adminUrl, dbName)}`,
          path.join(tmpDir, inFileName),
        ]);
      } else if (mode === "ci-docker-client") {
        runCmd(dockerBin, [
          "run",
          "--rm",
          "--network",
          "host",
          "-v",
          `${tmpDir}:/work`,
          "postgres:18-alpine",
          "pg_restore",
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=${buildDbUrlWithName(adminUrl, dbName)}`,
          `/work/${inFileName}`,
        ]);
      } else {
        runCmd(dockerBin, [
          "exec",
          containerName,
          "pg_restore",
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=postgresql://erp:erp_scratch_pw@127.0.0.1:5432/${dbName}`,
          `/work/${inFileName}`,
        ]);
      }
    };

    try {
      // =========================================================================
      // PROOF A: Realistic Pre-0007 (0000..0006) -> pg_dump -> pg_restore -> 0007
      // =========================================================================
      const srcUrl = await createScratchDb(srcDbName);
      const srcSql = postgres(srcUrl, { max: 1 });
      let pre0007Snapshot;
      try {
        await applyJournalMigrations(srcSql, pre0007Entries);
        await seedRealisticPre0007Data(srcSql);
        pre0007Snapshot = await captureSnapshot(srcSql);
      } finally {
        await srcSql.end();
      }
      assert.equal(pre0007Snapshot.trialBalance.isBalanced, true, "Pre-0007 trial balance must be balanced");
      assert.equal(pre0007Snapshot.trialBalance.totalDebit, 4650, "Pre-0007 debit total should be 4650");
      assert.equal(pre0007Snapshot.trialBalance.totalCredit, 4650, "Pre-0007 credit total should be 4650");

      // Simulate erp_uploads volume/directory backup & restore
      const srcUploadsDir = path.join(tmpDir, "uploads_src");
      const dstUploadsDir = path.join(tmpDir, "uploads_dst");
      fs.mkdirSync(path.join(srcUploadsDir, DEFAULT_COMPANY_ID, "sales_invoice", "inv-1"), { recursive: true });
      fs.mkdirSync(dstUploadsDir, { recursive: true });
      const sampleFileRel = path.join(DEFAULT_COMPANY_ID, "sales_invoice", "inv-1", "receipt-sample.pdf");
      const sampleFileSrc = path.join(srcUploadsDir, sampleFileRel);
      fs.writeFileSync(sampleFileSrc, Buffer.from("%PDF-1.4\n% Realistic invoice attachment payload\n%%EOF\n"));
      const expectedUploadSha = sha256File(sampleFileSrc);

      const uploadsArchiveName = `erp_uploads_${runTag}.tar.gz`;
      const uploadsArchivePath = path.join(tmpDir, uploadsArchiveName);
      runCmd("tar", ["-czf", uploadsArchivePath, "-C", srcUploadsDir, "."]);
      const uploadsArchiveSha = sha256File(uploadsArchivePath);
      runCmd("tar", ["-xzf", uploadsArchivePath, "-C", dstUploadsDir]);
      const restoredUploadSha = sha256File(path.join(dstUploadsDir, sampleFileRel));
      assert.equal(restoredUploadSha, expectedUploadSha, "Restored upload file SHA-256 must match source");

      // Dump pre-0007 DB and restore into clean scratch DB
      const dumpMeta = pgDumpToFile(srcDbName, `pre0007_${runTag}.dump`);
      const dstUrl = await createScratchDb(dstDbName);
      pgRestoreFromFile(dstDbName, `pre0007_${runTag}.dump`);

      // Apply migration 0007 to restored scratch DB and verify
      const dstSql = postgres(dstUrl, { max: 1 });
      let post0007Snapshot;
      let backfillReport;
      try {
        await applyJournalMigrations(dstSql, [mig0007Entry]);
        // Re-running full journal must be an idempotent no-op
        await applyJournalMigrations(dstSql, journal.entries);
        post0007Snapshot = await captureSnapshot(dstSql);
        backfillReport = await verifyComp01Backfill(dstSql);
      } finally {
        await dstSql.end();
      }

      for (const t of VERIFY_TABLES) {
        assert.equal(
          post0007Snapshot.counts[t],
          pre0007Snapshot.counts[t],
          `Row count mismatch on public.${t}: before=${pre0007Snapshot.counts[t]}, after=${post0007Snapshot.counts[t]}`
        );
      }
      assert.equal(post0007Snapshot.trialBalance.isBalanced, true, "Post-0007 trial balance must be balanced");
      assert.equal(
        post0007Snapshot.trialBalance.totalDebit,
        pre0007Snapshot.trialBalance.totalDebit,
        "Post-0007 total debit must equal pre-0007 total debit"
      );
      assert.equal(
        post0007Snapshot.trialBalance.totalCredit,
        pre0007Snapshot.trialBalance.totalCredit,
        "Post-0007 total credit must equal pre-0007 total credit"
      );

      // =========================================================================
      // PROOF B (optional --dev-copy): Restore copy of live dev DB into scratch DB
      // =========================================================================
      let devCopyReport = null;
      if (INCLUDE_DEV_COPY) {
        dotenv.config({ path: path.resolve(repoRoot, "backend/.env") });
        const devUrl = (process.env.DEV_SOURCE_DATABASE_URL || process.env.DATABASE_URL || "").trim();
        assert.ok(devUrl, "DATABASE_URL (or DEV_SOURCE_DATABASE_URL) must be set for --dev-copy");

        const devSql = postgres(devUrl, { max: 1 });
        let devBefore;
        let devHad0007;
        try {
          devBefore = await captureSnapshot(devSql);
          const migRows = await devSql`SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations`;
          devHad0007 = migRows[0].cnt >= 8;
        } finally {
          await devSql.end();
        }

        const devDump = pgDumpToFile(null, `devcopy_${runTag}.dump`, devUrl);
        const devDstUrl = await createScratchDb(devDstDbName);
        pgRestoreFromFile(devDstDbName, `devcopy_${runTag}.dump`);

        const devDstSql = postgres(devDstUrl, { max: 1 });
        let devAfter;
        let devBackfill;
        try {
          await applyJournalMigrations(devDstSql, journal.entries);
          devAfter = await captureSnapshot(devDstSql);
          devBackfill = await verifyComp01Backfill(devDstSql);
        } finally {
          await devDstSql.end();
        }

        for (const t of VERIFY_TABLES) {
          assert.equal(
            devAfter.counts[t],
            devBefore.counts[t],
            `Dev copy row count mismatch on public.${t}: before=${devBefore.counts[t]}, after=${devAfter.counts[t]}`
          );
        }
        assert.equal(devAfter.trialBalance.isBalanced, true, "Dev copy trial balance must be balanced");
        assert.equal(devAfter.trialBalance.totalDebit, devBefore.trialBalance.totalDebit);
        assert.equal(devAfter.trialBalance.totalCredit, devBefore.trialBalance.totalCredit);

        devCopyReport = {
          devAlreadyHadMigration0007: devHad0007,
          dumpSizeBytes: devDump.sizeBytes,
          dumpSha256: devDump.sha256,
          countsBefore: devBefore.counts,
          countsAfter: devAfter.counts,
          trialBalanceBefore: devBefore.trialBalance,
          trialBalanceAfter: devAfter.trialBalance,
          comp01Verified: devBackfill.company.code === "COMP-01",
          userCompaniesCount: devBackfill.userCompaniesCount,
        };
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            mode,
            pre0007To0007Proof: {
              dumpSizeBytes: dumpMeta.sizeBytes,
              dumpSha256: dumpMeta.sha256,
              uploadsArchiveSha256: uploadsArchiveSha,
              uploadsRestoredMatch: restoredUploadSha === expectedUploadSha,
              countsBefore: pre0007Snapshot.counts,
              countsAfter: post0007Snapshot.counts,
              trialBalanceBefore: pre0007Snapshot.trialBalance,
              trialBalanceAfter: post0007Snapshot.trialBalance,
              comp01: backfillReport.company,
              userCompaniesBackfilled: backfillReport.userCompaniesCount,
              drizzleMigrateIdempotent: true,
            },
            devCopyProof: devCopyReport,
          },
          null,
          2
        )
      );
    } finally {
      if (mode === "native" || mode === "ci-docker-client") {
        for (const name of createdDbs) {
          await adminSql
            .unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
            .catch(() => {});
        }
      }
      await adminSql.end({ timeout: 5 }).catch(() => {});
    }
  } finally {
    if (containerName && dockerBin) {
      spawnSync(dockerBin, ["rm", "-f", containerName], { stdio: "ignore" });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Backup/restore & migration 0007 test failed:", err);
  process.exit(1);
});
