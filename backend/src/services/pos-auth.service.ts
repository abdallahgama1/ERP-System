import { and, eq, isNotNull, or } from "drizzle-orm";
import type { PosOverrideAction } from "@erp/shared";
import {
  posTerminals,
  userCompanies,
  userPosPins,
  userRoles,
  users,
  userSessions,
} from "../../drizzle/schema.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { loadAuthUserById, type AuthUser } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export async function setUserPosPin(
  db: AppDatabase,
  actor: RequestActor,
  targetUserId: string,
  pin: string,
  ipAddress?: string
): Promise<{ userId: string; updatedAt: string }> {
  const companyId = actorCompanyId(actor);
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

  if (actor.id !== targetUserId) {
    const [actorGlobalRole] = await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, actor.id))
      .limit(1);
    if (actorGlobalRole?.role !== "admin") {
      const [targetMembership] = await db
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .where(
          and(
            eq(userCompanies.userId, targetUserId),
            eq(userCompanies.companyId, companyId),
            eq(userCompanies.isActive, true)
          )
        )
        .limit(1);
      if (!targetMembership) {
        throw new AppError(404, "Target user not found in active company", "NOT_FOUND");
      }
    }
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
      companyId,
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
  const companyId = actorCompanyId(actor);
  const [terminal] = await db
    .select()
    .from(posTerminals)
    .where(
      and(
        eq(posTerminals.id, terminalId),
        eq(posTerminals.companyId, companyId),
        eq(posTerminals.isActive, true)
      )
    )
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
      companyId,
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
  const companyId = actorCompanyId(actor);
  await db.transaction(async (tx) => {
    await tx
      .update(userSessions)
      .set({
        isTerminalLocked: true,
        lastActivityAt: new Date(),
      })
      .where(eq(userSessions.id, sessionId));

    await writeAuditLog(tx, {
      companyId,
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
    companyId?: string;
    pin: string;
    cashierId?: string;
    ipAddress?: string;
  }
): Promise<{ user: AuthUser; terminalId: string | null; isLocked: false }> {
  const now = new Date();
  let terminalBranchId: string | null = null;
  let terminalCompanyId: string | null = null;
  if (params.terminalId) {
    const [terminal] = await db
      .select({
        id: posTerminals.id,
        companyId: posTerminals.companyId,
        branchId: posTerminals.branchId,
        isActive: posTerminals.isActive,
      })
      .from(posTerminals)
      .where(
        params.companyId
          ? and(eq(posTerminals.id, params.terminalId), eq(posTerminals.companyId, params.companyId))
          : eq(posTerminals.id, params.terminalId)
      )
      .limit(1);
    if (!terminal || !terminal.isActive) {
      throw new AppError(404, "POS terminal not found or inactive", "TERMINAL_NOT_FOUND");
    }
    terminalBranchId = terminal.branchId;
    terminalCompanyId = terminal.companyId;
  }
  const effectiveCompanyId = terminalCompanyId ?? params.companyId;

  const companyScopeFilter = effectiveCompanyId
    ? or(isNotNull(userCompanies.id), eq(userRoles.role, "admin"))
    : undefined;

  const queriedCashierRows = await db
    .select({
      userId: userPosPins.userId,
      pinHash: userPosPins.pinHash,
      failedAttempts: userPosPins.failedAttempts,
      lockedUntil: userPosPins.lockedUntil,
    })
    .from(userPosPins)
    .innerJoin(users, eq(users.id, userPosPins.userId))
    .leftJoin(userRoles, eq(userRoles.userId, userPosPins.userId))
    .leftJoin(
      userCompanies,
      effectiveCompanyId
        ? and(
            eq(userCompanies.userId, userPosPins.userId),
            eq(userCompanies.companyId, effectiveCompanyId),
            eq(userCompanies.isActive, true)
          )
        : eq(userCompanies.userId, userPosPins.userId)
    )
    .where(
      and(
        eq(users.isActive, true),
        params.cashierId ? eq(userPosPins.userId, params.cashierId) : undefined,
        companyScopeFilter
      )
    );

  const seenCashierIds = new Set<string>();
  const candidateRows = queriedCashierRows.filter((row) => {
    if (seenCashierIds.has(row.userId)) return false;
    seenCashierIds.add(row.userId);
    return true;
  });

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

  const cashierUser = await loadAuthUserById(db, matchedUserId, effectiveCompanyId);
  if (!cashierUser) {
    throw new AppError(403, "Cashier account is inactive", "ACCOUNT_DISABLED");
  }
  if (effectiveCompanyId && cashierUser.activeCompanyId !== effectiveCompanyId) {
    throw new AppError(403, "Cashier does not belong to this terminal's company", "COMPANY_FORBIDDEN");
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
      companyId: effectiveCompanyId ?? cashierUser.activeCompanyId,
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

export async function verifyManagerPinOverride(
  db: DbOrTx,
  input: {
    pin: string;
    managerUserId?: string;
    terminalId?: string;
    companyId?: string;
    action?: PosOverrideAction;
    reason?: string;
    requestedByUserId: string;
    requestedByName?: string;
    requestedByRole?: string;
    branchIds: string[];
    hasAllBranchScope: boolean;
    ipAddress?: string;
  }
): Promise<{
  verified: true;
  approver: {
    id: string;
    name: string;
    role: AuthUser["role"];
  };
}> {
  if (!/^\d{4,6}$/.test(input.pin)) {
    throw new AppError(400, "PIN must be 4 to 6 numeric digits", "VALIDATION_ERROR");
  }

  const now = new Date();
  let terminalBranchId: string | null = null;
  let terminalCompanyId: string | null = null;
  if (input.terminalId) {
    const [terminal] = await db
      .select({
        id: posTerminals.id,
        companyId: posTerminals.companyId,
        branchId: posTerminals.branchId,
        isActive: posTerminals.isActive,
      })
      .from(posTerminals)
      .where(
        input.companyId
          ? and(eq(posTerminals.id, input.terminalId), eq(posTerminals.companyId, input.companyId))
          : eq(posTerminals.id, input.terminalId)
      )
      .limit(1);
    if (!terminal || !terminal.isActive) {
      throw new AppError(404, "POS terminal not found or inactive", "TERMINAL_NOT_FOUND");
    }
    if (!input.hasAllBranchScope && !input.branchIds.includes(terminal.branchId)) {
      throw new AppError(403, "Forbidden: you do not have access to this branch", "BRANCH_FORBIDDEN");
    }
    terminalBranchId = terminal.branchId;
    terminalCompanyId = terminal.companyId;
  }
  const effectiveCompanyId = terminalCompanyId ?? input.companyId;

  const companyScopeFilter = effectiveCompanyId
    ? or(isNotNull(userCompanies.id), eq(userRoles.role, "admin"))
    : undefined;

  const queriedCandidates = await db
    .select({
      userId: userPosPins.userId,
      pinHash: userPosPins.pinHash,
      failedAttempts: userPosPins.failedAttempts,
      lockedUntil: userPosPins.lockedUntil,
      companyRole: userCompanies.role,
      globalRole: userRoles.role,
    })
    .from(userPosPins)
    .innerJoin(users, eq(users.id, userPosPins.userId))
    .leftJoin(userRoles, eq(userRoles.userId, userPosPins.userId))
    .leftJoin(
      userCompanies,
      effectiveCompanyId
        ? and(
            eq(userCompanies.userId, userPosPins.userId),
            eq(userCompanies.companyId, effectiveCompanyId),
            eq(userCompanies.isActive, true)
          )
        : eq(userCompanies.userId, userPosPins.userId)
    )
    .where(
      and(
        eq(users.isActive, true),
        input.managerUserId ? eq(userPosPins.userId, input.managerUserId) : undefined,
        companyScopeFilter
      )
    );

  // Deduplicate by userId (only relevant when effectiveCompanyId is absent and user belongs to multiple companies)
  const seenCandidateIds = new Set<string>();
  const rawCandidates = queriedCandidates
    .filter((row) => {
      if (seenCandidateIds.has(row.userId)) return false;
      seenCandidateIds.add(row.userId);
      return true;
    })
    .map((row) => ({
      userId: row.userId,
      pinHash: row.pinHash,
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil,
      role: row.companyRole ?? row.globalRole,
    }));

  if (rawCandidates.length === 0) {
    throw new AppError(401, "Invalid manager PIN", "INVALID_PIN");
  }

  if (input.managerUserId) {
    const target = rawCandidates[0];
    if (target.lockedUntil && target.lockedUntil.getTime() > now.getTime()) {
      throw new AppError(
        429,
        "Manager PIN is temporarily locked due to too many failed attempts",
        "PIN_LOCKED"
      );
    }
  }

  // Prioritize admin/manager accounts before regular cashier accounts if multiple users share a PIN
  const roleWeight = (role: string | null) => (role === "admin" ? 0 : role === "manager" ? 1 : 2);
  const candidateRows = [...rawCandidates].sort((a, b) => roleWeight(a.role) - roleWeight(b.role));

  let matchedUserId: string | null = null;
  for (const candidate of candidateRows) {
    const ok = await verifyPassword(input.pin, candidate.pinHash);
    if (ok) {
      if (candidate.lockedUntil && candidate.lockedUntil.getTime() > now.getTime()) {
        throw new AppError(
          429,
          "Manager PIN is temporarily locked due to too many failed attempts",
          "PIN_LOCKED"
        );
      }
      matchedUserId = candidate.userId;
      break;
    }
  }

  if (!matchedUserId) {
    const lockoutTargets = input.managerUserId
      ? [rawCandidates[0]]
      : rawCandidates.filter((c) => c.role === "admin" || c.role === "manager");

    let triggeredLockout = false;
    for (const target of lockoutTargets) {
      if (target.lockedUntil && target.lockedUntil.getTime() > now.getTime()) {
        triggeredLockout = true;
        continue;
      }
      const nextAttempts = target.failedAttempts + 1;
      const lockedUntil =
        nextAttempts >= MAX_PIN_ATTEMPTS ? new Date(now.getTime() + PIN_LOCKOUT_MS) : null;
      await db
        .update(userPosPins)
        .set({ failedAttempts: nextAttempts, lockedUntil, updatedAt: now })
        .where(eq(userPosPins.userId, target.userId));
      if (lockedUntil) {
        triggeredLockout = true;
      }
    }

    if (triggeredLockout) {
      throw new AppError(
        429,
        "Manager PIN is temporarily locked due to too many failed attempts",
        "PIN_LOCKED"
      );
    }
    throw new AppError(401, "Invalid manager PIN", "INVALID_PIN");
  }

  const approver = await loadAuthUserById(db, matchedUserId, effectiveCompanyId);
  if (!approver || !approver.isActive) {
    throw new AppError(403, "Approver account is inactive", "ACCOUNT_DISABLED");
  }
  if (effectiveCompanyId && approver.activeCompanyId !== effectiveCompanyId) {
    throw new AppError(403, "Approver does not belong to this company", "COMPANY_FORBIDDEN");
  }

  const hasApprovePrivilege =
    approver.role === "admin" ||
    approver.role === "manager" ||
    Boolean(approver.permissions.pos?.approve);

  if (!hasApprovePrivilege) {
    throw new AppError(
      403,
      "Manager or Admin privilege required for POS override",
      "POS_OVERRIDE_FORBIDDEN"
    );
  }

  if (terminalBranchId) {
    assertBranchAccess(approver, terminalBranchId);
  }

  await db
    .update(userPosPins)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
    .where(eq(userPosPins.userId, matchedUserId));

  await writeAuditLog(db, {
    companyId: effectiveCompanyId ?? approver.activeCompanyId,
    userId: input.requestedByUserId,
    userName: input.requestedByName ?? approver.name,
    userRole: input.requestedByRole ?? approver.role,
    branchId: terminalBranchId,
    action: "pos_manager_override",
    entityType: "pos_terminal",
    entityId: input.terminalId ?? approver.id,
    entityLabel: approver.email,
    details: {
      action: input.action ?? "discount",
      reason: input.reason ?? "",
      requestedByUserId: input.requestedByUserId,
      approvedByUserId: approver.id,
      approvedByName: approver.name,
      approvedByRole: approver.role,
      terminalId: input.terminalId ?? null,
    },
    ipAddress: input.ipAddress,
  });

  return {
    verified: true,
    approver: {
      id: approver.id,
      name: approver.name,
      role: approver.role,
    },
  };
}
