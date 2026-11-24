import type { FastifyInstance } from "fastify";
import { assignUserCustomRoleSchema, normalizeRolePermissionsMap } from "@erp/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_COMPANY_ID,
  branches,
  customRoles,
  passwordResetTokens,
  rolePermissions,
  userBranches,
  userBranchScopes,
  userCompanies,
  userRoles,
  users,
  userSessions,
  type AppRole,
} from "../../drizzle/schema.ts";
import { hashPassword } from "../auth/password.ts";
import { invalidatePermissionMatrixCache, loadPermissionMatrix, PERMISSION_MODULES } from "../auth/permissions.ts";
import { generateOpaqueToken, hashToken } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth, requirePermission, requireRole } from "../middleware/auth.ts";
import {
  createCustomRole,
  deleteCustomRole,
  listCustomRoles,
  updateCustomRole,
} from "../services/custom-roles.service.ts";
import { runHousekeeping } from "../services/housekeeping.service.ts";
import { runOverdueSweep } from "../services/overdue-sweep.service.ts";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "manager", "user"]).default("user"),
  customRoleId: z.string().uuid().nullable().optional(),
  branchScopeMode: z.enum(["all", "selected"]).default("selected"),
  branchIds: z.array(z.string().uuid()).default([]),
  defaultBranchId: z.string().uuid().nullable().optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "manager", "user"]),
});

const updateBranchesSchema = z.object({
  branchScopeMode: z.enum(["all", "selected"]),
  branchIds: z.array(z.string().uuid()),
  defaultBranchId: z.string().uuid().nullable().optional(),
});

const updateStatusSchema = z.object({
  isActive: z.boolean(),
});

const updatePermissionsSchema = z.object({
  matrix: z.record(
    z.enum(["admin", "manager", "user"]),
    z.record(
      z.string(),
      z.object({
        view: z.boolean(),
        create: z.boolean(),
        edit: z.boolean(),
        delete: z.boolean(),
        approve: z.boolean().optional().default(false),
      })
    )
  ),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/custom-roles", { preHandler: requirePermission("roles", "view") }, async (req) => {
    const roles = await listCustomRoles(getDb(), req.authUser!.activeCompanyId);
    return { roles };
  });

  app.post("/api/custom-roles", { preHandler: requirePermission("roles", "create") }, async (req, reply) => {
    const role = await createCustomRole(getDb(), req.authUser!, req.body, req.ip);
    eventBroadcaster.broadcast("permissions_updated", { companyId: req.authUser!.activeCompanyId });
    return reply.status(201).send({ role });
  });

  app.put("/api/custom-roles/:id", { preHandler: requirePermission("roles", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const role = await updateCustomRole(getDb(), req.authUser!, id, req.body, req.ip);
    eventBroadcaster.broadcast("permissions_updated", { companyId: req.authUser!.activeCompanyId });
    return { role };
  });

  app.delete("/api/custom-roles/:id", { preHandler: requirePermission("roles", "delete") }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await deleteCustomRole(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("permissions_updated", { companyId: req.authUser!.activeCompanyId });
    return result;
  });

  app.get("/api/users", { preHandler: requirePermission("users", "view") }, async (req) => {
    const db = getDb();
    const companyId = req.authUser!.activeCompanyId;

    const userRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
        defaultBranchId: users.defaultBranchId,
        createdAt: users.createdAt,
        membershipRole: userCompanies.role,
        customRoleId: userCompanies.customRoleId,
        customRoleName: customRoles.name,
        customRoleBaseRole: customRoles.baseRole,
        customRoleIsActive: customRoles.isActive,
      })
      .from(users)
      .innerJoin(
        userCompanies,
        and(eq(userCompanies.userId, users.id), eq(userCompanies.companyId, companyId))
      )
      .leftJoin(customRoles, eq(customRoles.id, userCompanies.customRoleId))
      .orderBy(desc(users.createdAt));

    const userIds = userRows.map((u) => u.id);
    if (userIds.length === 0) {
      return { users: [] };
    }

    const [scopeRows, branchAssignRows] = await Promise.all([
      db.select().from(userBranchScopes).where(inArray(userBranchScopes.userId, userIds)),
      db
        .select({
          userId: userBranches.userId,
          branchId: userBranches.branchId,
        })
        .from(userBranches)
        .innerJoin(branches, eq(branches.id, userBranches.branchId))
        .where(and(inArray(userBranches.userId, userIds), eq(branches.companyId, companyId))),
    ]);

    const scopeMap = new Map(scopeRows.map((s) => [s.userId, s.scopeMode]));
    const branchesMap = new Map<string, string[]>();
    for (const row of branchAssignRows) {
      const list = branchesMap.get(row.userId) ?? [];
      list.push(row.branchId);
      branchesMap.set(row.userId, list);
    }

    return {
      users: userRows.map((u) => {
        const hasValidCustomRole = Boolean(u.customRoleId && u.customRoleIsActive);
        const role: AppRole =
          hasValidCustomRole && u.customRoleBaseRole ? u.customRoleBaseRole : u.membershipRole;
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          isActive: u.isActive,
          defaultBranchId: u.defaultBranchId,
          createdAt: u.createdAt,
          role,
          customRoleId: hasValidCustomRole ? u.customRoleId : null,
          customRoleName: hasValidCustomRole ? (u.customRoleName ?? null) : null,
          branchScopeMode: role === "admin" ? "all" : (scopeMap.get(u.id) ?? "selected"),
          branchIds: branchesMap.get(u.id) ?? [],
        };
      }),
    };
  });

  app.post("/api/users", { preHandler: requirePermission("users", "create") }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid user payload", "VALIDATION_ERROR");
    }

    const { name, email, password, role, customRoleId, branchScopeMode, branchIds, defaultBranchId } =
      parsed.data;
    const actor = req.authUser!;
    const companyId = actor.activeCompanyId;
    const db = getDb();

    const created = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        throw new AppError(409, "A user with this email already exists", "EMAIL_EXISTS");
      }

      let effectiveRole: AppRole = role;
      const effectiveCustomRoleId: string | null = customRoleId ?? null;
      let effectiveCustomRoleName: string | null = null;

      if (effectiveCustomRoleId) {
        const [cr] = await tx
          .select()
          .from(customRoles)
          .where(and(eq(customRoles.id, effectiveCustomRoleId), eq(customRoles.companyId, companyId)))
          .limit(1);
        if (!cr || !cr.isActive) {
          throw new AppError(
            400,
            "Selected custom role does not exist or is inactive in this company",
            "INVALID_CUSTOM_ROLE"
          );
        }
        effectiveRole = cr.baseRole;
        effectiveCustomRoleName = cr.name;
      }

      if (effectiveRole === "admin" && actor.role !== "admin") {
        throw new AppError(403, "Only admins can create another admin user", "FORBIDDEN");
      }

      if (branchIds.length > 0) {
        const validBranches = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(inArray(branches.id, branchIds), eq(branches.companyId, companyId)));
        if (validBranches.length !== branchIds.length) {
          throw new AppError(400, "One or more selected branches do not exist in this company", "INVALID_BRANCH");
        }
      }

      const passwordHash = await hashPassword(password);
      const effectiveDefaultBranch =
        defaultBranchId && branchIds.includes(defaultBranchId) ? defaultBranchId : (branchIds[0] ?? null);

      const [newUser] = await tx
        .insert(users)
        .values({
          name,
          email,
          passwordHash,
          emailVerified: true,
          isActive: true,
          defaultBranchId: effectiveDefaultBranch,
        })
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          isActive: users.isActive,
          defaultBranchId: users.defaultBranchId,
          createdAt: users.createdAt,
        });

      await tx.insert(userRoles).values({
        userId: newUser.id,
        role: effectiveRole,
        customRoleId: effectiveCustomRoleId,
      });

      await tx.insert(userCompanies).values({
        userId: newUser.id,
        companyId,
        role: effectiveRole,
        customRoleId: effectiveCustomRoleId,
        isDefault: true,
        isActive: true,
      });

      await tx.insert(userBranchScopes).values({
        userId: newUser.id,
        scopeMode: effectiveRole === "admin" ? "all" : branchScopeMode,
      });

      if (branchIds.length > 0) {
        await tx.insert(userBranches).values(
          branchIds.map((bId) => ({
            userId: newUser.id,
            branchId: bId,
            isDefault: bId === effectiveDefaultBranch,
          }))
        );
      }

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.created",
        entityType: "user",
        entityId: newUser.id,
        entityLabel: email,
        details: { role: effectiveRole, customRoleId: effectiveCustomRoleId, branchScopeMode, branchCount: branchIds.length },
        after: {
          id: newUser.id,
          name,
          email,
          role: effectiveRole,
          customRoleId: effectiveCustomRoleId,
          branchScopeMode: effectiveRole === "admin" ? "all" : branchScopeMode,
          branchIds,
        },
        ipAddress: req.ip,
      });

      return {
        ...newUser,
        role: effectiveRole,
        customRoleId: effectiveCustomRoleId,
        customRoleName: effectiveCustomRoleName,
        branchScopeMode: effectiveRole === "admin" ? "all" : branchScopeMode,
        branchIds,
      };
    });

    eventBroadcaster.broadcast("users_updated", { userId: created.id });
    return reply.status(201).send({ user: created });
  });

  const handleUpdateUserRole = async (req: import("fastify").FastifyRequest) => {
    const targetId = (req.params as { id: string }).id;
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const actor = req.authUser!;

    let requestedCustomRoleId: string | null = null;
    let requestedCompanyId: string = actor.activeCompanyId;
    let requestedLegacyRole: AppRole | null = null;

    if (typeof rawBody === "object" && rawBody !== null && "customRoleId" in rawBody && rawBody.customRoleId !== null) {
      const parsedCustom = assignUserCustomRoleSchema.safeParse(rawBody);
      if (!parsedCustom.success) {
        throw new AppError(400, parsedCustom.error.issues[0]?.message ?? "Invalid custom role assignment", "VALIDATION_ERROR");
      }
      requestedCustomRoleId = parsedCustom.data.customRoleId;
      if (parsedCustom.data.companyId) {
        if (parsedCustom.data.companyId !== actor.activeCompanyId && actor.role !== "admin") {
          throw new AppError(403, "Only admins can assign roles in another company", "FORBIDDEN");
        }
        requestedCompanyId = parsedCustom.data.companyId;
      }
    } else {
      const parsedLegacy = updateRoleSchema.safeParse(rawBody);
      if (!parsedLegacy.success) {
        throw new AppError(400, "Invalid role value", "VALIDATION_ERROR");
      }
      requestedLegacyRole = parsedLegacy.data.role;
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(749202)`);

      const [target] = await tx
        .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        throw new AppError(404, "User not found", "NOT_FOUND");
      }

      let newRole: AppRole;
      let newCustomRoleId: string | null = null;

      if (requestedCustomRoleId) {
        const [cr] = await tx
          .select()
          .from(customRoles)
          .where(and(eq(customRoles.id, requestedCustomRoleId), eq(customRoles.companyId, requestedCompanyId)))
          .limit(1);
        if (!cr || !cr.isActive) {
          throw new AppError(
            400,
            "Selected custom role does not exist or is inactive in this company",
            "INVALID_CUSTOM_ROLE"
          );
        }
        newRole = cr.baseRole;
        newCustomRoleId = cr.id;
      } else {
        newRole = requestedLegacyRole!;
        newCustomRoleId = null;
      }

      if (actor.role !== "admin" && newRole === "admin") {
        throw new AppError(403, "Only admins can assign the admin role", "FORBIDDEN");
      }

      const [currentMembership] = await tx
        .select()
        .from(userCompanies)
        .where(and(eq(userCompanies.userId, targetId), eq(userCompanies.companyId, requestedCompanyId)))
        .limit(1);

      const [currentRoleRow] = await tx
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, targetId))
        .limit(1);

      const currentRole = currentMembership?.role ?? currentRoleRow?.role ?? "user";
      const prevCustomRoleId = currentMembership?.customRoleId ?? currentRoleRow?.customRoleId ?? null;

      if (currentRole === "admin" && actor.role !== "admin") {
        throw new AppError(403, "Only admins can modify an admin user's role", "FORBIDDEN");
      }

      if (currentRole === "admin" && newRole !== "admin") {
        const activeCompanyAdmins = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(userCompanies, eq(users.id, userCompanies.userId))
          .where(
            and(
              eq(userCompanies.companyId, requestedCompanyId),
              eq(userCompanies.role, "admin"),
              eq(userCompanies.isActive, true),
              eq(users.isActive, true)
            )
          );

        if (activeCompanyAdmins.length <= 1 && requestedCompanyId === DEFAULT_COMPANY_ID) {
          throw new AppError(400, "Cannot remove the last active administrator", "LAST_ADMIN_PROTECTED");
        }

        if (requestedCompanyId === DEFAULT_COMPANY_ID) {
          const activeGlobalAdmins = await tx
            .select({ id: users.id })
            .from(users)
            .innerJoin(userRoles, eq(users.id, userRoles.userId))
            .where(and(eq(userRoles.role, "admin"), eq(users.isActive, true)));
          if (activeGlobalAdmins.length <= 1) {
            throw new AppError(400, "Cannot remove the last active administrator", "LAST_ADMIN_PROTECTED");
          }
        }
      }

      const now = new Date();
      await tx
        .insert(userCompanies)
        .values({
          userId: targetId,
          companyId: requestedCompanyId,
          role: newRole,
          customRoleId: newCustomRoleId,
          isDefault: currentMembership?.isDefault ?? requestedCompanyId === DEFAULT_COMPANY_ID,
          isActive: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userCompanies.userId, userCompanies.companyId],
          set: {
            role: newRole,
            customRoleId: newCustomRoleId,
            updatedAt: now,
          },
        });

      const shouldSyncGlobalRole =
        requestedCompanyId === actor.activeCompanyId ||
        requestedCompanyId === DEFAULT_COMPANY_ID ||
        Boolean(currentMembership?.isDefault);

      if (shouldSyncGlobalRole) {
        await tx
          .insert(userRoles)
          .values({ userId: targetId, role: newRole, customRoleId: newCustomRoleId })
          .onConflictDoUpdate({
            target: userRoles.userId,
            set: { role: newRole, customRoleId: newCustomRoleId, updatedAt: now },
          });
      }

      if (newRole === "admin") {
        await tx
          .insert(userBranchScopes)
          .values({ userId: targetId, scopeMode: "all" })
          .onConflictDoUpdate({
            target: userBranchScopes.userId,
            set: { scopeMode: "all", updatedAt: now },
          });
      }

      await writeAuditLog(tx, {
        companyId: requestedCompanyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.role_updated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
        details: { fromRole: currentRole, toRole: newRole, customRoleId: newCustomRoleId },
        before: { role: currentRole, customRoleId: prevCustomRoleId },
        after: { role: newRole, customRoleId: newCustomRoleId },
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("users_updated", { userId: targetId });
    return { ok: true };
  };

  app.put("/api/users/:id/role", { preHandler: requirePermission("users", "edit") }, handleUpdateUserRole);
  app.put("/api/users/:id/custom-role", { preHandler: requirePermission("users", "edit") }, handleUpdateUserRole);

  app.put("/api/users/:id/branches", { preHandler: requirePermission("users", "edit") }, async (req) => {
    const targetId = (req.params as { id: string }).id;
    const parsed = updateBranchesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid branch assignment", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const companyId = actor.activeCompanyId;
    const { branchScopeMode, branchIds, defaultBranchId } = parsed.data;
    const db = getDb();

    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email, defaultBranchId: users.defaultBranchId })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        throw new AppError(404, "User not found", "NOT_FOUND");
      }

      if (branchIds.length > 0) {
        const validBranches = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(inArray(branches.id, branchIds), eq(branches.companyId, companyId)));
        if (validBranches.length !== branchIds.length) {
          throw new AppError(400, "One or more selected branches do not exist in this company", "INVALID_BRANCH");
        }
      }

      const [prevScope] = await tx
        .select({ scopeMode: userBranchScopes.scopeMode })
        .from(userBranchScopes)
        .where(eq(userBranchScopes.userId, targetId))
        .limit(1);

      const companyBranchRows = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.companyId, companyId));
      const companyBranchIds = companyBranchRows.map((b) => b.id);

      const prevAssignedRows =
        companyBranchIds.length > 0
          ? await tx
              .select({ branchId: userBranches.branchId })
              .from(userBranches)
              .where(and(eq(userBranches.userId, targetId), inArray(userBranches.branchId, companyBranchIds)))
          : [];

      await tx
        .insert(userBranchScopes)
        .values({ userId: targetId, scopeMode: branchScopeMode })
        .onConflictDoUpdate({
          target: userBranchScopes.userId,
          set: { scopeMode: branchScopeMode, updatedAt: new Date() },
        });

      if (companyBranchIds.length > 0) {
        await tx
          .delete(userBranches)
          .where(and(eq(userBranches.userId, targetId), inArray(userBranches.branchId, companyBranchIds)));
      }

      const effectiveDefault =
        defaultBranchId && (branchScopeMode === "all" || branchIds.includes(defaultBranchId))
          ? defaultBranchId
          : (branchIds[0] ?? null);

      if (branchIds.length > 0) {
        await tx.insert(userBranches).values(
          branchIds.map((bId) => ({
            userId: targetId,
            branchId: bId,
            isDefault: bId === effectiveDefault,
          }))
        );
      }

      await tx
        .update(users)
        .set({ defaultBranchId: effectiveDefault, updatedAt: new Date() })
        .where(eq(users.id, targetId));

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.branches_updated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
        details: { branchScopeMode, branchIds, defaultBranchId: effectiveDefault },
        before: {
          branchScopeMode: prevScope?.scopeMode ?? "selected",
          branchIds: prevAssignedRows.map((r) => r.branchId),
          defaultBranchId: target.defaultBranchId,
        },
        after: {
          branchScopeMode,
          branchIds,
          defaultBranchId: effectiveDefault,
        },
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("users_updated", { userId: targetId });
    return { ok: true };
  });

  app.put("/api/users/:id/status", { preHandler: requirePermission("users", "edit") }, async (req) => {
    const targetId = (req.params as { id: string }).id;
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid status payload", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const companyId = actor.activeCompanyId;
    if (actor.id === targetId && !parsed.data.isActive) {
      throw new AppError(400, "You cannot deactivate your own account", "SELF_DEACTIVATE_FORBIDDEN");
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        throw new AppError(404, "User not found", "NOT_FOUND");
      }

      if (actor.role !== "admin") {
        const [membership] = await tx
          .select({ id: userCompanies.id })
          .from(userCompanies)
          .where(and(eq(userCompanies.userId, targetId), eq(userCompanies.companyId, companyId)))
          .limit(1);
        if (!membership) {
          throw new AppError(404, "User not found in active company", "NOT_FOUND");
        }
      }

      if (!parsed.data.isActive) {
        const [roleRow] = await tx.select().from(userRoles).where(eq(userRoles.userId, targetId)).limit(1);
        if (roleRow?.role === "admin") {
          const activeAdmins = await tx
            .select({ id: users.id })
            .from(users)
            .innerJoin(userRoles, eq(users.id, userRoles.userId))
            .where(and(eq(userRoles.role, "admin"), eq(users.isActive, true)));
          if (activeAdmins.length <= 1) {
            throw new AppError(400, "Cannot deactivate the last active administrator", "LAST_ADMIN_PROTECTED");
          }
        }
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
      }

      await tx
        .update(users)
        .set({ isActive: parsed.data.isActive, updatedAt: new Date() })
        .where(eq(users.id, targetId));

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: parsed.data.isActive ? "user.activated" : "user.deactivated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
        before: { isActive: target.isActive },
        after: { isActive: parsed.data.isActive },
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("users_updated", { userId: targetId });
    return { ok: true };
  });

  app.post("/api/users/:id/reset-token", { preHandler: requireRole("admin") }, async (req) => {
    const targetId = (req.params as { id: string }).id;
    const actor = req.authUser!;
    const db = getDb();

    const [target] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);

    if (!target) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }

    const rawToken = generateOpaqueToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await db.transaction(async (tx) => {
      await tx.insert(passwordResetTokens).values({
        userId: target.id,
        tokenHash,
        expiresAt,
      });

      await writeAuditLog(tx, {
        companyId: actor.activeCompanyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.reset_token_issued",
        entityType: "user",
        entityId: target.id,
        entityLabel: target.email,
        ipAddress: req.ip,
      });
    });

    return {
      resetPath: `/reset-password?token=${rawToken}`,
      expiresAt: expiresAt.toISOString(),
    };
  });

  app.get("/api/roles/permissions", { preHandler: requireAuth }, async () => {
    const db = getDb();
    const matrix = await loadPermissionMatrix(db);
    return { matrix };
  });

  app.put("/api/roles/permissions", { preHandler: requireRole("admin") }, async (req) => {
    const parsed = updatePermissionsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid permission matrix", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const db = getDb();

    await db.transaction(async (tx) => {
      const prevMatrix = await loadPermissionMatrix(tx, { bypassCache: true });

      for (const role of ["admin", "manager", "user"] as const) {
        const rawMods = parsed.data.matrix[role];
        if (!rawMods) continue;
        const normalizedMods = normalizeRolePermissionsMap(rawMods);

        for (const moduleName of PERMISSION_MODULES) {
          const incoming = rawMods[moduleName];
          const perm = incoming ? normalizedMods[moduleName] : prevMatrix[role][moduleName];

          // Prevent admin from locking themselves out of user or settings management
          const isProtectedAdminModule = role === "admin" && (moduleName === "users" || moduleName === "settings");

          await tx
            .insert(rolePermissions)
            .values({
              role,
              module: moduleName,
              canView: isProtectedAdminModule ? true : perm.view,
              canCreate: isProtectedAdminModule ? true : perm.create,
              canEdit: isProtectedAdminModule ? true : perm.edit,
              canDelete: isProtectedAdminModule ? true : perm.delete,
              canApprove: isProtectedAdminModule ? true : perm.approve,
            })
            .onConflictDoUpdate({
              target: [rolePermissions.role, rolePermissions.module],
              set: {
                canView: isProtectedAdminModule ? true : perm.view,
                canCreate: isProtectedAdminModule ? true : perm.create,
                canEdit: isProtectedAdminModule ? true : perm.edit,
                canDelete: isProtectedAdminModule ? true : perm.delete,
                canApprove: isProtectedAdminModule ? true : perm.approve,
                updatedAt: new Date(),
              },
            });
        }
      }

      const nextMatrix = await loadPermissionMatrix(tx, { bypassCache: true });
      await writeAuditLog(tx, {
        companyId: actor.activeCompanyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "roles.permissions_updated",
        entityType: "role_permissions",
        entityId: "matrix",
        before: prevMatrix as unknown as Record<string, unknown>,
        after: nextMatrix as unknown as Record<string, unknown>,
        ipAddress: req.ip,
      });
    });

    invalidatePermissionMatrixCache();
    eventBroadcaster.broadcast("permissions_updated");
    return { ok: true };
  });

  app.post("/api/admin/jobs/overdue-sweep", { preHandler: requireRole("admin") }, async (req) => {
    const result = await runOverdueSweep(getDb(), req.authUser!, req.ip);
    if (result.overdueInvoicesMarked > 0) eventBroadcaster.broadcast("sales_updated", { source: "overdue_sweep" });
    if (result.overdueBillsMarked > 0) eventBroadcaster.broadcast("purchases_updated", { source: "overdue_sweep" });
    if (result.overdueInvoicesMarked > 0 || result.overdueBillsMarked > 0) {
      eventBroadcaster.broadcast("notifications_updated", { source: "overdue_sweep" });
    }
    return result;
  });

  app.post("/api/admin/jobs/housekeeping", { preHandler: requireRole("admin") }, async (req) => {
    return runHousekeeping(getDb(), {
      actor: req.authUser!,
      ipAddress: req.ip,
    });
  });
}
