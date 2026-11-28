import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../../src/db/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const testDbUrl = (process.env.TEST_DATABASE_URL ?? "").trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

function extractCookie(res: { headers: Record<string, unknown> }, name = "erp_session"): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const prefix = `${name}=`;
  const match = list.find((c) => c.startsWith(prefix));
  return match ? match.split(";")[0]! : "";
}

function authHeaders(res: { headers: Record<string, unknown> }) {
  const session = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrf = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrf ? `${session}; erp_csrf=${csrf}` : session,
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  };
}

/**
 * Minimal in-process S3-compatible HTTP mock server supporting PutObject, GetObject,
 * ListObjectsV2, and DeleteObjects (path-style: /<bucket>/<key>) to test Cloudflare R2 /
 * MinIO / AWS S3 off-site encrypted backup sync end-to-end without external network calls.
 */
async function startMockS3Server() {
  const objects = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();

  const xmlEscape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    const decodedBody = String(req.headers["content-encoding"] ?? "").includes("aws-chunked")
      ? (() => {
          const out: Buffer[] = [];
          let offset = 0;
          while (offset < rawBody.length) {
            const crlf = rawBody.indexOf("\r\n", offset);
            if (crlf === -1) break;
            const headerLine = rawBody.subarray(offset, crlf).toString("ascii");
            const sizeHex = headerLine.split(";")[0]!.trim();
            const chunkLen = Number.parseInt(sizeHex, 16);
            if (!Number.isFinite(chunkLen) || chunkLen === 0) break;
            const dataStart = crlf + 2;
            out.push(rawBody.subarray(dataStart, dataStart + chunkLen));
            offset = dataStart + chunkLen + 2;
          }
          return Buffer.concat(out);
        })()
      : rawBody;
    const trimmedPath = url.pathname.replace(/^\/+/, "");
    const slashIdx = trimmedPath.indexOf("/");
    const bucket = slashIdx >= 0 ? trimmedPath.slice(0, slashIdx) : trimmedPath;
    const key = slashIdx >= 0 ? decodeURIComponent(trimmedPath.slice(slashIdx + 1)) : "";
    const fullKey = `${bucket}/${key}`;

    if (req.method === "PUT" && key) {
      objects.set(fullKey, {
        body: decodedBody,
        contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
        lastModified: new Date(),
      });
      res.writeHead(200, { ETag: '"mock-etag"' });
      res.end();
      return;
    }

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const matching: Array<{ key: string; size: number; lastModified: Date }> = [];
      for (const [k, v] of objects.entries()) {
        if (!k.startsWith(`${bucket}/`)) continue;
        const rel = k.slice(bucket.length + 1);
        if (rel.startsWith(prefix)) {
          matching.push({ key: rel, size: v.body.length, lastModified: v.lastModified });
        }
      }
      const contentsXml = matching
        .map(
          (m) =>
            `<Contents><Key>${xmlEscape(m.key)}</Key><LastModified>${m.lastModified.toISOString()}</LastModified><Size>${m.size}</Size></Contents>`
        )
        .join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xmlEscape(bucket)}</Name><IsTruncated>false</IsTruncated>${contentsXml}</ListBucketResult>`;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    if (req.method === "POST" && url.searchParams.has("delete")) {
      const bodyStr = rawBody.toString("utf8");
      const matches = [...bodyStr.matchAll(/<Key>([^<]+)<\/Key>/g)];
      for (const m of matches) {
        const delKey = m[1]!;
        objects.delete(`${bucket}/${delKey}`);
      }
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>`);
      return;
    }

    if (req.method === "GET" && key) {
      const found = objects.get(fullKey);
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end(`<Error><Code>NoSuchKey</Code></Error>`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": found.contentType,
        "Content-Length": String(found.body.length),
      });
      res.end(found.body);
      return;
    }

    res.writeHead(400);
    res.end("Unsupported mock S3 request");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describe("Off-Site AES-256-GCM Backup Encryption, S3 Sync & Retention (scripts/backup-offsite.mjs)", () => {
  it("encrypts/decrypts roundtrip, rejects wrong key & tampered bytes, and syncs/prunes via S3-compatible endpoint", async () => {
    const offsiteUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/backup-offsite.mjs")).href;
    const offsite = (await import(offsiteUrl)) as {
      encryptFile: (i: string, o: string, k: Buffer) => Promise<void>;
      decryptFile: (i: string, o: string, k: Buffer) => Promise<void>;
      parseBackupEncryptionKey: (raw: string) => Buffer;
      sha256File: (p: string) => Promise<string>;
      uploadBackupSet: (args: Record<string, unknown>) => Promise<{
        manifest: { db: { s3Key: string; sha256: string }; uploads: { s3Key: string; sha256: string } };
        pruneResult: { prunedSets: number; deletedKeys: number };
      }>;
      downloadLatestBackupSet: (args: Record<string, unknown>) => Promise<{
        dbFilePath: string;
        uploadsFilePath: string;
      }>;
      pruneOffsiteBackups: (
        client: unknown,
        cfg: Record<string, unknown>,
        now?: Date
      ) => Promise<{ prunedSets: number; deletedKeys: number }>;
      createBackupS3Client: (cfg: Record<string, unknown>) => { destroy: () => void };
      resolveBackupS3Config: (o: Record<string, unknown>) => Record<string, unknown>;
    };

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "erp-offsite-test-"));
    const mockS3 = await startMockS3Server();
    try {
      const keyHex = randomBytes(32).toString("hex");
      const wrongKeyHex = randomBytes(32).toString("hex");
      const keyBuf = offsite.parseBackupEncryptionKey(keyHex);
      const wrongKeyBuf = offsite.parseBackupEncryptionKey(wrongKeyHex);

      const plainDump = path.join(tmpDir, "erp_backup_20261128T020000Z.dump");
      const plainUploads = path.join(tmpDir, "erp_uploads_20261128T020000Z.tar.gz");
      const secretMarker = "PGDMP-SENSITIVE-ERP-LEDGER-PAYLOAD-987654321";
      await fsp.writeFile(plainDump, Buffer.from(`${secretMarker}\n${"A".repeat(4096)}`));
      await fsp.writeFile(plainUploads, Buffer.from("FAKE-GZIP-UPLOADS-ARCHIVE-CONTENT"));

      // 1. Direct encrypt / decrypt + wrong-key + tamper rejection
      const encPath = path.join(tmpDir, "sample.enc");
      const decPath = path.join(tmpDir, "sample.dec");
      await offsite.encryptFile(plainDump, encPath, keyBuf);
      const encBytes = await fsp.readFile(encPath);
      expect(encBytes.subarray(0, 6).toString("ascii")).toBe("CKIBK1");
      expect(encBytes.includes(Buffer.from(secretMarker))).toBe(false);

      await offsite.decryptFile(encPath, decPath, keyBuf);
      expect(await offsite.sha256File(decPath)).toBe(await offsite.sha256File(plainDump));

      await expect(offsite.decryptFile(encPath, path.join(tmpDir, "bad-key.dec"), wrongKeyBuf)).rejects.toThrow(
        /Failed to decrypt/i
      );

      // Flip a single byte in the ciphertext and verify GCM auth tag rejects it
      const tampered = Buffer.from(encBytes);
      tampered[25] = tampered[25]! ^ 0xff;
      const tamperedPath = path.join(tmpDir, "tampered.enc");
      await fsp.writeFile(tamperedPath, tampered);
      await expect(offsite.decryptFile(tamperedPath, path.join(tmpDir, "tampered.dec"), keyBuf)).rejects.toThrow(
        /Failed to decrypt/i
      );

      // 2. Upload backup set to S3-compatible mock & verify stored ciphertext has zero plaintext leakage
      const statusFile = path.join(tmpDir, "last-backup-status.json");
      const s3Config = {
        bucket: "erp-backups-test",
        region: "auto",
        endpoint: mockS3.endpoint,
        accessKeyId: "test-ak",
        secretAccessKey: "test-sk",
        forcePathStyle: true,
        prefix: "backups/count-it-keep-it",
        retentionDays: 30,
        minKeep: 1,
      };

      const uploaded = await offsite.uploadBackupSet({
        dbFilePath: plainDump,
        uploadsFilePath: plainUploads,
        timestamp: "20261128T020000Z",
        statusFilePath: statusFile,
        encryptionKey: keyHex,
        s3Config,
      });

      const storedDbObj = mockS3.objects.get(`erp-backups-test/${uploaded.manifest.db.s3Key}`);
      expect(storedDbObj).toBeDefined();
      expect(storedDbObj!.body.includes(Buffer.from(secretMarker))).toBe(false);

      const statusJson = JSON.parse(await fsp.readFile(statusFile, "utf8"));
      expect(statusJson.status).toBe("ok");
      expect(statusJson.offsite.uploaded).toBe(true);
      expect(statusJson.offsite.encrypted).toBe(true);
      expect(statusJson.offsite.bucket).toBe("erp-backups-test");

      // 3. Download latest, decrypt, and verify exact SHA-256 parity for DB + uploads
      const outDir = path.join(tmpDir, "downloaded");
      const downloaded = await offsite.downloadLatestBackupSet({
        outDir,
        encryptionKey: keyHex,
        s3Config,
      });
      expect(await offsite.sha256File(downloaded.dbFilePath)).toBe(await offsite.sha256File(plainDump));
      expect(await offsite.sha256File(downloaded.uploadsFilePath)).toBe(await offsite.sha256File(plainUploads));
      expect(fs.existsSync(`${downloaded.dbFilePath}.sha256`)).toBe(true);

      // 4. Retention pruning removes old off-site sets beyond minKeep + retentionDays
      await offsite.uploadBackupSet({
        dbFilePath: plainDump,
        uploadsFilePath: plainUploads,
        timestamp: "20261129T020000Z",
        encryptionKey: keyHex,
        s3Config,
      });
      const resolvedCfg = offsite.resolveBackupS3Config({ ...s3Config, retentionDays: 1, minKeep: 1 });
      const client = offsite.createBackupS3Client(resolvedCfg);
      try {
        // Advance clock 45 days into the future -> older backup set should be pruned, newest kept (minKeep=1)
        const futureNow = new Date(Date.now() + 45 * 24 * 3600 * 1000);
        const pruneRes = await offsite.pruneOffsiteBackups(client, resolvedCfg, futureNow);
        expect(pruneRes.prunedSets).toBe(1);
        expect(pruneRes.deletedKeys).toBe(3); // manifest + db.enc + uploads.enc
      } finally {
        client.destroy();
      }

      // 5. Dead-man's-switch healthcheck pings on off-site upload success & failure + monthly restore drill failure
      const pings: Array<{ method: string; url: string; body: string }> = [];
      const pingServer = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        pings.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200);
        res.end("OK");
      });
      await new Promise<void>((resolve) => pingServer.listen(0, "127.0.0.1", () => resolve()));
      const pingAddr = pingServer.address();
      const pingPort = typeof pingAddr === "object" && pingAddr ? pingAddr.port : 0;
      const pingUrl = `http://127.0.0.1:${pingPort}/hc/backup-daily`;

      try {
        await offsite.uploadBackupSet({
          dbFilePath: plainDump,
          uploadsFilePath: plainUploads,
          timestamp: "20261130T020000Z",
          encryptionKey: keyHex,
          s3Config,
          healthcheckPingUrl: pingUrl,
        });
        expect(pings).toHaveLength(1);
        expect(pings[0]?.url).toBe("/hc/backup-daily");
        expect(pings[0]?.body).toContain("offsite backup ok");

        await expect(
          offsite.uploadBackupSet({
            dbFilePath: plainDump,
            timestamp: "20261130T020001Z",
            encryptionKey: "not-a-valid-key",
            s3Config,
            healthcheckPingUrl: pingUrl,
          })
        ).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);
        expect(pings).toHaveLength(2);
        expect(pings[1]?.url).toBe("/hc/backup-daily/fail");
        expect(pings[1]?.body).toContain("BACKUP_ENCRYPTION_KEY");

        // Monthly restore drill pings /fail with error details when backup dir is empty
        const emptyDrillDir = path.join(tmpDir, "empty-drill-dir");
        await fsp.mkdir(emptyDrillDir, { recursive: true });
        const drillUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/monthly-restore-drill.mjs")).href;
        const { runMonthlyRestoreDrill } = (await import(drillUrl)) as {
          runMonthlyRestoreDrill: (opts: Record<string, unknown>) => Promise<unknown>;
        };
        const drillPingUrl = `http://127.0.0.1:${pingPort}/hc/restore-drill`;
        await expect(
          runMonthlyRestoreDrill({
            localDir: emptyDrillDir,
            healthcheckPingUrl: drillPingUrl,
          })
        ).rejects.toThrow(/No erp_backup_/);
        expect(pings).toHaveLength(3);
        expect(pings[2]?.url).toBe("/hc/restore-drill/fail");
        expect(pings[2]?.body).toContain("restore drill failed");
      } finally {
        await new Promise<void>((resolve, reject) => pingServer.close((e) => (e ? reject(e) : resolve())));
      }
    } finally {
      await mockS3.close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

async function snapshotPublicTableRowCounts(db: AppDatabase): Promise<Record<string, number>> {
  const tableRows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '__drizzle%'
    ORDER BY tablename
  `);
  const counts: Record<string, number> = {};
  for (const row of tableRows) {
    const [res] = await db.execute<{ cnt: number }>(
      sql.raw(`SELECT count(*)::int AS cnt FROM "public"."${row.tablename}"`)
    );
    counts[row.tablename] = Number(res?.cnt ?? 0);
  }
  return counts;
}

describeWithDb("Production Ops: Backup Freshness API, Metrics Gauges & Smoke Test", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string>;
  let tmpDir: string;
  let prevBackupStatusFile: string | undefined;
  let prevBackupMaxAgeHours: string | undefined;
  let prevMetricsToken: string | undefined;
  let prevUptimeStatusToken: string | undefined;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    app = await buildApp({ logger: false, enableRateLimit: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  beforeEach(async () => {
    prevBackupStatusFile = process.env.BACKUP_STATUS_FILE;
    prevBackupMaxAgeHours = process.env.BACKUP_MAX_AGE_HOURS;
    prevMetricsToken = process.env.METRICS_TOKEN;
    prevUptimeStatusToken = process.env.UPTIME_STATUS_TOKEN;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "erp-freshness-test-"));
    process.env.BACKUP_STATUS_FILE = path.join(tmpDir, "last-backup-status.json");
    process.env.BACKUP_MAX_AGE_HOURS = "26";
    process.env.METRICS_TOKEN = "test-metrics-token-secret";
    process.env.UPTIME_STATUS_TOKEN = "test-uptime-status-token-64-chars-secret-value";

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Ops Admin", email: "ops-admin@test.local", password: "StrongPassword123!" },
    });
    expect(signup.statusCode).toBe(201);
    adminHeaders = authHeaders(signup);
  });

  afterEach(async () => {
    if (prevBackupStatusFile === undefined) delete process.env.BACKUP_STATUS_FILE;
    else process.env.BACKUP_STATUS_FILE = prevBackupStatusFile;
    if (prevBackupMaxAgeHours === undefined) delete process.env.BACKUP_MAX_AGE_HOURS;
    else process.env.BACKUP_MAX_AGE_HOURS = prevBackupMaxAgeHours;
    if (prevMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevMetricsToken;
    if (prevUptimeStatusToken === undefined) delete process.env.UPTIME_STATUS_TOKEN;
    else process.env.UPTIME_STATUS_TOKEN = prevUptimeStatusToken;
    const { setStorageConfigOverrideForTests } = await import("../../src/services/storage.service.ts");
    setStorageConfigOverrideForTests(null);
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("1. reports missing, fresh (<=26h), and stale (>26h) backups on /api/admin/backups/freshness and /api/metrics", async () => {
    // Non-admin gets 403
    const userSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Standard User", email: "ops-user@test.local", password: "StrongPassword123!" },
    });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness",
      headers: authHeaders(userSignup),
    });
    expect(forbidden.statusCode).toBe(403);

    // Case A: Missing status file
    const missingRes = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness",
      headers: adminHeaders,
    });
    expect(missingRes.statusCode).toBe(200);
    expect(missingRes.json().ok).toBe(false);
    expect(missingRes.json().status).toBe("missing");
    expect(missingRes.json().stale).toBe(true);

    const missingStrict = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness?strict=true",
      headers: adminHeaders,
    });
    expect(missingStrict.statusCode).toBe(503);

    // Case B: Fresh backup (2 hours ago)
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: twoHoursAgo,
        dbFile: "erp_backup_fresh.dump",
        dbSizeBytes: 123456,
        uploadsFile: "erp_uploads_fresh.tar.gz",
        uploadsSizeBytes: 45678,
        offsite: {
          enabled: true,
          uploaded: true,
          encrypted: true,
          bucket: "r2-erp-backups",
          prefix: "backups/count-it-keep-it",
          uploadedAt: twoHoursAgo,
          dbKey: "backups/count-it-keep-it/db/erp_backup_fresh.dump.enc",
          uploadsKey: "backups/count-it-keep-it/uploads/erp_uploads_fresh.tar.gz.enc",
        },
      })
    );

    const freshRes = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness?strict=true",
      headers: adminHeaders,
    });
    expect(freshRes.statusCode).toBe(200);
    const freshBody = freshRes.json();
    expect(freshBody.ok).toBe(true);
    expect(freshBody.status).toBe("fresh");
    expect(freshBody.stale).toBe(false);
    expect(freshBody.ageHours).toBeGreaterThanOrEqual(1.9);
    expect(freshBody.ageHours).toBeLessThan(2.5);
    expect(freshBody.offsite.encrypted).toBe(true);

    // Prometheus /api/metrics exposes backup gauges
    const metricsFresh = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: "Bearer test-metrics-token-secret" },
    });
    expect(metricsFresh.statusCode).toBe(200);
    expect(metricsFresh.body).toContain("erp_backup_freshness_ok 1");
    expect(metricsFresh.body).toMatch(/erp_backup_age_seconds \d+/);

    // Case C: Stale backup (27 hours ago > 26h threshold)
    const twentySevenHoursAgo = new Date(Date.now() - 27 * 3600 * 1000).toISOString();
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: twentySevenHoursAgo,
        dbFile: "erp_backup_stale.dump",
        dbSizeBytes: 123456,
      })
    );

    const staleRes = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness",
      headers: adminHeaders,
    });
    expect(staleRes.statusCode).toBe(200);
    expect(staleRes.json().ok).toBe(false);
    expect(staleRes.json().status).toBe("stale");
    expect(staleRes.json().stale).toBe(true);
    expect(staleRes.json().ageHours).toBeGreaterThan(26);

    const staleStrict = await app.inject({
      method: "GET",
      url: "/api/admin/backups/freshness?strict=true",
      headers: adminHeaders,
    });
    expect(staleStrict.statusCode).toBe(503);

    const metricsStale = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: "Bearer test-metrics-token-secret" },
    });
    expect(metricsStale.body).toContain("erp_backup_freshness_ok 0");
  });

  it("2. GET /api/status enforces token auth, returns minimal booleans only, returns 503 on stale/missing backup or unhealthy storage, and writes zero DB rows", async () => {
    const token = process.env.UPTIME_STATUS_TOKEN!;

    // No token -> 401
    const noTok = await app.inject({ method: "GET", url: "/api/status" });
    expect(noTok.statusCode).toBe(401);
    expect(noTok.headers["www-authenticate"]).toContain("Bearer");

    // Wrong token -> 401
    const wrongTok = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer wrong-uptime-status-token-0000000000000000" },
    });
    expect(wrongTok.statusCode).toBe(401);

    // Missing backup status file -> 503 with minimal 4-boolean payload
    const missingBackup = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingBackup.statusCode).toBe(503);
    expect(missingBackup.json()).toEqual({
      ready: true,
      database: true,
      storage: true,
      backupFresh: false,
    });
    expect(Object.keys(missingBackup.json()).sort()).toEqual(["backupFresh", "database", "ready", "storage"]);

    // Fresh backup (1h old) -> 200 OK via Bearer and X-Status-Token, and ZERO rows written to ANY table
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        dbFile: "erp_backup_fresh.dump",
        dbSizeBytes: 2048,
      })
    );

    const beforeCounts = await snapshotPublicTableRowCounts(db);
    const freshBearer = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${token}` },
    });
    const freshHeader = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { "x-status-token": token },
    });
    const afterCounts = await snapshotPublicTableRowCounts(db);

    expect(freshBearer.statusCode).toBe(200);
    expect(freshBearer.json()).toEqual({
      ready: true,
      database: true,
      storage: true,
      backupFresh: true,
    });
    expect(freshHeader.statusCode).toBe(200);
    expect(freshHeader.json()).toEqual(freshBearer.json());
    expect(afterCounts).toEqual(beforeCounts);

    // Stale backup (27h old > 26h) -> 503 with backupFresh=false
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: new Date(Date.now() - 27 * 3600 * 1000).toISOString(),
        dbFile: "erp_backup_stale.dump",
        dbSizeBytes: 2048,
      })
    );
    const staleStatus = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(staleStatus.statusCode).toBe(503);
    expect(staleStatus.json()).toEqual({
      ready: true,
      database: true,
      storage: true,
      backupFresh: false,
    });

    // Fresh backup + unhealthy storage -> 503 with ready=false, storage=false
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: new Date().toISOString(),
        dbFile: "erp_backup_fresh2.dump",
        dbSizeBytes: 2048,
      })
    );
    const { setStorageConfigOverrideForTests } = await import("../../src/services/storage.service.ts");
    // Create a blocking file where localDir expects a directory so storage health fails deterministically
    const blockingFile = path.join(tmpDir, "not-a-dir");
    await fsp.writeFile(blockingFile, "x");
    setStorageConfigOverrideForTests({ driver: "local", localDir: blockingFile });
    const badStorage = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badStorage.statusCode).toBe(503);
    expect(badStorage.json()).toEqual({
      ready: false,
      database: true,
      storage: false,
      backupFresh: true,
    });
  });

  it("3. dedicated Smoke Monitor user is strictly read-only, MFA-safe, rejected for admin in production mode, and writes zero business/data rows during production smoke test", async () => {
    await fsp.writeFile(
      process.env.BACKUP_STATUS_FILE!,
      JSON.stringify({
        status: "ok",
        completedAt: new Date().toISOString(),
        dbFile: "erp_backup_smoke.dump",
        dbSizeBytes: 1024,
      })
    );

    const createSmokeUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/create-smoke-user.mjs")).href;
    const { provisionSmokeUser } = (await import(createSmokeUrl)) as {
      provisionSmokeUser: (
        database: AppDatabase,
        opts?: Record<string, unknown>
      ) => Promise<{
        userId: string;
        email: string;
        role: string;
        customRoleName: string;
        password: string | null;
      }>;
    };

    // Refuses to convert an existing admin email into a smoke user
    await expect(provisionSmokeUser(db, { email: "ops-admin@test.local" })).rejects.toThrow(
      /Refusing to convert existing admin/i
    );

    const smokeUser = await provisionSmokeUser(db, {
      email: "smoke-monitor@test.local",
      password: "SmokeOnlyStrongPassword-0123456789!",
    });
    expect(smokeUser.role).toBe("user");
    expect(smokeUser.customRoleName).toBe("Smoke Monitor");

    // Smoke user middleware blocks ALL mutating endpoints with 403 SMOKE_USER_READ_ONLY (writing 0 rows)
    const smokeLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: smokeUser.email, password: "SmokeOnlyStrongPassword-0123456789!" },
    });
    expect(smokeLogin.statusCode).toBe(200);
    const smokeHeaders = authHeaders(smokeLogin);

    const beforeMutations = await snapshotPublicTableRowCounts(db);
    for (const attempt of [
      { method: "POST" as const, url: "/api/audit-logs", payload: { module: "system", action: "ui.report_viewed" } },
      { method: "POST" as const, url: "/api/auth/mfa/enroll", payload: {} },
      {
        method: "POST" as const,
        url: "/api/auth/change-password",
        payload: { currentPassword: "SmokeOnlyStrongPassword-0123456789!", newPassword: "AnotherStrongPassword123!" },
      },
      { method: "PUT" as const, url: "/api/settings/company", payload: { companyName: "Hacked Co" } },
      { method: "POST" as const, url: "/api/accounting/journal-entries", payload: {} },
    ]) {
      const denied = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: smokeHeaders,
        payload: attempt.payload,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("SMOKE_USER_READ_ONLY");
    }

    // All 4 authenticated read-only verification endpoints succeed and write 0 rows across 100% of tables
    for (const pathUrl of [
      "/api/accounting/reports/reconciliation",
      "/api/accounting/setup-health",
      "/api/audit-logs/verify",
      "/api/admin/backups/freshness",
    ]) {
      const checkRes = await app.inject({ method: "GET", url: pathUrl, headers: smokeHeaders });
      expect(checkRes.statusCode).toBe(200);
    }
    const afterReadOnlyChecks = await snapshotPublicTableRowCounts(db);
    expect(afterReadOnlyChecks).toEqual(beforeMutations);

    // Logout works for Smoke Monitor
    const logoutRes = await app.inject({ method: "POST", url: "/api/auth/logout", headers: smokeHeaders });
    expect(logoutRes.statusCode).toBe(200);

    // Run scripts/smoke-test.mjs over real HTTP
    const { buildApp } = await import("../../src/app.ts");
    const liveApp = await buildApp({ logger: false, enableRateLimit: false });
    const address = await liveApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const smokeUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/smoke-test.mjs")).href;
      const { runSmokeTest } = (await import(smokeUrl)) as {
        runSmokeTest: (opts: Record<string, unknown>) => Promise<{
          ok: boolean;
          mode: string;
          readOnly: boolean;
          uptimeStatus: { status: number; ready: boolean; backupFresh: boolean };
          auth: { role: string; customRoleName: string; mfaEnabled: boolean };
          reconciliation: { allReconciled: boolean; controls: number };
          setupHealth: { healthy: boolean };
          auditChain: { valid: boolean };
          backupFreshness: { ok: boolean; status: string };
        }>;
      };

      // 3a. Production mode refuses admin account
      await expect(
        runSmokeTest({
          baseUrl: address,
          mode: "production",
          email: "ops-admin@test.local",
          password: "StrongPassword123!",
        })
      ).rejects.toThrow(/refuses privileged or non-smoke account/i);

      // 3b. MFA-enabled admin returns explicit MFA guidance instead of silent 401
      const { userMfa, users } = await import("../../drizzle/schema.ts");
      const { eq } = await import("drizzle-orm");
      const [adminRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "ops-admin@test.local"))
        .limit(1);
      await db.insert(userMfa).values({
        userId: adminRow!.id,
        totpSecretEncrypted: "iv:tag:ciphertext",
        isEnabled: true,
        keyVersion: 1,
      });
      await expect(
        runSmokeTest({
          baseUrl: address,
          mode: "staging",
          email: "ops-admin@test.local",
          password: "StrongPassword123!",
        })
      ).rejects.toThrow(/mfaRequired=true.*smoke:create-user/i);

      // 3c. Full production smoke run with dedicated Smoke Monitor user writes ZERO rows to all non-auth tables
      const beforeSmoke = await snapshotPublicTableRowCounts(db);
      const summary = await runSmokeTest({
        baseUrl: address,
        mode: "production",
        email: smokeUser.email,
        password: "SmokeOnlyStrongPassword-0123456789!",
        statusToken: process.env.UPTIME_STATUS_TOKEN!,
        requireFreshBackup: true,
      });
      const afterSmoke = await snapshotPublicTableRowCounts(db);

      expect(summary.ok).toBe(true);
      expect(summary.mode).toBe("production");
      expect(summary.readOnly).toBe(true);
      expect(summary.uptimeStatus).toEqual({
        status: 200,
        ready: true,
        database: true,
        storage: true,
        backupFresh: true,
      });
      expect(summary.auth.role).toBe("user");
      expect(summary.auth.customRoleName).toBe("Smoke Monitor");
      expect(summary.auth.mfaEnabled).toBe(false);
      expect(summary.reconciliation.allReconciled).toBe(true);
      expect(summary.reconciliation.controls).toBe(8);
      expect(summary.setupHealth.healthy).toBe(true);
      expect(summary.auditChain.valid).toBe(true);
      expect(summary.backupFreshness.ok).toBe(true);

      // Every single table in public schema except login's ephemeral session & login audit row has delta === 0
      const authLoginOnlyTables = new Set(["user_sessions", "audit_logs"]);
      for (const [tableName, beforeCount] of Object.entries(beforeSmoke)) {
        if (authLoginOnlyTables.has(tableName)) continue;
        expect(afterSmoke[tableName], `Expected 0 rows written to table '${tableName}'`).toBe(beforeCount);
      }

      // And 0 active (unrevoked) sessions remain for the smoke user after logout
      const [activeSmokeSessions] = await db.execute<{ cnt: number }>(sql`
        SELECT count(*)::int AS cnt
        FROM public.user_sessions
        WHERE user_id = ${smokeUser.userId} AND revoked_at IS NULL
      `);
      expect(Number(activeSmokeSessions?.cnt ?? -1)).toBe(0);

      // 3d. Token-only production smoke run (no login) writes 0 rows across 100% of tables including sessions & audit_logs
      const beforeTokenOnly = await snapshotPublicTableRowCounts(db);
      const tokenOnlySummary = await runSmokeTest({
        baseUrl: address,
        mode: "production",
        email: "",
        password: "",
        statusToken: process.env.UPTIME_STATUS_TOKEN!,
        requireFreshBackup: true,
      });
      const afterTokenOnly = await snapshotPublicTableRowCounts(db);
      expect(tokenOnlySummary.ok).toBe(true);
      expect(tokenOnlySummary.uptimeStatus.status).toBe(200);
      expect(afterTokenOnly).toEqual(beforeTokenOnly);
    } finally {
      await liveApp.close();
    }
  });
});
