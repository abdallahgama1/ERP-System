import { roundCurrency } from "@erp/shared";
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import {
  receivedPaymentAllocations,
  receivedPayments,
  retainerInvoices,
  salesInvoices,
  salesOrders,
  salesReturns,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num } from "../db/helpers.ts";

export interface CustomerCreditSummary {
  customerId: string;
  customerName: string;
  creditLimit: number | null;
  openAr: number;
  unbilledConfirmedSo: number;
  unappliedCredits: number;
  currentExposure: number;
}

export async function getCustomerCreditSummary(
  tx: DbOrTx,
  customerId: string,
  options: { lock?: boolean; excludeSoId?: string | null } = {}
): Promise<CustomerCreditSummary> {
  const lockClause = options.lock ? sql`FOR UPDATE` : sql``;
  const custRows = await tx.execute<{
    id: string;
    name: string;
    credit_limit: string | null;
  }>(sql`
    SELECT id, name, credit_limit
    FROM customers
    WHERE id = ${customerId}
    ${lockClause}
  `);

  const cust = custRows[0];
  if (!cust) {
    throw new AppError(404, "Customer not found", "NOT_FOUND");
  }

  const creditLimit = cust.credit_limit === null ? null : num(cust.credit_limit);

  const [arRow] = await tx
    .select({
      openAr: sql<string>`coalesce(sum(greatest(0, ${salesInvoices.totalAmount} - ${salesInvoices.paidAmount} - ${salesInvoices.creditAppliedAmount} - ${salesInvoices.retainerAppliedAmount})), 0)`,
    })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.customerId, customerId),
        notInArray(salesInvoices.status, ["Draft", "Cancelled", "Paid"])
      )
    );

  const soExclude = options.excludeSoId
    ? and(
        eq(salesOrders.customerId, customerId),
        ne(salesOrders.id, options.excludeSoId),
        sql`${salesOrders.status} IN ('Confirmed', 'Partially Fulfilled')`,
        sql`NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.so_id = ${salesOrders.id} AND si.status <> 'Cancelled')`
      )
    : and(
        eq(salesOrders.customerId, customerId),
        sql`${salesOrders.status} IN ('Confirmed', 'Partially Fulfilled')`,
        sql`NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.so_id = ${salesOrders.id} AND si.status <> 'Cancelled')`
      );

  const [soRow] = await tx
    .select({
      unbilledSo: sql<string>`coalesce(sum(${salesOrders.totalAmount}), 0)`,
    })
    .from(salesOrders)
    .where(soExclude);

  const [payRow] = await tx
    .select({
      totalPaid: sql<string>`coalesce(sum(${receivedPayments.amount}), 0)`,
    })
    .from(receivedPayments)
    .where(and(eq(receivedPayments.customerId, customerId), eq(receivedPayments.status, "Posted")));

  const [allocRow] = await tx
    .select({
      totalAllocated: sql<string>`coalesce(sum(${receivedPaymentAllocations.amount}), 0)`,
    })
    .from(receivedPaymentAllocations)
    .innerJoin(receivedPayments, eq(receivedPaymentAllocations.paymentId, receivedPayments.id))
    .where(and(eq(receivedPayments.customerId, customerId), eq(receivedPayments.status, "Posted")));

  const [cnRow] = await tx
    .select({
      openCreditNotes: sql<string>`coalesce(sum(greatest(0, ${salesReturns.totalAmount} - ${salesReturns.appliedAmount})), 0)`,
    })
    .from(salesReturns)
    .where(and(eq(salesReturns.customerId, customerId), ne(salesReturns.status, "Cancelled")));

  const [retRow] = await tx
    .select({
      unappliedRet: sql<string>`coalesce(sum(greatest(0, ${retainerInvoices.paidAmount} - ${retainerInvoices.appliedAmount})), 0)`,
    })
    .from(retainerInvoices)
    .where(
      and(
        eq(retainerInvoices.customerId, customerId),
        sql`${retainerInvoices.status} IN ('Paid', 'Partially Applied')`
      )
    );

  const openAr = roundCurrency(num(arRow?.openAr), 4);
  const unbilledConfirmedSo = roundCurrency(num(soRow?.unbilledSo), 4);
  const unappliedPay = Math.max(0, roundCurrency(num(payRow?.totalPaid) - num(allocRow?.totalAllocated), 4));
  const unappliedCredits = roundCurrency(
    unappliedPay + num(cnRow?.openCreditNotes) + num(retRow?.unappliedRet),
    4
  );
  const currentExposure = Math.max(0, roundCurrency(openAr + unbilledConfirmedSo - unappliedCredits, 4));

  return {
    customerId: cust.id,
    customerName: cust.name,
    creditLimit,
    openAr,
    unbilledConfirmedSo,
    unappliedCredits,
    currentExposure,
  };
}

/**
 * Acquires FOR UPDATE lock on the customer row and validates projected credit exposure
 * against credit_limit (NULL = unlimited, 0 = strict COD, >0 = capped).
 */
export async function assertCustomerCreditLimit(
  tx: DbOrTx,
  customerId: string,
  additionalAmount: number,
  excludeSoId?: string | null
): Promise<CustomerCreditSummary> {
  const summary = await getCustomerCreditSummary(tx, customerId, { lock: true, excludeSoId });
  if (summary.creditLimit === null) {
    return summary;
  }

  const projectedExposure = roundCurrency(summary.currentExposure + Math.max(0, additionalAmount), 4);
  if (projectedExposure > summary.creditLimit + 0.01) {
    throw new AppError(
      400,
      `Credit limit exceeded for ${summary.customerName}: projected exposure ${projectedExposure.toFixed(2)} exceeds limit ${summary.creditLimit.toFixed(2)}`,
      "CREDIT_LIMIT_EXCEEDED",
      {
        customerId: summary.customerId,
        creditLimit: summary.creditLimit,
        currentExposure: summary.currentExposure,
        additionalAmount,
        projectedExposure,
      }
    );
  }

  return summary;
}
