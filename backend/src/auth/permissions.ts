import { and, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DEFAULT_PERMISSION_MATRIX,
  normalizeRolePermissionsMap,
  PERMISSION_MODULES,
  SYSTEM_ROLE_PRESETS,
  type AppRole,
  type ApprovalEntityType,
  type ModulePermission,
  type PermissionAction,
  type PermissionMap,
  type PermissionModule,
  type RolePermissionMatrix,
} from "@erp/shared";
import * as schema from "../../drizzle/schema.ts";
import {
  DEFAULT_COMPANY_ID,
  approvalRules,
  branches,
  chartOfAccounts,
  companies,
  companySettings,
  currencies,
  customers,
  customRolePermissions,
  customRoles,
  documentSequences,
  fiscalPeriods,
  fiscalYears,
  glAccountMappings,
  rolePermissions,
  taxCodes,
  taxonomyItems,
} from "../../drizzle/schema.ts";
import { DEFAULT_COA } from "../services/gl.service.ts";

export { DEFAULT_PERMISSION_MATRIX, PERMISSION_MODULES };
export type { AppRole, ModulePermission, PermissionAction, PermissionMap, PermissionModule, RolePermissionMatrix };

export type DbOrTx =
  | PostgresJsDatabase<typeof schema>
  | PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

let defaultsBackfilledOnce = false;

export function resetSeededDefaultsCache(): void {
  defaultsBackfilledOnce = false;
}

const DEFAULT_APPROVAL_RULES: Array<{
  entityType: ApprovalEntityType;
  minAmount: string;
  requiredRole: AppRole;
  description: string;
}> = [
  {
    entityType: "purchase_order",
    minAmount: "10000",
    requiredRole: "manager",
    description: "Require approval before issuing Purchase Orders at or above threshold.",
  },
  {
    entityType: "stock_transfer",
    minAmount: "5000",
    requiredRole: "manager",
    description: "Require approval before dispatching Stock Transfers at or above threshold.",
  },
  {
    entityType: "stock_adjustment",
    minAmount: "2000",
    requiredRole: "manager",
    description: "Require approval before posting Stock Adjustments at or above threshold.",
  },
  {
    entityType: "stock_write_off",
    minAmount: "1000",
    requiredRole: "manager",
    description: "Require approval before posting Inventory Write-Offs at or above threshold.",
  },
];

const CURRENCY_META: Record<string, { name: string; symbol: string; decimals: number }> = {
  USD: { name: "US Dollar", symbol: "$", decimals: 2 },
  EUR: { name: "Euro", symbol: "€", decimals: 2 },
  GBP: { name: "British Pound", symbol: "£", decimals: 2 },
  EGP: { name: "Egyptian Pound", symbol: "EGP", decimals: 2 },
  SAR: { name: "Saudi Riyal", symbol: "SAR", decimals: 2 },
  AED: { name: "UAE Dirham", symbol: "AED", decimals: 2 },
};

export interface SeedCompanyDefaultsParams {
  companyId: string;
  companyName?: string;
  baseCurrency?: string;
  defaultBranchCode?: string;
  defaultBranchName?: string;
}

export async function seedCompanyCustomRoles(
  tx: DbOrTx,
  companyId: string
): Promise<{ adminRoleId: string; rolesByName: Map<string, string> }> {
  await tx
    .insert(customRoles)
    .values(
      SYSTEM_ROLE_PRESETS.map((preset) => ({
        companyId,
        name: preset.name,
        description: preset.description,
        baseRole: preset.baseRole,
        isSystem: true,
        isActive: true,
      }))
    )
    .onConflictDoNothing({ target: [customRoles.companyId, customRoles.name] });

  const roleRows = await tx
    .select({ id: customRoles.id, name: customRoles.name })
    .from(customRoles)
    .where(eq(customRoles.companyId, companyId));

  const rolesByName = new Map(roleRows.map((r) => [r.name, r.id]));
  const permRows: Array<typeof customRolePermissions.$inferInsert> = [];

  for (const preset of SYSTEM_ROLE_PRESETS) {
    const roleId = rolesByName.get(preset.name);
    if (!roleId) continue;
    const normalized = normalizeRolePermissionsMap(preset.permissions);
    for (const mod of PERMISSION_MODULES) {
      const perm = normalized[mod];
      permRows.push({
        customRoleId: roleId,
        module: mod,
        canView: perm.view,
        canCreate: perm.create,
        canEdit: perm.edit,
        canDelete: perm.delete,
        canApprove: perm.approve,
      });
    }
  }

  if (permRows.length > 0) {
    await tx
      .insert(customRolePermissions)
      .values(permRows)
      .onConflictDoNothing({ target: [customRolePermissions.customRoleId, customRolePermissions.module] });
  }

  const adminRoleId = rolesByName.get("Admin") ?? "";
  return { adminRoleId, rolesByName };
}

export async function seedCompanyDefaults(
  tx: DbOrTx,
  params: SeedCompanyDefaultsParams
): Promise<string> {
  const { companyId } = params;
  const baseCurrency = (params.baseCurrency ?? "USD").trim().toUpperCase() || "USD";
  const defaultBranchCode = params.defaultBranchCode ?? "HQ-01";
  const defaultBranchName = params.defaultBranchName ?? "Main Warehouse (HQ)";

  // 1. Default branch scoped by companyId
  let defaultBranchId: string;
  const existingBranches = await tx
    .select()
    .from(branches)
    .where(eq(branches.companyId, companyId))
    .limit(10);
  const existingDefault = existingBranches.find((b) => b.isDefault) ?? existingBranches[0];
  if (existingDefault) {
    defaultBranchId = existingDefault.id;
  } else {
    const [insertedBranch] = await tx
      .insert(branches)
      .values({
        companyId,
        code: defaultBranchCode,
        name: defaultBranchName,
        branchType: "hq_warehouse",
        location: "Headquarters",
        isDefault: true,
        isActive: true,
      })
      .onConflictDoNothing({ target: [branches.companyId, branches.code] })
      .returning();

    if (insertedBranch) {
      defaultBranchId = insertedBranch.id;
    } else {
      const [fallbackBranch] = await tx
        .select()
        .from(branches)
        .where(eq(branches.companyId, companyId))
        .limit(1);
      defaultBranchId = fallbackBranch.id;
    }
  }

  // Verify companies.defaultBranchId exists in branches for this company (repair dangling IDs after TRUNCATE)
  const [companyRow] = await tx
    .select({ defaultBranchId: companies.defaultBranchId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (companyRow) {
    let branchValid = false;
    if (companyRow.defaultBranchId) {
      if (existingBranches.some((b) => b.id === companyRow.defaultBranchId)) {
        branchValid = true;
      } else {
        const [matchingBranch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, companyRow.defaultBranchId), eq(branches.companyId, companyId)))
          .limit(1);
        branchValid = Boolean(matchingBranch);
      }
    }
    if (!branchValid) {
      await tx
        .update(companies)
        .set({ defaultBranchId, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
    }
  }

  // 2. Seed all 8 SYSTEM_ROLE_PRESETS into custom_roles + custom_role_permissions
  await seedCompanyCustomRoles(tx, companyId);

  // 3. Seed EXEMPT tax code for this company
  const existingTax = await tx
    .select({ id: taxCodes.id })
    .from(taxCodes)
    .where(eq(taxCodes.companyId, companyId))
    .limit(1);
  if (existingTax.length === 0) {
    await tx
      .insert(taxCodes)
      .values({
        companyId,
        code: "EXEMPT",
        name: "No Tax (0%)",
        rate: "0",
        isDefault: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  // 4. Seed all 23 document_sequences for this company
  const baseSequences = [
    { docType: "PO", prefix: "PO-", padding: 4 },
    { docType: "PRCV", prefix: "RCV-", padding: 4 },
    { docType: "BILL", prefix: "BILL-", padding: 4 },
    { docType: "PMADE", prefix: "PM-", padding: 4 },
    { docType: "PRET", prefix: "PRTN-", padding: 4 },
    { docType: "SO", prefix: "SO-", padding: 4 },
    { docType: "INV", prefix: "INV-", padding: 4 },
    { docType: "RPAY", prefix: "RP-", padding: 4 },
    { docType: "SRET", prefix: "SRTN-", padding: 4 },
    { docType: "CN", prefix: "CN-", padding: 4 },
    { docType: "RET", prefix: "RET-", padding: 4 },
    { docType: "ADJ", prefix: "ADJ-", padding: 4 },
    { docType: "WO", prefix: "WO-", padding: 4 },
    { docType: "TRF", prefix: "TRF-", padding: 4 },
    { docType: "SESS", prefix: "CNT-", padding: 4 },
    { docType: "CUST", prefix: "CUS-", padding: 4 },
    { docType: "VEND", prefix: "VEN-", padding: 4 },
    { docType: "JE", prefix: "JE-", padding: 4 },
    { docType: "BOM", prefix: "BOM-", padding: 4 },
    { docType: "MFG", prefix: "MO-", padding: 4 },
    { docType: "SHIFT", prefix: "SHF-", padding: 4 },
    { docType: "POS", prefix: "POS-", padding: 5 },
    { docType: "POSR", prefix: "POSR-", padding: 5 },
    { docType: "TRFT", prefix: "TRFT-", padding: 4 },
    { docType: "BST", prefix: "BST-", padding: 4 },
    { docType: "EXP", prefix: "EXP-", padding: 4 },
  ];

  await tx
    .insert(documentSequences)
    .values(
      baseSequences.map((seq) => ({
        companyId,
        docType: seq.docType,
        scopeKey: "company",
        prefix: seq.prefix,
        nextNumber: 1,
        padding: seq.padding,
      }))
    )
    .onConflictDoNothing();

  // 5. Seed baseline units of measure in taxonomy_items (kind = "unit") for this company
  const existingUnits = await tx
    .select({ id: taxonomyItems.id })
    .from(taxonomyItems)
    .where(and(eq(taxonomyItems.companyId, companyId), eq(taxonomyItems.kind, "unit")))
    .limit(1);
  if (existingUnits.length === 0) {
    await tx
      .insert(taxonomyItems)
      .values([
        { companyId, kind: "unit", name: "Pieces", symbol: "pcs", isActive: true },
        { companyId, kind: "unit", name: "Box", symbol: "box", isActive: true },
        { companyId, kind: "unit", name: "Kilogram", symbol: "kg", isActive: true },
      ])
      .onConflictDoNothing();
  }

  // 6. Seed Walk-in customer for POS rapid checkout
  await tx
    .insert(customers)
    .values({
      companyId,
      code: "WALK-IN",
      name: "Walk-in Customer",
      currency: baseCurrency,
      paymentTermsDays: 0,
      isWalkIn: true,
      isActive: true,
    })
    .onConflictDoNothing();

  // 7. Seed DEFAULT_COA, gl_account_mappings, base currency, and FY + 12 fiscal periods
  await tx
    .insert(chartOfAccounts)
    .values(
      DEFAULT_COA.map((def) => ({
        companyId,
        code: def.code,
        name: def.name,
        accountType: def.accountType,
        normalBalance: def.normalBalance,
        isSystem: true,
        isActive: true,
      }))
    )
    .onConflictDoNothing();

  const coaRows = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId));
  const coaByCode = new Map(coaRows.map((a) => [a.code, a.id]));

  const mappingRows: Array<typeof glAccountMappings.$inferInsert> = [];
  for (const def of DEFAULT_COA) {
    if (!def.mappingKey) continue;
    const accountId = coaByCode.get(def.code);
    if (!accountId) continue;
    mappingRows.push({
      companyId,
      mappingKey: def.mappingKey,
      accountId,
    });
  }
  if (mappingRows.length > 0) {
    await tx.insert(glAccountMappings).values(mappingRows).onConflictDoNothing();
  }

  const existingCurrency = await tx
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.companyId, companyId))
    .limit(1);
  if (existingCurrency.length === 0) {
    const meta = CURRENCY_META[baseCurrency] ?? {
      name: baseCurrency,
      symbol: baseCurrency,
      decimals: 2,
    };
    await tx
      .insert(currencies)
      .values({
        companyId,
        code: baseCurrency,
        name: meta.name,
        symbol: meta.symbol,
        decimals: meta.decimals,
        isBase: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  const nowYear = new Date().getUTCFullYear();
  for (const year of [nowYear, nowYear + 1]) {
    const fyName = `FY ${year}`;
    const existingFy = await tx
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.name, fyName)))
      .limit(1);
    if (existingFy.length === 0) {
      const [fy] = await tx
        .insert(fiscalYears)
        .values({
          companyId,
          name: fyName,
          startDate: new Date(Date.UTC(year, 0, 1, 0, 0, 0)),
          endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
          status: "open",
        })
        .onConflictDoNothing()
        .returning();

      if (fy) {
        const periods: Array<typeof fiscalPeriods.$inferInsert> = [];
        for (let m = 0; m < 12; m++) {
          periods.push({
            companyId,
            fiscalYearId: fy.id,
            periodNumber: m + 1,
            name: `${year}-${String(m + 1).padStart(2, "0")}`,
            startDate: new Date(Date.UTC(year, m, 1, 0, 0, 0)),
            endDate: new Date(Date.UTC(year, m + 1, 0, 23, 59, 59, 999)),
            status: "open",
          });
        }
        await tx.insert(fiscalPeriods).values(periods).onConflictDoNothing();
      }
    }
  }

  // 8. Seed 4 default disabled approval rules for this company
  await tx
    .insert(approvalRules)
    .values(
      DEFAULT_APPROVAL_RULES.map((def) => ({
        companyId,
        entityType: def.entityType,
        minAmount: def.minAmount,
        requiredRole: def.requiredRole,
        isActive: false,
        description: def.description,
      }))
    )
    .onConflictDoNothing();

  return defaultBranchId;
}

/**
 * Ensures initial company (COMP-01), company settings, default HQ branch, custom roles,
 * base tax code, document sequences, and default role permission rows exist inside PostgreSQL.
 */
export async function ensureSeededDefaults(tx: DbOrTx): Promise<string> {
  if (defaultsBackfilledOnce) {
    const [seeded] = await tx
      .select({ defaultBranchId: companies.defaultBranchId })
      .from(companies)
      .innerJoin(
        branches,
        and(eq(branches.id, companies.defaultBranchId), eq(branches.companyId, DEFAULT_COMPANY_ID))
      )
      .innerJoin(
        companySettings,
        and(eq(companySettings.id, 1), eq(companySettings.defaultBranchId, branches.id))
      )
      .where(eq(companies.id, DEFAULT_COMPANY_ID))
      .limit(1);

    if (seeded?.defaultBranchId) {
      const [adminRole] = await tx
        .select({ id: customRoles.id })
        .from(customRoles)
        .where(and(eq(customRoles.companyId, DEFAULT_COMPANY_ID), eq(customRoles.name, "Admin")))
        .limit(1);
      if (adminRole) {
        return seeded.defaultBranchId;
      }
    }
    defaultsBackfilledOnce = false;
  }

  // Seed any missing legacy role permissions idempotently
  const permRows: Array<typeof rolePermissions.$inferInsert> = [];
  for (const role of ["admin", "manager", "user"] as const) {
    for (const moduleName of PERMISSION_MODULES) {
      const perm = DEFAULT_PERMISSION_MATRIX[role][moduleName];
      permRows.push({
        role,
        module: moduleName,
        canView: perm.view,
        canCreate: perm.create,
        canEdit: perm.edit,
        canDelete: perm.delete,
        canApprove: perm.approve,
      });
    }
  }
  await tx.insert(rolePermissions).values(permRows).onConflictDoNothing();

  // Ensure default primary company COMP-01 exists before branches
  await tx
    .insert(companies)
    .values({
      id: DEFAULT_COMPANY_ID,
      code: "COMP-01",
      name: "Count It Keep It",
      baseCurrency: "USD",
      einvoicingMode: "none",
      isDefault: true,
      isActive: true,
    })
    .onConflictDoNothing();

  const [comp01] = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, DEFAULT_COMPANY_ID))
    .limit(1);

  const defaultBranchId = await seedCompanyDefaults(tx, {
    companyId: DEFAULT_COMPANY_ID,
    companyName: comp01?.name ?? "Count It Keep It",
    baseCurrency: comp01?.baseCurrency ?? "USD",
    defaultBranchCode: "HQ-01",
    defaultBranchName: "Main Warehouse (HQ)",
  });

  // Ensure singleton company_settings (id=1) exists and stays synced with COMP-01
  const existingSettings = await tx
    .select()
    .from(companySettings)
    .where(eq(companySettings.id, 1))
    .limit(1);
  if (existingSettings.length === 0) {
    await tx
      .insert(companySettings)
      .values({
        id: 1,
        companyName: comp01?.name ?? "Count It Keep It",
        legalName: comp01?.legalName ?? "",
        taxRegistrationNumber: comp01?.taxRegistrationNumber ?? "",
        baseCurrency: comp01?.baseCurrency ?? "USD",
        einvoicingMode: comp01?.einvoicingMode ?? "none",
        defaultBranchId,
        address: comp01?.address ?? "",
        phone: comp01?.phone ?? "",
        email: comp01?.email ?? "",
        settingsJson: comp01?.settingsJson ?? {},
      })
      .onConflictDoNothing();
  } else {
    const currentSettings = existingSettings[0];
    let settingsBranchValid = false;
    if (currentSettings.defaultBranchId) {
      const [br] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.id, currentSettings.defaultBranchId),
            eq(branches.companyId, DEFAULT_COMPANY_ID)
          )
        )
        .limit(1);
      settingsBranchValid = Boolean(br);
    }
    if (!settingsBranchValid) {
      await tx
        .update(companySettings)
        .set({ defaultBranchId, updatedAt: new Date() })
        .where(eq(companySettings.id, 1));
    }
  }

  defaultsBackfilledOnce = true;
  return defaultBranchId;
}

const PERMISSION_CACHE_TTL_MS = 30_000;
let cachedPermissionMatrix: { expiresAt: number; matrix: RolePermissionMatrix } | null = null;

export function invalidatePermissionMatrixCache(): void {
  cachedPermissionMatrix = null;
}

export async function loadPermissionMatrix(tx: DbOrTx, opts?: { bypassCache?: boolean }): Promise<RolePermissionMatrix> {
  if (!opts?.bypassCache && cachedPermissionMatrix && cachedPermissionMatrix.expiresAt > Date.now()) {
    return structuredClone(cachedPermissionMatrix.matrix);
  }

  const rows = await tx.select().from(rolePermissions);
  const matrix: RolePermissionMatrix = {
    admin: structuredClone(DEFAULT_PERMISSION_MATRIX.admin),
    manager: structuredClone(DEFAULT_PERMISSION_MATRIX.manager),
    user: structuredClone(DEFAULT_PERMISSION_MATRIX.user),
  };

  for (const row of rows) {
    if (row.role in matrix && (PERMISSION_MODULES as readonly string[]).includes(row.module)) {
      const mod = row.module as PermissionModule;
      matrix[row.role][mod] = {
        view: row.canView,
        create: row.canCreate,
        edit: row.canEdit,
        delete: row.canDelete,
        approve: row.canApprove,
      };
    }
  }
  cachedPermissionMatrix = {
    expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
    matrix: structuredClone(matrix),
  };
  return matrix;
}
