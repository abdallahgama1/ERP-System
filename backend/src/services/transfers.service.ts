import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { createTransferSchema, receiveTransferSchema } from "@erp/shared";
import { products, stockTransferLines, stockTransfers } from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { checkApprovalRequired, createApprovalRequest } from "./approvals.service.ts";
import { postMappedJournal } from "./gl.service.ts";
import { consumeTrackedStock, linkConsumedAllocations, receiveTransferredTrackedStock } from "./lots-serials.service.ts";
import { groupByKey } from "./query-helpers.ts";
import {
  actorCompanyId,
  applyBranchStockMovement,
  assertBranchInCompany,
  lockBranchProduct,
  type RequestActor,
} from "./stock-locks.ts";

export async function listTransfers(db: AppDatabase, actor: RequestActor) {
  const companyId = actorCompanyId(actor);
  const headers =
    actor.role === "admin" || actor.branchScopeMode === "all"
      ? await db
          .select()
          .from(stockTransfers)
          .where(eq(stockTransfers.companyId, companyId))
          .orderBy(desc(stockTransfers.createdAt))
      : actor.branchIds.length === 0
        ? []
        : await db
            .select()
            .from(stockTransfers)
            .where(
              and(
                eq(stockTransfers.companyId, companyId),
                or(inArray(stockTransfers.fromBranchId, actor.branchIds), inArray(stockTransfers.toBranchId, actor.branchIds))
              )
            )
            .orderBy(desc(stockTransfers.createdAt));

  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(stockTransferLines)
    .where(inArray(stockTransferLines.transferId, headers.map((h) => h.id)));
  const byTr = groupByKey(lines, (l) => l.transferId);

  return headers.map((t) => ({
    id: t.id,
    transferNumber: t.transferNumber,
    fromBranchId: t.fromBranchId,
    toBranchId: t.toBranchId,
    status: t.status,
    shortageResolution: t.shortageResolution,
    notes: t.notes,
    createdByName: t.createdByName,
    shippedAt: t.shippedAt?.toISOString() ?? null,
    receivedAt: t.receivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    lines: (byTr.get(t.id) ?? []).map((l) => ({
      id: l.id,
      productId: l.productId,
      qtySent: num(l.qtySent),
      qtyReceived: num(l.qtyReceived),
      unitCost: num(l.unitCost),
      notes: l.notes,
    })),
  }));
}

export async function createTransfer(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createTransferSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  if (data.fromBranchId === data.toBranchId) {
    throw new AppError(400, "Source and destination branches must be different", "SAME_BRANCH_TRANSFER");
  }
  assertBranchAccess(actor, data.fromBranchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.fromBranchId, companyId);
    await assertBranchInCompany(tx, data.toBranchId, companyId);

    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const transferNumber = await nextDocNumber(tx, "TRF", "TRF-", null, companyId);
    const wantsDispatch = data.status === "In Transit";

    let estimatedVal = 0;
    const prodMap = new Map<string, { prod: typeof products.$inferSelect; cost: number }>();
    for (const line of sortedLines) {
      const [prod] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.companyId, companyId)))
        .limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");
      const locked = await lockBranchProduct(tx, data.fromBranchId, line.productId, num(prod.costPrice), companyId);
      const unitCost = locked.avgCost > 0 ? locked.avgCost : num(prod.costPrice);
      prodMap.set(line.productId, { prod, cost: unitCost });
      estimatedVal += line.quantity * unitCost;
    }

    const needsApproval =
      wantsDispatch && Boolean(await checkApprovalRequired(tx, "stock_transfer", estimatedVal, companyId));
    const isDispatching = wantsDispatch && !needsApproval;

    const [tr] = await tx
      .insert(stockTransfers)
      .values({
        companyId,
        transferNumber,
        fromBranchId: data.fromBranchId,
        toBranchId: data.toBranchId,
        status: isDispatching ? "In Transit" : "Draft",
        approvalStatus: needsApproval ? "pending" : "not_required",
        notes: data.notes,
        createdBy: actor.id,
        createdByName: actor.name,
        shippedAt: isDispatching ? new Date() : null,
      })
      .returning();

    let totalDispatchedVal = 0;

    for (const line of sortedLines) {
      const meta = prodMap.get(line.productId)!;
      let unitCost = meta.cost;
      if (isDispatching) {
        const tracked = await consumeTrackedStock(tx, {
          companyId,
          product: meta.prod,
          branchId: data.fromBranchId,
          quantity: line.quantity,
          lotAllocations: line.lotAllocations,
          serialNumbers: line.serialNumbers,
          serialNextStatus: "in_transit",
        });

        const moved = await applyBranchStockMovement(tx, {
          companyId,
          branchId: data.fromBranchId,
          productId: line.productId,
          qtyDelta: -line.quantity,
          fallbackCost: unitCost,
          movementType: "transfer_out",
          movementUnitCost: tracked.tracked ? tracked.unitCost : undefined,
          referenceType: "transfer",
          referenceId: tr.id,
          referenceNumber: tr.transferNumber,
          insufficientStockMessage: `Insufficient source stock for ${meta.prod.name}: requested ${line.quantity}`,
          notes: `Dispatched transfer ${tr.transferNumber}`,
          actorId: actor.id,
        });
        if (tracked.tracked) {
          await linkConsumedAllocations(tx, moved.movementId, tracked.allocations);
        }
        unitCost = tracked.tracked ? tracked.unitCost : moved.movementCost;
        totalDispatchedVal += tracked.tracked ? tracked.totalCost : Math.abs(moved.totalValueDelta);
      }

      await tx.insert(stockTransferLines).values({
        transferId: tr.id,
        productId: line.productId,
        qtySent: toNumeric(line.quantity, 4),
        qtyReceived: "0",
        unitCost: toNumeric(unitCost, 4),
        notes: line.notes,
      });
    }

    if (needsApproval) {
      await createApprovalRequest(tx, {
        entityType: "stock_transfer",
        entityId: tr.id,
        entityNumber: tr.transferNumber,
        branchId: data.fromBranchId,
        amount: estimatedVal,
        actor,
        ipAddress,
      });
    }

    if (isDispatching && totalDispatchedVal > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: data.fromBranchId,
        sourceType: "stock_transfer",
        sourceId: tr.id,
        referenceNumber: tr.transferNumber,
        memo: `Dispatched transfer ${tr.transferNumber} to branch`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "in_transit_inventory", debit: totalDispatchedVal, branchId: data.fromBranchId },
          { mappingKey: "inventory_asset", credit: totalDispatchedVal, branchId: data.fromBranchId },
        ],
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.fromBranchId,
      action: isDispatching ? "transfer.dispatched" : "transfer.draft_created",
      entityType: "transfers",
      entityId: tr.id,
      entityLabel: tr.transferNumber,
      ipAddress,
    });

    return tr;
  });
}

export async function dispatchTransfer(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      transfer_number: string;
      from_branch_id: string;
      status: string;
    }>(
      sql`SELECT id, transfer_number, from_branch_id, status FROM stock_transfers WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`
    );
    const tr = rows[0];
    if (!tr) throw new AppError(404, "Transfer not found", "NOT_FOUND");
    assertBranchAccess(actor, tr.from_branch_id);

    if (tr.status !== "Draft") {
      throw new AppError(400, "Only Draft transfers can be dispatched", "INVALID_STATUS");
    }

    const lines = await tx
      .select()
      .from(stockTransferLines)
      .where(eq(stockTransferLines.transferId, id))
      .orderBy(asc(stockTransferLines.productId));

    const estimatedVal = lines.reduce((sum, l) => sum + num(l.qtySent) * num(l.unitCost), 0);
    if (await checkApprovalRequired(tx, "stock_transfer", estimatedVal, companyId)) {
      const [pending] = await tx
        .update(stockTransfers)
        .set({ approvalStatus: "pending", updatedAt: new Date() })
        .where(and(eq(stockTransfers.id, id), eq(stockTransfers.companyId, companyId)))
        .returning();
      await createApprovalRequest(tx, {
        entityType: "stock_transfer",
        entityId: id,
        entityNumber: tr.transfer_number,
        branchId: tr.from_branch_id,
        amount: estimatedVal,
        actor,
        ipAddress,
      });
      return pending;
    }

    let totalDispatchedVal = 0;

    for (const line of lines) {
      const qtySent = num(line.qtySent);
      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: tr.from_branch_id,
        productId: line.productId,
        qtyDelta: -qtySent,
        fallbackCost: num(line.unitCost),
        movementType: "transfer_out",
        referenceType: "transfer",
        referenceId: id,
        referenceNumber: tr.transfer_number,
        insufficientStockMessage: `Insufficient stock to dispatch line ${line.productId}`,
        notes: `Dispatched transfer ${tr.transfer_number}`,
        actorId: actor.id,
      });

      totalDispatchedVal += Math.abs(moved.totalValueDelta);

      await tx
        .update(stockTransferLines)
        .set({ unitCost: toNumeric(moved.movementCost, 4) })
        .where(eq(stockTransferLines.id, line.id));
    }

    if (totalDispatchedVal > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: tr.from_branch_id,
        sourceType: "stock_transfer",
        sourceId: id,
        referenceNumber: tr.transfer_number,
        memo: `Dispatched transfer ${tr.transfer_number}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "in_transit_inventory", debit: totalDispatchedVal, branchId: tr.from_branch_id },
          { mappingKey: "inventory_asset", credit: totalDispatchedVal, branchId: tr.from_branch_id },
        ],
      });
    }

    const [res] = await tx
      .update(stockTransfers)
      .set({ status: "In Transit", shippedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: tr.from_branch_id,
      action: "transfer.dispatched",
      entityType: "transfers",
      entityId: id,
      entityLabel: tr.transfer_number,
      ipAddress,
    });

    return res;
  });
}

export async function receiveTransfer(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof receiveTransferSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const trRows = await tx.execute<{
      id: string;
      transfer_number: string;
      from_branch_id: string;
      to_branch_id: string;
      status: string;
    }>(
      sql`SELECT id, transfer_number, from_branch_id, to_branch_id, status FROM stock_transfers WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`
    );
    const tr = trRows[0];
    if (!tr) throw new AppError(404, "Transfer not found", "NOT_FOUND");
    assertBranchAccess(actor, tr.to_branch_id);

    if (tr.status !== "In Transit" && tr.status !== "Partial") {
      throw new AppError(400, "Only In Transit or Partial transfers can be received", "INVALID_STATUS");
    }

    const lines = await tx
      .select()
      .from(stockTransferLines)
      .where(eq(stockTransferLines.transferId, id))
      .orderBy(asc(stockTransferLines.productId));

    const receivedInputMap = new Map(data.items.map((i) => [i.productId, i.qtyReceived]));
    let hasShortage = false;
    let totalReceivedVal = 0;
    let totalReturnedToSrcVal = 0;
    let totalWrittenOffShortVal = 0;

    for (const line of lines) {
      const alreadyReceived = num(line.qtyReceived);
      const qtySent = num(line.qtySent);
      const remaining = Math.max(0, qtySent - alreadyReceived);
      const receiveNow = receivedInputMap.get(line.productId) ?? 0;

      if (receiveNow > remaining) {
        throw new AppError(
          400,
          `Cannot receive more than remaining quantity (${remaining}) for product ${line.productId}`,
          "EXCEEDS_SHIPPED_QTY"
        );
      }

      const unitCost = num(line.unitCost);
      if (receiveNow > 0) {
        const [prod] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, line.productId), eq(products.companyId, companyId)))
          .limit(1);
        const moved = await applyBranchStockMovement(tx, {
          companyId,
          branchId: tr.to_branch_id,
          productId: line.productId,
          qtyDelta: receiveNow,
          unitCostForWmac: unitCost,
          fallbackCost: unitCost,
          recomputeAvgCost: true,
          movementType: "transfer_in",
          movementUnitCost: unitCost,
          referenceType: "transfer",
          referenceId: id,
          referenceNumber: tr.transfer_number,
          notes: `Received transfer ${tr.transfer_number}`,
          actorId: actor.id,
        });
        if (prod) {
          await receiveTransferredTrackedStock(tx, {
            companyId,
            transferId: id,
            product: prod,
            toBranchId: tr.to_branch_id,
            qtyReceived: receiveNow,
            movementId: moved.movementId,
            unitCost,
          });
        }
        totalReceivedVal += Math.abs(moved.totalValueDelta);
      }

      const newTotalReceived = alreadyReceived + receiveNow;
      const shortQty = qtySent - newTotalReceived;
      if (shortQty > 0) {
        hasShortage = true;
        if (data.shortageResolution === "return_to_source") {
          const movedBack = await applyBranchStockMovement(tx, {
            companyId,
            branchId: tr.from_branch_id,
            productId: line.productId,
            qtyDelta: shortQty,
            fallbackCost: unitCost,
            recomputeAvgCost: false,
            movementType: "transfer_in",
            movementUnitCost: unitCost,
            referenceType: "transfer",
            referenceId: id,
            referenceNumber: tr.transfer_number,
            notes: `Shortage returned to source on ${tr.transfer_number}`,
            actorId: actor.id,
          });
          totalReturnedToSrcVal += Math.abs(movedBack.totalValueDelta);
        } else if (data.shortageResolution !== "backorder") {
          totalWrittenOffShortVal += shortQty * unitCost;
        }
      }

      await tx
        .update(stockTransferLines)
        .set({ qtyReceived: toNumeric(newTotalReceived, 4) })
        .where(eq(stockTransferLines.id, line.id));
    }

    const totalClearedInTransit = totalReceivedVal + totalReturnedToSrcVal + totalWrittenOffShortVal;
    if (totalClearedInTransit > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: tr.to_branch_id,
        sourceType: "stock_transfer",
        sourceId: id,
        referenceNumber: tr.transfer_number,
        memo: `Received transfer ${tr.transfer_number}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "inventory_asset", debit: totalReceivedVal, branchId: tr.to_branch_id },
          { mappingKey: "inventory_asset", debit: totalReturnedToSrcVal, branchId: tr.from_branch_id },
          { mappingKey: "write_off_expense", debit: totalWrittenOffShortVal, branchId: tr.to_branch_id },
          { mappingKey: "in_transit_inventory", credit: totalClearedInTransit, branchId: tr.from_branch_id },
        ],
      });
    }

    const finalStatus = hasShortage && data.shortageResolution === "backorder" ? "Partial" : "Received";
    const storedResolution =
      data.shortageResolution === "backorder" ||
      data.shortageResolution === "close_short" ||
      data.shortageResolution === "claim_carrier"
        ? data.shortageResolution
        : hasShortage
          ? "close_short"
          : null;

    const [res] = await tx
      .update(stockTransfers)
      .set({
        status: finalStatus,
        shortageResolution: storedResolution,
        receivedAt: new Date(),
        receivedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: tr.to_branch_id,
      action: "transfer.received",
      entityType: "transfers",
      entityId: id,
      entityLabel: tr.transfer_number,
      details: { finalStatus, shortageResolution: data.shortageResolution ?? "none" },
      ipAddress,
    });

    return res;
  });
}

export async function cancelTransfer(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const trRows = await tx.execute<{
      id: string;
      transfer_number: string;
      from_branch_id: string;
      status: string;
    }>(
      sql`SELECT id, transfer_number, from_branch_id, status FROM stock_transfers WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`
    );
    const tr = trRows[0];
    if (!tr) throw new AppError(404, "Transfer not found", "NOT_FOUND");
    assertBranchAccess(actor, tr.from_branch_id);

    if (tr.status === "Received" || tr.status === "Cancelled") {
      throw new AppError(400, `Cannot cancel transfer in status '${tr.status}'`, "INVALID_STATUS");
    }

    if (tr.status === "In Transit" || tr.status === "Partial") {
      const lines = await tx
        .select()
        .from(stockTransferLines)
        .where(eq(stockTransferLines.transferId, id))
        .orderBy(asc(stockTransferLines.productId));

      let returnedVal = 0;

      for (const line of lines) {
        const returnQty = num(line.qtySent) - num(line.qtyReceived);
        if (returnQty <= 0) continue;
        const unitCost = num(line.unitCost);
        const moved = await applyBranchStockMovement(tx, {
          companyId,
          branchId: tr.from_branch_id,
          productId: line.productId,
          qtyDelta: returnQty,
          fallbackCost: unitCost,
          recomputeAvgCost: false,
          movementType: "transfer_in",
          movementUnitCost: unitCost,
          referenceType: "transfer",
          referenceId: id,
          referenceNumber: tr.transfer_number,
          notes: `Cancelled in-transit transfer ${tr.transfer_number}`,
          actorId: actor.id,
        });
        returnedVal += Math.abs(moved.totalValueDelta);
      }

      if (returnedVal > 0.0001) {
        await postMappedJournal(tx, {
          companyId,
          branchId: tr.from_branch_id,
          sourceType: "stock_transfer",
          sourceId: id,
          referenceNumber: tr.transfer_number,
          memo: `Cancelled transfer ${tr.transfer_number}`,
          createdBy: actor.id,
          lines: [
            { mappingKey: "inventory_asset", debit: returnedVal, branchId: tr.from_branch_id },
            { mappingKey: "in_transit_inventory", credit: returnedVal, branchId: tr.from_branch_id },
          ],
        });
      }
    }

    const [res] = await tx
      .update(stockTransfers)
      .set({ status: "Cancelled", updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: tr.from_branch_id,
      action: "transfer.cancelled",
      entityType: "transfers",
      entityId: id,
      entityLabel: tr.transfer_number,
      ipAddress,
    });

    return res;
  });
}
