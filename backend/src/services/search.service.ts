import {
  globalSearchQuerySchema,
  type GlobalSearchResponseDto,
  type GlobalSearchResultItemDto,
  type PermissionModule,
} from "@erp/shared";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import {
  customers,
  journalEntries,
  products,
  purchaseOrders,
  salesInvoices,
  salesOrders,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import type { AppDatabase } from "../db/index.ts";
import { buildBranchScopeCondition } from "./query-helpers.ts";
import { actorCompanyId, parseOrThrow } from "./stock-locks.ts";

function canView(actor: AuthUser, mod: PermissionModule): boolean {
  if (actor.role === "admin") return true;
  return Boolean(actor.permissions[mod]?.view);
}

function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function ilikeEscaped(col: unknown, pattern: string): SQL {
  return sql`${col} ILIKE ${pattern} ESCAPE '\\'`;
}

export async function runGlobalSearch(
  db: AppDatabase,
  actor: AuthUser,
  rawQuery: unknown
): Promise<GlobalSearchResponseDto> {
  const { q, limit } = parseOrThrow(globalSearchQuerySchema, rawQuery, "Invalid search query");
  const companyId = actorCompanyId(actor);
  const pattern = `%${escapeLikePattern(q)}%`;
  const perCategoryLimit = Math.max(3, Math.min(limit, 10));

  const tasks: Array<Promise<GlobalSearchResultItemDto[]>> = [];

  if (canView(actor, "products")) {
    tasks.push(
      db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          category: products.category,
        })
        .from(products)
        .where(
          and(
            eq(products.companyId, companyId),
            or(
              ilikeEscaped(products.name, pattern),
              ilikeEscaped(products.nameAr, pattern),
              ilikeEscaped(products.sku, pattern),
              ilikeEscaped(products.barcode, pattern)
            )
          )
        )
        .orderBy(desc(products.updatedAt))
        .limit(perCategoryLimit)
        .then((rows) =>
          rows.map((r) => ({
            type: "product" as const,
            id: r.id,
            title: r.name,
            subtitle: r.category ? `${r.sku} · ${r.category}` : r.sku,
            route: `/products?q=${encodeURIComponent(r.sku)}`,
          }))
        )
    );
  }

  if (canView(actor, "sales")) {
    tasks.push(
      db
        .select({
          id: customers.id,
          code: customers.code,
          name: customers.name,
          email: customers.email,
        })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            or(
              ilikeEscaped(customers.name, pattern),
              ilikeEscaped(customers.code, pattern),
              ilikeEscaped(customers.email, pattern),
              ilikeEscaped(customers.phone, pattern)
            )
          )
        )
        .orderBy(desc(customers.updatedAt))
        .limit(perCategoryLimit)
        .then((rows) =>
          rows.map((r) => ({
            type: "customer" as const,
            id: r.id,
            title: r.name,
            subtitle: r.email ? `${r.code} · ${r.email}` : r.code,
            route: `/sales/customers?q=${encodeURIComponent(r.code)}`,
          }))
        )
    );

    const soBranchCond = buildBranchScopeCondition(salesOrders.branchId, actor);
    if (soBranchCond !== "EMPTY") {
      const conds: SQL[] = [
        eq(salesOrders.companyId, companyId),
        or(ilikeEscaped(salesOrders.soNumber, pattern), ilikeEscaped(salesOrders.notes, pattern))!,
      ];
      if (soBranchCond) conds.push(soBranchCond);
      tasks.push(
        db
          .select({
            id: salesOrders.id,
            soNumber: salesOrders.soNumber,
            status: salesOrders.status,
            totalAmount: salesOrders.totalAmount,
          })
          .from(salesOrders)
          .where(and(...conds))
          .orderBy(desc(salesOrders.createdAt))
          .limit(perCategoryLimit)
          .then((rows) =>
            rows.map((r) => ({
              type: "sales_order" as const,
              id: r.id,
              title: r.soNumber,
              subtitle: `${r.status} · Total ${Number(r.totalAmount).toFixed(2)}`,
              route: `/sales/orders?q=${encodeURIComponent(r.soNumber)}`,
            }))
          )
      );
    }

    const invBranchCond = buildBranchScopeCondition(salesInvoices.branchId, actor);
    if (invBranchCond !== "EMPTY") {
      const conds: SQL[] = [
        eq(salesInvoices.companyId, companyId),
        or(ilikeEscaped(salesInvoices.invoiceNumber, pattern), ilikeEscaped(salesInvoices.notes, pattern))!,
      ];
      if (invBranchCond) conds.push(invBranchCond);
      tasks.push(
        db
          .select({
            id: salesInvoices.id,
            invoiceNumber: salesInvoices.invoiceNumber,
            status: salesInvoices.status,
            totalAmount: salesInvoices.totalAmount,
          })
          .from(salesInvoices)
          .where(and(...conds))
          .orderBy(desc(salesInvoices.createdAt))
          .limit(perCategoryLimit)
          .then((rows) =>
            rows.map((r) => ({
              type: "sales_invoice" as const,
              id: r.id,
              title: r.invoiceNumber,
              subtitle: `${r.status} · Total ${Number(r.totalAmount).toFixed(2)}`,
              route: `/sales/invoices?q=${encodeURIComponent(r.invoiceNumber)}`,
            }))
          )
      );
    }
  }

  if (canView(actor, "purchases")) {
    tasks.push(
      db
        .select({
          id: vendors.id,
          code: vendors.code,
          name: vendors.name,
          email: vendors.email,
        })
        .from(vendors)
        .where(
          and(
            eq(vendors.companyId, companyId),
            or(
              ilikeEscaped(vendors.name, pattern),
              ilikeEscaped(vendors.code, pattern),
              ilikeEscaped(vendors.email, pattern),
              ilikeEscaped(vendors.phone, pattern)
            )
          )
        )
        .orderBy(desc(vendors.updatedAt))
        .limit(perCategoryLimit)
        .then((rows) =>
          rows.map((r) => ({
            type: "vendor" as const,
            id: r.id,
            title: r.name,
            subtitle: r.email ? `${r.code} · ${r.email}` : r.code,
            route: `/purchases/vendors?q=${encodeURIComponent(r.code)}`,
          }))
        )
    );

    const poBranchCond = buildBranchScopeCondition(purchaseOrders.branchId, actor);
    if (poBranchCond !== "EMPTY") {
      const conds: SQL[] = [
        eq(purchaseOrders.companyId, companyId),
        or(ilikeEscaped(purchaseOrders.poNumber, pattern), ilikeEscaped(purchaseOrders.notes, pattern))!,
      ];
      if (poBranchCond) conds.push(poBranchCond);
      tasks.push(
        db
          .select({
            id: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            status: purchaseOrders.status,
            totalAmount: purchaseOrders.totalAmount,
          })
          .from(purchaseOrders)
          .where(and(...conds))
          .orderBy(desc(purchaseOrders.createdAt))
          .limit(perCategoryLimit)
          .then((rows) =>
            rows.map((r) => ({
              type: "purchase_order" as const,
              id: r.id,
              title: r.poNumber,
              subtitle: `${r.status} · Total ${Number(r.totalAmount).toFixed(2)}`,
              route: `/purchases/orders?q=${encodeURIComponent(r.poNumber)}`,
            }))
          )
      );
    }

    const billBranchCond = buildBranchScopeCondition(vendorBills.branchId, actor);
    if (billBranchCond !== "EMPTY") {
      const conds: SQL[] = [
        eq(vendorBills.companyId, companyId),
        or(ilikeEscaped(vendorBills.billNumber, pattern), ilikeEscaped(vendorBills.notes, pattern))!,
      ];
      if (billBranchCond) conds.push(billBranchCond);
      tasks.push(
        db
          .select({
            id: vendorBills.id,
            billNumber: vendorBills.billNumber,
            status: vendorBills.status,
            totalAmount: vendorBills.totalAmount,
          })
          .from(vendorBills)
          .where(and(...conds))
          .orderBy(desc(vendorBills.createdAt))
          .limit(perCategoryLimit)
          .then((rows) =>
            rows.map((r) => ({
              type: "vendor_bill" as const,
              id: r.id,
              title: r.billNumber,
              subtitle: `${r.status} · Total ${Number(r.totalAmount).toFixed(2)}`,
              route: `/purchases/bills?q=${encodeURIComponent(r.billNumber)}`,
            }))
          )
      );
    }
  }

  if (canView(actor, "accounting")) {
    const jeBranchCond = buildBranchScopeCondition(journalEntries.branchId, actor, undefined, true);
    if (jeBranchCond !== "EMPTY") {
      const conds: SQL[] = [
        eq(journalEntries.companyId, companyId),
        or(
          ilikeEscaped(journalEntries.entryNumber, pattern),
          ilikeEscaped(journalEntries.memo, pattern),
          ilikeEscaped(journalEntries.referenceNumber, pattern)
        )!,
      ];
      if (jeBranchCond) conds.push(jeBranchCond);
      tasks.push(
        db
          .select({
            id: journalEntries.id,
            entryNumber: journalEntries.entryNumber,
            memo: journalEntries.memo,
            status: journalEntries.status,
          })
          .from(journalEntries)
          .where(and(...conds))
          .orderBy(desc(journalEntries.createdAt))
          .limit(perCategoryLimit)
          .then((rows) =>
            rows.map((r) => ({
              type: "journal_entry" as const,
              id: r.id,
              title: r.entryNumber,
              subtitle: r.memo || r.status,
              route: `/accounting/journal-entries?q=${encodeURIComponent(r.entryNumber)}`,
            }))
          )
      );
    }
  }

  const buckets = await Promise.all(tasks);
  const results = buckets.flat().slice(0, limit);

  return {
    query: q,
    results,
  };
}
