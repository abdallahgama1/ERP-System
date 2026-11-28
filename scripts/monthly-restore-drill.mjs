#!/usr/bin/env node
/**
 * Monthly Off-Site Encrypted Backup Restore Drill
 *
 * Restores the latest off-site encrypted backup from S3-compatible storage
 * (Cloudflare R2, MinIO, AWS S3) — or from a local backup directory with --local-dir —
 * into an isolated scratch PostgreSQL 18 database, runs Drizzle migrations, and verifies:
 *   1. SHA-256 checksums + AES-256-GCM decryption (customer-held BACKUP_ENCRYPTION_KEY)
 *   2. pg_restore --clean --single-transaction --exit-on-error + uploads archive extraction
 *   3. Forward-only Drizzle migrations applied cleanly
 *   4. All 8 Subledger-to-GL reconciliation controls pass
 *   5. Accounting Setup Health (28/28 mappings healthy)
 *   6. Tamper-evident Audit Log SHA-256 hash chain valid
 *
 * Usage:
 *   npm run drill:restore
 *   node scripts/monthly-restore-drill.mjs [--local-dir <dir>] [--admin-url <postgres-url>]
 *
 * Env vars:
 *   BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION,
 *   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_FORCE_PATH_STYLE,
 *   BACKUP_S3_PREFIX, BACKUP_ENCRYPTION_KEY
 *   DRILL_ADMIN_DATABASE_URL             Optional existing Postgres 18 admin DB URL (defaults to ephemeral Docker PG 18)
 *   RESTORE_DRILL_HEALTHCHECK_PING_URL   Optional dedicated healthchecks.io URL for monthly restore drills
 *   HEALTHCHECK_PING_URL                 Fallback healthchecks.io URL if RESTORE_DRILL_HEALTHCHECK_PING_URL is unset
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { decryptFile, downloadLatestBackupSet, parseBackupEncryptionKey } from "./backup-offsite.mjs";
import { pingHealthcheck } from "./lib/healthcheck-ping.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const migrationsDir = path.resolve(repoRoot, "backend/drizzle/migrations");
const journalPath = path.join(migrationsDir, "meta/_journal.json");

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
    const stdout = err?.stdout ? redactUrls(err.stdout) : "";
    const msg = redactUrls(err?.message ?? String(err));
    throw new Error(`${msg}${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`);
  }
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
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
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
  throw new Error("Timed out waiting for scratch PostgreSQL container to become ready");
}

function splitDrizzleSql(rawSql) {
  return rawSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  let newlyApplied = 0;

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
    newlyApplied += 1;
  }

  return newlyApplied;
}

async function resolveLocalBackupSet(localDir, outDir) {
  const files = await fsp.readdir(localDir);
  const dumps = files
    .filter((f) => /^erp_backup_.+\.dump(\.enc)?$/.test(f))
    .sort((a, b) => b.localeCompare(a));
  if (dumps.length === 0) {
    throw new Error(`No erp_backup_*.dump(.enc) files found in ${localDir}`);
  }
  const latestDumpName = dumps[0];
  const srcDumpPath = path.join(localDir, latestDumpName);
  let dbFilePath;
  if (latestDumpName.endsWith(".enc")) {
    const keyBuf = parseBackupEncryptionKey();
    dbFilePath = path.join(outDir, latestDumpName.slice(0, -4));
    await decryptFile(srcDumpPath, dbFilePath, keyBuf);
  } else {
    dbFilePath = path.join(outDir, latestDumpName);
    await fsp.copyFile(srcDumpPath, dbFilePath);
  }

  const tsMatch = latestDumpName.match(/erp_backup_([^.]+)\.dump/);
  const timestamp = tsMatch ? tsMatch[1] : null;
  let uploadsFilePath = null;
  if (timestamp) {
    const plainUp = `erp_uploads_${timestamp}.tar.gz`;
    const encUp = `${plainUp}.enc`;
    if (files.includes(encUp)) {
      const keyBuf = parseBackupEncryptionKey();
      uploadsFilePath = path.join(outDir, plainUp);
      await decryptFile(path.join(localDir, encUp), uploadsFilePath, keyBuf);
    } else if (files.includes(plainUp)) {
      uploadsFilePath = path.join(outDir, plainUp);
      await fsp.copyFile(path.join(localDir, plainUp), uploadsFilePath);
    }
  }

  const stat = await fsp.stat(srcDumpPath);
  return {
    source: "local",
    manifest: {
      timestamp,
      completedAt: stat.mtime.toISOString(),
      encrypted: latestDumpName.endsWith(".enc"),
      db: { fileName: path.basename(dbFilePath) },
      uploads: uploadsFilePath ? { fileName: path.basename(uploadsFilePath) } : null,
    },
    dbFilePath,
    uploadsFilePath,
  };
}

export async function runMonthlyRestoreDrill(options = {}) {
  const startedAt = Date.now();
  const healthcheckPingUrl = (
    options.healthcheckPingUrl ??
    process.env.RESTORE_DRILL_HEALTHCHECK_PING_URL ??
    process.env.HEALTHCHECK_PING_URL ??
    ""
  ).trim();
  const runTag = `${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `erp-restore-drill-${runTag}-`));
  const downloadDir = path.join(tmpDir, "backup");
  const uploadsExtractDir = path.join(tmpDir, "uploads_restored");
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.mkdir(uploadsExtractDir, { recursive: true });

  const localDir = options.localDir ?? null;
  const adminEnvUrl = (options.adminUrl ?? process.env.DRILL_ADMIN_DATABASE_URL ?? "").trim();
  const nativePgRestoreMajor = getPgClientMajorVersion("pg_restore");
  const dockerBin = resolveDockerBin();

  let mode = "native";
  let containerName = null;
  let adminUrl = adminEnvUrl;
  let scratchDbName = `erp_drill_${runTag}`;

  try {
    // 1. Acquire & decrypt latest backup (off-site S3 by default, or --local-dir)
    const acquired = localDir
      ? await resolveLocalBackupSet(localDir, downloadDir)
      : { source: "offsite_s3", ...(await downloadLatestBackupSet({ outDir: downloadDir })) };

    const dbBaseName = path.basename(acquired.dbFilePath);
    assert.ok(fs.existsSync(acquired.dbFilePath) && fs.statSync(acquired.dbFilePath).size > 0, "Decrypted dump missing");

    // 2. Verify uploads archive if included
    let uploadsVerified = false;
    let uploadsFileCount = 0;
    if (acquired.uploadsFilePath && fs.existsSync(acquired.uploadsFilePath)) {
      runCmd("tar", ["-xzf", acquired.uploadsFilePath, "-C", uploadsExtractDir]);
      const walkCount = (dir) => {
        let count = 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) count += walkCount(full);
          else count += 1;
        }
        return count;
      };
      uploadsFileCount = walkCount(uploadsExtractDir);
      uploadsVerified = true;
    }

    // 3. Provision isolated scratch Postgres 18 database
    if (adminEnvUrl && nativePgRestoreMajor >= 18) {
      mode = "native";
    } else if (adminEnvUrl && dockerBin) {
      mode = "docker-client";
    } else {
      if (!dockerBin) {
        throw new Error(
          "Monthly restore drill requires either DRILL_ADMIN_DATABASE_URL + pg_restore (>=18) or Docker."
        );
      }
      mode = "docker-ephemeral";
      containerName = `erp_monthly_drill_${runTag}`;
      const port = 55500 + Math.floor(Math.random() * 350);
      runCmd(dockerBin, [
        "run",
        "-d",
        "--name",
        containerName,
        "-e",
        "POSTGRES_USER=erp",
        "-e",
        "POSTGRES_PASSWORD=erp_drill_pw",
        "-e",
        "POSTGRES_DB=postgres",
        "-p",
        `127.0.0.1:${port}:5432`,
        "-v",
        `${downloadDir}:/backup:ro`,
        "postgres:18-alpine",
      ]);
      adminUrl = `postgresql://erp:erp_drill_pw@127.0.0.1:${port}/postgres`;
      await waitForPostgres(adminUrl);
    }

    const adminSql = postgres(adminUrl, { max: 1 });
    let scratchUrl;
    try {
      await adminSql.unsafe(`CREATE DATABASE "${scratchDbName}"`);
      scratchUrl = buildDbUrlWithName(adminUrl, scratchDbName);

      // 4. Restore custom-format PostgreSQL dump into scratch DB
      if (mode === "native") {
        runCmd("pg_restore", [
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=${scratchUrl}`,
          acquired.dbFilePath,
        ]);
      } else if (mode === "docker-client") {
        const containerDbUrl = scratchUrl
          .replace("127.0.0.1", process.platform === "linux" ? "127.0.0.1" : "host.docker.internal")
          .replace("localhost", process.platform === "linux" ? "127.0.0.1" : "host.docker.internal");
        const netArgs = process.platform === "linux" ? ["--network", "host"] : [];
        runCmd(dockerBin, [
          "run",
          "--rm",
          ...netArgs,
          "-v",
          `${downloadDir}:/backup:ro`,
          "postgres:18-alpine",
          "pg_restore",
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=${containerDbUrl}`,
          `/backup/${dbBaseName}`,
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
          `--dbname=postgresql://erp:erp_drill_pw@127.0.0.1:5432/${scratchDbName}`,
          `/backup/${dbBaseName}`,
        ]);
      }

      // 5. Run forward-only Drizzle migrations idempotently on restored scratch DB
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      const scratchSql = postgres(scratchUrl, { max: 1 });
      let migrationsApplied = 0;
      try {
        migrationsApplied = await applyJournalMigrations(scratchSql, journal.entries);
      } finally {
        await scratchSql.end();
      }

      // 6. Verify reconciliation (8/8), setup health (28/28), and audit hash chain
      const tsxBin = path.join(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsx.cmd" : "tsx"
      );
      const verifyStdout = runCmd(
        process.platform === "win32" ? "cmd.exe" : tsxBin,
        process.platform === "win32"
          ? ["/c", tsxBin, path.join(scriptDir, "verify-restored-db.ts")]
          : [path.join(scriptDir, "verify-restored-db.ts")],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DATABASE_URL: scratchUrl,
            NODE_ENV: "test",
            AUTH_COOKIE_SECRET: "monthly-restore-drill-cookie-secret-32-chars",
          },
        }
      );

      // Extract the trailing JSON object from verify-restored-db output
      const jsonStart = verifyStdout.indexOf("{");
      assert.ok(jsonStart >= 0, `Unexpected verifier output: ${verifyStdout}`);
      const verification = JSON.parse(verifyStdout.slice(jsonStart));
      assert.equal(verification.ok, true, "Restored DB failed reconciliation, setup health, or audit chain check");

      const completedAtMs = acquired.manifest?.completedAt ? Date.parse(acquired.manifest.completedAt) : NaN;
      const rpoHours = Number.isFinite(completedAtMs)
        ? Math.round(((Date.now() - completedAtMs) / 3_600_000) * 100) / 100
        : null;
      const rtoSeconds = Math.round(((Date.now() - startedAt) / 1000) * 100) / 100;

      const report = {
        ok: true,
        drillDate: new Date().toISOString(),
        source: acquired.source,
        mode,
        backupTimestamp: acquired.manifest?.timestamp ?? null,
        backupCompletedAt: acquired.manifest?.completedAt ?? null,
        encrypted: Boolean(acquired.manifest?.encrypted),
        rpoHours,
        rtoSeconds,
        migrationsApplied,
        uploads: {
          included: Boolean(acquired.uploadsFilePath),
          verified: uploadsVerified,
          extractedFiles: uploadsFileCount,
        },
        verification,
      };

      if (healthcheckPingUrl) {
        await pingHealthcheck({
          url: healthcheckPingUrl,
          ok: true,
          body: `restore drill ok: source=${report.source} backup=${report.backupTimestamp ?? "unknown"} rpoHours=${report.rpoHours ?? "n/a"} rtoSeconds=${report.rtoSeconds} recon=${verification.reconciliation?.passedControls}/${verification.reconciliation?.totalControls} setupHealth=${verification.setupHealth?.validMappings}/${verification.setupHealth?.totalMappings} auditValid=${verification.auditChain?.valid}`,
        });
      }

      return report;
    } finally {
      if (mode !== "docker-ephemeral") {
        await adminSql.unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}" WITH (FORCE)`).catch(() => {});
      }
      await adminSql.end({ timeout: 5 }).catch(() => {});
    }
  } catch (err) {
    if (healthcheckPingUrl) {
      await pingHealthcheck({
        url: healthcheckPingUrl,
        ok: false,
        body: `restore drill failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    throw err;
  } finally {
    if (containerName && dockerBin) {
      spawnSync(dockerBin, ["rm", "-f", containerName], { stdio: "ignore" });
    }
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node scripts/monthly-restore-drill.mjs [--local-dir <dir>] [--admin-url <postgres-url>]`);
    process.exit(0);
  }
  runMonthlyRestoreDrill({
    localDir: opts["local-dir"] || null,
    adminUrl: opts["admin-url"] || undefined,
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(`[monthly-restore-drill] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
