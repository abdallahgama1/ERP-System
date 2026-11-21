import { eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DEFAULT_PERMISSION_MATRIX,
  PERMISSION_MODULES,
  type AppRole,
  type ModulePermission,
  type PermissionAction,
  type PermissionModule,
  type RolePermissionMatrix,
} from "@erp/shared";
import * as schema from "../../drizzle/schema.ts";
import { rolePermissions, branches, companySettings, customers, taxCodes, documentSequences, taxonomyItems } from "../../drizzle/schema.ts";
import { ensureAccountingDefaults } from "../services/gl.service.ts";
import { ensureApprovalDefaults } from "../services/approvals.service.ts";

export { DEFAULT_PERMISSION_MATRIX, PERMISSION_MODULES };
export type { AppRole, ModulePermission, PermissionAction, PermissionModule, RolePermissionMatrix };

export type DbOrTx =
  | PostgresJsDatabase<typeof schema>
  | PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

/**
 * Ensures initial company settings, default HQ branch, base tax code, document sequences,
 * and default role permission rows exist inside PostgreSQL. Safe to call repeatedly.
 */
export async function ensureSeededDefaults(tx: DbOrTx): Promise<string> {
  // Seed any missing role permissions idempotently (safe on existing databases when new modules are added)
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

  // Ensure default HQ branch exists
  let defaultBranchId: string;
  const existingBranches = await tx.select().from(branches).limit(10);
  const existingDefault = existingBranches.find((b) => b.isDefault) ?? existingBranches[0];
  if (existingDefault) {
    defaultBranchId = existingDefault.id;
  } else {
    const [insertedBranch] = await tx
      .insert(branches)
      .values({
        code: "HQ-01",
        name: "Main Warehouse (HQ)",
        branchType: "hq_warehouse",
        location: "Headquarters",
        isDefault: true,
        isActive: true,
      })
      .returning();
    defaultBranchId = insertedBranch.id;
  }

  // Ensure singleton company settings exists
  const existingCompany = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
  if (existingCompany.length === 0) {
    await tx
      .insert(companySettings)
      .values({
        id: 1,
        companyName: "Count It Keep It",
        baseCurrency: "USD",
        einvoicingMode: "none",
        defaultBranchId,
        settingsJson: {},
      })
      .onConflictDoNothing();
  } else if (!existingCompany[0].defaultBranchId) {
    await tx
      .update(companySettings)
      .set({ defaultBranchId, updatedAt: new Date() })
      .where(eq(companySettings.id, 1));
  }

  // Ensure zero-tax default tax code exists
  const existingTax = await tx.select({ id: taxCodes.id }).from(taxCodes).limit(1);
  if (existingTax.length === 0) {
    await tx
      .insert(taxCodes)
      .values({
        code: "EXEMPT",
        name: "No Tax (0%)",
        rate: "0",
        isDefault: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  // Ensure core document sequence counters exist
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
  ];

  await tx
    .insert(documentSequences)
    .values(
      baseSequences.map((seq) => ({
        docType: seq.docType,
        scopeKey: "company",
        prefix: seq.prefix,
        nextNumber: 1,
        padding: seq.padding,
      }))
    )
    .onConflictDoNothing();

  // Ensure baseline units of measure exist in Postgres rather than hardcoded client fallbacks
  const existingUnits = await tx
    .select({ id: taxonomyItems.id })
    .from(taxonomyItems)
    .where(eq(taxonomyItems.kind, "unit"))
    .limit(1);
  if (existingUnits.length === 0) {
    await tx.insert(taxonomyItems).values([
      { kind: "unit", name: "Pieces", symbol: "pcs", isActive: true },
      { kind: "unit", name: "Box", symbol: "box", isActive: true },
      { kind: "unit", name: "Kilogram", symbol: "kg", isActive: true },
    ]);
  }

  // Ensure default Walk-in customer exists for POS rapid checkout
  await tx
    .insert(customers)
    .values({
      code: "WALK-IN",
      name: "Walk-in Customer",
      currency: "USD",
      paymentTermsDays: 0,
      isWalkIn: true,
      isActive: true,
    })
    .onConflictDoNothing();

  await ensureAccountingDefaults(tx);
  await ensureApprovalDefaults(tx);

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
