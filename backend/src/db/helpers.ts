import { createHash } from "node:crypto";
import { AUDIT_SENSITIVE_FIELDS } from "@erp/shared";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { auditLogs, DEFAULT_COMPANY_ID, documentSequences } from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { getRequestContext } from "../logging/logger.ts";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, code = "BAD_REQUEST", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const num = (value: string | number | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toNumeric = (value: number, scale = 4): string => {
  const factor = Math.pow(10, scale);
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return rounded.toFixed(scale);
};

export async function nextDocNumber(
  tx: DbOrTx,
  docType: string,
  defaultPrefix?: string,
  branchId?: string | null,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<string> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;
  const scopeKey = branchId ? `branch:${branchId}` : "company";
  const rows = await tx.execute<{
    id: string;
    prefix: string;
    next_number: number;
    padding: number;
  }>(sql`
    SELECT id, prefix, next_number, padding
    FROM document_sequences
    WHERE company_id = ${effectiveCompanyId} AND doc_type = ${docType} AND scope_key = ${scopeKey}
    FOR UPDATE
  `);

  let seq = rows[0];
  if (!seq) {
    const prefix = defaultPrefix ?? `${docType}-`;
    const [inserted] = await tx
      .insert(documentSequences)
      .values({
        companyId: effectiveCompanyId,
        docType,
        scopeKey,
        branchId: branchId ?? null,
        prefix,
        nextNumber: 2,
        padding: 4,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return `${prefix}${String(1).padStart(4, "0")}`;
    }

    const retryRows = await tx.execute<{
      id: string;
      prefix: string;
      next_number: number;
      padding: number;
    }>(sql`
      SELECT id, prefix, next_number, padding
      FROM document_sequences
      WHERE company_id = ${effectiveCompanyId} AND doc_type = ${docType} AND scope_key = ${scopeKey}
      FOR UPDATE
    `);
    if (!retryRows[0]) {
      throw new AppError(500, `Failed to allocate document sequence for ${docType}`);
    }
    seq = retryRows[0];
  }

  const assigned = seq.next_number;
  await tx
    .update(documentSequences)
    .set({ nextNumber: assigned + 1, updatedAt: new Date() })
    .where(eq(documentSequences.id, seq.id));

  return `${seq.prefix}${String(assigned).padStart(seq.padding, "0")}`;
}

const toSnakeLower = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const SENSITIVE_AUDIT_KEY_SET = new Set<string>(
  AUDIT_SENSITIVE_FIELDS.flatMap((field) => [field.toLowerCase(), toSnakeLower(field)])
);

export function isSensitiveAuditKey(key: string): boolean {
  const lower = key.toLowerCase();
  const snake = toSnakeLower(key);
  if (SENSITIVE_AUDIT_KEY_SET.has(lower) || SENSITIVE_AUDIT_KEY_SET.has(snake)) {
    return true;
  }
  return (
    /password/.test(snake) ||
    /(?:^|_)pin(?:$|_|hash|code)/.test(snake) ||
    /pos_?pin/.test(snake) ||
    /secret/.test(snake) ||
    /(?:^|_)tokens?(?:$|_)/.test(snake) ||
    /^recovery_codes?/.test(snake) ||
    /^eta_client/.test(snake) ||
    /^smtp_pass/.test(snake) ||
    /^s3_secret/.test(snake)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function scrubSensitiveAuditData(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return value;
  if (depth >= 16) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => scrubSensitiveAuditData(item, seen, depth + 1));
    }

    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(source)) {
      if (val === undefined) continue;
      if (isSensitiveAuditKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = scrubSensitiveAuditData(val, seen, depth + 1);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function canonicalAuditValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return value;
  if (depth >= 16) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalAuditValue(item, seen, depth + 1));
    }
    const sorted: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const val = record[key];
      if (val !== undefined) {
        sorted[key] = canonicalAuditValue(val, seen, depth + 1);
      }
    }
    return sorted;
  } finally {
    seen.delete(value);
  }
}

export function computeAuditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): {
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  changedFields: string[];
} {
  const beforeRecord = before && isPlainRecord(before) ? before : null;
  const afterRecord = after && isPlainRecord(after) ? after : null;

  const beforeJson = beforeRecord ? (scrubSensitiveAuditData(beforeRecord) as Record<string, unknown>) : null;
  const afterJson = afterRecord ? (scrubSensitiveAuditData(afterRecord) as Record<string, unknown>) : null;

  let changedFields: string[] = [];
  if (beforeRecord && afterRecord) {
    const allKeys = new Set<string>([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    changedFields = Array.from(allKeys)
      .filter((key) => {
        const prev = beforeRecord[key];
        const next = afterRecord[key];
        if (prev === undefined && next === undefined) return false;
        return JSON.stringify(canonicalAuditValue(prev)) !== JSON.stringify(canonicalAuditValue(next));
      })
      .sort();
  } else if (afterJson) {
    changedFields = Object.keys(afterJson).sort();
  } else if (beforeJson) {
    changedFields = Object.keys(beforeJson).sort();
  }

  return {
    beforeJson,
    afterJson,
    changedFields,
  };
}

export interface AuditWriteInput {
  companyId?: string | null;
  userId?: string | null;
  userName: string;
  userRole?: string | null;
  branchId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  details?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  beforeJson?: Record<string, unknown> | null;
  afterJson?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export const AUDIT_CHAIN_GENESIS_HASH = "GENESIS";

export interface AuditChainHashInput {
  chainSeq: number;
  prevHash: string;
  companyId: string;
  userId: string | null;
  userName: string;
  userRole: string | null;
  branchId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  details: Record<string, unknown>;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  changedFields: string[];
  ipAddress: string | null;
  createdAt: Date | string;
}

export function computeAuditEntryHash(input: AuditChainHashInput): string {
  const createdAtIso =
    input.createdAt instanceof Date ? input.createdAt.toISOString() : new Date(input.createdAt).toISOString();
  const canonicalPayload = {
    v: 1,
    chainSeq: input.chainSeq,
    prevHash: input.prevHash,
    companyId: input.companyId,
    userId: input.userId ?? null,
    userName: input.userName,
    userRole: input.userRole ?? null,
    branchId: input.branchId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    details: canonicalAuditValue(input.details ?? {}),
    beforeJson: input.beforeJson ? canonicalAuditValue(input.beforeJson) : null,
    afterJson: input.afterJson ? canonicalAuditValue(input.afterJson) : null,
    changedFields: Array.isArray(input.changedFields) ? input.changedFields : [],
    ipAddress: input.ipAddress ?? null,
    createdAt: createdAtIso,
  };
  return createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
}

export interface AuditChainVerificationResult {
  valid: boolean;
  companyId: string;
  totalChainedRows: number;
  legacyUnchainedRows: number;
  latestChainSeq: number | null;
  latestEntryHash: string | null;
  firstBrokenId: string | null;
  firstBrokenSeq: number | null;
  reason: string | null;
}

export async function verifyAuditLogChain(
  db: DbOrTx,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<AuditChainVerificationResult> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;

  const [{ legacyCount }] = await db
    .select({ legacyCount: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, effectiveCompanyId), isNull(auditLogs.chainSeq)));

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, effectiveCompanyId), isNotNull(auditLogs.chainSeq)))
    .orderBy(asc(auditLogs.chainSeq));

  let expectedSeq = 1;
  let expectedPrevHash = AUDIT_CHAIN_GENESIS_HASH;
  let latestChainSeq: number | null = null;
  let latestEntryHash: string | null = null;

  for (const row of rows) {
    const seq = Number(row.chainSeq);
    if (seq !== expectedSeq) {
      return {
        valid: false,
        companyId: effectiveCompanyId,
        totalChainedRows: rows.length,
        legacyUnchainedRows: legacyCount,
        latestChainSeq,
        latestEntryHash,
        firstBrokenId: row.id,
        firstBrokenSeq: seq,
        reason: `Sequence gap or reorder detected: expected chain_seq ${expectedSeq}, found ${seq}`,
      };
    }

    if (!row.prevHash || !row.entryHash) {
      return {
        valid: false,
        companyId: effectiveCompanyId,
        totalChainedRows: rows.length,
        legacyUnchainedRows: legacyCount,
        latestChainSeq,
        latestEntryHash,
        firstBrokenId: row.id,
        firstBrokenSeq: seq,
        reason: `Missing hash chain metadata at chain_seq ${seq}`,
      };
    }

    if (row.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        companyId: effectiveCompanyId,
        totalChainedRows: rows.length,
        legacyUnchainedRows: legacyCount,
        latestChainSeq,
        latestEntryHash,
        firstBrokenId: row.id,
        firstBrokenSeq: seq,
        reason: `Broken prev_hash link at chain_seq ${seq}`,
      };
    }

    const recomputed = computeAuditEntryHash({
      chainSeq: seq,
      prevHash: row.prevHash,
      companyId: row.companyId,
      userId: row.userId ?? null,
      userName: row.userName,
      userRole: row.userRole ?? null,
      branchId: row.branchId ?? null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel ?? null,
      details: row.details ?? {},
      beforeJson: row.beforeJson ?? null,
      afterJson: row.afterJson ?? null,
      changedFields: row.changedFields ?? [],
      ipAddress: row.ipAddress ?? null,
      createdAt: row.createdAt,
    });

    if (recomputed !== row.entryHash) {
      return {
        valid: false,
        companyId: effectiveCompanyId,
        totalChainedRows: rows.length,
        legacyUnchainedRows: legacyCount,
        latestChainSeq,
        latestEntryHash,
        firstBrokenId: row.id,
        firstBrokenSeq: seq,
        reason: `Entry hash mismatch at chain_seq ${seq} (row tampered)`,
      };
    }

    expectedSeq += 1;
    expectedPrevHash = row.entryHash;
    latestChainSeq = seq;
    latestEntryHash = row.entryHash;
  }

  return {
    valid: true,
    companyId: effectiveCompanyId,
    totalChainedRows: rows.length,
    legacyUnchainedRows: legacyCount,
    latestChainSeq,
    latestEntryHash,
    firstBrokenId: null,
    firstBrokenSeq: null,
    reason: null,
  };
}

export async function writeAuditLog(tx: DbOrTx, input: AuditWriteInput): Promise<void> {
  const ctx = getRequestContext();
  const rawDetails = ctx?.reqId ? { reqId: ctx.reqId, ...(input.details ?? {}) } : (input.details ?? {});
  const details = scrubSensitiveAuditData(rawDetails) as Record<string, unknown>;
  const diff = computeAuditDiff(input.before ?? input.beforeJson, input.after ?? input.afterJson);
  const companyId = input.companyId || DEFAULT_COMPANY_ID;

  await tx.transaction(async (innerTx) => {
    // Serialize audit-log hash chain appends per company until the outer transaction commits
    await innerTx.execute(sql`SELECT pg_advisory_xact_lock(749208, hashtext(${companyId}))`);

    const headRows = await innerTx.execute<{
      chain_seq: string | number;
      entry_hash: string;
    }>(sql`
      SELECT chain_seq, entry_hash
      FROM audit_logs
      WHERE company_id = ${companyId} AND chain_seq IS NOT NULL
      ORDER BY chain_seq DESC
      LIMIT 1
    `);

    const head = headRows[0];
    const chainSeq = head ? Number(head.chain_seq) + 1 : 1;
    const prevHash = head?.entry_hash ?? AUDIT_CHAIN_GENESIS_HASH;
    const createdAt = new Date();
    const entryHash = computeAuditEntryHash({
      chainSeq,
      prevHash,
      companyId,
      userId: input.userId ?? null,
      userName: input.userName,
      userRole: input.userRole ?? null,
      branchId: input.branchId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      details,
      beforeJson: diff.beforeJson,
      afterJson: diff.afterJson,
      changedFields: diff.changedFields,
      ipAddress: input.ipAddress ?? null,
      createdAt,
    });

    await innerTx.insert(auditLogs).values({
      companyId,
      userId: input.userId ?? null,
      userName: input.userName,
      userRole: input.userRole ?? null,
      branchId: input.branchId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      details,
      beforeJson: diff.beforeJson,
      afterJson: diff.afterJson,
      changedFields: diff.changedFields,
      ipAddress: input.ipAddress ?? null,
      chainSeq,
      prevHash,
      entryHash,
      createdAt,
    });
  });
}
