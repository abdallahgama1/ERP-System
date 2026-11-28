import { PERMISSION_MODULES, SMOKE_MONITOR_ROLE_NAME } from "@erp/shared";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AppRole } from "../../drizzle/schema.ts";
import { env } from "../config.ts";
import { AppError } from "../db/helpers.ts";
import { getAuthenticatedSession, type AuthUser } from "../auth/sessions.ts";
import type { PermissionAction, PermissionModule } from "../auth/permissions.ts";

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    authSessionId: string | null;
    activeCompanyId: string | null;
    terminalSessionOwnerId: string | null;
    posTerminalId: string | null;
    isTerminalLocked: boolean;
  }
}

const LOCKED_TERMINAL_EXEMPT_PREFIXES = [
  "/api/pos/terminal/pin-switch",
  "/api/pos/terminal/lock",
  "/api/pos/sync",
  "/api/auth/logout",
  "/api/auth/me",
];

function isLockedTerminalExempt(req: FastifyRequest): boolean {
  const path = req.url.split("?")[0] ?? "";
  return LOCKED_TERMINAL_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function assertTerminalUnlocked(req: FastifyRequest): void {
  if (req.isTerminalLocked && !isLockedTerminalExempt(req)) {
    throw new AppError(423, "POS terminal is locked. Enter cashier PIN to unlock.", "TERMINAL_LOCKED");
  }
}

export async function attachAuthHook(req: FastifyRequest): Promise<void> {
  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) {
    req.authUser = null;
    req.authSessionId = null;
    req.activeCompanyId = null;
    req.terminalSessionOwnerId = null;
    req.posTerminalId = null;
    req.isTerminalLocked = false;
    return;
  }
  try {
    const resolved = await getAuthenticatedSession(token);
    req.authUser = resolved?.user ?? null;
    req.authSessionId = resolved?.sessionId ?? null;
    req.activeCompanyId = resolved?.user.activeCompanyId ?? null;
    req.terminalSessionOwnerId = resolved?.terminalSessionOwnerId ?? null;
    req.posTerminalId = resolved?.posTerminalId ?? null;
    req.isTerminalLocked = resolved?.isTerminalLocked ?? false;
  } catch {
    req.authUser = null;
    req.authSessionId = null;
    req.activeCompanyId = null;
    req.terminalSessionOwnerId = null;
    req.posTerminalId = null;
    req.isTerminalLocked = false;
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.authUser) {
    throw new AppError(401, "Authentication required", "UNAUTHORIZED");
  }
  assertTerminalUnlocked(req);
}

export function isSmokeMonitorActor(
  user: Pick<AuthUser, "role" | "customRoleName" | "permissions"> | null | undefined
): boolean {
  if (!user || user.role !== "user" || user.customRoleName !== SMOKE_MONITOR_ROLE_NAME) {
    return false;
  }
  for (const mod of PERMISSION_MODULES) {
    const p = user.permissions[mod];
    if (p && (p.create || p.edit || p.delete || p.approve)) {
      return false;
    }
  }
  return true;
}

/**
 * Defense-in-depth hook: ensures any account bound to the dedicated "Smoke Monitor" role
 * can NEVER execute mutating HTTP requests (POST/PUT/PATCH/DELETE) anywhere in the API,
 * except POST /api/auth/logout to close its own ephemeral session.
 */
export async function smokeMonitorReadOnlyHook(req: FastifyRequest): Promise<void> {
  if (!req.authUser || req.authUser.customRoleName !== SMOKE_MONITOR_ROLE_NAME) {
    return;
  }
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }
  const reqPath = req.url.split("?")[0] ?? "";
  if (method === "POST" && reqPath === "/api/auth/logout") {
    return;
  }
  throw new AppError(
    403,
    "Smoke monitor account is strictly read-only and cannot perform write operations.",
    "SMOKE_USER_READ_ONLY"
  );
}

export function requireRole(...allowedRoles: AppRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required", "UNAUTHORIZED");
    }
    assertTerminalUnlocked(req);
    if (!allowedRoles.includes(req.authUser.role)) {
      throw new AppError(403, "Insufficient role privileges", "FORBIDDEN");
    }
  };
}

/**
 * Permits either an active administrator OR the dedicated least-privilege read-only
 * Smoke Monitor account on strictly read-only operational health/integrity endpoints.
 */
export function requireAdminOrSmokeMonitor() {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required", "UNAUTHORIZED");
    }
    assertTerminalUnlocked(req);
    if (req.authUser.role === "admin" || isSmokeMonitorActor(req.authUser)) {
      return;
    }
    throw new AppError(403, "Insufficient role privileges", "FORBIDDEN");
  };
}

export function requirePermission(module: PermissionModule, action: PermissionAction) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required", "UNAUTHORIZED");
    }
    assertTerminalUnlocked(req);
    if (req.authUser.role === "admin") {
      return;
    }
    const allowed = req.authUser.permissions[module]?.[action] ?? false;
    if (!allowed) {
      throw new AppError(403, `Forbidden: missing ${module}.${action} permission`, "FORBIDDEN");
    }
  };
}

export function assertBranchAccess(
  user: Pick<AuthUser, "role" | "branchScopeMode" | "branchIds">,
  branchId: string | null | undefined
): void {
  if (!branchId) return;
  if (user.role === "admin" || user.branchScopeMode === "all") return;
  if (!user.branchIds.includes(branchId)) {
    throw new AppError(403, "Forbidden: you do not have access to this branch", "BRANCH_FORBIDDEN");
  }
}
