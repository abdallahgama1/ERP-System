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
