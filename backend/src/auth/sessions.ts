import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { normalizeRolePermissionsMap, PERMISSION_MODULES, type UserCompanySummaryDto } from "@erp/shared";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import {
  DEFAULT_COMPANY_ID,
  branches,
  companies,
  customRolePermissions,
  customRoles,
  userBranches,
  userBranchScopes,
  userCompanies,
  userMfa,
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
  activeCompanyId: string;
  customRoleId: string | null;
  customRoleName: string | null;
  mfaEnabled: boolean;
  companies: UserCompanySummaryDto[];
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

const SESSION_ACTIVITY_THROTTLE_MS = 60_000;

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

export async function resolvePrimaryCompanyIdForUser(
  txOrDb: DbOrTx,
  userId: string
): Promise<string | null> {
  const memberships = await txOrDb
    .select({
      companyId: userCompanies.companyId,
      isDefault: userCompanies.isDefault,
    })
    .from(userCompanies)
    .innerJoin(companies, eq(companies.id, userCompanies.companyId))
    .where(
      and(
        eq(userCompanies.userId, userId),
        eq(userCompanies.isActive, true),
        eq(companies.isActive, true)
      )
    )
    .orderBy(desc(userCompanies.isDefault), desc(companies.isDefault), asc(companies.createdAt));

  if (memberships.length > 0) {
    return memberships[0].companyId;
  }

  const [defaultCompany] = await txOrDb
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, DEFAULT_COMPANY_ID), eq(companies.isActive, true)))
    .limit(1);

  return defaultCompany?.id ?? null;
}

export async function createSessionRecord(
  txOrDb: DbOrTx,
  params: {
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    activeCompanyId?: string | null;
  }
): Promise<{ rawToken: string; sessionId: string }> {
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86400 * 1000);
  const now = new Date();
  const resolvedCompanyId =
    params.activeCompanyId !== undefined
      ? params.activeCompanyId
      : await resolvePrimaryCompanyIdForUser(txOrDb, params.userId);

  const [created] = await txOrDb
    .insert(userSessions)
    .values({
      userId: params.userId,
      tokenHash,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      activeCompanyId: resolvedCompanyId,
      lastActivityAt: now,
      expiresAt,
    })
    .returning({ id: userSessions.id });

  return { rawToken, sessionId: created.id };
}

async function loadCustomRolePermissionsMap(
  txOrDb: DbOrTx,
  customRoleId: string
): Promise<Record<PermissionModule, ModulePermission>> {
  const rows = await txOrDb
    .select()
    .from(customRolePermissions)
    .where(eq(customRolePermissions.customRoleId, customRoleId));

  const rawMap: Partial<Record<string, Partial<ModulePermission>>> = {};
  for (const row of rows) {
    if ((PERMISSION_MODULES as readonly string[]).includes(row.module)) {
      rawMap[row.module] = {
        view: row.canView,
        create: row.canCreate,
        edit: row.canEdit,
        delete: row.canDelete,
        approve: row.canApprove,
      };
    }
  }
  return normalizeRolePermissionsMap(rawMap);
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
    customRoleId?: string | null;
    scopeMode: BranchScopeMode | null;
  },
  requestedCompanyId?: string | null
): Promise<AuthUser> {
  const globalRole: AppRole = row.role ?? "user";

  const [membershipRows, mfaRow] = await Promise.all([
    txOrDb
      .select({
        companyId: companies.id,
        companyCode: companies.code,
        companyName: companies.name,
        companyDefaultBranchId: companies.defaultBranchId,
        companyIsDefault: companies.isDefault,
        membershipRole: userCompanies.role,
        customRoleId: userCompanies.customRoleId,
        membershipIsDefault: userCompanies.isDefault,
        membershipIsActive: userCompanies.isActive,
        customRoleName: customRoles.name,
        customRoleBaseRole: customRoles.baseRole,
        customRoleIsActive: customRoles.isActive,
        customRoleCompanyId: customRoles.companyId,
      })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .leftJoin(customRoles, eq(customRoles.id, userCompanies.customRoleId))
      .where(
        and(
          eq(userCompanies.userId, row.id),
          eq(userCompanies.isActive, true),
          eq(companies.isActive, true)
        )
      )
      .orderBy(desc(userCompanies.isDefault), desc(companies.isDefault), asc(companies.createdAt)),
    txOrDb
      .select({ isEnabled: userMfa.isEnabled })
      .from(userMfa)
      .where(eq(userMfa.userId, row.id))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  const companySummaries: UserCompanySummaryDto[] = membershipRows.map((m) => {
    const validCustomRole = Boolean(
      m.customRoleId && m.customRoleIsActive && m.customRoleCompanyId === m.companyId
    );
    return {
      id: m.companyId,
      code: m.companyCode,
      name: m.companyName,
      role: validCustomRole && m.customRoleBaseRole ? m.customRoleBaseRole : m.membershipRole,
      customRoleId: validCustomRole ? m.customRoleId : null,
      customRoleName: validCustomRole ? (m.customRoleName ?? null) : null,
      isDefault: m.membershipIsDefault,
      isActive: m.membershipIsActive,
    };
  });

  // For global admins, expose all active companies even if not explicitly listed in user_companies
  let extraAdminCompanyDefaultBranch: Map<string, string | null> | null = null;
  if (globalRole === "admin") {
    const allActiveCompanies = await txOrDb
      .select({
        id: companies.id,
        code: companies.code,
        name: companies.name,
        defaultBranchId: companies.defaultBranchId,
        isDefault: companies.isDefault,
      })
      .from(companies)
      .where(eq(companies.isActive, true))
      .orderBy(desc(companies.isDefault), asc(companies.createdAt));

    extraAdminCompanyDefaultBranch = new Map(allActiveCompanies.map((c) => [c.id, c.defaultBranchId]));
    const existingIds = new Set(companySummaries.map((c) => c.id));
    for (const c of allActiveCompanies) {
      if (!existingIds.has(c.id)) {
        companySummaries.push({
          id: c.id,
          code: c.code,
          name: c.name,
          role: "admin",
          customRoleId: null,
          customRoleName: null,
          isDefault: c.isDefault && companySummaries.length === 0,
          isActive: true,
        });
      }
    }
  } else if (companySummaries.length === 0) {
    // Legacy compatibility fallback when a user was created without user_companies rows
    const [defaultComp] = await txOrDb
      .select({
        id: companies.id,
        code: companies.code,
        name: companies.name,
        defaultBranchId: companies.defaultBranchId,
      })
      .from(companies)
      .where(and(eq(companies.id, DEFAULT_COMPANY_ID), eq(companies.isActive, true)))
      .limit(1);
    if (defaultComp) {
      companySummaries.push({
        id: defaultComp.id,
        code: defaultComp.code,
        name: defaultComp.name,
        role: globalRole,
        customRoleId: null,
        customRoleName: null,
        isDefault: true,
        isActive: true,
      });
    }
  }

  // Resolve active company ID
  let activeCompanyId = DEFAULT_COMPANY_ID;
  const requestedMatch = requestedCompanyId
    ? companySummaries.find((c) => c.id === requestedCompanyId)
    : undefined;

  if (requestedMatch) {
    activeCompanyId = requestedMatch.id;
  } else {
    const defaultMembership =
      companySummaries.find((c) => c.isDefault) ?? companySummaries[0];
    if (defaultMembership) {
      activeCompanyId = defaultMembership.id;
    }
  }

  const activeMembership = membershipRows.find((m) => m.companyId === activeCompanyId);
  const activeSummary = companySummaries.find((c) => c.id === activeCompanyId);

  let effectiveRole: AppRole = activeSummary?.role ?? globalRole;
  let customRoleId: string | null = activeSummary?.customRoleId ?? null;
  let customRoleName: string | null = activeSummary?.customRoleName ?? null;
  let permissions: Record<PermissionModule, ModulePermission>;

  if (!activeMembership && membershipRows.length === 0 && row.customRoleId) {
    const [legacyCustomRole] = await txOrDb
      .select()
      .from(customRoles)
      .where(
        and(
          eq(customRoles.id, row.customRoleId),
          eq(customRoles.companyId, activeCompanyId),
          eq(customRoles.isActive, true)
        )
      )
      .limit(1);
    if (legacyCustomRole) {
      customRoleId = legacyCustomRole.id;
      customRoleName = legacyCustomRole.name;
      effectiveRole = legacyCustomRole.baseRole;
    }
  }

  if (customRoleId) {
    permissions = await loadCustomRolePermissionsMap(txOrDb, customRoleId);
  } else {
    const matrix = await loadPermissionMatrix(txOrDb);
    permissions = matrix[effectiveRole];
  }

  const branchScopeMode: BranchScopeMode =
    effectiveRole === "admin" ? "all" : (row.scopeMode ?? "selected");

  const branchIds =
    branchScopeMode === "all"
      ? await txOrDb
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.companyId, activeCompanyId), eq(branches.isActive, true)))
          .then((list) => list.map((b) => b.id))
      : await txOrDb
          .select({ branchId: userBranches.branchId })
          .from(userBranches)
          .innerJoin(branches, eq(branches.id, userBranches.branchId))
          .where(
            and(
              eq(userBranches.userId, row.id),
              eq(branches.companyId, activeCompanyId),
              eq(branches.isActive, true)
            )
          )
          .then((list) => list.map((b) => b.branchId));

  const companyDefaultBranchId =
    activeMembership?.companyDefaultBranchId ??
    extraAdminCompanyDefaultBranch?.get(activeCompanyId) ??
    null;

  const defaultBranchId =
    row.defaultBranchId && branchIds.includes(row.defaultBranchId)
      ? row.defaultBranchId
      : companyDefaultBranchId && branchIds.includes(companyDefaultBranchId)
        ? companyDefaultBranchId
        : (branchIds[0] ?? null);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: effectiveRole,
    isActive: row.isActive,
    activeCompanyId,
    customRoleId,
    customRoleName,
    mfaEnabled: Boolean(mfaRow?.isEnabled),
    companies: companySummaries,
    branchScopeMode,
    branchIds,
    defaultBranchId,
    permissions,
  };
}

export async function loadAuthUserById(
  txOrDb: DbOrTx,
  userId: string,
  requestedCompanyId?: string | null
): Promise<AuthUser | null> {
  const [row] = await txOrDb
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      defaultBranchId: users.defaultBranchId,
      role: userRoles.role,
      customRoleId: userRoles.customRoleId,
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
  return resolveUserBranchesAndPermissions(txOrDb, row, requestedCompanyId);
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
      activeCompanyId: userSessions.activeCompanyId,
      lastActivityAt: userSessions.lastActivityAt,
      posTerminalId: userSessions.posTerminalId,
      activeCashierId: userSessions.activeCashierId,
      isTerminalLocked: userSessions.isTerminalLocked,
      id: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      defaultBranchId: users.defaultBranchId,
      role: userRoles.role,
      customRoleId: userRoles.customRoleId,
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

  if (now.getTime() - row.lastActivityAt.getTime() >= SESSION_ACTIVITY_THROTTLE_MS) {
    await db
      .update(userSessions)
      .set({ lastActivityAt: now })
      .where(eq(userSessions.id, row.sessionId));
  }

  let effectiveUser: AuthUser | null;
  if (row.activeCashierId && row.activeCashierId !== row.sessionUserId) {
    const ownerResolved = await resolveUserBranchesAndPermissions(db, row, row.activeCompanyId);
    effectiveUser = await loadAuthUserById(db, row.activeCashierId, ownerResolved.activeCompanyId);
    if (!effectiveUser) {
      return null;
    }
  } else {
    effectiveUser = await resolveUserBranchesAndPermissions(db, row, row.activeCompanyId);
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
