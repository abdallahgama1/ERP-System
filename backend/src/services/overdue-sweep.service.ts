import { and, eq, gt, inArray, isNotNull, lt, lte, type SQL } from "drizzle-orm";
import {
  DEFAULT_COMPANY_ID,
  branchLotBalances,
  notifications,
  products,
  salesInvoices,
  stockLots,
  userCompanies,
  userRoles,
  users,
  vendorBills,
} from "../../drizzle/schema.ts";
import { num, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { sendOverdueDigestEmail } from "./email.service.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

export interface OverdueSweepResult {
  overdueInvoicesMarked: number;
  overdueBillsMarked: number;
  expiringLotsAlerted: number;
  expiredLotsAlerted: number;
  checkedAt: string;
}

export async function runOverdueSweep(
  db: AppDatabase,
  actor?: RequestActor,
  ipAddress?: string
): Promise<OverdueSweepResult> {
  const scopedCompanyId = actor ? actorCompanyId(actor) : undefined;
  const now = new Date();
  const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  let overdueInvoicesMarked = 0;
  let overdueBillsMarked = 0;
  let expiringLotsAlerted = 0;
  let expiredLotsAlerted = 0;

  const perCompanyStats = new Map<
    string,
    {
      overdueInvoicesMarked: number;
      overdueBillsMarked: number;
      expiringLotsAlerted: number;
      expiredLotsAlerted: number;
    }
  >();

  const bumpCompanyStat = (
    companyId: string,
    field: "overdueInvoicesMarked" | "overdueBillsMarked" | "expiringLotsAlerted" | "expiredLotsAlerted"
  ) => {
    const cur = perCompanyStats.get(companyId) ?? {
      overdueInvoicesMarked: 0,
      overdueBillsMarked: 0,
      expiringLotsAlerted: 0,
      expiredLotsAlerted: 0,
    };
    cur[field]++;
    perCompanyStats.set(companyId, cur);
  };

  await db.transaction(async (tx) => {
    const invoiceConds: SQL[] = [
      inArray(salesInvoices.status, ["Sent", "Partially Paid"]),
      lt(salesInvoices.dueDate, now),
    ];
    if (scopedCompanyId) {
      invoiceConds.push(eq(salesInvoices.companyId, scopedCompanyId));
    }

    const pastDueInvoices = await tx
      .select()
      .from(salesInvoices)
      .where(and(...invoiceConds));

    for (const inv of pastDueInvoices) {
      const balance =
        num(inv.totalAmount) -
        num(inv.paidAmount) -
        num(inv.creditAppliedAmount) -
        num(inv.retainerAppliedAmount);
      if (balance <= 0.01) continue;

      const invCompanyId = inv.companyId || DEFAULT_COMPANY_ID;

      await tx
        .update(salesInvoices)
        .set({ status: "Overdue", updatedAt: now })
        .where(and(eq(salesInvoices.id, inv.id), eq(salesInvoices.companyId, invCompanyId)));

      const existingNotif = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.companyId, invCompanyId),
            eq(notifications.type, "overdue_invoice"),
            eq(notifications.entityType, "sales_invoice"),
            eq(notifications.entityId, inv.id)
          )
        )
        .limit(1);

      if (existingNotif.length === 0) {
        await tx.insert(notifications).values({
          companyId: invCompanyId,
          type: "overdue_invoice",
          title: `Overdue Invoice ${inv.invoiceNumber}`,
          message: `Invoice ${inv.invoiceNumber} is past due with outstanding balance ${balance.toFixed(2)}.`,
          branchId: inv.branchId,
          entityType: "sales_invoice",
          entityId: inv.id,
        });
      }

      await writeAuditLog(tx, {
        companyId: invCompanyId,
        userId: actor?.id ?? null,
        userName: actor?.name ?? "System Scheduler",
        userRole: actor?.role ?? "system",
        branchId: inv.branchId,
        action: "invoice.marked_overdue",
        entityType: "sales",
        entityId: inv.id,
        entityLabel: inv.invoiceNumber,
        details: { balance, dueDate: inv.dueDate.toISOString() },
        ipAddress,
      });
      overdueInvoicesMarked++;
      bumpCompanyStat(invCompanyId, "overdueInvoicesMarked");
    }

    const billConds: SQL[] = [
      inArray(vendorBills.status, ["Open", "Partially Paid"]),
      lt(vendorBills.dueDate, now),
    ];
    if (scopedCompanyId) {
      billConds.push(eq(vendorBills.companyId, scopedCompanyId));
    }

    const pastDueBills = await tx
      .select()
      .from(vendorBills)
      .where(and(...billConds));

    for (const bill of pastDueBills) {
      const balance = num(bill.totalAmount) - num(bill.paidAmount);
      if (balance <= 0.01) continue;

      const billCompanyId = bill.companyId || DEFAULT_COMPANY_ID;

      await tx
        .update(vendorBills)
        .set({ status: "Overdue", updatedAt: now })
        .where(and(eq(vendorBills.id, bill.id), eq(vendorBills.companyId, billCompanyId)));

      const existingNotif = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.companyId, billCompanyId),
            eq(notifications.type, "overdue_bill"),
            eq(notifications.entityType, "vendor_bill"),
            eq(notifications.entityId, bill.id)
          )
        )
        .limit(1);

      if (existingNotif.length === 0) {
        await tx.insert(notifications).values({
          companyId: billCompanyId,
          type: "overdue_bill",
          title: `Overdue Vendor Bill ${bill.billNumber}`,
          message: `Vendor bill ${bill.billNumber} is past due with outstanding balance ${balance.toFixed(2)}.`,
          branchId: bill.branchId,
          entityType: "vendor_bill",
          entityId: bill.id,
        });
      }

      await writeAuditLog(tx, {
        companyId: billCompanyId,
        userId: actor?.id ?? null,
        userName: actor?.name ?? "System Scheduler",
        userRole: actor?.role ?? "system",
        branchId: bill.branchId,
        action: "bill.marked_overdue",
        entityType: "purchases",
        entityId: bill.id,
        entityLabel: bill.billNumber,
        details: { balance, dueDate: bill.dueDate.toISOString() },
        ipAddress,
      });
      overdueBillsMarked++;
      bumpCompanyStat(billCompanyId, "overdueBillsMarked");
    }

    // Lot expiry alerts (Expired and Expiring Soon <= 30 days)
    const lotConds: SQL[] = [
      gt(branchLotBalances.qtyOnHand, "0"),
      isNotNull(stockLots.expiryDate),
      lte(stockLots.expiryDate, soonCutoff),
    ];
    if (scopedCompanyId) {
      lotConds.push(eq(branchLotBalances.companyId, scopedCompanyId));
    }

    const riskyLots = await tx
      .select({
        balanceId: branchLotBalances.id,
        companyId: branchLotBalances.companyId,
        branchId: branchLotBalances.branchId,
        qtyOnHand: branchLotBalances.qtyOnHand,
        lotId: stockLots.id,
        lotNumber: stockLots.lotNumber,
        expiryDate: stockLots.expiryDate,
        productName: products.name,
        productSku: products.sku,
      })
      .from(branchLotBalances)
      .innerJoin(stockLots, eq(stockLots.id, branchLotBalances.lotId))
      .innerJoin(products, eq(products.id, branchLotBalances.productId))
      .where(and(...lotConds));

    for (const lot of riskyLots) {
      if (!lot.expiryDate || num(lot.qtyOnHand) <= 0.0001) continue;
      const lotCompanyId = lot.companyId || DEFAULT_COMPANY_ID;
      const isExpired = lot.expiryDate.getTime() < now.getTime();
      const notifType = isExpired ? "lot_expired" : "lot_expiring_soon";
      const existingLotNotif = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.companyId, lotCompanyId),
            eq(notifications.type, notifType),
            eq(notifications.entityType, "stock_lot"),
            eq(notifications.entityId, lot.balanceId)
          )
        )
        .limit(1);

      if (existingLotNotif.length === 0) {
        const expStr = lot.expiryDate.toISOString().slice(0, 10);
        await tx.insert(notifications).values({
          companyId: lotCompanyId,
          type: notifType,
          title: isExpired
            ? `Expired Lot ${lot.lotNumber} (${lot.productSku})`
            : `Lot Expiring Soon ${lot.lotNumber} (${lot.productSku})`,
          message: isExpired
            ? `Lot ${lot.lotNumber} of ${lot.productName} expired on ${expStr} with ${num(lot.qtyOnHand)} units still on hand.`
            : `Lot ${lot.lotNumber} of ${lot.productName} expires on ${expStr} (${num(lot.qtyOnHand)} units on hand).`,
          branchId: lot.branchId,
          entityType: "stock_lot",
          entityId: lot.balanceId,
        });
        if (isExpired) {
          expiredLotsAlerted++;
          bumpCompanyStat(lotCompanyId, "expiredLotsAlerted");
        } else {
          expiringLotsAlerted++;
          bumpCompanyStat(lotCompanyId, "expiringLotsAlerted");
        }
      }
    }
  });

  const result: OverdueSweepResult = {
    overdueInvoicesMarked,
    overdueBillsMarked,
    expiringLotsAlerted,
    expiredLotsAlerted,
    checkedAt: now.toISOString(),
  };

  for (const [compId, stats] of perCompanyStats.entries()) {
    if (stats.overdueInvoicesMarked + stats.overdueBillsMarked + stats.expiredLotsAlerted <= 0) {
      continue;
    }
    let adminEmails = await db
      .select({ email: users.email })
      .from(userCompanies)
      .innerJoin(users, eq(users.id, userCompanies.userId))
      .where(
        and(
          eq(userCompanies.companyId, compId),
          eq(userCompanies.isActive, true),
          eq(userCompanies.role, "admin"),
          eq(users.isActive, true)
        )
      );
    if (adminEmails.length === 0 && compId === DEFAULT_COMPANY_ID) {
      adminEmails = await db
        .select({ email: users.email })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.role, "admin"), eq(users.isActive, true)));
    }
    const recipients = adminEmails.map((a) => a.email).filter(Boolean);
    if (recipients.length > 0) {
      void sendOverdueDigestEmail(recipients, stats);
    }
  }

  return result;
}
