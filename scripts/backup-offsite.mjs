#!/usr/bin/env node
/**
 * Client-side AES-256-GCM encrypted off-site backup sync for S3-compatible storage
 * (Cloudflare R2, MinIO, AWS S3).
 *
 * Envelope format (binary, streaming):
 *   [0..5]             ASCII magic "CKIBK1" (6 bytes)
 *   [6..17]            Random 96-bit GCM IV (12 bytes)
 *   [18..size-17]      AES-256-GCM ciphertext
 *   [size-16..size-1]  128-bit GCM authentication tag (16 bytes)
 *
 * Subcommands:
 *   upload --db <dump> [--uploads <tar.gz>] --timestamp <UTC> [--status-file <path>]
 *   download-latest --out-dir <dir>
 *   encrypt --in <file> --out <file.enc>
 *   decrypt --in <file.enc> --out <file>
 *
 * Environment variables:
 *   BACKUP_ENCRYPTION_KEY          Required 32-byte key (64 hex chars or base64 32 bytes)
 *   BACKUP_S3_BUCKET               S3 / R2 / MinIO bucket name
 *   BACKUP_S3_ENDPOINT             Custom endpoint (R2 / MinIO; blank for AWS S3)
 *   BACKUP_S3_REGION               Region (default: auto)
 *   BACKUP_S3_ACCESS_KEY_ID        Access key ID
 *   BACKUP_S3_SECRET_ACCESS_KEY    Secret access key
 *   BACKUP_S3_FORCE_PATH_STYLE     true for MinIO, false for R2/AWS (default: false)
 *   BACKUP_S3_PREFIX               Object key prefix (default: backups/count-it-keep-it)
 *   BACKUP_OFFSITE_RETENTION_DAYS  Delete off-site backup sets older than N days (default: 30, 0 disables)
 *   BACKUP_OFFSITE_MIN_KEEP        Minimum off-site backup sets to retain (default: 7)
 *   HEALTHCHECK_PING_URL           Optional healthchecks.io dead-man's-switch URL (or BACKUP_OFFSITE_HEALTHCHECK_PING_URL)
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { pingHealthcheck } from "./lib/healthcheck-ping.mjs";

export const ENVELOPE_MAGIC = Buffer.from("CKIBK1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENVELOPE_MAGIC.length + IV_BYTES;

export function parseBackupEncryptionKey(raw = process.env.BACKUP_ENCRYPTION_KEY ?? "") {
  const configured = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, "hex");
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(configured)) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length === 32 && decoded.toString("base64") === configured) {
      return decoded;
    }
  }
  throw new Error(
    "BACKUP_ENCRYPTION_KEY must be a 64-character hex string or base64-encoded 32-byte key (generate with: openssl rand -hex 32)."
  );
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function encryptFile(inputPath, outputPath, keyBuf) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
  cipher.setAAD(ENVELOPE_MAGIC);

  const tmpPath = `${outputPath}.tmp.${process.pid}`;
  const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
  try {
    out.write(ENVELOPE_MAGIC);
    out.write(iv);

    const input = fs.createReadStream(inputPath);
    for await (const chunk of input) {
      const enc = cipher.update(chunk);
      if (enc.length > 0 && !out.write(enc)) {
        await new Promise((resolve) => out.once("drain", resolve));
      }
    }
    const finalChunk = cipher.final();
    if (finalChunk.length > 0) out.write(finalChunk);
    out.write(cipher.getAuthTag());

    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(tmpPath, outputPath);
  } catch (err) {
    out.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function decryptFile(inputPath, outputPath, keyBuf) {
  const stat = await fsp.stat(inputPath);
  if (stat.size < HEADER_BYTES + TAG_BYTES) {
    throw new Error(`Encrypted backup '${inputPath}' is truncated (${stat.size} bytes).`);
  }

  const fh = await fsp.open(inputPath, "r");
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    await fh.read(header, 0, HEADER_BYTES, 0);
    tag = Buffer.alloc(TAG_BYTES);
    await fh.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    await fh.close();
  }

  const magic = header.subarray(0, ENVELOPE_MAGIC.length);
  if (!magic.equals(ENVELOPE_MAGIC)) {
    throw new Error(`File '${inputPath}' does not have a valid CKIBK1 encrypted backup header.`);
  }
  const iv = header.subarray(ENVELOPE_MAGIC.length, HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAAD(ENVELOPE_MAGIC);
  decipher.setAuthTag(tag);

  const tmpPath = `${outputPath}.tmp.${process.pid}`;
  const ciphertextEnd = stat.size - TAG_BYTES - 1;
  try {
    if (ciphertextEnd >= HEADER_BYTES) {
      await pipeline(
        fs.createReadStream(inputPath, { start: HEADER_BYTES, end: ciphertextEnd }),
        decipher,
        fs.createWriteStream(tmpPath, { mode: 0o600 })
      );
    } else {
      decipher.final();
      await fsp.writeFile(tmpPath, Buffer.alloc(0), { mode: 0o600 });
    }
    await fsp.rename(tmpPath, outputPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw new Error(
      `Failed to decrypt '${path.basename(inputPath)}' (wrong BACKUP_ENCRYPTION_KEY or corrupted ciphertext): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export function resolveBackupS3Config(overrides = {}) {
  const bucket = (overrides.bucket ?? process.env.BACKUP_S3_BUCKET ?? "").trim();
  const region = (overrides.region ?? process.env.BACKUP_S3_REGION ?? "auto").trim() || "auto";
  const endpoint = (overrides.endpoint ?? process.env.BACKUP_S3_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const accessKeyId = (overrides.accessKeyId ?? process.env.BACKUP_S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (overrides.secretAccessKey ?? process.env.BACKUP_S3_SECRET_ACCESS_KEY ?? "").trim();
  const rawPathStyle = String(overrides.forcePathStyle ?? process.env.BACKUP_S3_FORCE_PATH_STYLE ?? "false")
    .trim()
    .toLowerCase();
  const forcePathStyle = rawPathStyle === "true" || rawPathStyle === "1" || rawPathStyle === "yes";
  const prefix = (overrides.prefix ?? process.env.BACKUP_S3_PREFIX ?? "backups/count-it-keep-it")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const retentionDays = Number.parseInt(
    String(overrides.retentionDays ?? process.env.BACKUP_OFFSITE_RETENTION_DAYS ?? "30"),
    10
  );
  const minKeep = Number.parseInt(String(overrides.minKeep ?? process.env.BACKUP_OFFSITE_MIN_KEEP ?? "7"), 10);

  if (!bucket) throw new Error("BACKUP_S3_BUCKET is required for off-site S3 backup operations.");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY are required.");
  }

  return {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    prefix,
    retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : 30,
    minKeep: Number.isFinite(minKeep) && minKeep >= 1 ? minKeep : 7,
  };
}

export function createBackupS3Client(cfg) {
  return new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

function joinKey(prefix, ...parts) {
  return [prefix, ...parts].filter(Boolean).join("/");
}

async function readStreamToFile(body, outPath) {
  const tmpPath = `${outPath}.tmp.${process.pid}`;
  try {
    if (body && typeof body.pipe === "function") {
      await pipeline(body, fs.createWriteStream(tmpPath, { mode: 0o600 }));
    } else if (body && typeof body.transformToByteArray === "function") {
      const bytes = await body.transformToByteArray();
      await fsp.writeFile(tmpPath, Buffer.from(bytes), { mode: 0o600 });
    } else {
      throw new Error("Unsupported S3 GetObject response body stream.");
    }
    await fsp.rename(tmpPath, outPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function pruneOffsiteBackups(client, cfg, now = new Date()) {
  if (cfg.retentionDays <= 0) return { prunedSets: 0, deletedKeys: 0 };

  const manifestPrefix = joinKey(cfg.prefix, "manifests") + "/";
  const manifests = [];
  let continuationToken;
  do {
    const listRes = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: manifestPrefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of listRes.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith(".json")) {
        manifests.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
      }
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  // Sort newest first by key name (backup_YYYYMMDDTHHMMSSZ.json sorts lexicographically)
  manifests.sort((a, b) => b.key.localeCompare(a.key));
  if (manifests.length <= cfg.minKeep) return { prunedSets: 0, deletedKeys: 0 };

  const cutoffMs = now.getTime() - cfg.retentionDays * 24 * 3600 * 1000;
  const keysToDelete = [];
  let prunedSets = 0;

  for (let i = cfg.minKeep; i < manifests.length; i++) {
    const item = manifests[i];
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: item.key }));
      const text = await res.Body?.transformToString("utf8");
      const parsed = text ? JSON.parse(text) : null;
      const tsMs = parsed?.completedAt ? Date.parse(parsed.completedAt) : item.lastModified.getTime();
      if (Number.isFinite(tsMs) && tsMs < cutoffMs) {
        keysToDelete.push(item.key);
        if (parsed?.db?.s3Key) keysToDelete.push(parsed.db.s3Key);
        if (parsed?.uploads?.s3Key) keysToDelete.push(parsed.uploads.s3Key);
        prunedSets += 1;
      }
    } catch {
      // Skip malformed manifest rather than aborting retention
    }
  }

  for (let i = 0; i < keysToDelete.length; i += 500) {
    const batch = keysToDelete.slice(i, i + 500).map((Key) => ({ Key }));
    await client.send(
      new DeleteObjectsCommand({
        Bucket: cfg.bucket,
        Delete: { Objects: batch, Quiet: true },
      })
    );
  }

  return { prunedSets, deletedKeys: keysToDelete.length };
}

function resolveOffsiteHealthcheckUrl(override) {
  if (override !== undefined) return String(override ?? "").trim();
  const dedicated = (process.env.BACKUP_OFFSITE_HEALTHCHECK_PING_URL ?? "").trim();
  if (dedicated) return dedicated;
  if (process.env.HEALTHCHECK_PING_MANAGED_BY_CALLER === "1") return "";
  return (process.env.HEALTHCHECK_PING_URL ?? "").trim();
}

export async function uploadBackupSet({
  dbFilePath,
  uploadsFilePath = null,
  timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
  statusFilePath = null,
  encryptionKey = process.env.BACKUP_ENCRYPTION_KEY,
  s3Config = undefined,
  healthcheckPingUrl = undefined,
}) {
  const pingUrl = resolveOffsiteHealthcheckUrl(healthcheckPingUrl);
  try {
    const keyBuf = parseBackupEncryptionKey(encryptionKey);
    const cfg = resolveBackupS3Config(s3Config);
    const client = createBackupS3Client(cfg);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "erp-offsite-up-"));

    try {
      const dbBase = path.basename(dbFilePath);
      const dbStat = await fsp.stat(dbFilePath);
      const dbPlainSha = await sha256File(dbFilePath);
      const dbEncPath = path.join(tmpDir, `${dbBase}.enc`);
      await encryptFile(dbFilePath, dbEncPath, keyBuf);
      const dbEncStat = await fsp.stat(dbEncPath);
      const dbEncSha = await sha256File(dbEncPath);
      const dbS3Key = joinKey(cfg.prefix, "db", `${dbBase}.enc`);

      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: dbS3Key,
          Body: fs.createReadStream(dbEncPath),
          ContentLength: dbEncStat.size,
          ContentType: "application/octet-stream",
          Metadata: {
            "x-erp-cipher": "aes-256-gcm-ckibk1",
            "x-erp-plaintext-sha256": dbPlainSha,
            "x-erp-ciphertext-sha256": dbEncSha,
          },
        })
      );

      let uploadsMeta = null;
      if (uploadsFilePath && fs.existsSync(uploadsFilePath)) {
        const upBase = path.basename(uploadsFilePath);
        const upStat = await fsp.stat(uploadsFilePath);
        const upPlainSha = await sha256File(uploadsFilePath);
        const upEncPath = path.join(tmpDir, `${upBase}.enc`);
        await encryptFile(uploadsFilePath, upEncPath, keyBuf);
        const upEncStat = await fsp.stat(upEncPath);
        const upEncSha = await sha256File(upEncPath);
        const upS3Key = joinKey(cfg.prefix, "uploads", `${upBase}.enc`);

        await client.send(
          new PutObjectCommand({
            Bucket: cfg.bucket,
            Key: upS3Key,
            Body: fs.createReadStream(upEncPath),
            ContentLength: upEncStat.size,
            ContentType: "application/octet-stream",
            Metadata: {
              "x-erp-cipher": "aes-256-gcm-ckibk1",
              "x-erp-plaintext-sha256": upPlainSha,
              "x-erp-ciphertext-sha256": upEncSha,
            },
          })
        );

        uploadsMeta = {
          fileName: upBase,
          sizeBytes: upStat.size,
          sha256: upPlainSha,
          encryptedSizeBytes: upEncStat.size,
          encryptedSha256: upEncSha,
          s3Key: upS3Key,
        };
      }

      const nowIso = new Date().toISOString();
      const manifest = {
        schemaVersion: 1,
        timestamp,
        completedAt: nowIso,
        uploadedAt: nowIso,
        encrypted: true,
        cipher: "aes-256-gcm-ckibk1",
        bucket: cfg.bucket,
        prefix: cfg.prefix,
        db: {
          fileName: dbBase,
          sizeBytes: dbStat.size,
          sha256: dbPlainSha,
          encryptedSizeBytes: dbEncStat.size,
          encryptedSha256: dbEncSha,
          s3Key: dbS3Key,
        },
        uploads: uploadsMeta,
      };

      const manifestJson = JSON.stringify(manifest, null, 2);
      const manifestKey = joinKey(cfg.prefix, "manifests", `backup_${timestamp}.json`);
      const latestKey = joinKey(cfg.prefix, "latest.json");

      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: manifestKey,
          Body: manifestJson,
          ContentType: "application/json",
        })
      );
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: latestKey,
          Body: manifestJson,
          ContentType: "application/json",
        })
      );

      const pruneResult = await pruneOffsiteBackups(client, cfg);

      if (statusFilePath) {
        let existing = {};
        try {
          existing = JSON.parse(await fsp.readFile(statusFilePath, "utf8"));
        } catch {
          existing = {};
        }
        const nextStatus = {
          ...existing,
          status: "ok",
          timestamp,
          completedAt: existing.completedAt ?? nowIso,
          dbFile: existing.dbFile ?? dbBase,
          dbSizeBytes: existing.dbSizeBytes ?? dbStat.size,
          dbSha256: existing.dbSha256 ?? dbPlainSha,
          uploadsFile: existing.uploadsFile ?? uploadsMeta?.fileName ?? null,
          uploadsSizeBytes: existing.uploadsSizeBytes ?? uploadsMeta?.sizeBytes ?? null,
          uploadsSha256: existing.uploadsSha256 ?? uploadsMeta?.sha256 ?? null,
          offsite: {
            enabled: true,
            uploaded: true,
            encrypted: true,
            bucket: cfg.bucket,
            prefix: cfg.prefix,
            uploadedAt: nowIso,
            dbKey: dbS3Key,
            uploadsKey: uploadsMeta?.s3Key ?? null,
            manifestKey,
            prunedSets: pruneResult.prunedSets,
          },
        };
        const tmpStatus = `${statusFilePath}.tmp.${process.pid}`;
        await fsp.mkdir(path.dirname(statusFilePath), { recursive: true });
        await fsp.writeFile(tmpStatus, JSON.stringify(nextStatus, null, 2) + "\n", { mode: 0o644 });
        await fsp.rename(tmpStatus, statusFilePath);
      }

      if (pingUrl) {
        await pingHealthcheck({
          url: pingUrl,
          ok: true,
          body: `offsite backup ok: bucket=${cfg.bucket} timestamp=${timestamp} dbBytes=${dbStat.size} uploads=${Boolean(uploadsMeta)}`,
        });
      }

      return { manifest, manifestKey, latestKey, pruneResult };
    } finally {
      client.destroy();
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    if (pingUrl) {
      await pingHealthcheck({
        url: pingUrl,
        ok: false,
        body: `offsite backup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    throw err;
  }
}

export async function downloadLatestBackupSet({
  outDir,
  encryptionKey = process.env.BACKUP_ENCRYPTION_KEY,
  s3Config = undefined,
}) {
  const keyBuf = parseBackupEncryptionKey(encryptionKey);
  const cfg = resolveBackupS3Config(s3Config);
  const client = createBackupS3Client(cfg);
  await fsp.mkdir(outDir, { recursive: true });

  try {
    const latestKey = joinKey(cfg.prefix, "latest.json");
    const latestRes = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: latestKey }));
    const manifestText = await latestRes.Body?.transformToString("utf8");
    if (!manifestText) {
      throw new Error(`Empty manifest at s3://${cfg.bucket}/${latestKey}`);
    }
    const manifest = JSON.parse(manifestText);
    if (!manifest?.db?.s3Key || !manifest?.db?.fileName || !manifest?.db?.sha256) {
      throw new Error(`Malformed backup manifest at s3://${cfg.bucket}/${latestKey}`);
    }

    const dbEncPath = path.join(outDir, `${manifest.db.fileName}.enc`);
    const dbPlainPath = path.join(outDir, manifest.db.fileName);
    const dbObj = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: manifest.db.s3Key }));
    await readStreamToFile(dbObj.Body, dbEncPath);

    if (manifest.db.encryptedSha256) {
      const actualEncSha = await sha256File(dbEncPath);
      if (actualEncSha !== manifest.db.encryptedSha256) {
        throw new Error(
          `Encrypted DB backup SHA-256 mismatch: expected ${manifest.db.encryptedSha256}, got ${actualEncSha}`
        );
      }
    }

    await decryptFile(dbEncPath, dbPlainPath, keyBuf);
    await fsp.rm(dbEncPath, { force: true });

    const actualDbSha = await sha256File(dbPlainPath);
    if (actualDbSha !== manifest.db.sha256) {
      throw new Error(`Decrypted DB backup SHA-256 mismatch: expected ${manifest.db.sha256}, got ${actualDbSha}`);
    }
    await fsp.writeFile(`${dbPlainPath}.sha256`, `${actualDbSha}  ${manifest.db.fileName}\n`, { mode: 0o600 });

    let uploadsPlainPath = null;
    if (manifest.uploads?.s3Key && manifest.uploads?.fileName) {
      const upEncPath = path.join(outDir, `${manifest.uploads.fileName}.enc`);
      uploadsPlainPath = path.join(outDir, manifest.uploads.fileName);
      const upObj = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: manifest.uploads.s3Key }));
      await readStreamToFile(upObj.Body, upEncPath);

      if (manifest.uploads.encryptedSha256) {
        const actualUpEncSha = await sha256File(upEncPath);
        if (actualUpEncSha !== manifest.uploads.encryptedSha256) {
          throw new Error(
            `Encrypted uploads archive SHA-256 mismatch: expected ${manifest.uploads.encryptedSha256}, got ${actualUpEncSha}`
          );
        }
      }

      await decryptFile(upEncPath, uploadsPlainPath, keyBuf);
      await fsp.rm(upEncPath, { force: true });

      const actualUpSha = await sha256File(uploadsPlainPath);
      if (manifest.uploads.sha256 && actualUpSha !== manifest.uploads.sha256) {
        throw new Error(
          `Decrypted uploads archive SHA-256 mismatch: expected ${manifest.uploads.sha256}, got ${actualUpSha}`
        );
      }
      await fsp.writeFile(`${uploadsPlainPath}.sha256`, `${actualUpSha}  ${manifest.uploads.fileName}\n`, {
        mode: 0o600,
      });
    }

    return {
      manifest,
      dbFilePath: dbPlainPath,
      uploadsFilePath: uploadsPlainPath,
    };
  } finally {
    client.destroy();
  }
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    }
  }
  return { command, opts };
}

async function runCli() {
  const { command, opts } = parseCliArgs(process.argv.slice(2));
  if (!command || command === "-h" || command === "--help") {
    console.log(`Usage:
  node scripts/backup-offsite.mjs upload --db <dump> [--uploads <tar.gz>] --timestamp <UTC> [--status-file <path>]
  node scripts/backup-offsite.mjs download-latest --out-dir <dir>
  node scripts/backup-offsite.mjs encrypt --in <file> --out <file.enc>
  node scripts/backup-offsite.mjs decrypt --in <file.enc> --out <file>`);
    process.exit(0);
  }

  if (command === "encrypt") {
    if (!opts.in || !opts.out) throw new Error("encrypt requires --in and --out");
    const key = parseBackupEncryptionKey();
    await encryptFile(opts.in, opts.out, key);
    console.log(JSON.stringify({ ok: true, command, in: opts.in, out: opts.out }));
    return;
  }

  if (command === "decrypt") {
    if (!opts.in || !opts.out) throw new Error("decrypt requires --in and --out");
    const key = parseBackupEncryptionKey();
    await decryptFile(opts.in, opts.out, key);
    console.log(JSON.stringify({ ok: true, command, in: opts.in, out: opts.out }));
    return;
  }

  if (command === "upload") {
    if (!opts.db) throw new Error("upload requires --db <path>");
    const res = await uploadBackupSet({
      dbFilePath: opts.db,
      uploadsFilePath: opts.uploads || null,
      timestamp: opts.timestamp || undefined,
      statusFilePath: opts["status-file"] || null,
    });
    console.log(JSON.stringify({ ok: true, command, ...res }, null, 2));
    return;
  }

  if (command === "download-latest") {
    if (!opts["out-dir"]) throw new Error("download-latest requires --out-dir <dir>");
    const res = await downloadLatestBackupSet({ outDir: opts["out-dir"] });
    console.log(JSON.stringify({ ok: true, command, ...res }, null, 2));
    return;
  }

  throw new Error(`Unknown command '${command}'`);
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  runCli().catch((err) => {
    console.error(`[backup-offsite] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
