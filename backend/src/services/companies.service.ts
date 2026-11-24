import {
  assignCompanyMemberSchema,
  createCompanySchema,
  switchCompanySchema,
  updateCompanyMemberSchema,
  updateCompanySchema,
  type CompanyDto,
} from "@erp/shared";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_COMPANY_ID,
  branches,
  companies,
  companySettings,
  customers,
  customRoles,
  glAccountMappings,
  journalEntries,
  posShifts,
  products,
  purchaseOrders,
  salesInvoices,
  salesOrders,
  stockMovements,
  taxCodes,
  userCompanies,
  userRoles,
  userSessions,
  users,
  vendorBills,
  vendors,
  type AppRole,
} from "../../drizzle/schema.ts";
import { seedCompanyDefaults } from "../auth/permissions.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { parseOrThrow } from "./stock-locks.ts";

const uuidParamSchema = z.string().uuid("Invalid UUID parameter");

export function toCompanyDto(row: typeof companies.$inferSelect): CompanyDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    taxRegistrationNumber: row.taxRegistrationNumber,
    baseCurrency: row.baseCurrency,
    einvoicingMode: row.einvoicingMode,
    defaultBranchId: row.defaultBranchId ?? null,
    address: row.address,
    phone: row.phone,
    email: row.email,
    settingsJson: row.settingsJson ?? {},
    isDefault: row.isDefault,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCompanyAuditSnapshot(row: typeof companies.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    taxRegistrationNumber: row.taxRegistrationNumber,
    baseCurrency: row.baseCurrency,
    einvoicingMode: row.einvoicingMode,
    defaultBranchId: row.defaultBranchId ?? null,
    address: row.address,
    phone: row.phone,
    email: row.email,
    settingsJson: row.settingsJson ?? {},
    isDefault: row.isDefault,
    isActive: row.isActive,
  };
}

export async function listCompanies(db: AppDatabase, actor: AuthUser): Promise<CompanyDto[]> {
  if (actor.role === "admin") {
    const rows = await db
      .select()
      .from(companies)
      .orderBy(desc(companies.isDefault), asc(companies.createdAt));
    return rows.map(toCompanyDto);
  }

  const rows = await db
    .select({ company: companies })
    .from(userCompanies)
    .innerJoin(companies, eq(companies.id, userCompanies.companyId))
    .where(and(eq(userCompanies.userId, actor.id), eq(userCompanies.isActive, true)))
    .orderBy(desc(userCompanies.isDefault), desc(companies.isDefault), asc(companies.createdAt));

  return rows.map((r) => toCompanyDto(r.company));
}

export async function getCompanyById(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string
): Promise<{ company: CompanyDto; branchCount: number; memberCount: number }> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) {
    throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
  }

  if (actor.role !== "admin") {
    const [membership] = await db
      .select({ id: userCompanies.id })
      .from(userCompanies)
      .where(
        and(
          eq(userCompanies.userId, actor.id),
          eq(userCompanies.companyId, companyId),
          eq(userCompanies.isActive, true)
        )
      )
      .limit(1);
    if (!membership) {
      throw new AppError(403, "You do not have access to this company", "FORBIDDEN");
    }
  }

  const [[branchAgg], [memberAgg]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(branches)
      .where(eq(branches.companyId, companyId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userCompanies)
      .where(and(eq(userCompanies.companyId, companyId), eq(userCompanies.isActive, true))),
  ]);

  return {
    company: toCompanyDto(company),
    branchCount: branchAgg?.count ?? 0,
    memberCount: memberAgg?.count ?? 0,
  };
}

export async function createCompany(
  db: AppDatabase,
  actor: AuthUser,
  rawBody: unknown,
  ipAddress?: string
): Promise<CompanyDto> {
  const parsed = parseOrThrow(createCompanySchema, rawBody, "Invalid company payload");

  return db.transaction(async (tx) => {
    let code = parsed.code;
    if (!code) {
      const existingCodes = await tx.select({ code: companies.code }).from(companies);
      const codeSet = new Set(existingCodes.map((c) => c.code.toUpperCase()));
      let maxNum = 1;
      for (const c of codeSet) {
        const m = /^COMP-(\d+)$/i.exec(c);
        if (m) {
          const n = Number.parseInt(m[1]!, 10);
          if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
      }
      let next = maxNum + 1;
      code = `COMP-${String(next).padStart(2, "0")}`;
      while (codeSet.has(code)) {
        next++;
        code = `COMP-${String(next).padStart(2, "0")}`;
      }
    }

    const [dup] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.code, code))
      .limit(1);
    if (dup) {
      throw new AppError(409, `Company code '${code}' already exists`, "DUPLICATE_COMPANY_CODE");
    }

    const [created] = await tx
      .insert(companies)
      .values({
        code,
        name: parsed.name,
        legalName: parsed.legalName,
        taxRegistrationNumber: parsed.taxRegistrationNumber,
        baseCurrency: parsed.baseCurrency.toUpperCase(),
        einvoicingMode: parsed.einvoicingMode,
        address: parsed.address,
        phone: parsed.phone,
        email: parsed.email,
        settingsJson: parsed.settingsJson,
        isDefault: false,
        isActive: parsed.isActive,
      })
      .returning();

    await seedCompanyDefaults(tx, {
      companyId: created.id,
      companyName: created.name,
      baseCurrency: created.baseCurrency,
      defaultBranchCode: "HQ-01",
      defaultBranchName: `${created.name} (HQ)`,
    });

    const [finalRow] = await tx.select().from(companies).where(eq(companies.id, created.id)).limit(1);
    if (!finalRow) {
      throw new AppError(500, "Failed to reload newly created company");
    }

    const [adminCustomRole] = await tx
      .select({ id: customRoles.id })
      .from(customRoles)
      .where(and(eq(customRoles.companyId, finalRow.id), eq(customRoles.name, "Admin")))
      .limit(1);

    await tx
      .insert(userCompanies)
      .values({
        userId: actor.id,
        companyId: finalRow.id,
        role: "admin",
        customRoleId: adminCustomRole?.id ?? null,
        isDefault: false,
        isActive: true,
      })
      .onConflictDoNothing();

    await writeAuditLog(tx, {
      companyId: finalRow.id,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.created",
      entityType: "company",
      entityId: finalRow.id,
      entityLabel: finalRow.code,
      after: toCompanyAuditSnapshot(finalRow),
      ipAddress,
    });

    return toCompanyDto(finalRow);
  });
}

export async function updateCompany(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string,
  rawBody: unknown,
  ipAddress?: string
): Promise<CompanyDto> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new AppError(400, "Invalid company update payload", "VALIDATION_ERROR");
  }

  const presentKeys = new Set(Object.keys(rawBody as Record<string, unknown>));
  const parsed = parseOrThrow(updateCompanySchema, rawBody, "Invalid company update payload");

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
    }

    if (actor.role !== "admin") {
      const [membership] = await tx
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .where(
          and(
            eq(userCompanies.userId, actor.id),
            eq(userCompanies.companyId, companyId),
            eq(userCompanies.isActive, true)
          )
        )
        .limit(1);
      if (!membership) {
        throw new AppError(403, "You do not have access to this company", "FORBIDDEN");
      }
    }

    if (
      (companyId === DEFAULT_COMPANY_ID || existing.isDefault) &&
      presentKeys.has("isActive") &&
      parsed.isActive === false
    ) {
      throw new AppError(400, "Cannot deactivate the default company", "DEFAULT_COMPANY_PROTECTED");
    }

    if (presentKeys.has("defaultBranchId") && parsed.defaultBranchId) {
      const [branchRow] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.id, parsed.defaultBranchId), eq(branches.companyId, companyId)))
        .limit(1);
      if (!branchRow) {
        throw new AppError(
          400,
          "Selected default branch does not belong to this company",
          "INVALID_BRANCH"
        );
      }
    }

    const nextCode = presentKeys.has("code") && parsed.code ? parsed.code : existing.code;
    if (nextCode !== existing.code) {
      const [dup] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.code, nextCode), ne(companies.id, companyId)))
        .limit(1);
      if (dup) {
        throw new AppError(409, `Company code '${nextCode}' already exists`, "DUPLICATE_COMPANY_CODE");
      }
    }

    const nextSettingsJson = presentKeys.has("settingsJson")
      ? { ...(existing.settingsJson ?? {}), ...(parsed.settingsJson ?? {}) }
      : (existing.settingsJson ?? {});

    const nextName = presentKeys.has("name") && parsed.name ? parsed.name : existing.name;
    const nextLegalName = presentKeys.has("legalName") ? (parsed.legalName ?? "") : existing.legalName;
    const nextTaxReg = presentKeys.has("taxRegistrationNumber")
      ? (parsed.taxRegistrationNumber ?? "")
      : existing.taxRegistrationNumber;
    const nextBaseCurrency =
      presentKeys.has("baseCurrency") && parsed.baseCurrency
        ? parsed.baseCurrency.toUpperCase()
        : existing.baseCurrency;
    const nextEinvoicingMode =
      presentKeys.has("einvoicingMode") && parsed.einvoicingMode
        ? parsed.einvoicingMode
        : existing.einvoicingMode;
    const nextDefaultBranchId = presentKeys.has("defaultBranchId")
      ? (parsed.defaultBranchId ?? null)
      : existing.defaultBranchId;
    const nextAddress = presentKeys.has("address") ? (parsed.address ?? "") : existing.address;
    const nextPhone = presentKeys.has("phone") ? (parsed.phone ?? "") : existing.phone;
    const nextEmail = presentKeys.has("email") ? (parsed.email ?? "") : existing.email;
    const nextIsActive =
      presentKeys.has("isActive") && parsed.isActive !== undefined
        ? parsed.isActive
        : existing.isActive;

    const now = new Date();
    const [updated] = await tx
      .update(companies)
      .set({
        code: nextCode,
        name: nextName,
        legalName: nextLegalName,
        taxRegistrationNumber: nextTaxReg,
        baseCurrency: nextBaseCurrency,
        einvoicingMode: nextEinvoicingMode,
        defaultBranchId: nextDefaultBranchId,
        address: nextAddress,
        phone: nextPhone,
        email: nextEmail,
        settingsJson: nextSettingsJson,
        isActive: nextIsActive,
        updatedAt: now,
      })
      .where(eq(companies.id, companyId))
      .returning();

    if (companyId === DEFAULT_COMPANY_ID) {
      await tx
        .update(companySettings)
        .set({
          companyName: updated.name,
          legalName: updated.legalName,
          taxRegistrationNumber: updated.taxRegistrationNumber,
          baseCurrency: updated.baseCurrency,
          einvoicingMode: updated.einvoicingMode,
          defaultBranchId: updated.defaultBranchId,
          address: updated.address,
          phone: updated.phone,
          email: updated.email,
          settingsJson: updated.settingsJson,
          updatedAt: now,
        })
        .where(eq(companySettings.id, 1));
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      entityLabel: updated.code,
      before: toCompanyAuditSnapshot(existing),
      after: toCompanyAuditSnapshot(updated),
      ipAddress,
    });

    return toCompanyDto(updated);
  });
}

export async function deleteCompany(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string,
  ipAddress?: string
): Promise<{ ok: true }> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");

  if (companyId === DEFAULT_COMPANY_ID) {
    throw new AppError(400, "Cannot delete the default company", "DEFAULT_COMPANY_PROTECTED");
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
    }
    if (existing.isDefault) {
      throw new AppError(400, "Cannot delete the default company", "DEFAULT_COMPANY_PROTECTED");
    }

    const usageChecks = await Promise.all([
      tx.select({ id: products.id }).from(products).where(eq(products.companyId, companyId)).limit(1),
      tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.companyId, companyId), eq(customers.isWalkIn, false)))
        .limit(1),
      tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.companyId, companyId)).limit(1),
      tx
        .select({ id: salesOrders.id })
        .from(salesOrders)
        .where(eq(salesOrders.companyId, companyId))
        .limit(1),
      tx
        .select({ id: salesInvoices.id })
        .from(salesInvoices)
        .where(eq(salesInvoices.companyId, companyId))
        .limit(1),
      tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.companyId, companyId))
        .limit(1),
      tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(eq(vendorBills.companyId, companyId))
        .limit(1),
      tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(eq(journalEntries.companyId, companyId))
        .limit(1),
      tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(eq(stockMovements.companyId, companyId))
        .limit(1),
      tx.select({ id: posShifts.id }).from(posShifts).where(eq(posShifts.companyId, companyId)).limit(1),
    ]);

    if (usageChecks.some((rows) => rows.length > 0)) {
      throw new AppError(
        409,
        "Company has operational history and cannot be deleted; deactivate it instead",
        "COMPANY_IN_USE"
      );
    }

    await tx
      .update(userSessions)
      .set({ activeCompanyId: null })
      .where(eq(userSessions.activeCompanyId, companyId));

    // Delete restricting child rows in deterministic order before deleting company
    await tx.delete(glAccountMappings).where(eq(glAccountMappings.companyId, companyId));
    await tx.delete(taxCodes).where(eq(taxCodes.companyId, companyId));
    await tx.delete(customers).where(eq(customers.companyId, companyId));
    await tx.delete(branches).where(eq(branches.companyId, companyId));
    await tx.delete(companies).where(eq(companies.id, companyId));

    await writeAuditLog(tx, {
      companyId: DEFAULT_COMPANY_ID,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.deleted",
      entityType: "company",
      entityId: companyId,
      entityLabel: existing.code,
      before: toCompanyAuditSnapshot(existing),
      ipAddress,
    });
  });

  return { ok: true };
}

export interface CompanyMemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  userIsActive: boolean;
  companyId: string;
  role: AppRole;
  customRoleId: string | null;
  customRoleName: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listCompanyMembers(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string
): Promise<CompanyMemberDto[]> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");

  const [comp] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!comp) {
    throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
  }

  if (actor.role !== "admin") {
    const [membership] = await db
      .select({ id: userCompanies.id })
      .from(userCompanies)
      .where(
        and(
          eq(userCompanies.userId, actor.id),
          eq(userCompanies.companyId, companyId),
          eq(userCompanies.isActive, true)
        )
      )
      .limit(1);
    if (!membership) {
      throw new AppError(403, "You do not have access to this company", "FORBIDDEN");
    }
  }

  const rows = await db
    .select({
      membership: userCompanies,
      userName: users.name,
      userEmail: users.email,
      userIsActive: users.isActive,
      customRoleName: customRoles.name,
      customRoleBaseRole: customRoles.baseRole,
    })
    .from(userCompanies)
    .innerJoin(users, eq(users.id, userCompanies.userId))
    .leftJoin(customRoles, eq(customRoles.id, userCompanies.customRoleId))
    .where(eq(userCompanies.companyId, companyId))
    .orderBy(asc(users.name));

  return rows.map((r) => ({
    id: r.membership.id,
    userId: r.membership.userId,
    name: r.userName,
    email: r.userEmail,
    userIsActive: r.userIsActive,
    companyId: r.membership.companyId,
    role: r.membership.customRoleId && r.customRoleBaseRole ? r.customRoleBaseRole : r.membership.role,
    customRoleId: r.membership.customRoleId ?? null,
    customRoleName: r.customRoleName ?? null,
    isDefault: r.membership.isDefault,
    isActive: r.membership.isActive,
    createdAt: r.membership.createdAt.toISOString(),
    updatedAt: r.membership.updatedAt.toISOString(),
  }));
}

export async function assignCompanyMember(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string,
  rawBody: unknown,
  ipAddress?: string
): Promise<CompanyMemberDto> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");
  const parsed = parseOrThrow(assignCompanyMemberSchema, rawBody, "Invalid company member payload");

  return db.transaction(async (tx) => {
    const [comp] = await tx
      .select({ id: companies.id, code: companies.code, isActive: companies.isActive })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!comp) {
      throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
    }

    const [targetUser] = await tx
      .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, parsed.userId))
      .limit(1);
    if (!targetUser) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }

    let role: AppRole = "user";
    const customRoleId: string | null = parsed.customRoleId ?? null;
    let customRoleName: string | null = null;

    if (customRoleId) {
      const [cr] = await tx
        .select()
        .from(customRoles)
        .where(and(eq(customRoles.id, customRoleId), eq(customRoles.companyId, companyId)))
        .limit(1);
      if (!cr || !cr.isActive) {
        throw new AppError(400, "Selected custom role does not exist or is inactive in this company", "INVALID_CUSTOM_ROLE");
      }
      role = cr.baseRole;
      customRoleName = cr.name;
    }

    if (role === "admin" && actor.role !== "admin") {
      throw new AppError(403, "Only admins can assign an admin role", "FORBIDDEN");
    }

    const [existing] = await tx
      .select()
      .from(userCompanies)
      .where(and(eq(userCompanies.userId, parsed.userId), eq(userCompanies.companyId, companyId)))
      .limit(1);

    if (parsed.isDefault) {
      await tx
        .update(userCompanies)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(userCompanies.userId, parsed.userId), ne(userCompanies.companyId, companyId)));
    }

    const now = new Date();
    const [saved] = await tx
      .insert(userCompanies)
      .values({
        userId: parsed.userId,
        companyId,
        role,
        customRoleId,
        isDefault: parsed.isDefault ?? false,
        isActive: true,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userCompanies.userId, userCompanies.companyId],
        set: {
          role,
          customRoleId,
          isDefault: parsed.isDefault ?? existing?.isDefault ?? false,
          isActive: true,
          updatedAt: now,
        },
      })
      .returning();

    if (saved.isDefault || companyId === DEFAULT_COMPANY_ID) {
      await tx
        .insert(userRoles)
        .values({ userId: parsed.userId, role, customRoleId })
        .onConflictDoUpdate({
          target: userRoles.userId,
          set: { role, customRoleId, updatedAt: now },
        });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.member_assigned",
      entityType: "user_company",
      entityId: saved.id,
      entityLabel: `${targetUser.email} @ ${comp.code}`,
      before: existing
        ? { role: existing.role, customRoleId: existing.customRoleId, isDefault: existing.isDefault, isActive: existing.isActive }
        : null,
      after: { role: saved.role, customRoleId: saved.customRoleId, isDefault: saved.isDefault, isActive: saved.isActive },
      ipAddress,
    });

    return {
      id: saved.id,
      userId: saved.userId,
      name: targetUser.name,
      email: targetUser.email,
      userIsActive: targetUser.isActive,
      companyId: saved.companyId,
      role: saved.role,
      customRoleId: saved.customRoleId ?? null,
      customRoleName,
      isDefault: saved.isDefault,
      isActive: saved.isActive,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  });
}

export async function updateCompanyMember(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string,
  rawUserId: string,
  rawBody: unknown,
  ipAddress?: string
): Promise<CompanyMemberDto> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");
  const targetUserId = parseOrThrow(uuidParamSchema, rawUserId, "Invalid user ID");
  const parsed = parseOrThrow(updateCompanyMemberSchema, rawBody, "Invalid member update payload");

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(userCompanies)
      .where(and(eq(userCompanies.userId, targetUserId), eq(userCompanies.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Company membership not found", "NOT_FOUND");
    }

    const [targetUser] = await tx
      .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    if (!targetUser) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }

    let nextRole: AppRole = existing.role;
    let nextCustomRoleId: string | null = existing.customRoleId;
    let customRoleName: string | null = null;

    if (parsed.customRoleId !== undefined) {
      if (parsed.customRoleId === null) {
        nextCustomRoleId = null;
      } else {
        const [cr] = await tx
          .select()
          .from(customRoles)
          .where(and(eq(customRoles.id, parsed.customRoleId), eq(customRoles.companyId, companyId)))
          .limit(1);
        if (!cr || !cr.isActive) {
          throw new AppError(400, "Selected custom role does not exist or is inactive in this company", "INVALID_CUSTOM_ROLE");
        }
        nextCustomRoleId = cr.id;
        nextRole = cr.baseRole;
        customRoleName = cr.name;
      }
    } else if (nextCustomRoleId) {
      const [cr] = await tx
        .select({ name: customRoles.name })
        .from(customRoles)
        .where(eq(customRoles.id, nextCustomRoleId))
        .limit(1);
      customRoleName = cr?.name ?? null;
    }

    if ((existing.role === "admin" || nextRole === "admin") && actor.role !== "admin") {
      throw new AppError(403, "Only admins can modify an admin membership", "FORBIDDEN");
    }

    const nextIsActive = parsed.isActive !== undefined ? parsed.isActive : existing.isActive;
    const nextIsDefault = parsed.isDefault !== undefined ? parsed.isDefault : existing.isDefault;

    if (
      companyId === DEFAULT_COMPANY_ID &&
      existing.role === "admin" &&
      (nextRole !== "admin" || !nextIsActive)
    ) {
      const activeAdmins = await tx
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .innerJoin(users, eq(users.id, userCompanies.userId))
        .where(
          and(
            eq(userCompanies.companyId, DEFAULT_COMPANY_ID),
            eq(userCompanies.role, "admin"),
            eq(userCompanies.isActive, true),
            eq(users.isActive, true)
          )
        );
      if (activeAdmins.length <= 1) {
        throw new AppError(400, "Cannot remove the last active administrator", "LAST_ADMIN_PROTECTED");
      }
    }

    const now = new Date();
    if (nextIsDefault) {
      await tx
        .update(userCompanies)
        .set({ isDefault: false, updatedAt: now })
        .where(and(eq(userCompanies.userId, targetUserId), ne(userCompanies.companyId, companyId)));
    }

    const [updated] = await tx
      .update(userCompanies)
      .set({
        role: nextRole,
        customRoleId: nextCustomRoleId,
        isDefault: nextIsDefault,
        isActive: nextIsActive,
        updatedAt: now,
      })
      .where(eq(userCompanies.id, existing.id))
      .returning();

    if (updated.isDefault || companyId === DEFAULT_COMPANY_ID) {
      await tx
        .insert(userRoles)
        .values({ userId: targetUserId, role: nextRole, customRoleId: nextCustomRoleId })
        .onConflictDoUpdate({
          target: userRoles.userId,
          set: { role: nextRole, customRoleId: nextCustomRoleId, updatedAt: now },
        });
    }

    if (!updated.isActive) {
      await tx
        .update(userSessions)
        .set({ activeCompanyId: null })
        .where(and(eq(userSessions.userId, targetUserId), eq(userSessions.activeCompanyId, companyId)));
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.member_updated",
      entityType: "user_company",
      entityId: updated.id,
      entityLabel: targetUser.email,
      before: {
        role: existing.role,
        customRoleId: existing.customRoleId,
        isDefault: existing.isDefault,
        isActive: existing.isActive,
      },
      after: {
        role: updated.role,
        customRoleId: updated.customRoleId,
        isDefault: updated.isDefault,
        isActive: updated.isActive,
      },
      ipAddress,
    });

    return {
      id: updated.id,
      userId: updated.userId,
      name: targetUser.name,
      email: targetUser.email,
      userIsActive: targetUser.isActive,
      companyId: updated.companyId,
      role: updated.role,
      customRoleId: updated.customRoleId ?? null,
      customRoleName,
      isDefault: updated.isDefault,
      isActive: updated.isActive,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

export async function removeCompanyMember(
  db: AppDatabase,
  actor: AuthUser,
  rawCompanyId: string,
  rawUserId: string,
  ipAddress?: string
): Promise<{ ok: true }> {
  const companyId = parseOrThrow(uuidParamSchema, rawCompanyId, "Invalid company ID");
  const targetUserId = parseOrThrow(uuidParamSchema, rawUserId, "Invalid user ID");

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(userCompanies)
      .where(and(eq(userCompanies.userId, targetUserId), eq(userCompanies.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Company membership not found", "NOT_FOUND");
    }

    if (existing.role === "admin" && actor.role !== "admin") {
      throw new AppError(403, "Only admins can remove an admin membership", "FORBIDDEN");
    }

    if (companyId === DEFAULT_COMPANY_ID && existing.role === "admin") {
      const activeAdmins = await tx
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .innerJoin(users, eq(users.id, userCompanies.userId))
        .where(
          and(
            eq(userCompanies.companyId, DEFAULT_COMPANY_ID),
            eq(userCompanies.role, "admin"),
            eq(userCompanies.isActive, true),
            eq(users.isActive, true)
          )
        );
      if (activeAdmins.length <= 1) {
        throw new AppError(400, "Cannot remove the last active administrator", "LAST_ADMIN_PROTECTED");
      }
    }

    await tx.delete(userCompanies).where(eq(userCompanies.id, existing.id));
    await tx
      .update(userSessions)
      .set({ activeCompanyId: null })
      .where(and(eq(userSessions.userId, targetUserId), eq(userSessions.activeCompanyId, companyId)));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "company.member_removed",
      entityType: "user_company",
      entityId: existing.id,
      before: {
        userId: existing.userId,
        companyId: existing.companyId,
        role: existing.role,
        customRoleId: existing.customRoleId,
      },
      ipAddress,
    });
  });

  return { ok: true };
}

export { switchCompanySchema };
