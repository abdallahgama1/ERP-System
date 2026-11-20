import { asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { calculateLineAmounts, type invoiceSchema } from "@erp/shared";
import {
  products,
  salesInvoiceLines,
  salesInvoices,
  salesOrderLines,
  salesOrders,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { applyInvoiceEInvoiceMetadata } from "./einvoicing.service.ts";
import { postMappedJournal, reverseJournalEntriesForSource } from "./gl.service.ts";
import { groupByKey, listBranchScoped } from "./query-helpers.ts";
import { applyBranchStockMovement, type RequestActor } from "./stock-locks.ts";

export async function listSalesInvoices(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    salesInvoices,
    salesInvoices.branchId,
    salesInvoices.createdAt,
    actor
  )) as Array<typeof salesInvoices.$inferSelect>;
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(salesInvoiceLines)
    .where(inArray(salesInvoiceLines.invoiceId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.invoiceId);

  return headers.map((inv) => ({
    ...inv,
    fxRate: num(inv.fxRate),
    subtotal: num(inv.subtotal),
    taxTotal: num(inv.taxTotal),
    totalAmount: num(inv.totalAmount),
    paidAmount: num(inv.paidAmount),
    creditAppliedAmount: num(inv.creditAppliedAmount),
    retainerAppliedAmount: num(inv.retainerAppliedAmount),
    invoiceDate: inv.invoiceDate.toISOString(),
    dueDate: inv.dueDate.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    lines: (linesMap.get(inv.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      unitCostSnapshot: num(l.unitCostSnapshot),
      discount: num(l.discount),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));
}

export async function createSalesInvoice(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof invoiceSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const invoiceNumber = await nextDocNumber(tx, "INV", "INV-");
    let subtotal = 0;
    let taxTotal = 0;
    const computedLines = data.lines.map((l) => {
      const { taxable, taxAmount, lineTotal } = calculateLineAmounts(
        { quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate },
        4
      );
      subtotal += taxable;
      taxTotal += taxAmount;
      return { ...l, taxAmount, lineTotal };
    });

    const [inv] = await tx
      .insert(salesInvoices)
      .values({
        invoiceNumber,
        customerId: data.customerId,
        branchId: data.branchId,
        soId: data.soId ?? null,
        status: data.status,
        invoiceDate: data.invoiceDate ? new Date(data.invoiceDate) : new Date(),
        dueDate: new Date(data.dueDate),
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    const shouldDeduct = data.status === "Sent";
    const sorted = [...computedLines].sort((a, b) => (a.productId ?? "").localeCompare(b.productId ?? ""));
    let totalCogsVal = 0;

    for (const line of sorted) {
      let unitCostSnapshot = 0;
      if (line.productId && shouldDeduct) {
        const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
        if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

        const moved = await applyBranchStockMovement(tx, {
          branchId: data.branchId,
          productId: line.productId,
          qtyDelta: -line.quantity,
          fallbackCost: num(prod.costPrice),
          movementType: "sales_invoice",
          referenceType: "sales_invoice",
          referenceId: inv.id,
          referenceNumber: inv.invoiceNumber,
          insufficientStockMessage: `Insufficient stock for ${prod.name}: requested ${line.quantity}`,
          notes: `Sales invoice ${inv.invoiceNumber}`,
          actorId: actor.id,
        });
        unitCostSnapshot = moved.movementCost;
        totalCogsVal += Math.abs(moved.totalValueDelta);
      }

      await tx.insert(salesInvoiceLines).values({
        invoiceId: inv.id,
        productId: line.productId ?? null,
        description: line.description,
        quantity: toNumeric(line.quantity, 4),
        unitPrice: toNumeric(line.unitPrice, 4),
        unitCostSnapshot: toNumeric(unitCostSnapshot, 4),
        discount: toNumeric(line.discount, 4),
        taxRate: toNumeric(line.taxRate, 4),
        taxAmount: toNumeric(line.taxAmount, 4),
        lineTotal: toNumeric(line.lineTotal, 4),
      });
    }

    if (shouldDeduct) {
      await postMappedJournal(tx, {
        branchId: inv.branchId,
        entryDate: inv.invoiceDate,
        sourceType: "sales_invoice",
        sourceId: inv.id,
        referenceNumber: inv.invoiceNumber,
        memo: `Sales invoice ${inv.invoiceNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "accounts_receivable", debit: subtotal + taxTotal, currency: data.currency, fxRate: data.fxRate },
          { mappingKey: "sales_revenue", credit: subtotal, currency: data.currency, fxRate: data.fxRate },
          { mappingKey: "output_vat", credit: taxTotal, currency: data.currency, fxRate: data.fxRate },
        ],
      });

      if (totalCogsVal > 0.0001) {
        await postMappedJournal(tx, {
          branchId: inv.branchId,
          entryDate: inv.invoiceDate,
          sourceType: "sales_invoice",
          sourceId: inv.id,
          referenceNumber: inv.invoiceNumber,
          memo: `Sales invoice COGS ${inv.invoiceNumber}`,
          createdBy: actor.id,
          lines: [
            { mappingKey: "cogs", debit: totalCogsVal },
            { mappingKey: "inventory_asset", credit: totalCogsVal },
          ],
        });
      }

      const einv = await applyInvoiceEInvoiceMetadata(tx, inv.id);
      inv.eInvoiceStatus = einv.eInvoiceStatus;
      inv.icv = einv.icv;
      inv.invoiceHash = einv.invoiceHash;
      inv.prevInvoiceHash = einv.prevInvoiceHash;
      inv.qrTlv = einv.qrTlv;
    }

    if (data.soId && shouldDeduct) {
      const soLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.soId, data.soId));
      for (const line of sorted) {
        if (!line.productId) continue;
        const match = soLines.find((sl) => sl.productId === line.productId);
        if (match) {
          await tx
            .update(salesOrderLines)
            .set({ invoicedQty: toNumeric(num(match.invoicedQty) + line.quantity, 4) })
            .where(eq(salesOrderLines.id, match.id));
        }
      }
      const refreshed = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.soId, data.soId));
      const allFulfilled = refreshed.every((sl) => num(sl.invoicedQty) >= num(sl.quantity));
      await tx
        .update(salesOrders)
        .set({ status: allFulfilled ? "Fulfilled" : "Partially Fulfilled", updatedAt: new Date() })
        .where(eq(salesOrders.id, data.soId));
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: inv.branchId,
      action: "sales_invoice.created",
      entityType: "sales",
      entityId: inv.id,
      entityLabel: inv.invoiceNumber,
      ipAddress,
    });

    return inv;
  });
}

export async function sendSalesInvoice(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  return db.transaction(async (tx) => {
    const invRows = await tx.execute<{
      id: string;
      invoice_number: string;
      branch_id: string;
      so_id: string | null;
      status: string;
      invoice_date: Date;
      currency: string;
      fx_rate: string;
      subtotal: string;
      tax_total: string;
      total_amount: string;
    }>(sql`
      SELECT id, invoice_number, branch_id, so_id, status, invoice_date, currency, fx_rate, subtotal, tax_total, total_amount
      FROM sales_invoices WHERE id = ${id} FOR UPDATE
    `);
    const inv = invRows[0];
    if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
    assertBranchAccess(actor, inv.branch_id);
    if (inv.status !== "Draft") {
      throw new AppError(400, "Only Draft invoices can be posted/sent", "INVALID_STATUS");
    }

    const lines = await tx
      .select()
      .from(salesInvoiceLines)
      .where(eq(salesInvoiceLines.invoiceId, id))
      .orderBy(asc(salesInvoiceLines.productId));

    let totalCogsVal = 0;
    for (const line of lines) {
      if (!line.productId) continue;
      const qty = num(line.quantity);
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

      const moved = await applyBranchStockMovement(tx, {
        branchId: inv.branch_id,
        productId: line.productId,
        qtyDelta: -qty,
        fallbackCost: num(prod.costPrice),
        movementType: "sales_invoice",
        referenceType: "sales_invoice",
        referenceId: inv.id,
        referenceNumber: inv.invoice_number,
        insufficientStockMessage: `Insufficient stock for ${prod.name}: requested ${qty}`,
        notes: `Posted sales invoice ${inv.invoice_number}`,
        actorId: actor.id,
      });
      totalCogsVal += Math.abs(moved.totalValueDelta);

      await tx
        .update(salesInvoiceLines)
        .set({ unitCostSnapshot: toNumeric(moved.movementCost, 4) })
        .where(eq(salesInvoiceLines.id, line.id));
    }

    const [res] = await tx
      .update(salesInvoices)
      .set({ status: "Sent", updatedAt: new Date() })
      .where(eq(salesInvoices.id, id))
      .returning();

    const fxRate = num(inv.fx_rate) || 1;
    await postMappedJournal(tx, {
      branchId: inv.branch_id,
      entryDate: new Date(inv.invoice_date),
      sourceType: "sales_invoice",
      sourceId: id,
      referenceNumber: inv.invoice_number,
      memo: `Sales invoice ${inv.invoice_number}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "accounts_receivable", debit: num(inv.total_amount), currency: inv.currency, fxRate },
        { mappingKey: "sales_revenue", credit: num(inv.subtotal), currency: inv.currency, fxRate },
        { mappingKey: "output_vat", credit: num(inv.tax_total), currency: inv.currency, fxRate },
      ],
    });

    if (totalCogsVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: inv.branch_id,
        entryDate: new Date(inv.invoice_date),
        sourceType: "sales_invoice",
        sourceId: id,
        referenceNumber: inv.invoice_number,
        memo: `Sales invoice COGS ${inv.invoice_number}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "cogs", debit: totalCogsVal },
          { mappingKey: "inventory_asset", credit: totalCogsVal },
        ],
      });
    }

    await applyInvoiceEInvoiceMetadata(tx, id);

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: inv.branch_id,
      action: "sales_invoice.sent",
      entityType: "sales",
      entityId: id,
      entityLabel: inv.invoice_number,
      ipAddress,
    });

    return res;
  });
}

export async function voidSalesInvoice(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  reason: string,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id)).limit(1);
    if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
    assertBranchAccess(actor, inv.branchId);
    if (inv.status === "Cancelled") throw new AppError(400, "Invoice is already voided", "ALREADY_VOIDED");
    if (num(inv.paidAmount) > 0 || num(inv.creditAppliedAmount) > 0 || num(inv.retainerAppliedAmount) > 0) {
      throw new AppError(400, "Cannot void invoice with applied payments, credits, or retainers", "INVOICE_SETTLED");
    }

    if (inv.status !== "Draft") {
      const lines = await tx
        .select()
        .from(salesInvoiceLines)
        .where(eq(salesInvoiceLines.invoiceId, id))
        .orderBy(asc(salesInvoiceLines.productId));

      for (const line of lines) {
        if (!line.productId) continue;
        const qty = num(line.quantity);
        const unitCost = num(line.unitCostSnapshot);
        await applyBranchStockMovement(tx, {
          branchId: inv.branchId,
          productId: line.productId,
          qtyDelta: qty,
          unitCostForWmac: unitCost,
          fallbackCost: unitCost,
          recomputeAvgCost: true,
          movementType: "adjustment_in",
          movementUnitCost: unitCost,
          referenceType: "sales_invoice_void",
          referenceId: inv.id,
          referenceNumber: inv.invoiceNumber,
          notes: `Voided invoice ${inv.invoiceNumber}: ${reason}`,
          actorId: actor.id,
        });
      }
    }

    const [res] = await tx
      .update(salesInvoices)
      .set({
        status: "Cancelled",
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(salesInvoices.id, id))
      .returning();

    await reverseJournalEntriesForSource(tx, "sales_invoice", id, actor.id, reason);

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: inv.branchId,
      action: "sales_invoice.voided",
      entityType: "sales",
      entityId: id,
      entityLabel: inv.invoiceNumber,
      details: { reason },
      ipAddress,
    });

    return res;
  });
}
