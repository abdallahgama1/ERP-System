import fs from "node:fs/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { BackupFreshnessDto, BackupOffsiteStatusDto } from "@erp/shared";
import { getBackupFreshnessConfig } from "../config.ts";

interface RawBackupStatusPayload {
  status?: string;
  completedAt?: string;
  timestamp?: string;
  dbFile?: string | null;
  dbSizeBytes?: number | null;
  uploadsFile?: string | null;
  uploadsSizeBytes?: number | null;
  offsite?: Partial<BackupOffsiteStatusDto> | null;
}

function normalizeOffsite(raw: Partial<BackupOffsiteStatusDto> | null | undefined): BackupOffsiteStatusDto | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    enabled: Boolean(raw.enabled),
    uploaded: Boolean(raw.uploaded),
    encrypted: Boolean(raw.encrypted),
    bucket: typeof raw.bucket === "string" && raw.bucket ? raw.bucket : null,
    prefix: typeof raw.prefix === "string" && raw.prefix ? raw.prefix : null,
    uploadedAt: typeof raw.uploadedAt === "string" && raw.uploadedAt ? raw.uploadedAt : null,
    dbKey: typeof raw.dbKey === "string" && raw.dbKey ? raw.dbKey : null,
    uploadsKey: typeof raw.uploadsKey === "string" && raw.uploadsKey ? raw.uploadsKey : null,
  };
}

async function readS3LatestManifest(): Promise<RawBackupStatusPayload | null> {
  const cfg = getBackupFreshnessConfig();
  if (!cfg.s3Bucket || !cfg.s3AccessKeyId || !cfg.s3SecretAccessKey) {
    return null;
  }

  const client = new S3Client({
    region: cfg.s3Region,
    ...(cfg.s3Endpoint ? { endpoint: cfg.s3Endpoint } : {}),
    forcePathStyle: cfg.s3ForcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: cfg.s3SecretAccessKey,
    },
  });

  const key = cfg.s3Prefix ? `${cfg.s3Prefix}/latest.json` : "latest.json";
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.s3Bucket, Key: key }));
    const bodyText = await res.Body?.transformToString("utf8");
    if (!bodyText) return null;
    const parsed = JSON.parse(bodyText) as {
      completedAt?: string;
      uploadedAt?: string;
      timestamp?: string;
      db?: { fileName?: string; sizeBytes?: number; s3Key?: string };
      uploads?: { fileName?: string; sizeBytes?: number; s3Key?: string } | null;
      encrypted?: boolean;
      bucket?: string;
      prefix?: string;
    };
    return {
      status: "ok",
      completedAt: parsed.completedAt ?? parsed.uploadedAt,
      timestamp: parsed.timestamp,
      dbFile: parsed.db?.fileName ?? null,
      dbSizeBytes: typeof parsed.db?.sizeBytes === "number" ? parsed.db.sizeBytes : null,
      uploadsFile: parsed.uploads?.fileName ?? null,
      uploadsSizeBytes: typeof parsed.uploads?.sizeBytes === "number" ? parsed.uploads.sizeBytes : null,
      offsite: {
        enabled: true,
        uploaded: true,
        encrypted: parsed.encrypted !== false,
        bucket: parsed.bucket ?? cfg.s3Bucket,
        prefix: parsed.prefix ?? cfg.s3Prefix,
        uploadedAt: parsed.uploadedAt ?? parsed.completedAt ?? null,
        dbKey: parsed.db?.s3Key ?? null,
        uploadsKey: parsed.uploads?.s3Key ?? null,
      },
    };
  } finally {
    client.destroy();
  }
}

export async function getBackupFreshness(now = new Date()): Promise<BackupFreshnessDto> {
  const cfg = getBackupFreshnessConfig();
  const checkedAt = now.toISOString();

  let raw: RawBackupStatusPayload | null = null;
  let source: BackupFreshnessDto["source"] = "none";

  try {
    const text = await fs.readFile(cfg.statusFilePath, "utf8");
    raw = JSON.parse(text) as RawBackupStatusPayload;
    source = "status_file";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== "ENOENT") {
      return {
        ok: false,
        status: "error",
        checkedAt,
        maxAgeHours: cfg.maxAgeHours,
        lastBackupAt: null,
        ageSeconds: null,
        ageHours: null,
        stale: true,
        source: "none",
        statusFilePath: cfg.statusFilePath,
        dbFile: null,
        dbSizeBytes: null,
        uploadsFile: null,
        uploadsSizeBytes: null,
        offsite: null,
        message: `Failed to read backup status file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!code) {
      return {
        ok: false,
        status: "error",
        checkedAt,
        maxAgeHours: cfg.maxAgeHours,
        lastBackupAt: null,
        ageSeconds: null,
        ageHours: null,
        stale: true,
        source: "status_file",
        statusFilePath: cfg.statusFilePath,
        dbFile: null,
        dbSizeBytes: null,
        uploadsFile: null,
        uploadsSizeBytes: null,
        offsite: null,
        message: `Invalid JSON in backup status file (${cfg.statusFilePath})`,
      };
    }
  }

  if (!raw && cfg.s3Bucket) {
    try {
      raw = await readS3LatestManifest();
      if (raw) source = "s3_manifest";
    } catch (err) {
      return {
        ok: false,
        status: "error",
        checkedAt,
        maxAgeHours: cfg.maxAgeHours,
        lastBackupAt: null,
        ageSeconds: null,
        ageHours: null,
        stale: true,
        source: "s3_manifest",
        statusFilePath: cfg.statusFilePath,
        dbFile: null,
        dbSizeBytes: null,
        uploadsFile: null,
        uploadsSizeBytes: null,
        offsite: null,
        message: `Failed to query off-site backup manifest: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!raw || !raw.completedAt) {
    return {
      ok: false,
      status: "missing",
      checkedAt,
      maxAgeHours: cfg.maxAgeHours,
      lastBackupAt: null,
      ageSeconds: null,
      ageHours: null,
      stale: true,
      source: "none",
      statusFilePath: cfg.statusFilePath,
      dbFile: null,
      dbSizeBytes: null,
      uploadsFile: null,
      uploadsSizeBytes: null,
      offsite: null,
      message: `No successful backup recorded yet (expected status file at ${cfg.statusFilePath}).`,
    };
  }

  const parsedDate = new Date(raw.completedAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return {
      ok: false,
      status: "error",
      checkedAt,
      maxAgeHours: cfg.maxAgeHours,
      lastBackupAt: raw.completedAt,
      ageSeconds: null,
      ageHours: null,
      stale: true,
      source,
      statusFilePath: cfg.statusFilePath,
      dbFile: raw.dbFile ?? null,
      dbSizeBytes: typeof raw.dbSizeBytes === "number" ? raw.dbSizeBytes : null,
      uploadsFile: raw.uploadsFile ?? null,
      uploadsSizeBytes: typeof raw.uploadsSizeBytes === "number" ? raw.uploadsSizeBytes : null,
      offsite: normalizeOffsite(raw.offsite),
      message: `Invalid completedAt timestamp '${raw.completedAt}' in backup status record.`,
    };
  }

  const ageSeconds = Math.max(0, Math.round((now.getTime() - parsedDate.getTime()) / 1000));
  const ageHours = Math.round((ageSeconds / 3600) * 100) / 100;
  const maxAgeSeconds = cfg.maxAgeHours * 3600;
  const isOkStatus = !raw.status || raw.status === "ok";
  const stale = !isOkStatus || ageSeconds > maxAgeSeconds;
  const ok = !stale;

  return {
    ok,
    status: !isOkStatus ? "error" : stale ? "stale" : "fresh",
    checkedAt,
    maxAgeHours: cfg.maxAgeHours,
    lastBackupAt: parsedDate.toISOString(),
    ageSeconds,
    ageHours,
    stale,
    source,
    statusFilePath: cfg.statusFilePath,
    dbFile: raw.dbFile ?? null,
    dbSizeBytes: typeof raw.dbSizeBytes === "number" ? raw.dbSizeBytes : null,
    uploadsFile: raw.uploadsFile ?? null,
    uploadsSizeBytes: typeof raw.uploadsSizeBytes === "number" ? raw.uploadsSizeBytes : null,
    offsite: normalizeOffsite(raw.offsite),
    message: !isOkStatus
      ? `Last backup status reported '${raw.status}'`
      : stale
        ? `Backup is stale: ${ageHours}h old (threshold ${cfg.maxAgeHours}h)`
        : `Last successful backup was ${ageHours}h ago (within ${cfg.maxAgeHours}h threshold)`,
  };
}
