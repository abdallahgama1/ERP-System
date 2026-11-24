import {
  buildEmptyPermissionRecord,
  createCustomRoleSchema,
  normalizeRolePermissionsMap,
  PERMISSION_MODULES,
  updateCustomRoleSchema,
  type CustomRoleDto,
  type PermissionMap,
  type PermissionModule,
} from "@erp/shared";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  customRolePermissions,
  customRoles,
  userCompanies,
  userRoles,
} from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { parseOrThrow } from "./stock-locks.ts";

const uuidParamSchema = z.string().uuid("Invalid role ID");

const ADMIN_GOVERNANCE_MODULES: readonly PermissionModule[] = [
  "users",
  "roles",
  "companies",
  "settings",
];

function buildPermissionMapFromRows(
  rows: Array<typeof customRolePermissions.$inferSelect>
): PermissionMap {
  const raw: Partial<Record<string, Partial<Record<"view" | "create" | "edit" | "delete" | "approve", boolean>>>> =
    {};
  for (const row of rows) {
    if ((PERMISSION_MODULES as readonly string[]).includes(row.module)) {
      raw[row.module] = {
        view: row.canView,
        create: row.canCreate,
        edit: row.canEdit,
        delete: row.canDelete,
        approve: row.canApprove,
      };
    }
  }
  return normalizeRolePermissionsMap(raw);
}

function protectAdminSystemPermissions(permissions: PermissionMap): PermissionMap {
  const result: PermissionMap = structuredClone(permissions);
  for (const mod of ADMIN_GOVERNANCE_MODULES) {
    result[mod] = {
      view: true,
      create: true,
      edit: true,
      delete: true,
      approve: true,
    };
  }
  return result;
}

export async function listCustomRoles(db: AppDatabase, companyId: string): Promise<CustomRoleDto[]> {
  const roles = await db
    .select()
    .from(customRoles)
    .where(eq(customRoles.companyId, companyId))
    .orderBy(desc(customRoles.isSystem), asc(customRoles.name));

  if (roles.length === 0) {
    return [];
  }

  const roleIds = roles.map((r) => r.id);
  const [permRows, countRows] = await Promise.all([
    db
      .select()
      .from(customRolePermissions)
      .where(inArray(customRolePermissions.customRoleId, roleIds)),
    db
      .select({
        customRoleId: userCompanies.customRoleId,
        count: sql<number>`count(*)::int`,
      })
      .from(userCompanies)
      .where(
        and(
          eq(userCompanies.companyId, companyId),
          eq(userCompanies.isActive, true),
          inArray(userCompanies.customRoleId, roleIds)
        )
      )
      .groupBy(userCompanies.customRoleId),
  ]);

  const permsByRole = new Map<string, Array<typeof customRolePermissions.$inferSelect>>();
  for (const row of permRows) {
    const list = permsByRole.get(row.customRoleId) ?? [];
    list.push(row);
    permsByRole.set(row.customRoleId, list);
  }

  const countByRole = new Map<string, number>();
  for (const c of countRows) {
    if (c.customRoleId) {
      countByRole.set(c.customRoleId, c.count);
    }
  }

  return roles.map((role) => {
    const rows = permsByRole.get(role.id) ?? [];
    const permissions =
      rows.length > 0 ? buildPermissionMapFromRows(rows) : buildEmptyPermissionRecord();
    return {
      id: role.id,
      companyId: role.companyId,
      name: role.name,
      description: role.description,
      baseRole: role.baseRole,
      isSystem: role.isSystem,
      isActive: role.isActive,
      permissions,
      assignedUserCount: countByRole.get(role.id) ?? 0,
      createdAt: role.createdAt.toISOString(),
      updatedAt: role.updatedAt.toISOString(),
    };
  });
}

export async function createCustomRole(
  db: AppDatabase,
  actor: AuthUser,
  rawBody: unknown,
  ipAddress?: string
): Promise<CustomRoleDto> {
  const parsed = parseOrThrow(createCustomRoleSchema, rawBody, "Invalid custom role payload");

  if (parsed.baseRole === "admin" && actor.role !== "admin") {
    throw new AppError(403, "Only admins can create a role with admin base privilege", "FORBIDDEN");
  }

  const normalizedPermissions = normalizeRolePermissionsMap(parsed.permissions);
  const companyId = actor.activeCompanyId;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: customRoles.id })
      .from(customRoles)
      .where(and(eq(customRoles.companyId, companyId), eq(customRoles.name, parsed.name)))
      .limit(1);
    if (existing) {
      throw new AppError(409, `Role '${parsed.name}' already exists in this company`, "DUPLICATE_ROLE_NAME");
    }

    const [created] = await tx
      .insert(customRoles)
      .values({
        companyId,
        name: parsed.name,
        description: parsed.description ?? "",
        baseRole: parsed.baseRole,
        isSystem: false,
        isActive: true,
      })
      .returning();

    await tx.insert(customRolePermissions).values(
      PERMISSION_MODULES.map((mod) => ({
        customRoleId: created.id,
        module: mod,
        canView: normalizedPermissions[mod].view,
        canCreate: normalizedPermissions[mod].create,
        canEdit: normalizedPermissions[mod].edit,
        canDelete: normalizedPermissions[mod].delete,
        canApprove: normalizedPermissions[mod].approve,
      }))
    );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "custom_role.created",
      entityType: "custom_role",
      entityId: created.id,
      entityLabel: created.name,
      after: {
        id: created.id,
        name: created.name,
        description: created.description,
        baseRole: created.baseRole,
        isSystem: created.isSystem,
        isActive: created.isActive,
        permissions: normalizedPermissions,
      },
      ipAddress,
    });

    return {
      id: created.id,
      companyId: created.companyId,
      name: created.name,
      description: created.description,
      baseRole: created.baseRole,
      isSystem: created.isSystem,
      isActive: created.isActive,
      permissions: normalizedPermissions,
      assignedUserCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });
}

export async function updateCustomRole(
  db: AppDatabase,
  actor: AuthUser,
  rawRoleId: string,
  rawBody: unknown,
  ipAddress?: string
): Promise<CustomRoleDto> {
  const roleId = parseOrThrow(uuidParamSchema, rawRoleId, "Invalid role ID");
  const parsed = parseOrThrow(updateCustomRoleSchema, rawBody, "Invalid custom role update payload");
  const companyId = actor.activeCompanyId;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.id, roleId), eq(customRoles.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "Custom role not found", "ROLE_NOT_FOUND");
    }

    if (existing.isSystem) {
      if (parsed.name !== undefined && parsed.name !== existing.name) {
        throw new AppError(400, "Cannot rename a system preset role", "SYSTEM_ROLE_PROTECTED");
      }
      if (parsed.baseRole !== undefined && parsed.baseRole !== existing.baseRole) {
        throw new AppError(400, "Cannot change base role of a system preset role", "SYSTEM_ROLE_PROTECTED");
      }
      if (parsed.isActive === false) {
        throw new AppError(400, "Cannot deactivate a system preset role", "SYSTEM_ROLE_PROTECTED");
      }
    }

    if (parsed.baseRole === "admin" && actor.role !== "admin") {
      throw new AppError(403, "Only admins can assign admin base privilege to a role", "FORBIDDEN");
    }

    const nextName = parsed.name ?? existing.name;
    if (nextName !== existing.name) {
      const [dup] = await tx
        .select({ id: customRoles.id })
        .from(customRoles)
        .where(
          and(
            eq(customRoles.companyId, companyId),
            eq(customRoles.name, nextName),
            ne(customRoles.id, roleId)
          )
        )
        .limit(1);
      if (dup) {
        throw new AppError(409, `Role '${nextName}' already exists in this company`, "DUPLICATE_ROLE_NAME");
      }
    }

    const existingPermRows = await tx
      .select()
      .from(customRolePermissions)
      .where(eq(customRolePermissions.customRoleId, roleId));
    const prevPermissions = buildPermissionMapFromRows(existingPermRows);

    let nextPermissions = prevPermissions;
    if (parsed.permissions) {
      nextPermissions = normalizeRolePermissionsMap(parsed.permissions);
      if (existing.isSystem && existing.name === "Admin") {
        nextPermissions = protectAdminSystemPermissions(nextPermissions);
      }
    }

    const nextDescription = parsed.description ?? existing.description;
    const nextBaseRole = parsed.baseRole ?? existing.baseRole;
    const nextIsActive = parsed.isActive ?? existing.isActive;
    const now = new Date();

    const [updated] = await tx
      .update(customRoles)
      .set({
        name: nextName,
        description: nextDescription,
        baseRole: nextBaseRole,
        isActive: nextIsActive,
        updatedAt: now,
      })
      .where(eq(customRoles.id, roleId))
      .returning();

    if (parsed.permissions) {
      for (const mod of PERMISSION_MODULES) {
        const perm = nextPermissions[mod];
        await tx
          .insert(customRolePermissions)
          .values({
            customRoleId: roleId,
            module: mod,
            canView: perm.view,
            canCreate: perm.create,
            canEdit: perm.edit,
            canDelete: perm.delete,
            canApprove: perm.approve,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [customRolePermissions.customRoleId, customRolePermissions.module],
            set: {
              canView: perm.view,
              canCreate: perm.create,
              canEdit: perm.edit,
              canDelete: perm.delete,
              canApprove: perm.approve,
              updatedAt: now,
            },
          });
      }
    }

    if (nextBaseRole !== existing.baseRole) {
      await tx
        .update(userCompanies)
        .set({ role: nextBaseRole, updatedAt: now })
        .where(eq(userCompanies.customRoleId, roleId));
      await tx
        .update(userRoles)
        .set({ role: nextBaseRole, updatedAt: now })
        .where(eq(userRoles.customRoleId, roleId));
    }

    const [assignedAgg] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userCompanies)
      .where(
        and(
          eq(userCompanies.companyId, companyId),
          eq(userCompanies.customRoleId, roleId),
          eq(userCompanies.isActive, true)
        )
      );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "custom_role.updated",
      entityType: "custom_role",
      entityId: roleId,
      entityLabel: updated.name,
      before: {
        name: existing.name,
        description: existing.description,
        baseRole: existing.baseRole,
        isActive: existing.isActive,
        permissions: prevPermissions,
      },
      after: {
        name: updated.name,
        description: updated.description,
        baseRole: updated.baseRole,
        isActive: updated.isActive,
        permissions: nextPermissions,
      },
      ipAddress,
    });

    return {
      id: updated.id,
      companyId: updated.companyId,
      name: updated.name,
      description: updated.description,
      baseRole: updated.baseRole,
      isSystem: updated.isSystem,
      isActive: updated.isActive,
      permissions: nextPermissions,
      assignedUserCount: assignedAgg?.count ?? 0,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

export async function deleteCustomRole(
  db: AppDatabase,
  actor: AuthUser,
  rawRoleId: string,
  ipAddress?: string
): Promise<{ ok: true }> {
  const roleId = parseOrThrow(uuidParamSchema, rawRoleId, "Invalid role ID");
  const companyId = actor.activeCompanyId;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.id, roleId), eq(customRoles.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "Custom role not found", "ROLE_NOT_FOUND");
    }

    if (existing.isSystem) {
      throw new AppError(400, "System preset roles cannot be deleted", "SYSTEM_ROLE_PROTECTED");
    }

    const [assignedInCompanies, assignedInRoles] = await Promise.all([
      tx
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .where(eq(userCompanies.customRoleId, roleId))
        .limit(1),
      tx
        .select({ id: userRoles.id })
        .from(userRoles)
        .where(eq(userRoles.customRoleId, roleId))
        .limit(1),
    ]);

    if (assignedInCompanies.length > 0 || assignedInRoles.length > 0) {
      throw new AppError(
        409,
        "Cannot delete a role that is currently assigned to users",
        "ROLE_IN_USE"
      );
    }

    await tx.delete(customRoles).where(eq(customRoles.id, roleId));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "custom_role.deleted",
      entityType: "custom_role",
      entityId: roleId,
      entityLabel: existing.name,
      before: {
        name: existing.name,
        description: existing.description,
        baseRole: existing.baseRole,
      },
      ipAddress,
    });
  });

  return { ok: true };
}
