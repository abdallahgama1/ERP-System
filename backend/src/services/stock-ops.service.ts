import { and, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { adjustmentSchema, writeOffSchema } from "@erp/shared";
import {
  branches,
  products,
  stockAdjustmentLines,
  stockAdjustments,
  stockMovements,
  stockWriteOffLines,
  stockWriteOffs,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal } from "./gl.service.ts";
import { groupByKey, listBranchScoped } from "./query-helpers.ts";
import { applyBranchStockMovement, lockBranchProduct, type RequestActor } from "./stock-locks.ts";

export async function listMovements(
  db: AppDatabase,
  actor: RequestActor,
  query: { branchId?: string; productId?: string; limit?: string }
) {
  const limit = Math.min(1000, Math.max(1, Number.parseInt(query.limit ?? "500", 10) || 500));
  const conditions = [];
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    conditions.push(eq(stockMovements.branchId, query.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length === 0) return [];
    conditions.push(inArray(stockMovements.branchId, actor.branchIds));
  }
  if (query.productId) {
    conditions.push(eq(stockMovements.productId, query.productId));
  }

  const rows = await db
    .select()
    .from(stockMovements)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(stockMovements.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    branchId: r.branchId,
    productId: r.productId,
    type: r.movementType,
    qtyDelta: num(r.qtyDelta),
    unitCost: num(r.unitCost),
    balanceAfter: num(r.balanceAfter),
    avgCostAfter: num(r.avgCostAfter),
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    referenceNumber: r.referenceNumber,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listAdjustments(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    stockAdjustments,
    stockAdjustments.branchId,
    stockAdjustments.createdAt,
    actor
  )) as Array<typeof stockAdjustments.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(stockAdjustmentLines)
    .where(inArray(stockAdjustmentLines.adjustmentId, headers.map((h) => h.id)));
  const byAdj = groupByKey(lines, (l) => l.adjustmentId);

  return headers.map((h) => ({
    id: h.id,
    adjustmentNumber: h.adjustmentNumber,
    branchId: h.branchId,
    reason: h.reason,
    status: h.status,
    notes: h.notes,
    createdByName: h.createdByName,
    createdAt: h.createdAt.toISOString(),
    lines: (byAdj.get(h.id) ?? []).map((l) => ({
      id: l.id,
      productId: l.productId,
      qtyDelta: num(l.qtyDelta),
      unitCost: num(l.unitCost),
      previousQty: num(l.previousQty),
      newQty: num(l.newQty),
      notes: l.notes,
    })),
  }));
}

export async function createAdjustment(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof adjustmentSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const [branch] = await tx.select().from(branches).where(eq(branches.id, data.branchId)).limit(1);
    if (!branch) throw new AppError(404, "Branch not found", "NOT_FOUND");

    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const adjNumber = await nextDocNumber(tx, "ADJ", "ADJ-");

    const [adj] = await tx
      .insert(stockAdjustments)
      .values({
        adjustmentNumber: adjNumber,
        branchId: data.branchId,
        reason: data.reason,
        status: "Posted",
        notes: data.notes,
        createdBy: actor.id,
        createdByName: actor.name,
      })
      .returning();

    let totalPosVal = 0;
    let totalNegVal = 0;

    for (const line of sortedLines) {
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

      const prodFallback = num(prod.costPrice);
      const locked = await lockBranchProduct(tx, data.branchId, line.productId, prodFallback);
      const delta = line.newQty !== undefined ? line.newQty - locked.qtyOnHand : (line.qtyDelta ?? 0);
      if (delta === 0) continue;

      const unitCost = locked.avgCost > 0 ? locked.avgCost : prodFallback;
      const moved = await applyBranchStockMovement(tx, {
        branchId: data.branchId,
        productId: line.productId,
        qtyDelta: delta,
        fallbackCost: unitCost,
        recomputeAvgCost: false,
        movementType: delta > 0 ? "adjustment_in" : "adjustment_out",
        movementUnitCost: unitCost,
        referenceType: "adjustment",
        referenceId: adj.id,
        referenceNumber: adj.adjustmentNumber,
        insufficientStockMessage: `Insufficient stock for ${prod.name} (${prod.sku}): available ${locked.qtyOnHand}, attempted delta ${delta}`,
        notes: `${data.reason}${line.notes ? `: ${line.notes}` : ""}`,
        actorId: actor.id,
      });

      if (moved.totalValueDelta > 0) totalPosVal += moved.totalValueDelta;
      else totalNegVal += Math.abs(moved.totalValueDelta);

      await tx.insert(stockAdjustmentLines).values({
        adjustmentId: adj.id,
        productId: line.productId,
        qtyDelta: toNumeric(delta, 4),
        unitCost: toNumeric(unitCost, 4),
        previousQty: toNumeric(moved.previousQty, 4),
        newQty: toNumeric(moved.newQty, 4),
        notes: line.notes,
      });
    }

    const netInvDelta = totalPosVal - totalNegVal;
    if (Math.abs(netInvDelta) > 0.0001) {
      const absVal = Math.abs(netInvDelta);
      await postMappedJournal(tx, {
        branchId: data.branchId,
        sourceType: "stock_adjustment",
        sourceId: adj.id,
        referenceNumber: adj.adjustmentNumber,
        memo: `Stock adjustment ${adj.adjustmentNumber} (${data.reason})`,
        createdBy: actor.id,
        lines:
          netInvDelta > 0
            ? [
                { mappingKey: "inventory_asset", debit: absVal },
                { mappingKey: "inventory_adjustment", credit: absVal },
              ]
            : [
                { mappingKey: "inventory_adjustment", debit: absVal },
                { mappingKey: "inventory_asset", credit: absVal },
              ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "adjustment.created",
      entityType: "adjustments",
      entityId: adj.id,
      entityLabel: adj.adjustmentNumber,
      details: { reason: data.reason, lineCount: sortedLines.length },
      ipAddress,
    });

    return adj;
  });
}

export async function listWriteOffs(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    stockWriteOffs,
    stockWriteOffs.branchId,
    stockWriteOffs.createdAt,
    actor
  )) as Array<typeof stockWriteOffs.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(stockWriteOffLines)
    .where(inArray(stockWriteOffLines.writeOffId, headers.map((h) => h.id)));
  const byWo = groupByKey(lines, (l) => l.writeOffId);

  return headers.map((h) => ({
    id: h.id,
    writeOffNumber: h.writeOffNumber,
    branchId: h.branchId,
    reason: h.reason,
    status: h.status,
    notes: h.notes,
    createdByName: h.createdByName,
    createdAt: h.createdAt.toISOString(),
    lines: (byWo.get(h.id) ?? []).map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      totalValue: num(l.totalValue),
      notes: l.notes,
    })),
  }));
}

export async function createWriteOff(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof writeOffSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const woNumber = await nextDocNumber(tx, "WO", "WO-");

    const [wo] = await tx
      .insert(stockWriteOffs)
      .values({
        writeOffNumber: woNumber,
        branchId: data.branchId,
        reason: data.reason,
        status: "Posted",
        notes: data.notes,
        createdBy: actor.id,
        createdByName: actor.name,
      })
      .returning();

    let totalWriteOffVal = 0;

    for (const line of sortedLines) {
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

      const prodCost = num(prod.costPrice);
      const moved = await applyBranchStockMovement(tx, {
        branchId: data.branchId,
        productId: line.productId,
        qtyDelta: -line.quantity,
        fallbackCost: prodCost,
        movementType: "write_off",
        referenceType: "write_off",
        referenceId: wo.id,
        referenceNumber: wo.writeOffNumber,
        insufficientStockMessage: `Insufficient stock for ${prod.name}: requested ${line.quantity}`,
        notes: `${data.reason}${line.notes ? `: ${line.notes}` : ""}`,
        actorId: actor.id,
      });

      const unitCost = moved.movementCost;
      const totalValue = Math.abs(moved.totalValueDelta);
      totalWriteOffVal += totalValue;
      await tx.insert(stockWriteOffLines).values({
        writeOffId: wo.id,
        productId: line.productId,
        quantity: toNumeric(line.quantity, 4),
        unitCost: toNumeric(unitCost, 4),
        totalValue: toNumeric(totalValue, 4),
        notes: line.notes,
      });
    }

    if (totalWriteOffVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: data.branchId,
        sourceType: "write_off",
        sourceId: wo.id,
        referenceNumber: wo.writeOffNumber,
        memo: `Stock write-off ${wo.writeOffNumber} (${data.reason})`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "write_off_expense", debit: totalWriteOffVal },
          { mappingKey: "inventory_asset", credit: totalWriteOffVal },
        ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "write_off.created",
      entityType: "write_offs",
      entityId: wo.id,
      entityLabel: wo.writeOffNumber,
      details: { reason: data.reason, lineCount: sortedLines.length },
      ipAddress,
    });

    return wo;
  });
}
