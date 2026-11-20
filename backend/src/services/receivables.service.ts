import { desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  calculateLineAmounts,
  type applyAmountSchema,
  type receivedPaymentSchema,
  type retainerSchema,
  type salesReturnSchema,
} from "@erp/shared";
import {
  creditNoteApplications,
  products,
  receivedPaymentAllocations,
  receivedPayments,
  retainerApplications,
  retainerInvoices,
  salesInvoices,
  salesReturnLines,
  salesReturns,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal, reverseJournalEntriesForSource } from "./gl.service.ts";
import { groupByKey, listBranchScoped } from "./query-helpers.ts";
import { applyBranchStockMovement, type RequestActor } from "./stock-locks.ts";

export async function listReceivedPayments(db: AppDatabase) {
  const list = await db.select().from(receivedPayments).orderBy(desc(receivedPayments.createdAt));
  if (list.length === 0) return [];

  const allocs = await db
    .select()
    .from(receivedPaymentAllocations)
    .where(inArray(receivedPaymentAllocations.paymentId, list.map((p) => p.id)));
  const allocMap = groupByKey(allocs, (a) => a.paymentId);

  return list.map((p) => ({
    ...p,
    amount: num(p.amount),
    fxRate: num(p.fxRate),
    paymentDate: p.paymentDate.toISOString(),
    createdAt: p.createdAt.toISOString(),
    allocations: (allocMap.get(p.id) ?? []).map((a) => ({
      invoiceId: a.invoiceId,
      amount: num(a.amount),
    })),
  }));
}

export async function createReceivedPayment(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof receivedPaymentSchema>,
  ipAddress?: string
) {
  const totalAllocated = data.allocations.reduce((s, a) => s + a.amount, 0);
  if (totalAllocated > data.amount + 0.0001) {
    throw new AppError(400, "Allocated amount exceeds payment amount", "INVALID_ALLOCATION");
  }
  if (data.branchId) assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const paymentNumber = await nextDocNumber(tx, "RPAY", "RP-");
    const [rp] = await tx
      .insert(receivedPayments)
      .values({
        paymentNumber,
        customerId: data.customerId,
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
      const invRows = await tx.execute<{
        id: string;
        total_amount: string;
        paid_amount: string;
        credit_applied_amount: string;
        retainer_applied_amount: string;
        status: string;
      }>(sql`
        SELECT id, total_amount, paid_amount, credit_applied_amount, retainer_applied_amount, status
        FROM sales_invoices WHERE id = ${alloc.invoiceId} FOR UPDATE
      `);
      const inv = invRows[0];
      if (!inv) throw new AppError(404, "Referenced invoice not found", "NOT_FOUND");
      if (inv.status === "Cancelled") throw new AppError(400, "Cannot apply payment to voided invoice", "INVALID_STATUS");

      const settled = num(inv.paid_amount) + num(inv.credit_applied_amount) + num(inv.retainer_applied_amount);
      const balance = num(inv.total_amount) - settled;
      if (alloc.amount > balance + 0.0001) {
        throw new AppError(400, "Payment allocation exceeds invoice balance", "OVERPAYMENT");
      }

      const nextPaid = num(inv.paid_amount) + alloc.amount;
      const nextTotalSettled = settled + alloc.amount;
      const nextStatus = nextTotalSettled >= num(inv.total_amount) - 0.0001 ? "Paid" : "Partially Paid";

      await tx
        .update(salesInvoices)
        .set({ paidAmount: toNumeric(nextPaid, 4), status: nextStatus, updatedAt: new Date() })
        .where(eq(salesInvoices.id, inv.id));

      await tx.insert(receivedPaymentAllocations).values({
        paymentId: rp.id,
        invoiceId: inv.id,
        amount: toNumeric(alloc.amount, 4),
      });
    }

    await postMappedJournal(tx, {
      branchId: rp.branchId,
      entryDate: rp.paymentDate,
      sourceType: "received_payment",
      sourceId: rp.id,
      referenceNumber: rp.paymentNumber,
      memo: `Customer payment received ${rp.paymentNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "default_cash_bank", debit: data.amount, currency: data.currency, fxRate: data.fxRate },
        { mappingKey: "accounts_receivable", credit: data.amount, currency: data.currency, fxRate: data.fxRate },
      ],
    });

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: rp.branchId,
      action: "received_payment.created",
      entityType: "sales",
      entityId: rp.id,
      entityLabel: rp.paymentNumber,
      details: { amount: data.amount },
      ipAddress,
    });

    return rp;
  });
}

export async function voidReceivedPayment(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  reason: string,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [rp] = await tx.select().from(receivedPayments).where(eq(receivedPayments.id, id)).limit(1);
    if (!rp) throw new AppError(404, "Payment not found", "NOT_FOUND");
    if (rp.status === "Voided") throw new AppError(400, "Payment is already voided", "ALREADY_VOIDED");

    const allocs = await tx
      .select()
      .from(receivedPaymentAllocations)
      .where(eq(receivedPaymentAllocations.paymentId, id));

    for (const alloc of allocs) {
      const invRows = await tx.execute<{
        id: string;
        total_amount: string;
        paid_amount: string;
        credit_applied_amount: string;
        retainer_applied_amount: string;
      }>(sql`
        SELECT id, total_amount, paid_amount, credit_applied_amount, retainer_applied_amount
        FROM sales_invoices WHERE id = ${alloc.invoiceId} FOR UPDATE
      `);
      const inv = invRows[0];
      if (!inv) continue;
      const nextPaid = Math.max(0, num(inv.paid_amount) - num(alloc.amount));
      const totalSettled = nextPaid + num(inv.credit_applied_amount) + num(inv.retainer_applied_amount);
      const nextStatus = totalSettled <= 0.0001 ? "Sent" : "Partially Paid";

      await tx
        .update(salesInvoices)
        .set({ paidAmount: toNumeric(nextPaid, 4), status: nextStatus, updatedAt: new Date() })
        .where(eq(salesInvoices.id, inv.id));
    }

    const [res] = await tx
      .update(receivedPayments)
      .set({ status: "Voided", voidReason: reason, voidedAt: new Date(), voidedBy: actor.id })
      .where(eq(receivedPayments.id, id))
      .returning();

    await reverseJournalEntriesForSource(tx, "received_payment", id, actor.id, reason);

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: rp.branchId,
      action: "received_payment.voided",
      entityType: "sales",
      entityId: id,
      entityLabel: rp.paymentNumber,
      details: { reason },
      ipAddress,
    });
    return res;
  });
}

export async function listSalesReturns(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    salesReturns,
    salesReturns.branchId,
    salesReturns.createdAt,
    actor
  )) as Array<typeof salesReturns.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(salesReturnLines)
    .where(inArray(salesReturnLines.returnId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.returnId);

  return headers.map((r) => ({
    ...r,
    subtotal: num(r.subtotal),
    taxTotal: num(r.taxTotal),
    totalAmount: num(r.totalAmount),
    appliedAmount: num(r.appliedAmount),
    returnDate: r.returnDate.toISOString(),
    createdAt: r.createdAt.toISOString(),
    lines: (linesMap.get(r.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      unitCostSnapshot: num(l.unitCostSnapshot),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));
}

export async function createSalesReturn(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof salesReturnSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const returnNumber = await nextDocNumber(tx, "SRET", "SRTN-");
    const creditNoteNumber = await nextDocNumber(tx, "CN", "CN-");

    let subtotal = 0;
    let taxTotal = 0;
    const computed = data.lines.map((l) => {
      const { taxable, taxAmount, lineTotal } = calculateLineAmounts(
        { quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate },
        4
      );
      subtotal += taxable;
      taxTotal += taxAmount;
      return { ...l, taxAmount, lineTotal };
    });

    const [ret] = await tx
      .insert(salesReturns)
      .values({
        returnNumber,
        creditNoteNumber,
        customerId: data.customerId,
        branchId: data.branchId,
        invoiceId: data.invoiceId ?? null,
        status: "Open",
        returnDate: data.returnDate ? new Date(data.returnDate) : new Date(),
        reason: data.reason,
        restockItems: data.restockItems,
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        appliedAmount: "0",
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    const sorted = [...computed].sort((a, b) => a.productId.localeCompare(b.productId));
    let totalRestockVal = 0;

    for (const line of sorted) {
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

      let unitCostSnapshot = num(prod.costPrice);
      if (data.restockItems) {
        const moved = await applyBranchStockMovement(tx, {
          branchId: data.branchId,
          productId: line.productId,
          qtyDelta: line.quantity,
          fallbackCost: unitCostSnapshot,
          recomputeAvgCost: true,
          movementType: "sales_return",
          referenceType: "sales_return",
          referenceId: ret.id,
          referenceNumber: ret.returnNumber,
          notes: `Sales return ${ret.returnNumber} restocked`,
          actorId: actor.id,
        });
        unitCostSnapshot = moved.movementCost;
        totalRestockVal += Math.abs(moved.totalValueDelta);
      }

      await tx.insert(salesReturnLines).values({
        returnId: ret.id,
        productId: line.productId,
        quantity: toNumeric(line.quantity, 4),
        unitPrice: toNumeric(line.unitPrice, 4),
        unitCostSnapshot: toNumeric(unitCostSnapshot, 4),
        taxRate: toNumeric(line.taxRate, 4),
        taxAmount: toNumeric(line.taxAmount, 4),
        lineTotal: toNumeric(line.lineTotal, 4),
      });
    }

    await postMappedJournal(tx, {
      branchId: ret.branchId,
      entryDate: ret.returnDate,
      sourceType: "sales_return",
      sourceId: ret.id,
      referenceNumber: ret.creditNoteNumber,
      memo: `Sales return & credit note ${ret.creditNoteNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "sales_revenue", debit: subtotal },
        { mappingKey: "output_vat", debit: taxTotal },
        { mappingKey: "accounts_receivable", credit: subtotal + taxTotal },
      ],
    });

    if (totalRestockVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: ret.branchId,
        entryDate: ret.returnDate,
        sourceType: "sales_return",
        sourceId: ret.id,
        referenceNumber: ret.returnNumber,
        memo: `Sales return restock ${ret.returnNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "inventory_asset", debit: totalRestockVal },
          { mappingKey: "cogs", credit: totalRestockVal },
        ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "sales_return.created",
      entityType: "sales",
      entityId: ret.id,
      entityLabel: `${ret.returnNumber} (${ret.creditNoteNumber})`,
      ipAddress,
    });
    return ret;
  });
}

export async function applySalesReturnCredit(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof applyAmountSchema>,
  ipAddress?: string
) {
  await db.transaction(async (tx) => {
    const retRows = await tx.execute<{
      id: string;
      credit_note_number: string;
      customer_id: string;
      total_amount: string;
      applied_amount: string;
    }>(sql`SELECT id, credit_note_number, customer_id, total_amount, applied_amount FROM sales_returns WHERE id = ${id} FOR UPDATE`);
    const ret = retRows[0];
    if (!ret) throw new AppError(404, "Credit note not found", "NOT_FOUND");

    const creditRemaining = num(ret.total_amount) - num(ret.applied_amount);
    if (data.amount > creditRemaining + 0.0001) {
      throw new AppError(400, "Amount exceeds remaining credit note balance", "EXCEEDS_CREDIT");
    }

    const invRows = await tx.execute<{
      id: string;
      customer_id: string;
      total_amount: string;
      paid_amount: string;
      credit_applied_amount: string;
      retainer_applied_amount: string;
      status: string;
    }>(sql`
      SELECT id, customer_id, total_amount, paid_amount, credit_applied_amount, retainer_applied_amount, status
      FROM sales_invoices WHERE id = ${data.invoiceId} FOR UPDATE
    `);
    const inv = invRows[0];
    if (!inv) throw new AppError(404, "Target invoice not found", "NOT_FOUND");
    if (inv.customer_id !== ret.customer_id) {
      throw new AppError(400, "Credit note and invoice belong to different customers", "CUSTOMER_MISMATCH");
    }

    const settled = num(inv.paid_amount) + num(inv.credit_applied_amount) + num(inv.retainer_applied_amount);
    const invBalance = num(inv.total_amount) - settled;
    if (data.amount > invBalance + 0.0001) {
      throw new AppError(400, "Amount exceeds remaining invoice balance", "EXCEEDS_INVOICE_BALANCE");
    }

    const nextApplied = num(ret.applied_amount) + data.amount;
    const nextCreditOnInv = num(inv.credit_applied_amount) + data.amount;
    const nextInvStatus = settled + data.amount >= num(inv.total_amount) - 0.0001 ? "Paid" : "Partially Paid";

    await tx
      .update(salesReturns)
      .set({
        appliedAmount: toNumeric(nextApplied, 4),
        status: nextApplied >= num(ret.total_amount) - 0.0001 ? "Applied" : "Open",
      })
      .where(eq(salesReturns.id, id));

    await tx
      .update(salesInvoices)
      .set({
        creditAppliedAmount: toNumeric(nextCreditOnInv, 4),
        status: nextInvStatus,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id));

    await tx.insert(creditNoteApplications).values({
      returnId: id,
      invoiceId: inv.id,
      amount: toNumeric(data.amount, 4),
      createdBy: actor.id,
    });

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "credit_note.applied",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.credit_note_number,
      details: { invoiceId: inv.id, amount: data.amount },
      ipAddress,
    });
  });
}

export async function listRetainerInvoices(db: AppDatabase) {
  const list = await db.select().from(retainerInvoices).orderBy(desc(retainerInvoices.createdAt));
  return list.map((r) => ({
    ...r,
    fxRate: num(r.fxRate),
    amount: num(r.amount),
    paidAmount: num(r.paidAmount),
    appliedAmount: num(r.appliedAmount),
    issueDate: r.issueDate.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createRetainerInvoice(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof retainerSchema>,
  ipAddress?: string
) {
  if (data.branchId) assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const retainerNumber = await nextDocNumber(tx, "RET", "RET-");
    const paidAmount = data.status === "Paid" ? data.amount : 0;
    const [row] = await tx
      .insert(retainerInvoices)
      .values({
        retainerNumber,
        customerId: data.customerId,
        branchId: data.branchId ?? null,
        status: data.status,
        issueDate: data.issueDate ? new Date(data.issueDate) : new Date(),
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        amount: toNumeric(data.amount, 4),
        paidAmount: toNumeric(paidAmount, 4),
        appliedAmount: "0",
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    if (data.status === "Paid") {
      await postMappedJournal(tx, {
        branchId: row.branchId,
        entryDate: row.issueDate,
        sourceType: "retainer",
        sourceId: row.id,
        referenceNumber: row.retainerNumber,
        memo: `Customer retainer received ${row.retainerNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "default_cash_bank", debit: data.amount, currency: data.currency, fxRate: data.fxRate },
          { mappingKey: "retainer_liability", credit: data.amount, currency: data.currency, fxRate: data.fxRate },
        ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: row.branchId,
      action: "retainer.created",
      entityType: "sales",
      entityId: row.id,
      entityLabel: row.retainerNumber,
      ipAddress,
    });
    return row;
  });
}

export async function sendRetainerInvoice(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const [ret] = await tx.select().from(retainerInvoices).where(eq(retainerInvoices.id, id)).limit(1);
    if (!ret) throw new AppError(404, "Retainer not found", "NOT_FOUND");
    if (ret.status !== "Draft") throw new AppError(400, "Only Draft retainers can be sent", "INVALID_STATUS");
    const [res] = await tx.update(retainerInvoices).set({ status: "Sent" }).where(eq(retainerInvoices.id, id)).returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "retainer.sent",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.retainerNumber,
      ipAddress,
    });
    return res;
  });
}

export async function cancelRetainerInvoice(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const [ret] = await tx.select().from(retainerInvoices).where(eq(retainerInvoices.id, id)).limit(1);
    if (!ret) throw new AppError(404, "Retainer not found", "NOT_FOUND");
    if (num(ret.paidAmount) > 0 || num(ret.appliedAmount) > 0) {
      throw new AppError(400, "Cannot cancel a paid or applied retainer invoice", "RETAINER_IN_USE");
    }
    const [res] = await tx
      .update(retainerInvoices)
      .set({ status: "Cancelled" })
      .where(eq(retainerInvoices.id, id))
      .returning();
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "retainer.cancelled",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.retainerNumber,
      ipAddress,
    });
    return res;
  });
}

export async function deleteRetainerInvoice(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  await db.transaction(async (tx) => {
    const [ret] = await tx.select().from(retainerInvoices).where(eq(retainerInvoices.id, id)).limit(1);
    if (!ret) throw new AppError(404, "Retainer not found", "NOT_FOUND");
    if (ret.status !== "Draft") {
      throw new AppError(400, "Only Draft retainer invoices can be deleted", "IMMUTABLE_DOCUMENT");
    }
    await tx.delete(retainerInvoices).where(eq(retainerInvoices.id, id));
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "retainer.deleted",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.retainerNumber,
      ipAddress,
    });
  });
}

export async function recordRetainerPayment(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const [ret] = await tx.select().from(retainerInvoices).where(eq(retainerInvoices.id, id)).limit(1);
    if (!ret) throw new AppError(404, "Retainer not found", "NOT_FOUND");
    const [res] = await tx
      .update(retainerInvoices)
      .set({ paidAmount: ret.amount, status: "Paid" })
      .where(eq(retainerInvoices.id, id))
      .returning();

    if (ret.status !== "Paid") {
      const amt = num(ret.amount);
      const fx = num(ret.fxRate) || 1;
      await postMappedJournal(tx, {
        branchId: ret.branchId,
        entryDate: new Date(),
        sourceType: "retainer",
        sourceId: id,
        referenceNumber: ret.retainerNumber,
        memo: `Retainer payment recorded ${ret.retainerNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "default_cash_bank", debit: amt, currency: ret.currency, fxRate: fx },
          { mappingKey: "retainer_liability", credit: amt, currency: ret.currency, fxRate: fx },
        ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: ret.branchId,
      action: "retainer.paid",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.retainerNumber,
      ipAddress,
    });
    return res;
  });
}

export async function applyRetainer(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof applyAmountSchema>,
  ipAddress?: string
) {
  await db.transaction(async (tx) => {
    const retRows = await tx.execute<{
      id: string;
      retainer_number: string;
      customer_id: string;
      paid_amount: string;
      applied_amount: string;
    }>(sql`SELECT id, retainer_number, customer_id, paid_amount, applied_amount FROM retainer_invoices WHERE id = ${id} FOR UPDATE`);
    const ret = retRows[0];
    if (!ret) throw new AppError(404, "Retainer not found", "NOT_FOUND");

    const available = num(ret.paid_amount) - num(ret.applied_amount);
    if (data.amount > available + 0.0001) {
      throw new AppError(400, "Amount exceeds available paid retainer balance", "EXCEEDS_RETAINER");
    }

    const invRows = await tx.execute<{
      id: string;
      customer_id: string;
      total_amount: string;
      paid_amount: string;
      credit_applied_amount: string;
      retainer_applied_amount: string;
    }>(sql`
      SELECT id, customer_id, total_amount, paid_amount, credit_applied_amount, retainer_applied_amount
      FROM sales_invoices WHERE id = ${data.invoiceId} FOR UPDATE
    `);
    const inv = invRows[0];
    if (!inv) throw new AppError(404, "Target invoice not found", "NOT_FOUND");
    if (inv.customer_id !== ret.customer_id) {
      throw new AppError(400, "Retainer and invoice belong to different customers", "CUSTOMER_MISMATCH");
    }

    const settled = num(inv.paid_amount) + num(inv.credit_applied_amount) + num(inv.retainer_applied_amount);
    const balance = num(inv.total_amount) - settled;
    if (data.amount > balance + 0.0001) {
      throw new AppError(400, "Amount exceeds invoice balance", "EXCEEDS_INVOICE_BALANCE");
    }

    const nextApplied = num(ret.applied_amount) + data.amount;
    const nextInvRetainer = num(inv.retainer_applied_amount) + data.amount;
    const nextInvStatus = settled + data.amount >= num(inv.total_amount) - 0.0001 ? "Paid" : "Partially Paid";

    await tx
      .update(retainerInvoices)
      .set({
        appliedAmount: toNumeric(nextApplied, 4),
        status: nextApplied >= num(ret.paid_amount) - 0.0001 ? "Applied" : "Partially Applied",
      })
      .where(eq(retainerInvoices.id, id));

    await tx
      .update(salesInvoices)
      .set({
        retainerAppliedAmount: toNumeric(nextInvRetainer, 4),
        status: nextInvStatus,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, inv.id));

    await tx.insert(retainerApplications).values({
      retainerId: id,
      invoiceId: inv.id,
      amount: toNumeric(data.amount, 4),
      createdBy: actor.id,
    });

    await postMappedJournal(tx, {
      sourceType: "retainer_application",
      sourceId: id,
      referenceNumber: ret.retainer_number,
      memo: `Applied retainer ${ret.retainer_number} to invoice`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "retainer_liability", debit: data.amount },
        { mappingKey: "accounts_receivable", credit: data.amount },
      ],
    });

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "retainer.applied",
      entityType: "sales",
      entityId: id,
      entityLabel: ret.retainer_number,
      details: { invoiceId: inv.id, amount: data.amount },
      ipAddress,
    });
  });
}
