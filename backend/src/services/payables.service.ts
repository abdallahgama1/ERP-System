import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  calculateLineAmounts,
  resolveSearchTerm,
  roundCurrency,
  vendorBillsListQuerySchema,
  type billSchema,
  type paymentMadeSchema,
  type purchaseReturnSchema,
} from "@erp/shared";
import {
  branchProducts,
  paymentMadeAllocations,
  paymentsMade,
  products,
  purchaseOrders,
  purchaseReceiveLines,
  purchaseReceives,
  purchaseReturnLines,
  purchaseReturns,
  vendorBillLines,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal, reverseJournalEntriesForSource, type MappedLineSpec } from "./gl.service.ts";
import {
  buildBranchScopeCondition,
  groupByKey,
  listBranchScoped,
  listBranchScopedPaginated,
  parseOffsetQueryOrThrow,
} from "./query-helpers.ts";
import {
  actorCompanyId,
  applyBranchStockMovement,
  assertBranchInCompany,
  lockBranchProduct,
  type RequestActor,
} from "./stock-locks.ts";

function summarizeCostLines<T extends { quantity: number; unitCost: number; taxRate: number }>(lines: T[]) {
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

export async function listVendorBills(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery?: Record<string, unknown>
) {
  const companyId = actorCompanyId(actor);
  const query = parseOffsetQueryOrThrow(vendorBillsListQuerySchema, rawQuery);
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
  }

  const extraConditions: SQL[] = [];
  if (query.status) {
    extraConditions.push(eq(vendorBills.status, query.status));
  }
  if (query.vendorId) {
    extraConditions.push(eq(vendorBills.vendorId, query.vendorId));
  }
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    const matchedVendors = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), ilike(vendors.name, pattern)));
    const vendorIds = matchedVendors.map((v) => v.id);
    if (vendorIds.length > 0) {
      extraConditions.push(
        or(
          ilike(vendorBills.billNumber, pattern),
          ilike(vendorBills.notes, pattern),
          inArray(vendorBills.vendorId, vendorIds)
        )!
      );
    } else {
      extraConditions.push(
        or(ilike(vendorBills.billNumber, pattern), ilike(vendorBills.notes, pattern))!
      );
    }
  }

  const sortCol =
    query.sortBy === "billDate"
      ? vendorBills.billDate
      : query.sortBy === "dueDate"
        ? vendorBills.dueDate
        : query.sortBy === "billNumber"
          ? vendorBills.billNumber
          : query.sortBy === "totalAmount"
            ? vendorBills.totalAmount
            : vendorBills.createdAt;

  const { rows, pageInfo } = await listBranchScopedPaginated(
    db,
    vendorBills,
    vendorBills.branchId,
    sortCol,
    vendorBills.id,
    actor,
    {
      page: query.page,
      pageSize: query.pageSize,
      sortDir: query.sortDir,
      requestedBranchId: query.branchId,
      extraConditions,
    }
  );
  const headers = rows as Array<typeof vendorBills.$inferSelect>;
  if (headers.length === 0) return { items: [], bills: [], pageInfo };

  const lines = await db
    .select()
    .from(vendorBillLines)
    .where(inArray(vendorBillLines.billId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.billId);

  const items = headers.map((b) => ({
    ...b,
    fxRate: num(b.fxRate),
    subtotal: num(b.subtotal),
    taxTotal: num(b.taxTotal),
    totalAmount: num(b.totalAmount),
    paidAmount: num(b.paidAmount),
    billDate: b.billDate.toISOString(),
    dueDate: b.dueDate.toISOString(),
    createdAt: b.createdAt.toISOString(),
    lines: (linesMap.get(b.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));

  return { items, bills: items, pageInfo };
}

export async function getVendorBillById(db: AppDatabase, actor: RequestActor, id: string) {
  const companyId = actorCompanyId(actor);
  const [b] = await db
    .select()
    .from(vendorBills)
    .where(and(eq(vendorBills.id, id), eq(vendorBills.companyId, companyId)))
    .limit(1);
  if (!b) throw new AppError(404, "Vendor bill not found", "NOT_FOUND");
  assertBranchAccess(actor, b.branchId);

  const lines = await db.select().from(vendorBillLines).where(eq(vendorBillLines.billId, b.id));
  return {
    ...b,
    fxRate: num(b.fxRate),
    subtotal: num(b.subtotal),
    taxTotal: num(b.taxTotal),
    totalAmount: num(b.totalAmount),
    paidAmount: num(b.paidAmount),
    billDate: b.billDate.toISOString(),
    dueDate: b.dueDate.toISOString(),
    createdAt: b.createdAt.toISOString(),
    lines: lines.map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  };
}

export async function createVendorBill(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof billSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);
    const [vend] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, data.vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vend) throw new AppError(404, "Vendor not found", "NOT_FOUND");

    if (data.poId) {
      const [po] = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, data.poId), eq(purchaseOrders.companyId, companyId)))
        .limit(1);
      if (!po) throw new AppError(404, "Purchase order not found", "NOT_FOUND");
    }

    if (data.receiveId) {
      const [rcv] = await tx
        .select({ id: purchaseReceives.id })
        .from(purchaseReceives)
        .where(and(eq(purchaseReceives.id, data.receiveId), eq(purchaseReceives.companyId, companyId)))
        .limit(1);
      if (!rcv) throw new AppError(404, "Purchase receive not found", "NOT_FOUND");
    }

    const lineProdIds = Array.from(new Set(data.lines.map((l) => l.productId).filter((pid): pid is string => Boolean(pid))));
    if (lineProdIds.length > 0) {
      const validProds = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, lineProdIds)));
      if (validProds.length !== lineProdIds.length) {
        throw new AppError(404, "One or more products not found in active company", "NOT_FOUND");
      }
    }

    const billNumber = await nextDocNumber(tx, "BILL", "BILL-", null, companyId);
    const { subtotal, taxTotal, computed } = summarizeCostLines(data.lines);

    const [bill] = await tx
      .insert(vendorBills)
      .values({
        companyId,
        billNumber,
        vendorId: data.vendorId,
        branchId: data.branchId,
        poId: data.poId ?? null,
        receiveId: data.receiveId ?? null,
        status: "Open",
        billDate: data.billDate ? new Date(data.billDate) : new Date(),
        dueDate: new Date(data.dueDate),
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        paidAmount: "0",
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(vendorBillLines).values(
      computed.map((l) => ({
        billId: bill.id,
        productId: l.productId ?? null,
        description: l.description,
        quantity: toNumeric(l.quantity, 4),
        unitCost: toNumeric(l.unitCost, 4),
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    let grniClearAmount = 0;
    let invAdjustAmount = 0;
    let ppvExpenseAmount = 0;

    if (data.receiveId) {
      const receiveLines = await tx
        .select()
        .from(purchaseReceiveLines)
        .where(eq(purchaseReceiveLines.receiveId, data.receiveId));
      const rcvByProduct = new Map<string, { qty: number; value: number }>();
      for (const rl of receiveLines) {
        const cur = rcvByProduct.get(rl.productId) ?? { qty: 0, value: 0 };
        const q = num(rl.quantity);
        cur.qty += q;
        cur.value += q * num(rl.unitCost);
        rcvByProduct.set(rl.productId, cur);
      }

      for (const l of computed) {
        const billedLineVal = roundCurrency(l.quantity * l.unitCost, 4);
        const rcv = l.productId ? rcvByProduct.get(l.productId) : undefined;
        if (!l.productId || !rcv || rcv.qty <= 0) {
          grniClearAmount = roundCurrency(grniClearAmount + billedLineVal, 4);
          continue;
        }
        const receivedUnitCost = rcv.value / rcv.qty;
        const expectedReceivedVal = roundCurrency(l.quantity * receivedUnitCost, 4);
        const variance = roundCurrency(billedLineVal - expectedReceivedVal, 4);
        grniClearAmount = roundCurrency(grniClearAmount + expectedReceivedVal, 4);

        if (Math.abs(variance) > 0.005) {
          const bp = await lockBranchProduct(tx, bill.branchId, l.productId, l.unitCost, companyId);
          const onHandRatio = Math.min(1, Math.max(0, bp.qtyOnHand / rcv.qty));
          const invAdj = roundCurrency(variance * onHandRatio, 4);
          const ppv = roundCurrency(variance - invAdj, 4);

          if (Math.abs(invAdj) > 0.0001 && bp.qtyOnHand > 0) {
            const newAvgCost = Math.max(
              0,
              roundCurrency((bp.qtyOnHand * bp.avgCost + invAdj) / bp.qtyOnHand, 4)
            );
            await tx
              .update(branchProducts)
              .set({ avgCost: toNumeric(newAvgCost, 4), updatedAt: new Date() })
              .where(eq(branchProducts.id, bp.id));
          }
          invAdjustAmount = roundCurrency(invAdjustAmount + invAdj, 4);
          ppvExpenseAmount = roundCurrency(ppvExpenseAmount + ppv, 4);
        }
      }
    } else {
      grniClearAmount = subtotal;
    }

    const journalLinesSpec: MappedLineSpec[] = [
      { mappingKey: "grni", debit: grniClearAmount, currency: data.currency, fxRate: data.fxRate },
      { mappingKey: "input_vat", debit: taxTotal, currency: data.currency, fxRate: data.fxRate },
      { mappingKey: "accounts_payable", credit: subtotal + taxTotal, currency: data.currency, fxRate: data.fxRate },
    ];
    if (invAdjustAmount > 0.0001) {
      journalLinesSpec.push({ mappingKey: "inventory_asset", debit: invAdjustAmount, currency: data.currency, fxRate: data.fxRate, description: "PPV allocated to on-hand inventory" });
    } else if (invAdjustAmount < -0.0001) {
      journalLinesSpec.push({ mappingKey: "inventory_asset", credit: Math.abs(invAdjustAmount), currency: data.currency, fxRate: data.fxRate, description: "Favorable PPV allocated to on-hand inventory" });
    }
    if (ppvExpenseAmount > 0.0001) {
      journalLinesSpec.push({ mappingKey: "rounding_variance", debit: ppvExpenseAmount, currency: data.currency, fxRate: data.fxRate, description: "Purchase price variance (already consumed stock)" });
    } else if (ppvExpenseAmount < -0.0001) {
      journalLinesSpec.push({ mappingKey: "rounding_variance", credit: Math.abs(ppvExpenseAmount), currency: data.currency, fxRate: data.fxRate, description: "Favorable purchase price variance" });
    }

    await postMappedJournal(tx, {
      companyId,
      branchId: bill.branchId,
      entryDate: bill.billDate,
      sourceType: "vendor_bill",
      sourceId: bill.id,
      referenceNumber: bill.billNumber,
      memo: `Vendor bill ${bill.billNumber}`,
      createdBy: actor.id,
      lines: journalLinesSpec,
    });

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: bill.branchId,
      action: "vendor_bill.created",
      entityType: "purchases",
      entityId: bill.id,
      entityLabel: bill.billNumber,
      ipAddress,
    });
    return bill;
  });
}

export async function voidVendorBill(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  reason: string,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(and(eq(vendorBills.id, id), eq(vendorBills.companyId, companyId)))
      .limit(1);
    if (!bill) throw new AppError(404, "Vendor bill not found", "NOT_FOUND");
    assertBranchAccess(actor, bill.branchId);
    if (num(bill.paidAmount) > 0) {
      throw new AppError(400, "Void linked payments before voiding this vendor bill", "BILL_HAS_PAYMENTS");
    }

    const [res] = await tx
      .update(vendorBills)
      .set({
        status: "Cancelled",
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(vendorBills.id, id), eq(vendorBills.companyId, companyId)))
      .returning();

    await reverseJournalEntriesForSource(tx, "vendor_bill", id, actor.id, reason, companyId);

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: bill.branchId,
      action: "vendor_bill.voided",
      entityType: "purchases",
      entityId: id,
      entityLabel: bill.billNumber,
      details: { reason },
      ipAddress,
    });
    return res;
  });
}

export async function listPaymentsMade(db: AppDatabase, actor: RequestActor) {
  const companyId = actorCompanyId(actor);
  const scopeCond = buildBranchScopeCondition(paymentsMade.branchId, actor, undefined, true);
  if (scopeCond === "EMPTY") return [];

  const companyCond = eq(paymentsMade.companyId, companyId);
  const whereClause = scopeCond ? and(companyCond, scopeCond) : companyCond;

  const list = await db
    .select()
    .from(paymentsMade)
    .where(whereClause)
    .orderBy(desc(paymentsMade.createdAt));
  if (list.length === 0) return [];

  const allocs = await db
    .select()
    .from(paymentMadeAllocations)
    .where(inArray(paymentMadeAllocations.paymentId, list.map((p) => p.id)));
  const allocMap = groupByKey(allocs, (a) => a.paymentId);

  return list.map((p) => ({
    ...p,
    amount: num(p.amount),
    fxRate: num(p.fxRate),
    paymentDate: p.paymentDate.toISOString(),
    createdAt: p.createdAt.toISOString(),
    allocations: (allocMap.get(p.id) ?? []).map((a) => ({
      billId: a.billId,
      amount: num(a.amount),
    })),
  }));
}

export async function createPaymentMade(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof paymentMadeSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  const totalAllocated = data.allocations.reduce((s, a) => s + a.amount, 0);
  if (totalAllocated > data.amount + 0.0001) {
    throw new AppError(400, "Allocated amount exceeds total payment amount", "INVALID_ALLOCATION");
  }
  if (data.branchId) assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }
    const [vend] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, data.vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vend) throw new AppError(404, "Vendor not found", "NOT_FOUND");

    const paymentNumber = await nextDocNumber(tx, "PMADE", "PM-", null, companyId);
    const [pm] = await tx
      .insert(paymentsMade)
      .values({
        companyId,
        paymentNumber,
        vendorId: data.vendorId,
        branchId: data.branchId ?? null,
        paymentDate: data.paymentDate ? new Date(data.paymentDate) : new Date(),
        amount: toNumeric(data.amount, 4),
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        paymentMethod: data.paymentMethod,
        reference: data.reference,
        status: "Posted",
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    for (const alloc of data.allocations) {
      const billRows = await tx.execute<{
        id: string;
        total_amount: string;
        paid_amount: string;
        status: string;
      }>(
        sql`SELECT id, total_amount, paid_amount, status FROM vendor_bills WHERE id = ${alloc.billId} AND company_id = ${companyId} FOR UPDATE`
      );
      const bill = billRows[0];
      if (!bill) throw new AppError(404, "Referenced bill not found", "NOT_FOUND");
      if (bill.status === "Cancelled") throw new AppError(400, "Cannot pay a voided bill", "INVALID_STATUS");

      const balance = num(bill.total_amount) - num(bill.paid_amount);
      if (alloc.amount > balance + 0.0001) {
        throw new AppError(400, "Payment exceeds remaining bill balance", "OVERPAYMENT");
      }

      const nextPaid = num(bill.paid_amount) + alloc.amount;
      const nextStatus = nextPaid >= num(bill.total_amount) - 0.0001 ? "Paid" : "Partially Paid";

      await tx
        .update(vendorBills)
        .set({ paidAmount: toNumeric(nextPaid, 4), status: nextStatus, updatedAt: new Date() })
        .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.companyId, companyId)));

      await tx.insert(paymentMadeAllocations).values({
        paymentId: pm.id,
        billId: bill.id,
        amount: toNumeric(alloc.amount, 4),
      });
    }

    await postMappedJournal(tx, {
      companyId,
      branchId: pm.branchId,
      entryDate: pm.paymentDate,
      sourceType: "payment_made",
      sourceId: pm.id,
      referenceNumber: pm.paymentNumber,
      memo: `Payment made ${pm.paymentNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "accounts_payable", debit: data.amount, currency: data.currency, fxRate: data.fxRate },
        { mappingKey: "default_cash_bank", credit: data.amount, currency: data.currency, fxRate: data.fxRate },
      ],
    });

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: pm.branchId,
      action: "payment_made.created",
      entityType: "purchases",
      entityId: pm.id,
      entityLabel: pm.paymentNumber,
      details: { amount: data.amount },
      ipAddress,
    });

    return pm;
  });
}

export async function voidPaymentMade(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  reason: string,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [pm] = await tx
      .select()
      .from(paymentsMade)
      .where(and(eq(paymentsMade.id, id), eq(paymentsMade.companyId, companyId)))
      .limit(1);
    if (!pm) throw new AppError(404, "Payment not found", "NOT_FOUND");
    if (pm.status === "Voided") throw new AppError(400, "Payment is already voided", "ALREADY_VOIDED");

    const allocs = await tx
      .select()
      .from(paymentMadeAllocations)
      .where(eq(paymentMadeAllocations.paymentId, id));

    for (const alloc of allocs) {
      const billRows = await tx.execute<{
        id: string;
        total_amount: string;
        paid_amount: string;
      }>(
        sql`SELECT id, total_amount, paid_amount FROM vendor_bills WHERE id = ${alloc.billId} AND company_id = ${companyId} FOR UPDATE`
      );
      const bill = billRows[0];
      if (!bill) continue;
      const nextPaid = Math.max(0, num(bill.paid_amount) - num(alloc.amount));
      const nextStatus = nextPaid <= 0.0001 ? "Open" : "Partially Paid";
      await tx
        .update(vendorBills)
        .set({ paidAmount: toNumeric(nextPaid, 4), status: nextStatus, updatedAt: new Date() })
        .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.companyId, companyId)));
    }

    const [res] = await tx
      .update(paymentsMade)
      .set({
        status: "Voided",
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: actor.id,
      })
      .where(and(eq(paymentsMade.id, id), eq(paymentsMade.companyId, companyId)))
      .returning();

    await reverseJournalEntriesForSource(tx, "payment_made", id, actor.id, reason, companyId);

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: pm.branchId,
      action: "payment_made.voided",
      entityType: "purchases",
      entityId: id,
      entityLabel: pm.paymentNumber,
      details: { reason },
      ipAddress,
    });

    return res;
  });
}

export async function listPurchaseReturns(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    purchaseReturns,
    purchaseReturns.branchId,
    purchaseReturns.createdAt,
    actor
  )) as Array<typeof purchaseReturns.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(purchaseReturnLines)
    .where(inArray(purchaseReturnLines.returnId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.returnId);

  return headers.map((r) => ({
    ...r,
    subtotal: num(r.subtotal),
    taxTotal: num(r.taxTotal),
    totalAmount: num(r.totalAmount),
    returnDate: r.returnDate.toISOString(),
    createdAt: r.createdAt.toISOString(),
    lines: (linesMap.get(r.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));
}

export async function createPurchaseReturn(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof purchaseReturnSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);
    const [vend] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, data.vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vend) throw new AppError(404, "Vendor not found", "NOT_FOUND");

    if (data.receiveId) {
      const [rcv] = await tx
        .select({ id: purchaseReceives.id })
        .from(purchaseReceives)
        .where(and(eq(purchaseReceives.id, data.receiveId), eq(purchaseReceives.companyId, companyId)))
        .limit(1);
      if (!rcv) throw new AppError(404, "Purchase receive not found", "NOT_FOUND");
    }

    if (data.billId) {
      const [bill] = await tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(and(eq(vendorBills.id, data.billId), eq(vendorBills.companyId, companyId)))
        .limit(1);
      if (!bill) throw new AppError(404, "Vendor bill not found", "NOT_FOUND");
    }

    const uniqueProdIds = Array.from(new Set(data.lines.map((l) => l.productId)));
    if (uniqueProdIds.length > 0) {
      const validProds = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, uniqueProdIds)));
      if (validProds.length !== uniqueProdIds.length) {
        throw new AppError(404, "One or more products not found in active company", "NOT_FOUND");
      }
    }

    const returnNumber = await nextDocNumber(tx, "PRET", "PRTN-", null, companyId);
    const { subtotal, taxTotal, computed } = summarizeCostLines(data.lines);

    const [ret] = await tx
      .insert(purchaseReturns)
      .values({
        companyId,
        returnNumber,
        vendorId: data.vendorId,
        branchId: data.branchId,
        receiveId: data.receiveId ?? null,
        billId: data.billId ?? null,
        status: "Posted",
        returnDate: data.returnDate ? new Date(data.returnDate) : new Date(),
        reason: data.reason,
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    const sorted = [...computed].sort((a, b) => a.productId.localeCompare(b.productId));
    let totalReturnedInventoryVal = 0;
    for (const line of sorted) {
      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: data.branchId,
        productId: line.productId,
        qtyDelta: -line.quantity,
        fallbackCost: line.unitCost,
        movementType: "purchase_return",
        movementUnitCost: line.unitCost,
        referenceType: "purchase_return",
        referenceId: ret.id,
        referenceNumber: ret.returnNumber,
        insufficientStockMessage: "Insufficient stock on hand to return to vendor",
        notes: `Purchase return ${ret.returnNumber} (${data.reason})`,
        actorId: actor.id,
      });
      totalReturnedInventoryVal += Math.abs(moved.totalValueDelta);

      await tx.insert(purchaseReturnLines).values({
        returnId: ret.id,
        productId: line.productId,
        quantity: toNumeric(line.quantity, 4),
        unitCost: toNumeric(line.unitCost, 4),
        taxRate: toNumeric(line.taxRate, 4),
        taxAmount: toNumeric(line.taxAmount, 4),
        lineTotal: toNumeric(line.lineTotal, 4),
      });
    }

    const debitKey = data.billId ? "accounts_payable" : "grni";
    const debitAmt = data.billId ? subtotal + taxTotal : subtotal;
    const priceDiff = debitAmt - (totalReturnedInventoryVal + (data.billId ? taxTotal : 0));
    await postMappedJournal(tx, {
      companyId,
      branchId: ret.branchId,
      entryDate: ret.returnDate,
      sourceType: "purchase_return",
      sourceId: ret.id,
      referenceNumber: ret.returnNumber,
      memo: `Purchase return ${ret.returnNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: debitKey, debit: debitAmt },
        { mappingKey: "inventory_asset", credit: totalReturnedInventoryVal },
        ...(data.billId && taxTotal > 0 ? [{ mappingKey: "input_vat" as const, credit: taxTotal }] : []),
        ...(priceDiff > 0.0001
          ? [{ mappingKey: "rounding_variance" as const, credit: priceDiff }]
          : priceDiff < -0.0001
            ? [{ mappingKey: "rounding_variance" as const, debit: Math.abs(priceDiff) }]
            : []),
      ],
    });

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "purchase_return.created",
      entityType: "purchases",
      entityId: ret.id,
      entityLabel: ret.returnNumber,
      ipAddress,
    });
    return ret;
  });
}
