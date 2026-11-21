import { and, eq } from "drizzle-orm";
import {
  posTerminals,
  userPosPins,
  users,
  userSessions,
} from "../../drizzle/schema.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { loadAuthUserById, type AuthUser } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import type { RequestActor } from "./stock-locks.ts";

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export async function setUserPosPin(
  db: AppDatabase,
  actor: RequestActor,
  targetUserId: string,
  pin: string,
  ipAddress?: string
): Promise<{ userId: string; updatedAt: string }> {
  if (actor.id !== targetUserId && actor.role !== "admin" && actor.role !== "manager") {
    throw new AppError(403, "Only admins, managers, or the user themselves can update a POS PIN", "FORBIDDEN");
  }

  const [target] = await db
    .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target || !target.isActive) {
    throw new AppError(404, "Target user not found or inactive", "NOT_FOUND");
  }

  const pinHash = await hashPassword(pin);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(userPosPins)
      .values({
        userId: targetUserId,
        pinHash,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userPosPins.userId,
        set: {
          pinHash,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        },
      });

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "pos.pin_updated",
      entityType: "user",
      entityId: targetUserId,
      entityLabel: target.email,
      ipAddress,
    });
  });

  return { userId: targetUserId, updatedAt: now.toISOString() };
}

export async function bindSessionToTerminal(
  db: AppDatabase,
  sessionId: string,
  actor: RequestActor,
  terminalId: string,
  ipAddress?: string
): Promise<{ terminalId: string; branchId: string; code: string; name: string }> {
  const [terminal] = await db
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.isActive, true)))
    .limit(1);

  if (!terminal) {
    throw new AppError(404, "POS terminal not found or inactive", "TERMINAL_NOT_FOUND");
  }
  assertBranchAccess(actor, terminal.branchId);

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(userSessions)
      .set({
        posTerminalId: terminal.id,
        activeCashierId: actor.id,
        isTerminalLocked: false,
        lastActivityAt: now,
      })
      .where(eq(userSessions.id, sessionId));

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: terminal.branchId,
      action: "pos.terminal_bound",
      entityType: "pos_terminal",
      entityId: terminal.id,
      entityLabel: terminal.code,
      ipAddress,
    });
  });

  return {
    terminalId: terminal.id,
    branchId: terminal.branchId,
    code: terminal.code,
    name: terminal.name,
  };
}

export async function lockTerminalSession(
  db: AppDatabase,
  sessionId: string,
  actor: RequestActor,
  terminalId: string | null,
  ipAddress?: string
): Promise<{ isLocked: true }> {
  await db.transaction(async (tx) => {
    await tx
      .update(userSessions)
      .set({
        isTerminalLocked: true,
        lastActivityAt: new Date(),
      })
      .where(eq(userSessions.id, sessionId));

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "pos.terminal_locked",
      entityType: "pos_terminal",
      entityId: terminalId ?? sessionId,
      ipAddress,
    });
  });

  return { isLocked: true };
}

export async function switchCashierByPin(
  db: AppDatabase,
  params: {
    sessionId: string;
    terminalId: string | null;
    pin: string;
    cashierId?: string;
    ipAddress?: string;
  }
): Promise<{ user: AuthUser; terminalId: string | null; isLocked: false }> {
  const now = new Date();
  let terminalBranchId: string | null = null;
  if (params.terminalId) {
    const [terminal] = await db
      .select({ id: posTerminals.id, branchId: posTerminals.branchId, isActive: posTerminals.isActive })
      .from(posTerminals)
      .where(eq(posTerminals.id, params.terminalId))
      .limit(1);
    if (!terminal || !terminal.isActive) {
      throw new AppError(404, "POS terminal not found or inactive", "TERMINAL_NOT_FOUND");
    }
    terminalBranchId = terminal.branchId;
  }

  const candidateRows = params.cashierId
    ? await db
        .select({
          userId: userPosPins.userId,
          pinHash: userPosPins.pinHash,
          failedAttempts: userPosPins.failedAttempts,
          lockedUntil: userPosPins.lockedUntil,
        })
        .from(userPosPins)
        .innerJoin(users, eq(users.id, userPosPins.userId))
        .where(and(eq(userPosPins.userId, params.cashierId), eq(users.isActive, true)))
    : await db
        .select({
          userId: userPosPins.userId,
          pinHash: userPosPins.pinHash,
          failedAttempts: userPosPins.failedAttempts,
          lockedUntil: userPosPins.lockedUntil,
        })
        .from(userPosPins)
        .innerJoin(users, eq(users.id, userPosPins.userId))
        .where(eq(users.isActive, true));

  if (candidateRows.length === 0) {
    throw new AppError(401, "Invalid cashier PIN", "INVALID_PIN");
  }

  if (params.cashierId) {
    const target = candidateRows[0];
    if (target.lockedUntil && target.lockedUntil.getTime() > now.getTime()) {
      throw new AppError(429, "Cashier PIN is temporarily locked due to too many failed attempts", "PIN_LOCKED");
    }
  }

  let matchedUserId: string | null = null;
  for (const candidate of candidateRows) {
    if (candidate.lockedUntil && candidate.lockedUntil.getTime() > now.getTime()) {
      continue;
    }
    const ok = await verifyPassword(params.pin, candidate.pinHash);
    if (ok) {
      matchedUserId = candidate.userId;
      break;
    }
  }

  if (!matchedUserId) {
    if (params.cashierId) {
      const target = candidateRows[0];
      const nextAttempts = target.failedAttempts + 1;
      const lockedUntil = nextAttempts >= MAX_PIN_ATTEMPTS ? new Date(now.getTime() + PIN_LOCKOUT_MS) : null;
      await db
        .update(userPosPins)
        .set({ failedAttempts: nextAttempts, lockedUntil, updatedAt: now })
        .where(eq(userPosPins.userId, target.userId));
      if (lockedUntil) {
        throw new AppError(429, "Cashier PIN is temporarily locked due to too many failed attempts", "PIN_LOCKED");
      }
    }
    throw new AppError(401, "Invalid cashier PIN", "INVALID_PIN");
  }

  const cashierUser = await loadAuthUserById(db, matchedUserId);
  if (!cashierUser) {
    throw new AppError(403, "Cashier account is inactive", "ACCOUNT_DISABLED");
  }
  if (cashierUser.role !== "admin" && !cashierUser.permissions.pos?.view) {
    throw new AppError(403, "Cashier does not have POS register access", "FORBIDDEN");
  }
  if (terminalBranchId) {
    assertBranchAccess(cashierUser, terminalBranchId);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(userPosPins)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(eq(userPosPins.userId, matchedUserId));

    await tx
      .update(userSessions)
      .set({
        activeCashierId: matchedUserId,
        isTerminalLocked: false,
        lastActivityAt: now,
      })
      .where(eq(userSessions.id, params.sessionId));

    await writeAuditLog(tx, {
      userId: cashierUser.id,
      userName: cashierUser.name,
      userRole: cashierUser.role,
      branchId: terminalBranchId,
      action: "pos.cashier_switched",
      entityType: "pos_terminal",
      entityId: params.terminalId ?? params.sessionId,
      entityLabel: cashierUser.email,
      ipAddress: params.ipAddress,
    });
  });

  return {
    user: cashierUser,
    terminalId: params.terminalId,
    isLocked: false,
  };
}
