import {
  roundCurrency,
  type cancelWorkOrderSchema,
  type completeWorkOrderSchema,
  type createBomSchema,
  type createWorkOrderSchema,
  type issueWorkOrderSchema,
  type updateBomSchema,
} from "@erp/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  billsOfMaterials,
  bomComponents,
  branches,
  products,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal } from "./gl.service.ts";
import { consumeTrackedStock, linkConsumedAllocations, receiveTrackedStock } from "./lots-serials.service.ts";
import { groupByKey, listBranchScoped } from "./query-helpers.ts";
import {
  actorCompanyId,
  applyBranchStockMovement,
  assertBranchInCompany,
  type RequestActor,
} from "./stock-locks.ts";

async function assertNoBomCycle(
  tx: DbOrTx,
  companyId: string,
  finishedProductId: string,
  componentProductIds: string[],
  ignoreBomId?: string
): Promise<void> {
  if (componentProductIds.includes(finishedProductId)) {
    throw new AppError(400, "A product cannot be a component of its own Bill of Materials", "BOM_CYCLE_DETECTED");
  }

  const allBoms = await tx
    .select({ id: billsOfMaterials.id, productId: billsOfMaterials.productId })
    .from(billsOfMaterials)
    .where(eq(billsOfMaterials.companyId, companyId));
  const allComps = allBoms.length
    ? await tx
        .select()
        .from(bomComponents)
        .where(inArray(bomComponents.bomId, allBoms.map((b) => b.id)))
    : [];

  const adj = new Map<string, Set<string>>();
  for (const b of allBoms) {
    if (ignoreBomId && b.id === ignoreBomId) continue;
    const set = adj.get(b.productId) ?? new Set<string>();
    for (const c of allComps) {
      if (c.bomId === b.id) set.add(c.componentProductId);
    }
    adj.set(b.productId, set);
  }

  const proposed = adj.get(finishedProductId) ?? new Set<string>();
  for (const cid of componentProductIds) proposed.add(cid);
  adj.set(finishedProductId, proposed);

  // DFS from every proposed component: if we can reach finishedProductId, there is a cycle
  const visited = new Set<string>();
  const stack = [...componentProductIds];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === finishedProductId) {
      throw new AppError(400, "Circular Bill of Materials dependency detected", "BOM_CYCLE_DETECTED");
    }
    if (visited.has(curr)) continue;
    visited.add(curr);
    const nexts = adj.get(curr);
    if (nexts) {
      for (const n of nexts) {
        if (!visited.has(n)) stack.push(n);
      }
    }
  }
}

export async function listBoms(db: AppDatabase, actor?: RequestActor) {
  const companyId = actorCompanyId(actor);
  const boms = await db
    .select()
    .from(billsOfMaterials)
    .where(eq(billsOfMaterials.companyId, companyId))
    .orderBy(desc(billsOfMaterials.createdAt));
  if (boms.length === 0) return [];

  const comps = await db
    .select()
    .from(bomComponents)
    .where(inArray(bomComponents.bomId, boms.map((b) => b.id)));

  const productIds = Array.from(
    new Set([...boms.map((b) => b.productId), ...comps.map((c) => c.componentProductId)])
  );
  const prodRows = productIds.length
    ? await db
        .select()
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
    : [];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  const compByBom = groupByKey(comps, (c) => c.bomId);

  return boms.map((b) => {
    const fg = prodMap.get(b.productId);
    return {
      id: b.id,
      bomNumber: b.bomNumber,
      productId: b.productId,
      productName: fg?.name ?? "",
      productSku: fg?.sku ?? "",
      name: b.name,
      outputQty: num(b.outputQty),
      isActive: b.isActive,
      notes: b.notes,
      createdAt: b.createdAt.toISOString(),
      components: (compByBom.get(b.id) ?? []).map((c) => {
        const cp = prodMap.get(c.componentProductId);
        return {
          id: c.id,
          componentProductId: c.componentProductId,
          componentName: cp?.name ?? "",
          componentSku: cp?.sku ?? "",
          unitCost: cp ? num(cp.costPrice) : 0,
          quantity: num(c.quantity),
          scrapPercent: num(c.scrapPercent),
          notes: c.notes,
        };
      }),
    };
  });
}

export async function createBom(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createBomSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [fg] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, data.productId), eq(products.companyId, companyId)))
      .limit(1);
    if (!fg) throw new AppError(404, "Finished product not found", "NOT_FOUND");

    const componentIds = data.components.map((c) => c.componentProductId);
    const existingComps = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, componentIds)));
    if (existingComps.length !== new Set(componentIds).size) {
      throw new AppError(404, "One or more BOM component products were not found", "NOT_FOUND");
    }

    await assertNoBomCycle(tx, companyId, data.productId, componentIds);

    const bomNumber = await nextDocNumber(tx, "BOM", "BOM-", undefined, companyId);
    const [bom] = await tx
      .insert(billsOfMaterials)
      .values({
        companyId,
        bomNumber,
        productId: data.productId,
        name: data.name,
        outputQty: toNumeric(data.outputQty, 4),
        isActive: data.isActive,
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(bomComponents).values(
      data.components.map((c) => ({
        bomId: bom.id,
        componentProductId: c.componentProductId,
        quantity: toNumeric(c.quantity, 4),
        scrapPercent: toNumeric(c.scrapPercent, 4),
        notes: c.notes,
      }))
    );

    await tx
      .update(products)
      .set({ hasBom: true, updatedAt: new Date() })
      .where(and(eq(products.id, data.productId), eq(products.companyId, companyId)));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "bom.created",
      entityType: "manufacturing",
      entityId: bom.id,
      entityLabel: `${bom.bomNumber} (${bom.name})`,
      details: { productId: data.productId, componentCount: data.components.length },
      ipAddress,
    });

    return bom;
  });
}

export async function updateBom(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updateBomSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(billsOfMaterials)
      .where(and(eq(billsOfMaterials.id, id), eq(billsOfMaterials.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "BOM not found", "NOT_FOUND");

    if (data.components) {
      const componentIds = data.components.map((c) => c.componentProductId);
      const existingComps = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, componentIds)));
      if (existingComps.length !== new Set(componentIds).size) {
        throw new AppError(404, "One or more BOM component products were not found", "NOT_FOUND");
      }
      await assertNoBomCycle(tx, companyId, current.productId, componentIds, id);
    }

    const [updated] = await tx
      .update(billsOfMaterials)
      .set({
        name: data.name ?? current.name,
        outputQty: data.outputQty !== undefined ? toNumeric(data.outputQty, 4) : current.outputQty,
        isActive: data.isActive ?? current.isActive,
        notes: data.notes ?? current.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(billsOfMaterials.id, id), eq(billsOfMaterials.companyId, companyId)))
      .returning();

    if (data.components) {
      await tx.delete(bomComponents).where(eq(bomComponents.bomId, id));
      await tx.insert(bomComponents).values(
        data.components.map((c) => ({
          bomId: id,
          componentProductId: c.componentProductId,
          quantity: toNumeric(c.quantity, 4),
          scrapPercent: toNumeric(c.scrapPercent, 4),
          notes: c.notes,
        }))
      );
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "bom.updated",
      entityType: "manufacturing",
      entityId: id,
      entityLabel: updated.bomNumber,
      ipAddress,
    });

    return updated;
  });
}

export async function listWorkOrders(db: AppDatabase, actor: RequestActor) {
  const companyId = actorCompanyId(actor);
  const headers = (await listBranchScoped(
    db,
    workOrders,
    workOrders.branchId,
    workOrders.createdAt,
    actor
  )) as Array<typeof workOrders.$inferSelect>;
  if (headers.length === 0) return [];

  const mats = await db
    .select()
    .from(workOrderMaterials)
    .where(inArray(workOrderMaterials.workOrderId, headers.map((h) => h.id)));

  const productIds = Array.from(
    new Set([...headers.map((h) => h.productId), ...mats.map((m) => m.componentProductId)])
  );
  const branchIds = Array.from(new Set(headers.map((h) => h.branchId)));
  const bomIds = Array.from(new Set(headers.map((h) => h.bomId)));

  const [prodRows, branchRows, bomRows] = await Promise.all([
    productIds.length
      ? db.select().from(products).where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : Promise.resolve([]),
    branchIds.length
      ? db.select().from(branches).where(and(eq(branches.companyId, companyId), inArray(branches.id, branchIds)))
      : Promise.resolve([]),
    bomIds.length
      ? db
          .select()
          .from(billsOfMaterials)
          .where(and(eq(billsOfMaterials.companyId, companyId), inArray(billsOfMaterials.id, bomIds)))
      : Promise.resolve([]),
  ]);

  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  const branchMap = new Map(branchRows.map((b) => [b.id, b]));
  const bomMap = new Map(bomRows.map((b) => [b.id, b]));
  const matsByWo = groupByKey(mats, (m) => m.workOrderId);

  return headers.map((h) => {
    const fg = prodMap.get(h.productId);
    const br = branchMap.get(h.branchId);
    const bm = bomMap.get(h.bomId);
    const wipIssued = num(h.wipValueIssued);
    const wipAbsorbed = num(h.wipValueAbsorbed);
    return {
      id: h.id,
      woNumber: h.woNumber,
      bomId: h.bomId,
      bomNumber: bm?.bomNumber ?? "",
      bomName: bm?.name ?? "",
      branchId: h.branchId,
      branchName: br?.name ?? "",
      productId: h.productId,
      productName: fg?.name ?? "",
      productSku: fg?.sku ?? "",
      productTrackingMode: fg?.trackingMode ?? "none",
      plannedQty: num(h.plannedQty),
      completedQty: num(h.completedQty),
      status: h.status,
      wipValueIssued: wipIssued,
      wipValueAbsorbed: wipAbsorbed,
      wipBalance: roundCurrency(wipIssued - wipAbsorbed, 4),
      notes: h.notes,
      startedAt: h.startedAt?.toISOString() ?? null,
      completedAt: h.completedAt?.toISOString() ?? null,
      createdAt: h.createdAt.toISOString(),
      materials: (matsByWo.get(h.id) ?? []).map((m) => {
        const cp = prodMap.get(m.componentProductId);
        return {
          id: m.id,
          componentProductId: m.componentProductId,
          componentName: cp?.name ?? "",
          componentSku: cp?.sku ?? "",
          trackingMode: cp?.trackingMode ?? "none",
          requiredQty: num(m.requiredQty),
          issuedQty: num(m.issuedQty),
          unitCostSnapshot: num(m.unitCostSnapshot),
        };
      }),
    };
  });
}

export async function createWorkOrder(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createWorkOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);

    const [bom] = await tx
      .select()
      .from(billsOfMaterials)
      .where(and(eq(billsOfMaterials.id, data.bomId), eq(billsOfMaterials.companyId, companyId)))
      .limit(1);
    if (!bom) throw new AppError(404, "BOM not found", "NOT_FOUND");
    if (!bom.isActive) throw new AppError(400, "Cannot create a work order from an inactive BOM", "INACTIVE_BOM");

    const comps = await tx.select().from(bomComponents).where(eq(bomComponents.bomId, bom.id));
    if (comps.length === 0) throw new AppError(400, "BOM has no components", "EMPTY_BOM");

    const woNumber = await nextDocNumber(tx, "MFG", "MO-", undefined, companyId);
    const scale = data.plannedQty / Math.max(0.0001, num(bom.outputQty));

    const [wo] = await tx
      .insert(workOrders)
      .values({
        companyId,
        woNumber,
        bomId: bom.id,
        branchId: data.branchId,
        productId: bom.productId,
        plannedQty: toNumeric(data.plannedQty, 4),
        completedQty: "0",
        status: data.status,
        wipValueIssued: "0",
        wipValueAbsorbed: "0",
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(workOrderMaterials).values(
      comps.map((c) => {
        const required = roundCurrency(num(c.quantity) * (1 + num(c.scrapPercent) / 100) * scale, 4);
        return {
          workOrderId: wo.id,
          componentProductId: c.componentProductId,
          requiredQty: toNumeric(required, 4),
          issuedQty: "0",
          unitCostSnapshot: "0",
        };
      })
    );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "work_order.created",
      entityType: "manufacturing",
      entityId: wo.id,
      entityLabel: wo.woNumber,
      details: { bomNumber: bom.bomNumber, plannedQty: data.plannedQty },
      ipAddress,
    });

    return wo;
  });
}

export async function issueWorkOrderMaterials(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof issueWorkOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      wo_number: string;
      branch_id: string;
      status: string;
      wip_value_issued: string;
      started_at: Date | null;
    }>(sql`
      SELECT id, wo_number, branch_id, status, wip_value_issued, started_at
      FROM work_orders WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE
    `);
    const wo = rows[0];
    if (!wo) throw new AppError(404, "Work order not found", "NOT_FOUND");
    assertBranchAccess(actor, wo.branch_id);

    if (wo.status === "Completed" || wo.status === "Cancelled") {
      throw new AppError(400, `Cannot issue materials to a ${wo.status} work order`, "INVALID_STATUS");
    }

    const mats = await tx
      .select()
      .from(workOrderMaterials)
      .where(eq(workOrderMaterials.workOrderId, id))
      .orderBy(asc(workOrderMaterials.componentProductId));

    const issuePlan =
      data.lines && data.lines.length > 0
        ? data.lines
        : mats
            .map((m) => ({
              componentProductId: m.componentProductId,
              quantity: roundCurrency(num(m.requiredQty) - num(m.issuedQty), 4),
              lotAllocations: undefined,
              serialNumbers: undefined,
            }))
            .filter((l) => l.quantity > 0.0001);

    if (issuePlan.length === 0) {
      throw new AppError(400, "All required materials have already been issued", "NOTHING_TO_ISSUE");
    }

    const sortedPlan = [...issuePlan].sort((a, b) => a.componentProductId.localeCompare(b.componentProductId));
    let totalIssuedVal = 0;

    for (const line of sortedPlan) {
      const matRow = mats.find((m) => m.componentProductId === line.componentProductId);
      if (!matRow) {
        throw new AppError(400, `Component ${line.componentProductId} is not part of this work order`, "INVALID_COMPONENT");
      }

      const [prod] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.componentProductId), eq(products.companyId, companyId)))
        .limit(1);
      if (!prod) throw new AppError(404, "Component product not found", "NOT_FOUND");

      const tracked = await consumeTrackedStock(tx, {
        product: prod,
        branchId: wo.branch_id,
        quantity: line.quantity,
        lotAllocations: line.lotAllocations,
        serialNumbers: line.serialNumbers,
        serialNextStatus: "consumed",
        workOrderId: wo.id,
      });

      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: wo.branch_id,
        productId: line.componentProductId,
        qtyDelta: -line.quantity,
        fallbackCost: num(prod.costPrice),
        movementType: "work_order_consume",
        movementUnitCost: tracked.tracked ? tracked.unitCost : undefined,
        referenceType: "work_order",
        referenceId: wo.id,
        referenceNumber: wo.wo_number,
        insufficientStockMessage: `Insufficient raw material stock for ${prod.name} (${prod.sku}): requested ${line.quantity}`,
        notes: `Issued to work order ${wo.wo_number}${data.notes ? ` — ${data.notes}` : ""}`,
        actorId: actor.id,
      });

      if (tracked.tracked) {
        await linkConsumedAllocations(tx, moved.movementId, tracked.allocations);
      }

      const lineVal = tracked.tracked ? tracked.totalCost : Math.abs(moved.totalValueDelta);
      totalIssuedVal = roundCurrency(totalIssuedVal + lineVal, 4);

      const prevIssuedQty = num(matRow.issuedQty);
      const prevIssuedVal = prevIssuedQty * num(matRow.unitCostSnapshot);
      const nextIssuedQty = roundCurrency(prevIssuedQty + line.quantity, 4);
      const nextUnitCost = nextIssuedQty > 0 ? roundCurrency((prevIssuedVal + lineVal) / nextIssuedQty, 4) : moved.movementCost;

      await tx
        .update(workOrderMaterials)
        .set({
          issuedQty: toNumeric(nextIssuedQty, 4),
          unitCostSnapshot: toNumeric(nextUnitCost, 4),
        })
        .where(eq(workOrderMaterials.id, matRow.id));
    }

    const nextWipIssued = roundCurrency(num(wo.wip_value_issued) + totalIssuedVal, 4);
    const now = new Date();

    const [updated] = await tx
      .update(workOrders)
      .set({
        status: "In Progress",
        wipValueIssued: toNumeric(nextWipIssued, 4),
        startedAt: wo.started_at ?? now,
        updatedAt: now,
      })
      .where(and(eq(workOrders.id, id), eq(workOrders.companyId, companyId)))
      .returning();

    if (totalIssuedVal > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: wo.branch_id,
        sourceType: "work_order_issue",
        sourceId: wo.id,
        referenceNumber: wo.wo_number,
        memo: `Raw materials issued to ${wo.wo_number}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "wip_inventory", debit: totalIssuedVal },
          { mappingKey: "inventory_asset", credit: totalIssuedVal },
        ],
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: wo.branch_id,
      action: "work_order.materials_issued",
      entityType: "manufacturing",
      entityId: wo.id,
      entityLabel: wo.wo_number,
      details: { issuedValue: totalIssuedVal },
      ipAddress,
    });

    return updated;
  });
}

export async function completeWorkOrder(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof completeWorkOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      wo_number: string;
      branch_id: string;
      product_id: string;
      planned_qty: string;
      completed_qty: string;
      status: string;
      wip_value_issued: string;
      wip_value_absorbed: string;
    }>(sql`
      SELECT id, wo_number, branch_id, product_id, planned_qty, completed_qty, status, wip_value_issued, wip_value_absorbed
      FROM work_orders WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE
    `);
    const wo = rows[0];
    if (!wo) throw new AppError(404, "Work order not found", "NOT_FOUND");
    assertBranchAccess(actor, wo.branch_id);

    if (wo.status === "Completed" || wo.status === "Cancelled") {
      throw new AppError(400, `Cannot complete a ${wo.status} work order`, "INVALID_STATUS");
    }

    const plannedQty = num(wo.planned_qty);
    const completedQty = num(wo.completed_qty);
    const remainingQty = roundCurrency(plannedQty - completedQty, 4);
    if (data.qtyCompleted > remainingQty + 0.0001) {
      throw new AppError(
        400,
        `Completion quantity (${data.qtyCompleted}) exceeds remaining planned quantity (${remainingQty})`,
        "OVER_COMPLETION"
      );
    }

    const wipIssued = num(wo.wip_value_issued);
    const wipAbsorbed = num(wo.wip_value_absorbed);
    const wipRemaining = roundCurrency(wipIssued - wipAbsorbed, 4);
    if (wipIssued <= 0.0001) {
      throw new AppError(400, "Issue raw materials to WIP before completing finished goods", "WIP_NOT_ISSUED");
    }

    const isFinal = Math.abs(remainingQty - data.qtyCompleted) <= 0.0001;
    const absorbedNow = isFinal
      ? wipRemaining
      : roundCurrency(wipRemaining * (data.qtyCompleted / remainingQty), 4);
    const unitCost = data.qtyCompleted > 0 ? roundCurrency(absorbedNow / data.qtyCompleted, 4) : 0;

    const [fg] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, wo.product_id), eq(products.companyId, companyId)))
      .limit(1);
    if (!fg) throw new AppError(404, "Finished good product not found", "NOT_FOUND");

    const moved = await applyBranchStockMovement(tx, {
      companyId,
      branchId: wo.branch_id,
      productId: wo.product_id,
      qtyDelta: data.qtyCompleted,
      unitCostForWmac: unitCost,
      fallbackCost: unitCost,
      recomputeAvgCost: true,
      movementType: "work_order_produce",
      movementUnitCost: unitCost,
      referenceType: "work_order",
      referenceId: wo.id,
      referenceNumber: wo.wo_number,
      notes: `Finished goods produced from ${wo.wo_number}${data.notes ? ` — ${data.notes}` : ""}`,
      actorId: actor.id,
    });

    await receiveTrackedStock(tx, {
      product: fg,
      branchId: wo.branch_id,
      quantity: data.qtyCompleted,
      unitCost,
      movementId: moved.movementId,
      lotNumber: data.lotNumber,
      manufactureDate: data.manufactureDate,
      expiryDate: data.expiryDate,
      serialNumbers: data.serialNumbers,
      receivedFromType: "work_order",
      receivedFromId: wo.id,
      workOrderId: wo.id,
      notes: `Produced by ${wo.wo_number}`,
    });

    const now = new Date();
    const nextCompleted = roundCurrency(completedQty + data.qtyCompleted, 4);
    const nextAbsorbed = roundCurrency(wipAbsorbed + absorbedNow, 4);

    const [updated] = await tx
      .update(workOrders)
      .set({
        completedQty: toNumeric(nextCompleted, 4),
        wipValueAbsorbed: toNumeric(nextAbsorbed, 4),
        status: isFinal ? "Completed" : "In Progress",
        completedAt: isFinal ? now : null,
        updatedAt: now,
      })
      .where(and(eq(workOrders.id, id), eq(workOrders.companyId, companyId)))
      .returning();

    if (absorbedNow > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: wo.branch_id,
        sourceType: "work_order_complete",
        sourceId: wo.id,
        referenceNumber: wo.wo_number,
        memo: `Finished goods completion for ${wo.wo_number} (${data.qtyCompleted} units)`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "inventory_asset", debit: absorbedNow },
          { mappingKey: "wip_inventory", credit: absorbedNow },
        ],
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: wo.branch_id,
      action: isFinal ? "work_order.completed" : "work_order.partially_completed",
      entityType: "manufacturing",
      entityId: wo.id,
      entityLabel: wo.wo_number,
      details: { qtyCompleted: data.qtyCompleted, absorbedWip: absorbedNow, unitCost },
      ipAddress,
    });

    return updated;
  });
}

export async function cancelWorkOrder(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof cancelWorkOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      wo_number: string;
      branch_id: string;
      status: string;
      wip_value_issued: string;
      wip_value_absorbed: string;
    }>(sql`
      SELECT id, wo_number, branch_id, status, wip_value_issued, wip_value_absorbed
      FROM work_orders WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE
    `);
    const wo = rows[0];
    if (!wo) throw new AppError(404, "Work order not found", "NOT_FOUND");
    assertBranchAccess(actor, wo.branch_id);

    if (wo.status === "Completed" || wo.status === "Cancelled") {
      throw new AppError(400, `Cannot cancel a ${wo.status} work order`, "INVALID_STATUS");
    }

    const wipIssued = num(wo.wip_value_issued);
    const wipAbsorbed = num(wo.wip_value_absorbed);
    const wipRemaining = roundCurrency(wipIssued - wipAbsorbed, 4);

    if (wipRemaining > 0.0001 && wipIssued > 0.0001) {
      const returnRatio = wipRemaining / wipIssued;
      const mats = await tx
        .select()
        .from(workOrderMaterials)
        .where(eq(workOrderMaterials.workOrderId, id))
        .orderBy(asc(workOrderMaterials.componentProductId));

      for (const m of mats) {
        const issued = num(m.issuedQty);
        if (issued <= 0.0001) continue;
        const returnQty = roundCurrency(issued * returnRatio, 4);
        if (returnQty <= 0.0001) continue;

        await applyBranchStockMovement(tx, {
          companyId,
          branchId: wo.branch_id,
          productId: m.componentProductId,
          qtyDelta: returnQty,
          unitCostForWmac: num(m.unitCostSnapshot),
          fallbackCost: num(m.unitCostSnapshot),
          recomputeAvgCost: true,
          movementType: "adjustment_in",
          movementUnitCost: num(m.unitCostSnapshot),
          referenceType: "work_order_cancel",
          referenceId: wo.id,
          referenceNumber: wo.wo_number,
          notes: `Returned unused material from cancelled ${wo.wo_number}: ${data.reason}`,
          actorId: actor.id,
        });
      }

      await postMappedJournal(tx, {
        companyId,
        branchId: wo.branch_id,
        sourceType: "work_order_cancel",
        sourceId: wo.id,
        referenceNumber: wo.wo_number,
        memo: `Reversed unabsorbed WIP for cancelled ${wo.wo_number}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "inventory_asset", debit: wipRemaining },
          { mappingKey: "wip_inventory", credit: wipRemaining },
        ],
      });
    }

    const [updated] = await tx
      .update(workOrders)
      .set({
        status: "Cancelled",
        wipValueAbsorbed: toNumeric(wipIssued, 4),
        notes: `${data.reason}`,
        updatedAt: new Date(),
      })
      .where(and(eq(workOrders.id, id), eq(workOrders.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: wo.branch_id,
      action: "work_order.cancelled",
      entityType: "manufacturing",
      entityId: wo.id,
      entityLabel: wo.wo_number,
      details: { reason: data.reason, returnedWip: wipRemaining },
      ipAddress,
    });

    return updated;
  });
}
