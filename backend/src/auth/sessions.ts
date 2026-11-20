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

export async function loadAuthUserById(txOrDb: DbOrTx, userId: string): Promise<AuthUser | null> {
  const [userRow] = await txOrDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow || !userRow.isActive) {
    return null;
  }

  const [roleRow] = await txOrDb.select().from(userRoles).where(eq(userRoles.userId, userId)).limit(1);
  const role: AppRole = roleRow?.role ?? "user";

  const [scopeRow] = await txOrDb
    .select()
    .from(userBranchScopes)
    .where(eq(userBranchScopes.userId, userId))
    .limit(1);
  const branchScopeMode: BranchScopeMode =
    role === "admin" ? "all" : (scopeRow?.scopeMode ?? "selected");

  let branchIds: string[] = [];
  if (branchScopeMode === "all") {
    const activeBranches = await txOrDb
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.isActive, true));
    branchIds = activeBranches.map((b) => b.id);
  } else {
    const assigned = await txOrDb
      .select({ branchId: userBranches.branchId })
      .from(userBranches)
      .where(eq(userBranches.userId, userId));
    branchIds = assigned.map((b) => b.branchId);
  }

  const matrix = await loadPermissionMatrix(txOrDb);
  const defaultBranchId =
    userRow.defaultBranchId && branchIds.includes(userRow.defaultBranchId)
      ? userRow.defaultBranchId
      : (branchIds[0] ?? null);

  return {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role,
    isActive: userRow.isActive,
    branchScopeMode,
    branchIds,
    defaultBranchId,
    permissions: matrix[role],
  };
}

export async function getAuthenticatedSession(rawToken: string | undefined): Promise<AuthSessionResult | null> {
  if (!rawToken || !isDatabaseConfigured()) {
    return null;
  }

  const db = getDb();
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const [session] = await db
    .select()
    .from(userSessions)
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, now)
      )
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const user = await loadAuthUserById(db, session.userId);
  if (!user) {
    return null;
  }

  return { sessionId: session.id, user };
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
