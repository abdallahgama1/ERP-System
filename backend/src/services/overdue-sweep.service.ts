import { and, eq, inArray, lt } from "drizzle-orm";
import { notifications, salesInvoices, vendorBills } from "../../drizzle/schema.ts";
import { num, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import type { RequestActor } from "./stock-locks.ts";

export interface OverdueSweepResult {
  overdueInvoicesMarked: number;
  overdueBillsMarked: number;
  checkedAt: string;
}

export async function runOverdueSweep(
  db: AppDatabase,
  actor?: RequestActor,
  ipAddress?: string
): Promise<OverdueSweepResult> {
  const now = new Date();
  let overdueInvoicesMarked = 0;
  let overdueBillsMarked = 0;

  await db.transaction(async (tx) => {
    const pastDueInvoices = await tx
      .select()
      .from(salesInvoices)
      .where(
        and(
          inArray(salesInvoices.status, ["Sent", "Partially Paid"]),
          lt(salesInvoices.dueDate, now)
        )
      );

    for (const inv of pastDueInvoices) {
      const balance =
        num(inv.totalAmount) -
        num(inv.paidAmount) -
        num(inv.creditAppliedAmount) -
        num(inv.retainerAppliedAmount);
      if (balance <= 0.01) continue;

      await tx
        .update(salesInvoices)
        .set({ status: "Overdue", updatedAt: now })
        .where(eq(salesInvoices.id, inv.id));

      const existingNotif = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "overdue_invoice"),
            eq(notifications.entityType, "sales_invoice"),
            eq(notifications.entityId, inv.id)
          )
        )
        .limit(1);

      if (existingNotif.length === 0) {
        await tx.insert(notifications).values({
          type: "overdue_invoice",
          title: `Overdue Invoice ${inv.invoiceNumber}`,
          message: `Invoice ${inv.invoiceNumber} is past due with outstanding balance ${balance.toFixed(2)}.`,
          branchId: inv.branchId,
          entityType: "sales_invoice",
          entityId: inv.id,
        });
      }

      await writeAuditLog(tx, {
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
    }

    const pastDueBills = await tx
      .select()
      .from(vendorBills)
      .where(
        and(
          inArray(vendorBills.status, ["Open", "Partially Paid"]),
          lt(vendorBills.dueDate, now)
        )
      );

    for (const bill of pastDueBills) {
      const balance = num(bill.totalAmount) - num(bill.paidAmount);
      if (balance <= 0.01) continue;

      await tx
        .update(vendorBills)
        .set({ status: "Overdue", updatedAt: now })
        .where(eq(vendorBills.id, bill.id));

      const existingNotif = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, "overdue_bill"),
            eq(notifications.entityType, "vendor_bill"),
            eq(notifications.entityId, bill.id)
          )
        )
        .limit(1);

      if (existingNotif.length === 0) {
        await tx.insert(notifications).values({
          type: "overdue_bill",
          title: `Overdue Vendor Bill ${bill.billNumber}`,
          message: `Vendor bill ${bill.billNumber} is past due with outstanding balance ${balance.toFixed(2)}.`,
          branchId: bill.branchId,
          entityType: "vendor_bill",
          entityId: bill.id,
        });
      }

      await writeAuditLog(tx, {
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
    }
  });

  return {
    overdueInvoicesMarked,
    overdueBillsMarked,
    checkedAt: now.toISOString(),
  };
}
