import { eq, sql } from "drizzle-orm";
import { auditLogs, documentSequences } from "../../drizzle/schema.ts";
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
  branchId?: string | null
): Promise<string> {
  const scopeKey = branchId ? `branch:${branchId}` : "company";
  const rows = await tx.execute<{
    id: string;
    prefix: string;
    next_number: number;
    padding: number;
  }>(sql`
    SELECT id, prefix, next_number, padding
    FROM document_sequences
    WHERE doc_type = ${docType} AND scope_key = ${scopeKey}
    FOR UPDATE
  `);

  let seq = rows[0];
  if (!seq) {
    const prefix = defaultPrefix ?? `${docType}-`;
    const [inserted] = await tx
      .insert(documentSequences)
      .values({
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
      WHERE doc_type = ${docType} AND scope_key = ${scopeKey}
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

export interface AuditWriteInput {
  userId?: string | null;
  userName: string;
  userRole?: string | null;
  branchId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAuditLog(tx: DbOrTx, input: AuditWriteInput): Promise<void> {
  const ctx = getRequestContext();
  const details = ctx?.reqId ? { reqId: ctx.reqId, ...(input.details ?? {}) } : (input.details ?? {});
  await tx.insert(auditLogs).values({
    userId: input.userId ?? null,
    userName: input.userName,
    userRole: input.userRole ?? null,
    branchId: input.branchId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    details,
    ipAddress: input.ipAddress ?? null,
  });
}
