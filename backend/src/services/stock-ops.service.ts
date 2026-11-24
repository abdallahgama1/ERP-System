import { encodeCursor, type CursorPageInfo, type SortDirection } from "@erp/shared";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
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
  type MovementType,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { checkApprovalRequired, createApprovalRequest } from "./approvals.service.ts";
import { postMappedJournal } from "./gl.service.ts";
import { consumeTrackedStock, linkConsumedAllocations, receiveTrackedStock } from "./lots-serials.service.ts";
import { buildKeysetCondition, groupByKey, listBranchScoped, parseCursorOrThrow } from "./query-helpers.ts";
import {
  actorCompanyId,
  applyBranchStockMovement,
  assertBranchInCompany,
  lockBranchProduct,
  type RequestActor,
} from "./stock-locks.ts";

export async function listMovements(
  db: AppDatabase,
  actor: RequestActor,
  query: {
    branchId?: string;
    productId?: string;
    movementType?: string;
    fromDate?: string;
    toDate?: string;
    q?: string;
    cursor?: string;
    limit?: string;
    sortDir?: string;
  }
) {
  const companyId = actorCompanyId(actor);
  const hasExplicitPagination = Boolean(query.cursor || query.limit);
  const limit = hasExplicitPagination
    ? Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "50", 10) || 50))
    : 200;
  const sortDir: SortDirection = query.sortDir === "asc" ? "asc" : "desc";
  const cursor = parseCursorOrThrow(query.cursor);

  const conditions: SQL[] = [eq(stockMovements.companyId, companyId)];
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    conditions.push(eq(stockMovements.branchId, query.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length === 0) {
      return { items: [], pageInfo: { nextCursor: null, hasMore: false, limit } satisfies CursorPageInfo };
    }
    conditions.push(inArray(stockMovements.branchId, actor.branchIds));
  }
  if (query.productId) conditions.push(eq(stockMovements.productId, query.productId));
  if (query.movementType && query.movementType !== "all") {
    conditions.push(eq(stockMovements.movementType, query.movementType as MovementType));
  }
  if (query.fromDate) conditions.push(gte(stockMovements.createdAt, new Date(query.fromDate)));
  if (query.toDate) conditions.push(lte(stockMovements.createdAt, new Date(query.toDate)));
  if (query.q?.trim()) {
    const pattern = `%${query.q.trim()}%`;
    conditions.push(
      or(ilike(stockMovements.referenceNumber, pattern), ilike(stockMovements.notes, pattern))!
    );
  }
  if (cursor) {
    conditions.push(buildKeysetCondition(stockMovements.createdAt, stockMovements.id, cursor, sortDir));
  }

  const orderDir = sortDir === "asc" ? asc : desc;
  const rawRows = await db
    .select()
    .from(stockMovements)
    .where(and(...conditions))
    .orderBy(orderDir(stockMovements.createdAt), orderDir(stockMovements.id))
    .limit(limit + 1);

  const hasMore = rawRows.length > limit;
  const rows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const last = rows[rows.length - 1];

  const items = rows.map((r) => ({
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

  const pageInfo: CursorPageInfo = {
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    hasMore,
    limit,
  };

  return { items, pageInfo };
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
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const [branch] = await tx
      .select()
      .from(branches)
      .where(and(eq(branches.id, data.branchId), eq(branches.companyId, companyId)))
      .limit(1);
    if (!branch) throw new AppError(404, "Branch not found", "NOT_FOUND");

    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const adjNumber = await nextDocNumber(tx, "ADJ", "ADJ-", null, companyId);

    const prepared: Array<{
      productId: string;
      prod: typeof products.$inferSelect;
      delta: number;
      unitCost: number;
      previousQty: number;
      notes: string;
      lotNumber?: string;
      manufactureDate?: string | null;
      expiryDate?: string | null;
      lotAllocations?: z.infer<typeof adjustmentSchema>["lines"][number]["lotAllocations"];
      serialNumbers?: string[];
    }> = [];
    let totalAbsImpact = 0;

    for (const line of sortedLines) {
      const [prod] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.companyId, companyId)))
        .limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");
      const prodFallback = num(prod.costPrice);
      const locked = await lockBranchProduct(tx, data.branchId, line.productId, prodFallback, companyId);
      const delta = line.newQty !== undefined ? line.newQty - locked.qtyOnHand : (line.qtyDelta ?? 0);
      if (delta === 0) continue;
      const unitCost = locked.avgCost > 0 ? locked.avgCost : prodFallback;
      totalAbsImpact += Math.abs(delta) * unitCost;
      prepared.push({
        productId: line.productId,
        prod,
        delta,
        unitCost,
        previousQty: locked.qtyOnHand,
        notes: line.notes,
        lotNumber: line.lotNumber,
        manufactureDate: line.manufactureDate,
        expiryDate: line.expiryDate,
        lotAllocations: line.lotAllocations,
        serialNumbers: line.serialNumbers,
      });
    }

    const needsApproval = Boolean(await checkApprovalRequired(tx, "stock_adjustment", totalAbsImpact, companyId));

    const [adj] = await tx
      .insert(stockAdjustments)
      .values({
        companyId,
        adjustmentNumber: adjNumber,
        branchId: data.branchId,
        reason: data.reason,
        status: needsApproval ? "Pending Approval" : "Posted",
        approvalStatus: needsApproval ? "pending" : "not_required",
        notes: data.notes,
        createdBy: actor.id,
        createdByName: actor.name,
      })
      .returning();

    let totalPosVal = 0;
    let totalNegVal = 0;

    for (const item of prepared) {
      if (needsApproval) {
        await tx.insert(stockAdjustmentLines).values({
          adjustmentId: adj.id,
          productId: item.productId,
          qtyDelta: toNumeric(item.delta, 4),
          unitCost: toNumeric(item.unitCost, 4),
          previousQty: toNumeric(item.previousQty, 4),
          newQty: toNumeric(Math.max(0, item.previousQty + item.delta), 4),
          notes: item.notes,
        });
        continue;
      }

      const consumed =
        item.delta < 0
          ? await consumeTrackedStock(tx, {
              companyId,
              product: item.prod,
              branchId: data.branchId,
              quantity: Math.abs(item.delta),
              lotAllocations: item.lotAllocations,
              serialNumbers: item.serialNumbers,
              allowExpired: true,
              serialNextStatus: "written_off",
            })
          : null;

      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: data.branchId,
        productId: item.productId,
        qtyDelta: item.delta,
        fallbackCost: item.unitCost,
        recomputeAvgCost: false,
        movementType: item.delta > 0 ? "adjustment_in" : "adjustment_out",
        movementUnitCost: consumed?.tracked ? consumed.unitCost : item.unitCost,
        referenceType: "adjustment",
        referenceId: adj.id,
        referenceNumber: adj.adjustmentNumber,
        insufficientStockMessage: `Insufficient stock for ${item.prod.name} (${item.prod.sku}): available ${item.previousQty}, attempted delta ${item.delta}`,
        notes: `${data.reason}${item.notes ? `: ${item.notes}` : ""}`,
        actorId: actor.id,
      });

      if (item.delta > 0) {
        await receiveTrackedStock(tx, {
          companyId,
          product: item.prod,
          branchId: data.branchId,
          quantity: item.delta,
          unitCost: item.unitCost,
          movementId: moved.movementId,
          lotNumber: item.lotNumber,
          manufactureDate: item.manufactureDate,
          expiryDate: item.expiryDate,
          serialNumbers: item.serialNumbers,
          receivedFromType: "adjustment",
          receivedFromId: adj.id,
          notes: `${data.reason}${item.notes ? `: ${item.notes}` : ""}`,
        });
      } else if (consumed?.tracked) {
        await linkConsumedAllocations(tx, moved.movementId, consumed.allocations);
      }

      if (moved.totalValueDelta > 0) totalPosVal += moved.totalValueDelta;
      else totalNegVal += Math.abs(moved.totalValueDelta);

      await tx.insert(stockAdjustmentLines).values({
        adjustmentId: adj.id,
        productId: item.productId,
        qtyDelta: toNumeric(item.delta, 4),
        unitCost: toNumeric(item.unitCost, 4),
        previousQty: toNumeric(moved.previousQty, 4),
        newQty: toNumeric(moved.newQty, 4),
        notes: item.notes,
      });
    }

    if (needsApproval) {
      await createApprovalRequest(tx, {
        entityType: "stock_adjustment",
        entityId: adj.id,
        entityNumber: adj.adjustmentNumber,
        branchId: data.branchId,
        amount: totalAbsImpact,
        actor,
        ipAddress,
      });
    } else {
      const netInvDelta = totalPosVal - totalNegVal;
      if (Math.abs(netInvDelta) > 0.0001) {
        const absVal = Math.abs(netInvDelta);
        await postMappedJournal(tx, {
          companyId,
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
    }

    await writeAuditLog(tx, {
      companyId,
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
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);
    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const woNumber = await nextDocNumber(tx, "WO", "WO-", null, companyId);

    const prepared: Array<{
      productId: string;
      prod: typeof products.$inferSelect;
      quantity: number;
      unitCost: number;
      notes: string;
      lotAllocations?: z.infer<typeof writeOffSchema>["lines"][number]["lotAllocations"];
      serialNumbers?: string[];
    }> = [];
    let estimatedTotal = 0;
    for (const line of sortedLines) {
      const [prod] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.companyId, companyId)))
        .limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");
      const locked = await lockBranchProduct(tx, data.branchId, line.productId, num(prod.costPrice), companyId);
      const unitCost = locked.avgCost > 0 ? locked.avgCost : num(prod.costPrice);
      estimatedTotal += line.quantity * unitCost;
      prepared.push({
        productId: line.productId,
        prod,
        quantity: line.quantity,
        unitCost,
        notes: line.notes,
        lotAllocations: line.lotAllocations,
        serialNumbers: line.serialNumbers,
      });
    }

    const needsApproval = Boolean(await checkApprovalRequired(tx, "stock_write_off", estimatedTotal, companyId));

    const [wo] = await tx
      .insert(stockWriteOffs)
      .values({
        companyId,
        writeOffNumber: woNumber,
        branchId: data.branchId,
        reason: data.reason,
        status: needsApproval ? "Pending Approval" : "Posted",
        approvalStatus: needsApproval ? "pending" : "not_required",
        notes: data.notes,
        createdBy: actor.id,
        createdByName: actor.name,
      })
      .returning();

    let totalWriteOffVal = 0;

    for (const item of prepared) {
      if (needsApproval) {
        await tx.insert(stockWriteOffLines).values({
          writeOffId: wo.id,
          productId: item.productId,
          quantity: toNumeric(item.quantity, 4),
          unitCost: toNumeric(item.unitCost, 4),
          totalValue: toNumeric(item.quantity * item.unitCost, 4),
          notes: item.notes,
        });
        continue;
      }

      const tracked = await consumeTrackedStock(tx, {
        companyId,
        product: item.prod,
        branchId: data.branchId,
        quantity: item.quantity,
        lotAllocations: item.lotAllocations,
        serialNumbers: item.serialNumbers,
        allowExpired: true,
        serialNextStatus: "written_off",
      });

      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: data.branchId,
        productId: item.productId,
        qtyDelta: -item.quantity,
        fallbackCost: item.unitCost,
        movementType: "write_off",
        movementUnitCost: tracked.tracked ? tracked.unitCost : undefined,
        referenceType: "write_off",
        referenceId: wo.id,
        referenceNumber: wo.writeOffNumber,
        insufficientStockMessage: `Insufficient stock for ${item.prod.name}: requested ${item.quantity}`,
        notes: `${data.reason}${item.notes ? `: ${item.notes}` : ""}`,
        actorId: actor.id,
      });

      if (tracked.tracked) {
        await linkConsumedAllocations(tx, moved.movementId, tracked.allocations);
      }

      const unitCost = tracked.tracked ? tracked.unitCost : moved.movementCost;
      const totalValue = tracked.tracked ? tracked.totalCost : Math.abs(moved.totalValueDelta);
      totalWriteOffVal += totalValue;
      await tx.insert(stockWriteOffLines).values({
        writeOffId: wo.id,
        productId: item.productId,
        quantity: toNumeric(item.quantity, 4),
        unitCost: toNumeric(unitCost, 4),
        totalValue: toNumeric(totalValue, 4),
        notes: item.notes,
      });
    }

    if (needsApproval) {
      await createApprovalRequest(tx, {
        entityType: "stock_write_off",
        entityId: wo.id,
        entityNumber: wo.writeOffNumber,
        branchId: data.branchId,
        amount: estimatedTotal,
        actor,
        ipAddress,
      });
    } else if (totalWriteOffVal > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
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
      companyId,
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
