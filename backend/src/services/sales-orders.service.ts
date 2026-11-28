import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  buildOffsetPageInfo,
  calculateLineAmounts,
  customersListQuerySchema,
  resolveSearchTerm,
  salesOrdersListQuerySchema,
  type customerSchema,
  type fulfillSalesOrderSchema,
  type salesOrderSchema,
} from "@erp/shared";
import {
  customers,
  products,
  receivedPayments,
  salesInvoices,
  salesOrderLines,
  salesOrders,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { assertCustomerCreditLimit } from "./credit-limit.service.ts";
import { postMappedJournal } from "./gl.service.ts";
import { groupByKey, listBranchScopedPaginated, parseOffsetQueryOrThrow } from "./query-helpers.ts";
import {
  actorCompanyId,
  applyBranchStockMovement,
  assertBranchInCompany,
  type RequestActor,
} from "./stock-locks.ts";

export async function listCustomers(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery?: Record<string, unknown>
) {
  const companyId = actorCompanyId(actor);
  const query = parseOffsetQueryOrThrow(customersListQuerySchema, rawQuery);
  const conds: SQL[] = [eq(customers.companyId, companyId)];
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    conds.push(
      or(
        ilike(customers.name, pattern),
        ilike(customers.code, pattern),
        ilike(customers.email, pattern),
        ilike(customers.phone, pattern),
        ilike(customers.company, pattern),
        ilike(customers.taxNumber, pattern)
      )!
    );
  }
  const whereClause = and(...conds);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(customers)
    .where(whereClause);

  const dir = query.sortDir === "asc" ? asc : desc;
  const sortCol =
    query.sortBy === "name"
      ? customers.name
      : query.sortBy === "code"
        ? customers.code
        : customers.createdAt;

  const list = await db
    .select()
    .from(customers)
    .where(whereClause)
    .orderBy(dir(sortCol), dir(customers.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const items = list.map((c) => ({
    ...c,
    creditLimit: c.creditLimit === null ? null : num(c.creditLimit),
  }));
  const pageInfo = buildOffsetPageInfo(query.page, query.pageSize, total);
  return { items, customers: items, pageInfo };
}

export async function createCustomer(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof customerSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  const { confirmDuplicate, ...customerFields } = data;
  const row = await db.transaction(async (tx) => {
    const code = (customerFields.code || (await nextDocNumber(tx, "CUST", "CUS-", null, companyId))).trim();
    const dup = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, companyId), sql`lower(btrim(${customers.code})) = lower(btrim(${code}))`))
      .limit(1);
    if (dup.length > 0) {
      throw new AppError(409, `Customer code '${code}' already exists`, "DUPLICATE_CUSTOMER_CODE", {
        field: "code",
        messageEn: `Customer code '${code}' already exists in your company.`,
        messageAr: `يوجد عميل بنفس الكود '${code}' بالفعل في شركتك.`,
      });
    }

    const normalizedTax = (customerFields.taxNumber ?? "").trim();
    if (normalizedTax && !confirmDuplicate) {
      const [dupTax] = await tx
        .select({ id: customers.id, code: customers.code, name: customers.name, taxNumber: customers.taxNumber })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            sql`btrim(${customers.taxNumber}) <> '' AND lower(btrim(${customers.taxNumber})) = lower(btrim(${normalizedTax}))`
          )
        )
        .limit(1);
      if (dupTax) {
        throw new AppError(
          409,
          `Tax registration number '${normalizedTax}' is already used by customer '${dupTax.name}' (${dupTax.code}). Resubmit with confirmDuplicate=true to proceed.`,
          "DUPLICATE_TAX_NUMBER_WARNING",
          {
            field: "taxNumber",
            taxNumber: normalizedTax,
            existingId: dupTax.id,
            existingCode: dupTax.code,
            existingName: dupTax.name,
            canOverride: true,
            messageEn: `Tax registration number '${normalizedTax}' is already used by customer '${dupTax.name}' (${dupTax.code}).`,
            messageAr: `رقم التسجيل الضريبي '${normalizedTax}' مستخدم بالفعل لدى العميل '${dupTax.name}' (${dupTax.code}).`,
          }
        );
      }
    }

    const resolvedReceiverType: "B" | "P" | "F" =
      customerFields.etaReceiverType ??
      (customerFields.company?.trim() || normalizedTax ? "B" : "P");

    const [inserted] = await tx
      .insert(customers)
      .values({
        ...customerFields,
        etaReceiverType: resolvedReceiverType,
        companyId,
        code,
        creditLimit:
          customerFields.creditLimit === null || customerFields.creditLimit === undefined
            ? null
            : toNumeric(customerFields.creditLimit, 4),
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "customer.created",
      entityType: "sales",
      entityId: inserted.id,
      entityLabel: `${inserted.name} (${inserted.code})`,
      ipAddress,
    });
    return inserted;
  });

  return { ...row, creditLimit: row.creditLimit === null ? null : num(row.creditLimit) };
}

export async function updateCustomer(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: Partial<z.infer<typeof customerSchema>>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  const { confirmDuplicate, ...customerFields } = data;
  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Customer not found", "NOT_FOUND");
    if (customerFields.code && customerFields.code.trim().toLowerCase() !== current.code.trim().toLowerCase()) {
      const dup = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            sql`lower(btrim(${customers.code})) = lower(btrim(${customerFields.code}))`
          )
        )
        .limit(1);
      if (dup.length > 0) {
        throw new AppError(409, `Customer code '${customerFields.code}' already exists`, "DUPLICATE_CUSTOMER_CODE", {
          field: "code",
          messageEn: `Customer code '${customerFields.code}' already exists in your company.`,
          messageAr: `يوجد عميل بنفس الكود '${customerFields.code}' بالفعل في شركتك.`,
        });
      }
    }

    const nextTax = (customerFields.taxNumber ?? "").trim();
    if (customerFields.taxNumber !== undefined && nextTax && !confirmDuplicate) {
      const [dupTax] = await tx
        .select({ id: customers.id, code: customers.code, name: customers.name })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            sql`${customers.id} <> ${id}`,
            sql`btrim(${customers.taxNumber}) <> '' AND lower(btrim(${customers.taxNumber})) = lower(btrim(${nextTax}))`
          )
        )
        .limit(1);
      if (dupTax) {
        throw new AppError(
          409,
          `Tax registration number '${nextTax}' is already used by customer '${dupTax.name}' (${dupTax.code}). Resubmit with confirmDuplicate=true to proceed.`,
          "DUPLICATE_TAX_NUMBER_WARNING",
          {
            field: "taxNumber",
            taxNumber: nextTax,
            existingId: dupTax.id,
            existingCode: dupTax.code,
            existingName: dupTax.name,
            canOverride: true,
            messageEn: `Tax registration number '${nextTax}' is already used by customer '${dupTax.name}' (${dupTax.code}).`,
            messageAr: `رقم التسجيل الضريبي '${nextTax}' مستخدم بالفعل لدى العميل '${dupTax.name}' (${dupTax.code}).`,
          }
        );
      }
    }

    const [updated] = await tx
      .update(customers)
      .set({
        ...customerFields,
        creditLimit:
          customerFields.creditLimit === undefined
            ? current.creditLimit
            : customerFields.creditLimit === null
              ? null
              : toNumeric(customerFields.creditLimit, 4),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "customer.updated",
      entityType: "sales",
      entityId: id,
      entityLabel: updated.name,
      ipAddress,
    });
    return updated;
  });

  return { ...row, creditLimit: row.creditLimit === null ? null : num(row.creditLimit) };
}

export async function deleteCustomer(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  const companyId = actorCompanyId(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Customer not found", "NOT_FOUND");

    const [{ soC }] = await tx
      .select({ soC: sql<number>`count(*)::int` })
      .from(salesOrders)
      .where(and(eq(salesOrders.companyId, companyId), eq(salesOrders.customerId, id)));
    const [{ invC }] = await tx
      .select({ invC: sql<number>`count(*)::int` })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.companyId, companyId), eq(salesInvoices.customerId, id)));
    const [{ payC }] = await tx
      .select({ payC: sql<number>`count(*)::int` })
      .from(receivedPayments)
      .where(and(eq(receivedPayments.companyId, companyId), eq(receivedPayments.customerId, id)));

    if (soC > 0 || invC > 0 || payC > 0) {
      throw new AppError(409, "Cannot delete customer with existing orders, invoices, or payments", "CUSTOMER_IN_USE");
    }

    await tx.delete(customers).where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "customer.deleted",
      entityType: "sales",
      entityId: id,
      entityLabel: current.name,
      ipAddress,
    });
  });
}

function summarizePriceLines(lines: z.infer<typeof salesOrderSchema>["lines"]) {
  let subtotal = 0;
  let taxTotal = 0;
  const computed = lines.map((l) => {
    const { taxable, taxAmount, lineTotal } = calculateLineAmounts(
      { quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate },
      4
    );
    subtotal += taxable;
    taxTotal += taxAmount;
    return { ...l, taxAmount, lineTotal };
  });
  return { subtotal, taxTotal, computed };
}

export async function listSalesOrders(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery?: Record<string, unknown>
) {
  const companyId = actorCompanyId(actor);
  const query = parseOffsetQueryOrThrow(salesOrdersListQuerySchema, rawQuery);
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
  }

  const extraConditions: SQL[] = [];
  if (query.status) {
    extraConditions.push(eq(salesOrders.status, query.status));
  }
  if (query.customerId) {
    extraConditions.push(eq(salesOrders.customerId, query.customerId));
  }
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    const matchedCustomers = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, companyId), ilike(customers.name, pattern)));
    const customerIds = matchedCustomers.map((c) => c.id);
    if (customerIds.length > 0) {
      extraConditions.push(
        or(
          ilike(salesOrders.soNumber, pattern),
          ilike(salesOrders.notes, pattern),
          inArray(salesOrders.customerId, customerIds)
        )!
      );
    } else {
      extraConditions.push(
        or(ilike(salesOrders.soNumber, pattern), ilike(salesOrders.notes, pattern))!
      );
    }
  }

  const sortCol =
    query.sortBy === "orderDate"
      ? salesOrders.orderDate
      : query.sortBy === "soNumber"
        ? salesOrders.soNumber
        : query.sortBy === "totalAmount"
          ? salesOrders.totalAmount
          : salesOrders.createdAt;

  const { rows, pageInfo } = await listBranchScopedPaginated(
    db,
    salesOrders,
    salesOrders.branchId,
    sortCol,
    salesOrders.id,
    actor,
    {
      page: query.page,
      pageSize: query.pageSize,
      sortDir: query.sortDir,
      requestedBranchId: query.branchId,
      extraConditions,
    }
  );
  const headers = rows as Array<typeof salesOrders.$inferSelect>;
  if (headers.length === 0) return { items: [], salesOrders: [], pageInfo };

  const lines = await db
    .select()
    .from(salesOrderLines)
    .where(inArray(salesOrderLines.soId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.soId);

  const items = headers.map((so) => ({
    ...so,
    fxRate: num(so.fxRate),
    subtotal: num(so.subtotal),
    taxTotal: num(so.taxTotal),
    totalAmount: num(so.totalAmount),
    orderDate: so.orderDate.toISOString(),
    expectedShipmentDate: so.expectedShipmentDate?.toISOString() ?? null,
    createdAt: so.createdAt.toISOString(),
    lines: (linesMap.get(so.id) ?? []).map((l) => ({
      ...l,
      quantity: num(l.quantity),
      invoicedQty: num(l.invoicedQty),
      unitPrice: num(l.unitPrice),
      discount: num(l.discount),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    })),
  }));

  return { items, salesOrders: items, pageInfo };
}

export async function createSalesOrder(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof salesOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);
    const [cust] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, data.customerId), eq(customers.companyId, companyId)))
      .limit(1);
    if (!cust) throw new AppError(404, "Customer not found", "NOT_FOUND");

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

    const soNumber = await nextDocNumber(tx, "SO", "SO-", null, companyId);
    const { subtotal, taxTotal, computed } = summarizePriceLines(data.lines);
    if (data.status === "Confirmed") {
      await assertCustomerCreditLimit(tx, data.customerId, subtotal + taxTotal, null, companyId);
    }

    const [so] = await tx
      .insert(salesOrders)
      .values({
        companyId,
        soNumber,
        customerId: data.customerId,
        branchId: data.branchId,
        status: data.status,
        orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
        expectedShipmentDate: data.expectedShipmentDate ? new Date(data.expectedShipmentDate) : null,
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        notes: data.notes,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(salesOrderLines).values(
      computed.map((l) => ({
        soId: so.id,
        productId: l.productId,
        description: l.description,
        quantity: toNumeric(l.quantity, 4),
        invoicedQty: "0",
        unitPrice: toNumeric(l.unitPrice, 4),
        discount: toNumeric(l.discount, 4),
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: so.branchId,
      action: "so.created",
      entityType: "sales",
      entityId: so.id,
      entityLabel: so.soNumber,
      ipAddress,
    });

    return so;
  });
}

export async function updateSalesOrder(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof salesOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Sales order not found", "NOT_FOUND");
    assertBranchAccess(actor, current.branchId);
    if (current.status !== "Draft") {
      throw new AppError(400, "Only Draft sales orders can be edited", "IMMUTABLE_DOCUMENT");
    }

    await assertBranchInCompany(tx, data.branchId, companyId);
    const [cust] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, data.customerId), eq(customers.companyId, companyId)))
      .limit(1);
    if (!cust) throw new AppError(404, "Customer not found", "NOT_FOUND");

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

    const { subtotal, taxTotal, computed } = summarizePriceLines(data.lines);
    if (data.status === "Confirmed") {
      await assertCustomerCreditLimit(tx, data.customerId, subtotal + taxTotal, id, companyId);
    }
    const [so] = await tx
      .update(salesOrders)
      .set({
        customerId: data.customerId,
        branchId: data.branchId,
        status: data.status,
        orderDate: data.orderDate ? new Date(data.orderDate) : current.orderDate,
        expectedShipmentDate: data.expectedShipmentDate ? new Date(data.expectedShipmentDate) : null,
        currency: data.currency,
        fxRate: toNumeric(data.fxRate, 6),
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(subtotal + taxTotal, 4),
        notes: data.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .returning();

    await tx.delete(salesOrderLines).where(eq(salesOrderLines.soId, id));
    await tx.insert(salesOrderLines).values(
      computed.map((l) => ({
        soId: id,
        productId: l.productId,
        description: l.description,
        quantity: toNumeric(l.quantity, 4),
        invoicedQty: "0",
        unitPrice: toNumeric(l.unitPrice, 4),
        discount: toNumeric(l.discount, 4),
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: so.branchId,
      action: "so.updated",
      entityType: "sales",
      entityId: id,
      entityLabel: so.soNumber,
      ipAddress,
    });

    return so;
  });
}

export async function confirmSalesOrder(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .limit(1);
    if (!so) throw new AppError(404, "Sales order not found", "NOT_FOUND");
    assertBranchAccess(actor, so.branchId);
    if (so.status !== "Draft") throw new AppError(400, "Only Draft sales orders can be confirmed", "INVALID_STATUS");
    await assertCustomerCreditLimit(tx, so.customerId, num(so.totalAmount), id, companyId);

    const [res] = await tx
      .update(salesOrders)
      .set({ status: "Confirmed", updatedAt: new Date() })
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: so.branchId,
      action: "so.confirmed",
      entityType: "sales",
      entityId: id,
      entityLabel: so.soNumber,
      ipAddress,
    });
    return res;
  });
}

export async function fulfillSalesOrder(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof fulfillSalesOrderSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .limit(1);
    if (!so) throw new AppError(404, "Sales order not found", "NOT_FOUND");
    assertBranchAccess(actor, so.branchId);
    if (so.status === "Cancelled" || so.status === "Closed") {
      throw new AppError(400, "Cannot fulfill cancelled or closed order", "INVALID_STATUS");
    }

    const soLines = await tx
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.soId, id))
      .orderBy(asc(salesOrderLines.productId));

    let totalCogsVal = 0;

    for (const reqLine of data.lines) {
      const match = soLines.find((l) => l.id === reqLine.itemId);
      if (!match) throw new AppError(404, `Sales order line ${reqLine.itemId} not found`, "NOT_FOUND");
      const remaining = num(match.quantity) - num(match.invoicedQty);
      if (reqLine.qty > remaining + 0.0001) {
        throw new AppError(400, "Fulfill quantity exceeds remaining ordered quantity", "EXCEEDS_ORDERED");
      }

      const [prod] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, match.productId), eq(products.companyId, companyId)))
        .limit(1);
      const moved = await applyBranchStockMovement(tx, {
        companyId,
        branchId: so.branchId,
        productId: match.productId,
        qtyDelta: -reqLine.qty,
        fallbackCost: prod ? num(prod.costPrice) : 0,
        movementType: "sales_invoice",
        referenceType: "sales_order",
        referenceId: so.id,
        referenceNumber: so.soNumber,
        insufficientStockMessage: `Insufficient stock for ${prod?.name ?? match.productId}`,
        notes: `Fulfilled sales order ${so.soNumber}`,
        actorId: actor.id,
      });
      totalCogsVal += Math.abs(moved.totalValueDelta);

      await tx
        .update(salesOrderLines)
        .set({ invoicedQty: toNumeric(num(match.invoicedQty) + reqLine.qty, 4) })
        .where(eq(salesOrderLines.id, match.id));
    }

    if (totalCogsVal > 0.0001) {
      await postMappedJournal(tx, {
        companyId,
        branchId: so.branchId,
        sourceType: "sales_order_fulfill",
        sourceId: so.id,
        referenceNumber: so.soNumber,
        memo: `Sales order fulfillment COGS ${so.soNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "cogs", debit: totalCogsVal },
          { mappingKey: "inventory_asset", credit: totalCogsVal },
        ],
      });
    }

    const refreshed = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.soId, id));
    const allFulfilled = refreshed.every((l) => num(l.invoicedQty) >= num(l.quantity) - 0.0001);

    const [res] = await tx
      .update(salesOrders)
      .set({ status: allFulfilled ? "Fulfilled" : "Partially Fulfilled", updatedAt: new Date() })
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: so.branchId,
      action: "so.fulfilled",
      entityType: "sales",
      entityId: id,
      entityLabel: so.soNumber,
      ipAddress,
    });
    return res;
  });
}

export async function cancelSalesOrder(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .limit(1);
    if (!so) throw new AppError(404, "Sales order not found", "NOT_FOUND");
    assertBranchAccess(actor, so.branchId);
    if (so.status === "Fulfilled" || so.status === "Closed") {
      throw new AppError(400, "Cannot cancel fulfilled or closed sales orders", "INVALID_STATUS");
    }

    const [res] = await tx
      .update(salesOrders)
      .set({ status: "Cancelled", updatedAt: new Date() })
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: so.branchId,
      action: "so.cancelled",
      entityType: "sales",
      entityId: id,
      entityLabel: so.soNumber,
      ipAddress,
    });
    return res;
  });
}

export async function deleteSalesOrder(db: AppDatabase, actor: RequestActor, id: string) {
  const companyId = actorCompanyId(actor);
  await db.transaction(async (tx) => {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)))
      .limit(1);
    if (!so) throw new AppError(404, "Sales order not found", "NOT_FOUND");
    assertBranchAccess(actor, so.branchId);
    if (so.status !== "Draft") throw new AppError(400, "Only Draft sales orders can be deleted", "IMMUTABLE_DOCUMENT");
    await tx.delete(salesOrders).where(and(eq(salesOrders.id, id), eq(salesOrders.companyId, companyId)));
  });
}
