import { and, isNotNull, lt, or, sql } from "drizzle-orm";
import { idempotencyKeys, passwordResetTokens, userSessions } from "../../drizzle/schema.ts";
import { writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { recordHousekeepingFailure, recordHousekeepingResult } from "../observability/metrics.ts";
import type { RequestActor } from "./stock-locks.ts";

export const HOUSEKEEPING_LOCK_KEY = 910301;
const DEFAULT_REVOKED_SESSION_RETENTION_DAYS = 7;

export interface HousekeepingOptions {
  now?: Date;
  revokedRetentionDays?: number;
  actor?: RequestActor;
  ipAddress?: string;
}

export interface HousekeepingResult {
  skipped: boolean;
  deletedSessions: number;
  deletedResetTokens: number;
  deletedIdempotencyKeys: number;
  totalDeleted: number;
  checkedAt: string;
}

export async function runHousekeeping(
  db: AppDatabase,
  options?: HousekeepingOptions
): Promise<HousekeepingResult> {
  const now = options?.now ?? new Date();
  const retentionDays = options?.revokedRetentionDays ?? DEFAULT_REVOKED_SESSION_RETENTION_DAYS;
  const revokedCutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  try {
    const result = await db.transaction(async (tx): Promise<HousekeepingResult> => {
      const lockRows = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${HOUSEKEEPING_LOCK_KEY}) AS acquired`
      );
      if (!lockRows[0]?.acquired) {
        return {
          skipped: true,
          deletedSessions: 0,
          deletedResetTokens: 0,
          deletedIdempotencyKeys: 0,
          totalDeleted: 0,
          checkedAt: now.toISOString(),
        };
      }

      const purgedSessions = await tx
        .delete(userSessions)
        .where(
          or(
            lt(userSessions.expiresAt, now),
            and(isNotNull(userSessions.revokedAt), lt(userSessions.revokedAt, revokedCutoff))
          )
        )
        .returning({ id: userSessions.id });

      const purgedResetTokens = await tx
        .delete(passwordResetTokens)
        .where(or(lt(passwordResetTokens.expiresAt, now), isNotNull(passwordResetTokens.usedAt)))
        .returning({ id: passwordResetTokens.id });

      const purgedIdempotencyKeys = await tx
        .delete(idempotencyKeys)
        .where(and(isNotNull(idempotencyKeys.expiresAt), lt(idempotencyKeys.expiresAt, now)))
        .returning({ id: idempotencyKeys.id });

      const deletedSessions = purgedSessions.length;
      const deletedResetTokens = purgedResetTokens.length;
      const deletedIdempotencyKeys = purgedIdempotencyKeys.length;
      const totalDeleted = deletedSessions + deletedResetTokens + deletedIdempotencyKeys;

      if (options?.actor || totalDeleted > 0) {
        await writeAuditLog(tx, {
          userId: options?.actor?.id ?? null,
          userName: options?.actor?.name ?? "System Scheduler",
          userRole: options?.actor?.role ?? "system",
          action: "system.housekeeping",
          entityType: "system",
          entityId: "housekeeping",
          details: {
            deletedSessions,
            deletedResetTokens,
            deletedIdempotencyKeys,
            totalDeleted,
          },
          ipAddress: options?.ipAddress,
        });
      }

      return {
        skipped: false,
        deletedSessions,
        deletedResetTokens,
        deletedIdempotencyKeys,
        totalDeleted,
        checkedAt: now.toISOString(),
      };
    });

    recordHousekeepingResult(result);
    return result;
  } catch (err) {
    recordHousekeepingFailure();
    throw err;
  }
}
