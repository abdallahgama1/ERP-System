export interface BackupOffsiteStatusDto {
  enabled: boolean;
  uploaded: boolean;
  encrypted: boolean;
  bucket: string | null;
  prefix: string | null;
  uploadedAt: string | null;
  dbKey: string | null;
  uploadsKey: string | null;
}

export interface BackupFreshnessDto {
  ok: boolean;
  status: "fresh" | "stale" | "missing" | "error";
  checkedAt: string;
  maxAgeHours: number;
  lastBackupAt: string | null;
  ageSeconds: number | null;
  ageHours: number | null;
  stale: boolean;
  source: "status_file" | "s3_manifest" | "none";
  statusFilePath: string;
  dbFile: string | null;
  dbSizeBytes: number | null;
  uploadsFile: string | null;
  uploadsSizeBytes: number | null;
  offsite: BackupOffsiteStatusDto | null;
  message: string;
}
