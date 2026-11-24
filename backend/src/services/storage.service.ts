import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "../config.ts";
import { AppError } from "../db/helpers.ts";

export type StorageDriver = "local" | "s3";

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface StoredObjectResult {
  driver: StorageDriver;
  key: string;
  sha256: string;
  sizeBytes: number;
}

let cachedS3Client: S3ClientLike | null = null;
let testS3ClientOverride: S3ClientLike | null = null;
let testDriverOverride: StorageDriver | null = null;
let testLocalDirOverride: string | null = null;

export function setS3ClientOverrideForTests(client: S3ClientLike | null): void {
  testS3ClientOverride = client;
}

export function setStorageConfigOverrideForTests(
  opts: { driver?: StorageDriver | null; localDir?: string | null } | null
): void {
  testDriverOverride = opts?.driver ?? null;
  testLocalDirOverride = opts?.localDir ? path.resolve(opts.localDir) : null;
}

export function getActiveStorageDriver(): StorageDriver {
  return testDriverOverride ?? env.STORAGE_DRIVER;
}

export function getLocalStorageRoot(): string {
  return testLocalDirOverride ?? env.STORAGE_LOCAL_DIR;
}

export function sanitizeFileName(rawName: string): string {
  const normalized = (rawName ?? "").replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  const withoutControls = Array.from(base)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : ch;
    })
    .join("");
  const cleaned = withoutControls
    .replace(/\.\./g, "")
    .replace(/["<>|:*?\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned.replace(/^\.+/, "").slice(0, 200).trim();
  return safe || "attachment";
}

export function assertSafeStorageKey(rawKey: string): string {
  const key = (rawKey ?? "").trim().replace(/\\/g, "/");
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\0")) {
    throw new AppError(400, "Invalid storage key", "INVALID_STORAGE_KEY");
  }
  const segments = key.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === ".." || !/^[a-zA-Z0-9._-]+$/.test(seg))) {
    throw new AppError(400, "Invalid storage key format", "INVALID_STORAGE_KEY");
  }
  return key;
}

export function buildStorageKey(
  _companyId?: string,
  _entityType?: string,
  _entityId?: string,
  _fileName?: string
): string {
  const token = randomBytes(24).toString("hex");
  const key = `objects/${token.slice(0, 2)}/${token.slice(2, 4)}/${token}`;
  return assertSafeStorageKey(key);
}

function resolveLocalFilePath(storageKey: string): string {
  const safeKey = assertSafeStorageKey(storageKey);
  const rootDir = path.resolve(getLocalStorageRoot());
  const target = path.resolve(rootDir, ...safeKey.split("/"));
  const rel = path.relative(rootDir, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError(400, "Resolved storage path escapes uploads root", "PATH_TRAVERSAL");
  }
  return target;
}

function getS3Client(): S3ClientLike {
  if (testS3ClientOverride) return testS3ClientOverride;
  if (!cachedS3Client) {
    cachedS3Client = new S3Client({
      region: env.S3_REGION || "us-east-1",
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  return cachedS3Client;
}

function resolveS3Bucket(): string {
  const bucket = env.S3_BUCKET || (testS3ClientOverride ? "test-bucket" : "");
  if (!bucket) {
    throw new AppError(500, "S3_BUCKET is not configured for s3 storage driver", "STORAGE_CONFIG_ERROR");
  }
  return bucket;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === "function") {
    const arr = await withTransform.transformToByteArray();
    return Buffer.from(arr);
  }
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new AppError(500, "Unsupported S3 response body stream", "STORAGE_READ_ERROR");
}

export async function putStorageObject(
  key: string,
  body: Buffer,
  mimeType: string
): Promise<StoredObjectResult> {
  const safeKey = assertSafeStorageKey(key);
  const driver = getActiveStorageDriver();
  const sha256 = createHash("sha256").update(body).digest("hex");

  if (driver === "s3") {
    const client = getS3Client();
    const bucket = resolveS3Bucket();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: safeKey,
        Body: body,
        ContentType: mimeType,
        Metadata: { sha256 },
      })
    );
    return { driver, key: safeKey, sha256, sizeBytes: body.length };
  }

  const filePath = resolveLocalFilePath(safeKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);
  return { driver, key: safeKey, sha256, sizeBytes: body.length };
}

export async function getStorageObject(key: string, driverOverride?: StorageDriver): Promise<Buffer> {
  const safeKey = assertSafeStorageKey(key);
  const driver = driverOverride ?? getActiveStorageDriver();

  if (driver === "s3") {
    const client = getS3Client();
    const bucket = resolveS3Bucket();
    try {
      const response = (await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: safeKey,
        })
      )) as { Body?: unknown };
      return await bodyToBuffer(response?.Body);
    } catch (err) {
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (code === "NoSuchKey" || status === 404) {
        throw new AppError(404, "Stored attachment object not found", "NOT_FOUND");
      }
      throw err;
    }
  }

  const filePath = resolveLocalFilePath(safeKey);
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new AppError(404, "Stored attachment file not found", "NOT_FOUND");
    }
    throw err;
  }
}

export async function deleteStorageObject(key: string, driverOverride?: StorageDriver): Promise<void> {
  const safeKey = assertSafeStorageKey(key);
  const driver = driverOverride ?? getActiveStorageDriver();

  if (driver === "s3") {
    const client = getS3Client();
    const bucket = resolveS3Bucket();
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: safeKey,
      })
    );
    return;
  }

  const filePath = resolveLocalFilePath(safeKey);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
}

export interface StorageHealthStatus {
  driver: StorageDriver;
  ok: boolean;
  error?: string;
}

export async function checkStorageHealth(): Promise<StorageHealthStatus> {
  const driver = getActiveStorageDriver();

  if (driver === "s3") {
    try {
      const bucket = resolveS3Bucket();
      const client = getS3Client();
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return { driver, ok: true };
    } catch (err) {
      return {
        driver,
        ok: false,
        error: err instanceof Error ? err.message : "S3 storage bucket unreachable",
      };
    }
  }

  try {
    const rootDir = path.resolve(getLocalStorageRoot());
    await fs.mkdir(rootDir, { recursive: true });
    await fs.access(rootDir, fsConstants.R_OK | fsConstants.W_OK);
    return { driver, ok: true };
  } catch (err) {
    return {
      driver,
      ok: false,
      error: err instanceof Error ? err.message : "Local storage directory unreachable",
    };
  }
}
