import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  passwordResetTokens,
  rolePermissions,
  userBranches,
  userBranchScopes,
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
import { runHousekeeping } from "../services/housekeeping.service.ts";
import { runOverdueSweep } from "../services/overdue-sweep.service.ts";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "manager", "user"]).default("user"),
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
  app.get("/api/users", { preHandler: requirePermission("users", "view") }, async () => {
    const db = getDb();
    const userRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
        defaultBranchId: users.defaultBranchId,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    const roleRows = await db.select().from(userRoles);
    const scopeRows = await db.select().from(userBranchScopes);
    const branchAssignRows = await db.select().from(userBranches);

    const roleMap = new Map(roleRows.map((r) => [r.userId, r.role]));
    const scopeMap = new Map(scopeRows.map((s) => [s.userId, s.scopeMode]));
    const branchesMap = new Map<string, string[]>();
    for (const row of branchAssignRows) {
      const list = branchesMap.get(row.userId) ?? [];
      list.push(row.branchId);
      branchesMap.set(row.userId, list);
    }

    return {
      users: userRows.map((u) => {
        const role: AppRole = roleMap.get(u.id) ?? "user";
        return {
          ...u,
          role,
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

    const { name, email, password, role, branchScopeMode, branchIds, defaultBranchId } = parsed.data;
    const actor = req.authUser!;
    if (role === "admin" && actor.role !== "admin") {
      throw new AppError(403, "Only admins can create another admin user", "FORBIDDEN");
    }

    const db = getDb();
    const created = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        throw new AppError(409, "A user with this email already exists", "EMAIL_EXISTS");
      }

      if (branchIds.length > 0) {
        const validBranches = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(inArray(branches.id, branchIds));
        if (validBranches.length !== branchIds.length) {
          throw new AppError(400, "One or more selected branches do not exist", "INVALID_BRANCH");
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

      await tx.insert(userRoles).values({ userId: newUser.id, role });
      await tx.insert(userBranchScopes).values({
        userId: newUser.id,
        scopeMode: role === "admin" ? "all" : branchScopeMode,
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
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.created",
        entityType: "user",
        entityId: newUser.id,
        entityLabel: email,
        details: { role, branchScopeMode, branchCount: branchIds.length },
        ipAddress: req.ip,
      });

      return {
        ...newUser,
        role,
        branchScopeMode: role === "admin" ? "all" : branchScopeMode,
        branchIds,
      };
    });

    eventBroadcaster.broadcast("users_updated", { userId: created.id });
    return reply.status(201).send({ user: created });
  });

  app.put("/api/users/:id/role", { preHandler: requirePermission("users", "edit") }, async (req) => {
    const targetId = (req.params as { id: string }).id;
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "Invalid role value", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const newRole = parsed.data.role;
    if (actor.role !== "admin" && newRole === "admin") {
      throw new AppError(403, "Only admins can assign the admin role", "FORBIDDEN");
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

      const [currentRoleRow] = await tx
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, targetId))
        .limit(1);
      const currentRole = currentRoleRow?.role ?? "user";

      if (currentRole === "admin" && actor.role !== "admin") {
        throw new AppError(403, "Only admins can modify an admin user's role", "FORBIDDEN");
      }

      if (currentRole === "admin" && newRole !== "admin") {
        const activeAdmins = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(userRoles, eq(users.id, userRoles.userId))
          .where(and(eq(userRoles.role, "admin"), eq(users.isActive, true)));

        if (activeAdmins.length <= 1) {
          throw new AppError(400, "Cannot remove the last active administrator", "LAST_ADMIN_PROTECTED");
        }
      }

      if (currentRoleRow) {
        await tx
          .update(userRoles)
          .set({ role: newRole, updatedAt: new Date() })
          .where(eq(userRoles.userId, targetId));
      } else {
        await tx.insert(userRoles).values({ userId: targetId, role: newRole });
      }

      if (newRole === "admin") {
        await tx
          .insert(userBranchScopes)
          .values({ userId: targetId, scopeMode: "all" })
          .onConflictDoUpdate({
            target: userBranchScopes.userId,
            set: { scopeMode: "all", updatedAt: new Date() },
          });
      }

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.role_updated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
        details: { fromRole: currentRole, toRole: newRole },
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("users_updated", { userId: targetId });
    return { ok: true };
  });

  app.put("/api/users/:id/branches", { preHandler: requirePermission("users", "edit") }, async (req) => {
    const targetId = (req.params as { id: string }).id;
    const parsed = updateBranchesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid branch assignment", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const { branchScopeMode, branchIds, defaultBranchId } = parsed.data;
    const db = getDb();

    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email })
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
          .where(inArray(branches.id, branchIds));
        if (validBranches.length !== branchIds.length) {
          throw new AppError(400, "One or more selected branches do not exist", "INVALID_BRANCH");
        }
      }

      await tx
        .insert(userBranchScopes)
        .values({ userId: targetId, scopeMode: branchScopeMode })
        .onConflictDoUpdate({
          target: userBranchScopes.userId,
          set: { scopeMode: branchScopeMode, updatedAt: new Date() },
        });

      await tx.delete(userBranches).where(eq(userBranches.userId, targetId));

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
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "user.branches_updated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
        details: { branchScopeMode, branchIds, defaultBranchId: effectiveDefault },
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
    if (actor.id === targetId && !parsed.data.isActive) {
      throw new AppError(400, "You cannot deactivate your own account", "SELF_DEACTIVATE_FORBIDDEN");
    }

    const db = getDb();
    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        throw new AppError(404, "User not found", "NOT_FOUND");
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
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: parsed.data.isActive ? "user.activated" : "user.deactivated",
        entityType: "user",
        entityId: targetId,
        entityLabel: target.email,
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
      for (const role of ["admin", "manager", "user"] as const) {
        const roleMods = parsed.data.matrix[role];
        if (!roleMods) continue;

        for (const moduleName of PERMISSION_MODULES) {
          const perm = roleMods[moduleName];
          if (!perm) continue;

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
              canApprove: isProtectedAdminModule ? true : Boolean(perm.approve),
            })
            .onConflictDoUpdate({
              target: [rolePermissions.role, rolePermissions.module],
              set: {
                canView: isProtectedAdminModule ? true : perm.view,
                canCreate: isProtectedAdminModule ? true : perm.create,
                canEdit: isProtectedAdminModule ? true : perm.edit,
                canDelete: isProtectedAdminModule ? true : perm.delete,
                canApprove: isProtectedAdminModule ? true : Boolean(perm.approve),
                updatedAt: new Date(),
              },
            });
        }
      }

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "roles.permissions_updated",
        entityType: "role_permissions",
        entityId: "matrix",
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
