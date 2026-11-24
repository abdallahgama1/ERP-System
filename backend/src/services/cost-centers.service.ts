import type { CostCenterDto, createCostCenterSchema, updateCostCenterSchema } from "@erp/shared";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { branches, costCenters } from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { actorCompanyId, assertBranchInCompany, type RequestActor } from "./stock-locks.ts";

export async function assertCostCenterInCompany(
  tx: DbOrTx,
  costCenterId: string,
  companyId: string
): Promise<void> {
  const [cc] = await tx
    .select({ id: costCenters.id, isActive: costCenters.isActive })
    .from(costCenters)
    .where(and(eq(costCenters.id, costCenterId), eq(costCenters.companyId, companyId)))
    .limit(1);
  if (!cc) {
    throw new AppError(404, "Cost center not found in active company", "COST_CENTER_NOT_FOUND");
  }
}

export async function listCostCenters(
  db: AppDatabase,
  actor: RequestActor,
  opts: { activeOnly?: boolean } = {}
): Promise<CostCenterDto[]> {
  const companyId = actorCompanyId(actor);
  const conds = [eq(costCenters.companyId, companyId)];
  if (opts.activeOnly) {
    conds.push(eq(costCenters.isActive, true));
  }

  const rows = await db
    .select({
      id: costCenters.id,
      code: costCenters.code,
      name: costCenters.name,
      branchId: costCenters.branchId,
      branchName: branches.name,
      description: costCenters.description,
      isActive: costCenters.isActive,
      createdAt: costCenters.createdAt,
      updatedAt: costCenters.updatedAt,
    })
    .from(costCenters)
    .leftJoin(branches, eq(branches.id, costCenters.branchId))
    .where(and(...conds))
    .orderBy(asc(costCenters.code));

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    branchId: r.branchId ?? null,
    branchName: r.branchName ?? null,
    description: r.description,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createCostCenter(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createCostCenterSchema>,
  ipAddress?: string
): Promise<CostCenterDto> {
  const companyId = actorCompanyId(actor);

  const created = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: costCenters.id })
      .from(costCenters)
      .where(and(eq(costCenters.companyId, companyId), eq(costCenters.code, data.code)))
      .limit(1);
    if (dup) {
      throw new AppError(409, `Cost center code '${data.code}' already exists`, "DUPLICATE_CODE");
    }

    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }

    const [row] = await tx
      .insert(costCenters)
      .values({
        companyId,
        code: data.code,
        name: data.name,
        branchId: data.branchId ?? null,
        description: data.description ?? "",
        isActive: data.isActive ?? true,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId ?? null,
      action: "cost_center.created",
      entityType: "accounting",
      entityId: row.id,
      entityLabel: `${row.code} — ${row.name}`,
      after: { code: row.code, name: row.name, branchId: row.branchId, isActive: row.isActive },
      ipAddress,
    });

    return row;
  });

  const all = await listCostCenters(db, actor);
  return all.find((c) => c.id === created.id)!;
}

export async function updateCostCenter(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updateCostCenterSchema>,
  ipAddress?: string
): Promise<CostCenterDto> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(costCenters)
      .where(and(eq(costCenters.id, id), eq(costCenters.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Cost center not found", "NOT_FOUND");
    }

    if (data.code && data.code !== existing.code) {
      const [dup] = await tx
        .select({ id: costCenters.id })
        .from(costCenters)
        .where(and(eq(costCenters.companyId, companyId), eq(costCenters.code, data.code)))
        .limit(1);
      if (dup) {
        throw new AppError(409, `Cost center code '${data.code}' already exists`, "DUPLICATE_CODE");
      }
    }

    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }

    const [updated] = await tx
      .update(costCenters)
      .set({
        ...(data.code !== undefined ? { code: data.code } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(costCenters.id, id), eq(costCenters.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: updated.branchId ?? null,
      action: "cost_center.updated",
      entityType: "accounting",
      entityId: updated.id,
      entityLabel: `${updated.code} — ${updated.name}`,
      before: {
        code: existing.code,
        name: existing.name,
        branchId: existing.branchId,
        isActive: existing.isActive,
      },
      after: {
        code: updated.code,
        name: updated.name,
        branchId: updated.branchId,
        isActive: updated.isActive,
      },
      ipAddress,
    });
  });

  const all = await listCostCenters(db, actor);
  return all.find((c) => c.id === id)!;
}
