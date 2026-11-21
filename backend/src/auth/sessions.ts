import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  branches,
  userBranches,
  userBranchScopes,
  userRoles,
  users,
  userSessions,
  type AppRole,
  type BranchScopeMode,
} from "../../drizzle/schema.ts";
import { env } from "../config.ts";
import { getDb, isDatabaseConfigured } from "../db/index.ts";
import { loadPermissionMatrix, type PermissionModule, type ModulePermission, type DbOrTx } from "./permissions.ts";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  isActive: boolean;
  branchScopeMode: BranchScopeMode;
  branchIds: string[];
  defaultBranchId: string | null;
  permissions: Record<PermissionModule, ModulePermission>;
}

export interface AuthSessionResult {
  sessionId: string;
  terminalSessionOwnerId: string;
  posTerminalId: string | null;
  activeCashierId: string | null;
  isTerminalLocked: boolean;
  user: AuthUser;
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function shouldUseSecureCookie(): boolean {
  if (env.COOKIE_SECURE === "true") return true;
  if (env.COOKIE_SECURE === "false") return false;
  return env.NODE_ENV === "production" && env.CORS_ORIGIN.startsWith("https://");
}

export function setSessionCookie(reply: FastifyReply, rawToken: string): void {
  reply.setCookie(env.SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: shouldUseSecureCookie(),
    maxAge: env.SESSION_TTL_DAYS * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: shouldUseSecureCookie(),
  });
}

export async function createSessionRecord(
  txOrDb: DbOrTx,
  params: { userId: string; ipAddress?: string | null; userAgent?: string | null }
): Promise<{ rawToken: string; sessionId: string }> {
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86400 * 1000);

  const [created] = await txOrDb
    .insert(userSessions)
    .values({
      userId: params.userId,
      tokenHash,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      expiresAt,
    })
    .returning({ id: userSessions.id });

  return { rawToken, sessionId: created.id };
}

async function resolveUserBranchesAndPermissions(
  txOrDb: DbOrTx,
  row: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    defaultBranchId: string | null;
    role: AppRole | null;
    scopeMode: BranchScopeMode | null;
  }
): Promise<AuthUser> {
  const role: AppRole = row.role ?? "user";
  const branchScopeMode: BranchScopeMode = role === "admin" ? "all" : (row.scopeMode ?? "selected");

  const [branchIds, matrix] = await Promise.all([
    branchScopeMode === "all"
      ? txOrDb
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.isActive, true))
          .then((list) => list.map((b) => b.id))
      : txOrDb
          .select({ branchId: userBranches.branchId })
          .from(userBranches)
          .where(eq(userBranches.userId, row.id))
          .then((list) => list.map((b) => b.branchId)),
    loadPermissionMatrix(txOrDb),
  ]);

  const defaultBranchId =
    row.defaultBranchId && branchIds.includes(row.defaultBranchId)
      ? row.defaultBranchId
      : (branchIds[0] ?? null);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    isActive: row.isActive,
    branchScopeMode,
    branchIds,
    defaultBranchId,
    permissions: matrix[role],
  };
}

export async function loadAuthUserById(txOrDb: DbOrTx, userId: string): Promise<AuthUser | null> {
  const [row] = await txOrDb
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      defaultBranchId: users.defaultBranchId,
      role: userRoles.role,
      scopeMode: userBranchScopes.scopeMode,
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(userBranchScopes, eq(userBranchScopes.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || !row.isActive) {
    return null;
  }
  return resolveUserBranchesAndPermissions(txOrDb, row);
}

export async function getAuthenticatedSession(rawToken: string | undefined): Promise<AuthSessionResult | null> {
  if (!rawToken || !isDatabaseConfigured()) {
    return null;
  }

  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: userSessions.id,
      sessionUserId: userSessions.userId,
      posTerminalId: userSessions.posTerminalId,
      activeCashierId: userSessions.activeCashierId,
      isTerminalLocked: userSessions.isTerminalLocked,
      id: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      defaultBranchId: users.defaultBranchId,
      role: userRoles.role,
      scopeMode: userBranchScopes.scopeMode,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(userBranchScopes, eq(userBranchScopes.userId, users.id))
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, now),
        eq(users.isActive, true)
      )
    )
    .limit(1);

  if (!row) {
    return null;
  }

  let effectiveUser: AuthUser | null;
  if (row.activeCashierId && row.activeCashierId !== row.sessionUserId) {
    effectiveUser = await loadAuthUserById(db, row.activeCashierId);
    if (!effectiveUser) {
      return null;
    }
  } else {
    effectiveUser = await resolveUserBranchesAndPermissions(db, row);
  }

  return {
    sessionId: row.sessionId,
    terminalSessionOwnerId: row.sessionUserId,
    posTerminalId: row.posTerminalId,
    activeCashierId: row.activeCashierId,
    isTerminalLocked: row.isTerminalLocked,
    user: effectiveUser,
  };
}

export async function revokeSessionByToken(rawToken: string | undefined): Promise<void> {
  if (!rawToken || !isDatabaseConfigured()) return;
  const db = getDb();
  const tokenHash = hashToken(rawToken);
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.revokedAt)));
}
