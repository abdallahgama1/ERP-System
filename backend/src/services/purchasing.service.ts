import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  buildOffsetPageInfo,
  calculateLineAmounts,
  purchaseOrdersListQuerySchema,
  resolveSearchTerm,
  vendorsListQuerySchema,
  type poSchema,
  type receiveSchema,
  type vendorSchema,
} from "@erp/shared";
import {
  products,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReceiveLines,
  purchaseReceives,
  paymentsMade,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { checkApprovalRequired, createApprovalRequest } from "./approvals.service.ts";
import { postMappedJournal } from "./gl.service.ts";
import { receiveTrackedStock } from "./lots-serials.service.ts";
import {
  groupByKey,
  listBranchScoped,
  listBranchScopedPaginated,
  parseOffsetQueryOrThrow,
} from "./query-helpers.ts";
import { applyBranchStockMovement, type RequestActor } from "./stock-locks.ts";

export async function listVendors(db: AppDatabase, rawQuery?: Record<string, unknown>) {
  const query = parseOffsetQueryOrThrow(vendorsListQuerySchema, rawQuery);
  const conds: SQL[] = [];
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    conds.push(
      or(
        ilike(vendors.name, pattern),
        ilike(vendors.code, pattern),
        ilike(vendors.email, pattern),
        ilike(vendors.phone, pattern),
        ilike(vendors.company, pattern),
        ilike(vendors.taxNumber, pattern)
      )!
    );
  }
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(vendors)
    .where(whereClause);

  const dir = query.sortDir === "asc" ? asc : desc;
  const sortCol =
    query.sortBy === "name"
      ? vendors.name
      : query.sortBy === "code"
        ? vendors.code
        : vendors.createdAt;

  const items = await db
    .select()
    .from(vendors)
    .where(whereClause)
    .orderBy(dir(sortCol), dir(vendors.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const pageInfo = buildOffsetPageInfo(query.page, query.pageSize, total);
  return { items, vendors: items, pageInfo };
}

export async function createVendor(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof vendorSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const code = data.code || (await nextDocNumber(tx, "VEND", "VEN-"));
    const [row] = await tx.insert(vendors).values({ ...data, code }).returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "vendor.created",
      entityType: "purchases",
      entityId: row.id,
      entityLabel: `${row.name} (${row.code})`,
      ipAddress,
    });
    return row;
  });
}

export async function updateVendor(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: Partial<z.infer<typeof vendorSchema>>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    if (!current) throw new AppError(404, "Vendor not found", "NOT_FOUND");
    const [row] = await tx
      .update(vendors)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vendors.id, id))
      .returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "vendor.updated",
      entityType: "purchases",
      entityId: row.id,
      entityLabel: row.name,
      ipAddress,
    });
    return row;
  });
}

export async function deleteVendor(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    if (!current) throw new AppError(404, "Vendor not found", "NOT_FOUND");

    const [{ poC }] = await tx
      .select({ poC: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.vendorId, id));
    const [{ billC }] = await tx
      .select({ billC: sql<number>`count(*)::int` })
      .from(vendorBills)
      .where(eq(vendorBills.vendorId, id));
    const [{ payC }] = await tx
      .select({ payC: sql<number>`count(*)::int` })
      .from(paymentsMade)
      .where(eq(paymentsMade.vendorId, id));

    if (poC > 0 || billC > 0 || payC > 0) {
      throw new AppError(409, "Cannot delete vendor with existing orders, bills, or payments", "VENDOR_IN_USE");
    }

    await tx.delete(vendors).where(eq(vendors.id, id));
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "vendor.deleted",
      entityType: "purchases",
      entityId: id,
      entityLabel: current.name,
      ipAddress,
    });
  });
}

function summarizeCostLines(lines: z.infer<typeof poSchema>["lines"]) {
  let subtotal = 0;
  let taxTotal = 0;
  const computed = lines.map((l) => {
    const { taxable, taxAmount, lineTotal } = calculateLineAmounts(
      { quantity: l.quantity, unitPrice: l.unitCost, taxRate: l.taxRate },
      4
    );
    subtotal += taxable;
    taxTotal += taxAmount;
    return { ...l, taxAmount, lineTotal };
  });
  return { subtotal, taxTotal, computed };
}

export async function listPurchaseOrders(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery?: Record<string, unknown>
) {
  const query = parseOffsetQueryOrThrow(purchaseOrdersListQuerySchema, rawQuery);
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
  }

  const extraConditions: SQL[] = [];
  if (query.status) {
    extraConditions.push(eq(purchaseOrders.status, query.status));
  }
  if (query.vendorId) {
    extraConditions.push(eq(purchaseOrders.vendorId, query.vendorId));
  }
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    const matchedVendors = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(ilike(vendors.name, pattern));
    const vendorIds = matchedVendors.map((v) => v.id);
    if (vendorIds.length > 0) {
      extraConditions.push(
        or(
          ilike(purchaseOrders.poNumber, pattern),
          ilike(purchaseOrders.notes, pattern),
          inArray(purchaseOrders.vendorId, vendorIds)
        )!
      );
    } else {
      extraConditions.push(
        or(ilike(purchaseOrders.poNumber, pattern), ilike(purchaseOrders.notes, pattern))!
      );
    }
  }

  const sortCol =
    query.sortBy === "orderDate"
      ? purchaseOrders.orderDate
      : query.sortBy === "poNumber"
        ? purchaseOrders.poNumber
        : query.sortBy === "totalAmount"
          ? purchaseOrders.totalAmount
          : purchaseOrders.createdAt;

  const { rows, pageInfo } = await listBranchScopedPaginated(
    db,
    purchaseOrders,
    purchaseOrders.branchId,
    sortCol,
    purchaseOrders.id,
    actor,
    {
      page: query.page,
      pageSize: query.pageSize,
      sortDir: query.sortDir,
      requestedBranchId: query.branchId,
      extraConditions,
    }
  );
  const headers = rows as Array<typeof purchaseOrders.$inferSelect>;
  if (headers.length === 0) return { items: [], purchaseOrders: [], pageInfo };

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(inArray(purchaseOrderLines.poId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.poId);

  const items = headers.map((po) => ({
    ...po,
    fxRate: num(po.fxRate),
    subtotal: num(po.subtotal),
    taxTotal: num(po.taxTotal),
    totalAmount: num(po.totalAmount),
    orderDate: po.orderDate.toISOString(),
    expectedDate: po.expectedDate?.toISOString() ?? null,
    createdAt: po.createdAt.toISOString(),
    lines: (linesMap.get(po.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      receivedQty: num(l.receivedQty),
      unitCost: num(l.unitCost),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));

  return { items, purchaseOrders: items, pageInfo };
}

export async function createPurchaseOrder(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof poSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const poNumber = await nextDocNumber(tx, "PO", "PO-");
    const { subtotal, taxTotal, computed } = summarizeCostLines(data.lines);
    const totalAmount = subtotal + taxTotal;
    const needsApproval =
      data.status === "Issued" && Boolean(await checkApprovalRequired(tx, "purchase_order", totalAmount));

    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        poNumber,
        vendorId: data.vendorId,
        branchId: data.branchId,
        status: needsApproval ? "Draft" : data.status,
        approvalStatus: needsApproval ? "pending" : "not_required",
        orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
        expectedDate: data.expectedDate ? new Date(data.expectedDate) : null,
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(totalAmount, 4),
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(purchaseOrderLines).values(
      computed.map((l) => ({
        poId: po.id,
        productId: l.productId,
        description: l.description,
        quantity: toNumeric(l.quantity, 4),
        receivedQty: "0",
        unitCost: toNumeric(l.unitCost, 4),
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    if (needsApproval) {
      await createApprovalRequest(tx, {
        entityType: "purchase_order",
        entityId: po.id,
        entityNumber: po.poNumber,
        branchId: po.branchId,
        amount: totalAmount,
        actor,
        ipAddress,
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: po.branchId,
      action: "po.created",
      entityType: "purchases",
      entityId: po.id,
      entityLabel: po.poNumber,
      ipAddress,
    });

    return po;
  });
}

export async function updatePurchaseOrder(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof poSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    if (!current) throw new AppError(404, "Purchase order not found", "NOT_FOUND");
    if (current.status !== "Draft") {
      throw new AppError(400, "Only Draft purchase orders can be edited", "IMMUTABLE_DOCUMENT");
    }

    const { subtotal, taxTotal, computed } = summarizeCostLines(data.lines);
    const totalAmount = subtotal + taxTotal;
    const needsApproval =
      data.status === "Issued" && Boolean(await checkApprovalRequired(tx, "purchase_order", totalAmount));

    const [po] = await tx
      .update(purchaseOrders)
      .set({
        vendorId: data.vendorId,
        branchId: data.branchId,
        status: needsApproval ? "Draft" : data.status,
        approvalStatus: needsApproval ? "pending" : current.approvalStatus,
        orderDate: data.orderDate ? new Date(data.orderDate) : current.orderDate,
        expectedDate: data.expectedDate ? new Date(data.expectedDate) : null,
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(totalAmount, 4),
        notes: data.notes,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, id))
      .returning();

    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, id));
    await tx.insert(purchaseOrderLines).values(
      computed.map((l) => ({
        poId: id,
        productId: l.productId,
        description: l.description,
        quantity: toNumeric(l.quantity, 4),
        receivedQty: "0",
        unitCost: toNumeric(l.unitCost, 4),
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    if (needsApproval) {
      await createApprovalRequest(tx, {
        entityType: "purchase_order",
        entityId: po.id,
        entityNumber: po.poNumber,
        branchId: po.branchId,
        amount: totalAmount,
        actor,
        ipAddress,
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: po.branchId,
      action: "po.updated",
      entityType: "purchases",
      entityId: id,
      entityLabel: po.poNumber,
      ipAddress,
    });

    return po;
  });
}

export async function issuePurchaseOrder(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    if (!po) throw new AppError(404, "Purchase order not found", "NOT_FOUND");
    assertBranchAccess(actor, po.branchId);
    if (po.status !== "Draft") throw new AppError(400, "Only Draft POs can be issued", "INVALID_STATUS");
    const totalAmount = num(po.totalAmount);
    const needsApproval = Boolean(await checkApprovalRequired(tx, "purchase_order", totalAmount));

    if (needsApproval) {
      const [pendingPo] = await tx
        .update(purchaseOrders)
        .set({ approvalStatus: "pending", updatedAt: new Date() })
        .where(eq(purchaseOrders.id, id))
        .returning();
      await createApprovalRequest(tx, {
        entityType: "purchase_order",
        entityId: po.id,
        entityNumber: po.poNumber,
        branchId: po.branchId,
        amount: totalAmount,
        actor,
        ipAddress,
      });
      return pendingPo;
    }

    const [res] = await tx
      .update(purchaseOrders)
      .set({ status: "Issued", updatedAt: new Date() })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: po.branchId,
      action: "po.issued",
      entityType: "purchases",
      entityId: id,
      entityLabel: po.poNumber,
      ipAddress,
    });
    return res;
  });
}

export async function cancelPurchaseOrder(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    if (!po) throw new AppError(404, "Purchase order not found", "NOT_FOUND");
    assertBranchAccess(actor, po.branchId);
    if (po.status === "Closed" || po.status === "Partially Received") {
      throw new AppError(400, "Cannot cancel a PO that has already been received", "INVALID_STATUS");
    }

    const [res] = await tx
      .update(purchaseOrders)
      .set({ status: "Cancelled", updatedAt: new Date() })
      .where(eq(purchaseOrders.id, id))
      .returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: po.branchId,
      action: "po.cancelled",
      entityType: "purchases",
      entityId: id,
      entityLabel: po.poNumber,
      ipAddress,
    });
    return res;
  });
}

export async function deletePurchaseOrder(db: AppDatabase, actor: RequestActor, id: string) {
  await db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    if (!po) throw new AppError(404, "Purchase order not found", "NOT_FOUND");
    assertBranchAccess(actor, po.branchId);
    if (po.status !== "Draft") {
      throw new AppError(400, "Only Draft POs can be deleted", "IMMUTABLE_DOCUMENT");
    }
    await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
  });
}

export async function listPurchaseReceives(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    purchaseReceives,
    purchaseReceives.branchId,
    purchaseReceives.createdAt,
    actor
  )) as Array<typeof purchaseReceives.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(purchaseReceiveLines)
    .where(inArray(purchaseReceiveLines.receiveId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.receiveId);

  return headers.map((r) => ({
    ...r,
    receiveDate: r.receiveDate.toISOString(),
    createdAt: r.createdAt.toISOString(),
    lines: (linesMap.get(r.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      lineTotal: num(l.lineTotal),
    })),
  }));
}

export async function createPurchaseReceive(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof receiveSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const receiveNumber = await nextDocNumber(tx, "PRCV", "RCV-");

    const [rcv] = await tx
      .insert(purchaseReceives)
      .values({
        receiveNumber,
        poId: data.poId ?? null,
        vendorId: data.vendorId,
        branchId: data.branchId,
        status: "Received",
        receiveDate: data.receiveDate ? new Date(data.receiveDate) : new Date(),
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    const sortedLines = [...data.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    let totalReceiveVal = 0;

    for (const line of sortedLines) {
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

      const moved = await applyBranchStockMovement(tx, {
        branchId: data.branchId,
        productId: line.productId,
        qtyDelta: line.quantity,
        unitCostForWmac: line.unitCost,
        fallbackCost: line.unitCost,
        recomputeAvgCost: true,
        movementType: "purchase_receive",
        movementUnitCost: line.unitCost,
        referenceType: "purchase_receive",
        referenceId: rcv.id,
        referenceNumber: rcv.receiveNumber,
        notes: `Purchase receive ${rcv.receiveNumber}`,
        actorId: actor.id,
      });
      await receiveTrackedStock(tx, {
        product: prod,
        branchId: data.branchId,
        quantity: line.quantity,
        unitCost: line.unitCost,
        movementId: moved.movementId,
        lotNumber: line.lotNumber,
        manufactureDate: line.manufactureDate,
        expiryDate: line.expiryDate,
        serialNumbers: line.serialNumbers,
        vendorId: data.vendorId,
        receivedFromType: "purchase_receive",
        receivedFromId: rcv.id,
        notes: `Purchase receive ${rcv.receiveNumber}`,
      });
      totalReceiveVal += Math.abs(moved.totalValueDelta);

      await tx.insert(purchaseReceiveLines).values({
        receiveId: rcv.id,
        poLineId: line.poLineId ?? null,
        productId: line.productId,
        quantity: toNumeric(line.quantity, 4),
        unitCost: toNumeric(line.unitCost, 4),
        lineTotal: toNumeric(line.quantity * line.unitCost, 4),
      });

      if (data.poId) {
        const poLineRows = line.poLineId
          ? await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.poLineId)).limit(1)
          : await tx
              .select()
              .from(purchaseOrderLines)
              .where(eq(purchaseOrderLines.poId, data.poId))
              .then((list) => list.filter((p) => p.productId === line.productId).slice(0, 1));

        const poLine = poLineRows[0];
        if (poLine) {
          const newReceived = num(poLine.receivedQty) + line.quantity;
          await tx
            .update(purchaseOrderLines)
            .set({ receivedQty: toNumeric(newReceived, 4) })
            .where(eq(purchaseOrderLines.id, poLine.id));
        }
      }
    }

    if (totalReceiveVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: data.branchId,
        entryDate: rcv.receiveDate,
        sourceType: "purchase_receive",
        sourceId: rcv.id,
        referenceNumber: rcv.receiveNumber,
        memo: `Goods receipt ${rcv.receiveNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "inventory_asset", debit: totalReceiveVal },
          { mappingKey: "grni", credit: totalReceiveVal },
        ],
      });
    }

    if (data.poId) {
      const allPoLines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, data.poId));
      const allClosed = allPoLines.every((l) => num(l.receivedQty) >= num(l.quantity));
      const anyReceived = allPoLines.some((l) => num(l.receivedQty) > 0);
      await tx
        .update(purchaseOrders)
        .set({
          status: allClosed ? "Closed" : anyReceived ? "Partially Received" : "Issued",
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, data.poId));
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "purchase_receive.created",
      entityType: "purchases",
      entityId: rcv.id,
      entityLabel: rcv.receiveNumber,
      ipAddress,
    });

    return rcv;
  });
}
