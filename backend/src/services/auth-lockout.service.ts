import { and, eq, sql } from "drizzle-orm";
import { authLockouts } from "../../drizzle/schema.ts";
import { getAuthHardeningConfig } from "../config.ts";
import { AppError } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";

export type AuthLockoutScope =
  | "login"
  | "mfa_login"
  | "mfa_enroll_verify"
  | "mfa_recovery"
  | "mfa_disable"
  | "forgot_password"
  | "password_reset";

export interface LockoutRecordResult {
  locked: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
  retryAfterSeconds: number;
}

function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim().toLowerCase();
  return trimmed.slice(0, 255) || "unknown";
}

export async function assertNotLocked(
  db: AppDatabase,
  scope: AuthLockoutScope,
  identifier: string,
  now = new Date()
): Promise<void> {
  const normalized = normalizeIdentifier(identifier);
  const [row] = await db
    .select({
      lockedUntil: authLockouts.lockedUntil,
      failedAttempts: authLockouts.failedAttempts,
    })
    .from(authLockouts)
    .where(and(eq(authLockouts.scope, scope), eq(authLockouts.identifier, normalized)))
    .limit(1);

  if (row?.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000));
    throw new AppError(
      429,
      `Too many failed attempts. Please try again in ${retryAfterSeconds} seconds.`,
      "ACCOUNT_LOCKED",
      {
        scope,
        retryAfterSeconds,
        lockedUntil: row.lockedUntil.toISOString(),
      }
    );
  }
}

export async function recordFailedAuthAttempt(
  db: AppDatabase,
  scope: AuthLockoutScope,
  identifier: string,
  now = new Date()
): Promise<LockoutRecordResult> {
  const normalized = normalizeIdentifier(identifier);
  const cfg = getAuthHardeningConfig();

  return db.transaction(async (tx) => {
    const existingRows = await tx.execute<{
      failed_attempts: number;
      first_failed_at: Date | string;
      locked_until: Date | string | null;
    }>(sql`
      SELECT failed_attempts, first_failed_at, locked_until
      FROM auth_lockouts
      WHERE scope = ${scope} AND identifier = ${normalized}
      FOR UPDATE
    `);

    const existing = existingRows[0];
    const windowCutoffMs = now.getTime() - cfg.lockoutWindowMs;

    let nextAttempts = 1;
    let nextFirstFailedAt = now;

    if (existing) {
      const firstFailedMs = new Date(existing.first_failed_at).getTime();
      const existingLockedMs = existing.locked_until ? new Date(existing.locked_until).getTime() : 0;
      const lockExpired = existingLockedMs > 0 && existingLockedMs <= now.getTime();
      const windowExpired = firstFailedMs < windowCutoffMs;

      if (!lockExpired && !windowExpired) {
        nextAttempts = Number(existing.failed_attempts) + 1;
        nextFirstFailedAt = new Date(existing.first_failed_at);
      }
    }

    const shouldLock = nextAttempts >= cfg.lockoutMaxAttempts;
    const nextLockedUntil = shouldLock ? new Date(now.getTime() + cfg.lockoutDurationMs) : null;

    await tx
      .insert(authLockouts)
      .values({
        scope,
        identifier: normalized,
        failedAttempts: nextAttempts,
        firstFailedAt: nextFirstFailedAt,
        lockedUntil: nextLockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [authLockouts.scope, authLockouts.identifier],
        set: {
          failedAttempts: nextAttempts,
          firstFailedAt: nextFirstFailedAt,
          lockedUntil: nextLockedUntil,
          updatedAt: now,
        },
      });

    const retryAfterSeconds = nextLockedUntil
      ? Math.max(1, Math.ceil((nextLockedUntil.getTime() - now.getTime()) / 1000))
      : 0;

    return {
      locked: shouldLock,
      failedAttempts: nextAttempts,
      lockedUntil: nextLockedUntil,
      retryAfterSeconds,
    };
  });
}

export async function clearAuthLockout(
  db: AppDatabase,
  scope: AuthLockoutScope,
  identifier: string
): Promise<void> {
  const normalized = normalizeIdentifier(identifier);
  await db
    .delete(authLockouts)
    .where(and(eq(authLockouts.scope, scope), eq(authLockouts.identifier, normalized)));
}
