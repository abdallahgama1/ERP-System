import ExcelJS from "exceljs";
import {
  exportParamsSchema,
  exportQuerySchema,
  type ExportFormat,
  type ExportQuery,
  type ExportResource,
  type PermissionModule,
} from "@erp/shared";
import { and, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  branches,
  customers,
  journalEntries,
  products,
  purchaseOrders,
  salesInvoices,
  salesOrders,
  stockMovements,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, num } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { buildBranchScopeCondition } from "./query-helpers.ts";
import { actorCompanyId, parseOrThrow } from "./stock-locks.ts";

const MAX_EXPORT_ROWS = 10_000;

interface ExportColumn {
  key: string;
  header: string;
  width?: number;
}

interface ExportDataset {
  sheetName: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
}

export function resolveExportPermissionModule(resource: ExportResource): PermissionModule {
  switch (resource) {
    case "products":
      return "products";
    case "customers":
    case "sales-orders":
    case "invoices":
      return "sales";
    case "vendors":
    case "purchase-orders":
    case "vendor-bills":
      return "purchases";
    case "journal-entries":
      return "accounting";
    case "movements":
      return "inventory";
    case "audit-logs":
      return "audit";
  }
}

function assertExportPermission(actor: AuthUser, resource: ExportResource): void {
  if (actor.role === "admin") return;
  const mod = resolveExportPermissionModule(resource);
  if (!actor.permissions[mod]?.view) {
    throw new AppError(403, `Forbidden: missing ${mod}.view permission for export`, "FORBIDDEN");
  }
}

export function sanitizeSpreadsheetCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function formatCsvField(value: unknown): string {
  const safe = sanitizeSpreadsheetCell(value);
  const str = String(safe);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildRfc4180Csv(columns: ExportColumn[], rows: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => formatCsvField(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => formatCsvField(row[c.key])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export async function buildXlsxBuffer(dataset: ExportDataset): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(dataset.sheetName.slice(0, 31));
  sheet.columns = dataset.columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width ?? 20,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  for (const row of dataset.rows) {
    const sanitizedRow: Record<string, unknown> = {};
    for (const col of dataset.columns) {
      sanitizedRow[col.key] = sanitizeSpreadsheetCell(row[col.key]);
    }
    sheet.addRow(sanitizedRow);
  }

  const raw = await workbook.xlsx.writeBuffer();
  return Buffer.from(raw);
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function ilikeEscaped(col: unknown, pattern: string): SQL {
  return sql`${col} ILIKE ${pattern} ESCAPE '\\'`;
}

function parseOptionalDate(raw?: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchDataset(
  db: AppDatabase,
  actor: AuthUser,
  resource: ExportResource,
  query: ExportQuery
): Promise<ExportDataset> {
  const companyId = actorCompanyId(actor);
  const searchTerm = (query.q ?? query.search ?? "").trim();
  const pattern = searchTerm ? `%${escapeLike(searchTerm)}%` : null;
  const fromDate = parseOptionalDate(query.fromDate);
  const toDate = parseOptionalDate(query.toDate);

  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    const [br] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, query.branchId), eq(branches.companyId, companyId)))
      .limit(1);
    if (!br) {
      throw new AppError(404, "Branch not found in active company", "NOT_FOUND");
    }
  }

  switch (resource) {
    case "products": {
      const conds: SQL[] = [eq(products.companyId, companyId)];
      if (pattern) {
        conds.push(
          or(
            ilikeEscaped(products.sku, pattern),
            ilikeEscaped(products.name, pattern),
            ilikeEscaped(products.category, pattern),
            ilikeEscaped(products.brand, pattern)
          )!
        );
      }
      const rows = await db
        .select()
        .from(products)
        .where(and(...conds))
        .orderBy(desc(products.createdAt))
        .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Products",
        columns: [
          { key: "sku", header: "SKU", width: 18 },
          { key: "name", header: "Name", width: 28 },
          { key: "category", header: "Category", width: 18 },
          { key: "brand", header: "Brand", width: 16 },
          { key: "unit", header: "Unit", width: 10 },
          { key: "costPrice", header: "Cost Price", width: 14 },
          { key: "sellingPrice", header: "Selling Price", width: 14 },
          { key: "minStockLevel", header: "Min Stock", width: 12 },
          { key: "itemType", header: "Item Type", width: 14 },
          { key: "isActive", header: "Active", width: 10 },
          { key: "createdAt", header: "Created At", width: 24 },
        ],
        rows: rows.map((r) => ({
          sku: r.sku,
          name: r.name,
          category: r.category,
          brand: r.brand,
          unit: r.unit,
          costPrice: num(r.costPrice),
          sellingPrice: num(r.sellingPrice),
          minStockLevel: num(r.minStockLevel),
          itemType: r.itemType,
          isActive: r.isActive,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }

    case "customers": {
      const conds: SQL[] = [eq(customers.companyId, companyId)];
      if (pattern) {
        conds.push(
          or(
            ilikeEscaped(customers.code, pattern),
            ilikeEscaped(customers.name, pattern),
            ilikeEscaped(customers.email, pattern)
          )!
        );
      }
      const rows = await db
        .select()
        .from(customers)
        .where(and(...conds))
        .orderBy(desc(customers.createdAt))
        .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Customers",
        columns: [
          { key: "code", header: "Code", width: 16 },
          { key: "name", header: "Name", width: 26 },
          { key: "email", header: "Email", width: 26 },
          { key: "phone", header: "Phone", width: 18 },
          { key: "taxNumber", header: "Tax Number", width: 18 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "creditLimit", header: "Credit Limit", width: 14 },
          { key: "isActive", header: "Active", width: 10 },
        ],
        rows: rows.map((r) => ({
          code: r.code,
          name: r.name,
          email: r.email,
          phone: r.phone,
          taxNumber: r.taxNumber,
          currency: r.currency,
          creditLimit: r.creditLimit === null ? "" : num(r.creditLimit),
          isActive: r.isActive,
        })),
      };
    }

    case "vendors": {
      const conds: SQL[] = [eq(vendors.companyId, companyId)];
      if (pattern) {
        conds.push(
          or(
            ilikeEscaped(vendors.code, pattern),
            ilikeEscaped(vendors.name, pattern),
            ilikeEscaped(vendors.email, pattern)
          )!
        );
      }
      const rows = await db
        .select()
        .from(vendors)
        .where(and(...conds))
        .orderBy(desc(vendors.createdAt))
        .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Vendors",
        columns: [
          { key: "code", header: "Code", width: 16 },
          { key: "name", header: "Name", width: 26 },
          { key: "email", header: "Email", width: 26 },
          { key: "phone", header: "Phone", width: 18 },
          { key: "taxNumber", header: "Tax Number", width: 18 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "isActive", header: "Active", width: 10 },
        ],
        rows: rows.map((r) => ({
          code: r.code,
          name: r.name,
          email: r.email,
          phone: r.phone,
          taxNumber: r.taxNumber,
          currency: r.currency,
          isActive: r.isActive,
        })),
      };
    }

    case "sales-orders": {
      const scopeCond = buildBranchScopeCondition(salesOrders.branchId, actor, query.branchId);
      const conds: SQL[] = [eq(salesOrders.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (query.status) conds.push(eq(salesOrders.status, query.status));
      if (pattern) conds.push(ilikeEscaped(salesOrders.soNumber, pattern));
      if (fromDate) conds.push(gte(salesOrders.orderDate, fromDate));
      if (toDate) conds.push(lte(salesOrders.orderDate, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(salesOrders)
              .where(and(...conds))
              .orderBy(desc(salesOrders.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Sales Orders",
        columns: [
          { key: "soNumber", header: "SO Number", width: 18 },
          { key: "status", header: "Status", width: 16 },
          { key: "orderDate", header: "Order Date", width: 22 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "subtotal", header: "Subtotal", width: 14 },
          { key: "taxTotal", header: "Tax Total", width: 14 },
          { key: "total", header: "Total", width: 14 },
          { key: "notes", header: "Notes", width: 30 },
        ],
        rows: rows.map((r) => ({
          soNumber: r.soNumber,
          status: r.status,
          orderDate: r.orderDate.toISOString(),
          currency: r.currency,
          subtotal: num(r.subtotal),
          taxTotal: num(r.taxTotal),
          total: num(r.totalAmount),
          notes: r.notes,
        })),
      };
    }

    case "invoices": {
      const scopeCond = buildBranchScopeCondition(salesInvoices.branchId, actor, query.branchId);
      const conds: SQL[] = [eq(salesInvoices.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (query.status) conds.push(eq(salesInvoices.status, query.status));
      if (pattern) conds.push(ilikeEscaped(salesInvoices.invoiceNumber, pattern));
      if (fromDate) conds.push(gte(salesInvoices.invoiceDate, fromDate));
      if (toDate) conds.push(lte(salesInvoices.invoiceDate, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(salesInvoices)
              .where(and(...conds))
              .orderBy(desc(salesInvoices.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Sales Invoices",
        columns: [
          { key: "invoiceNumber", header: "Invoice Number", width: 20 },
          { key: "status", header: "Status", width: 16 },
          { key: "invoiceDate", header: "Invoice Date", width: 22 },
          { key: "dueDate", header: "Due Date", width: 22 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "subtotal", header: "Subtotal", width: 14 },
          { key: "taxTotal", header: "Tax Total", width: 14 },
          { key: "total", header: "Total", width: 14 },
          { key: "amountPaid", header: "Amount Paid", width: 14 },
          { key: "balanceDue", header: "Balance Due", width: 14 },
        ],
        rows: rows.map((r) => {
          const total = num(r.totalAmount);
          const paid = num(r.paidAmount) + num(r.creditAppliedAmount) + num(r.retainerAppliedAmount);
          return {
            invoiceNumber: r.invoiceNumber,
            status: r.status,
            invoiceDate: r.invoiceDate.toISOString(),
            dueDate: r.dueDate ? r.dueDate.toISOString() : "",
            currency: r.currency,
            subtotal: num(r.subtotal),
            taxTotal: num(r.taxTotal),
            total,
            amountPaid: paid,
            balanceDue: Math.max(0, total - paid),
          };
        }),
      };
    }

    case "purchase-orders": {
      const scopeCond = buildBranchScopeCondition(purchaseOrders.branchId, actor, query.branchId);
      const conds: SQL[] = [eq(purchaseOrders.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (query.status) conds.push(eq(purchaseOrders.status, query.status));
      if (pattern) conds.push(ilikeEscaped(purchaseOrders.poNumber, pattern));
      if (fromDate) conds.push(gte(purchaseOrders.orderDate, fromDate));
      if (toDate) conds.push(lte(purchaseOrders.orderDate, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(purchaseOrders)
              .where(and(...conds))
              .orderBy(desc(purchaseOrders.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Purchase Orders",
        columns: [
          { key: "poNumber", header: "PO Number", width: 18 },
          { key: "status", header: "Status", width: 16 },
          { key: "orderDate", header: "Order Date", width: 22 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "subtotal", header: "Subtotal", width: 14 },
          { key: "taxTotal", header: "Tax Total", width: 14 },
          { key: "total", header: "Total", width: 14 },
          { key: "notes", header: "Notes", width: 30 },
        ],
        rows: rows.map((r) => ({
          poNumber: r.poNumber,
          status: r.status,
          orderDate: r.orderDate.toISOString(),
          currency: r.currency,
          subtotal: num(r.subtotal),
          taxTotal: num(r.taxTotal),
          total: num(r.totalAmount),
          notes: r.notes,
        })),
      };
    }

    case "vendor-bills": {
      const scopeCond = buildBranchScopeCondition(vendorBills.branchId, actor, query.branchId);
      const conds: SQL[] = [eq(vendorBills.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (query.status) conds.push(eq(vendorBills.status, query.status));
      if (pattern) {
        conds.push(or(ilikeEscaped(vendorBills.billNumber, pattern), ilikeEscaped(vendorBills.notes, pattern))!);
      }
      if (fromDate) conds.push(gte(vendorBills.billDate, fromDate));
      if (toDate) conds.push(lte(vendorBills.billDate, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(vendorBills)
              .where(and(...conds))
              .orderBy(desc(vendorBills.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Vendor Bills",
        columns: [
          { key: "billNumber", header: "Bill Number", width: 18 },
          { key: "status", header: "Status", width: 16 },
          { key: "billDate", header: "Bill Date", width: 22 },
          { key: "dueDate", header: "Due Date", width: 22 },
          { key: "currency", header: "Currency", width: 10 },
          { key: "total", header: "Total", width: 14 },
          { key: "amountPaid", header: "Amount Paid", width: 14 },
          { key: "balanceDue", header: "Balance Due", width: 14 },
          { key: "notes", header: "Notes", width: 30 },
        ],
        rows: rows.map((r) => {
          const total = num(r.totalAmount);
          const paid = num(r.paidAmount);
          return {
            billNumber: r.billNumber,
            status: r.status,
            billDate: r.billDate.toISOString(),
            dueDate: r.dueDate ? r.dueDate.toISOString() : "",
            currency: r.currency,
            total,
            amountPaid: paid,
            balanceDue: Math.max(0, total - paid),
            notes: r.notes,
          };
        }),
      };
    }

    case "journal-entries": {
      const scopeCond = buildBranchScopeCondition(journalEntries.branchId, actor, query.branchId, true);
      const conds: SQL[] = [eq(journalEntries.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (query.status === "posted" || query.status === "reversed") {
        conds.push(eq(journalEntries.status, query.status));
      }
      if (pattern) {
        conds.push(
          or(
            ilikeEscaped(journalEntries.entryNumber, pattern),
            ilikeEscaped(journalEntries.memo, pattern),
            ilikeEscaped(journalEntries.referenceNumber, pattern)
          )!
        );
      }
      if (fromDate) conds.push(gte(journalEntries.entryDate, fromDate));
      if (toDate) conds.push(lte(journalEntries.entryDate, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(journalEntries)
              .where(and(...conds))
              .orderBy(desc(journalEntries.entryDate), desc(journalEntries.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Journal Entries",
        columns: [
          { key: "entryNumber", header: "Entry Number", width: 18 },
          { key: "entryDate", header: "Entry Date", width: 22 },
          { key: "sourceType", header: "Source Type", width: 18 },
          { key: "referenceNumber", header: "Reference", width: 18 },
          { key: "status", header: "Status", width: 14 },
          { key: "memo", header: "Memo", width: 40 },
          { key: "createdAt", header: "Created At", width: 22 },
        ],
        rows: rows.map((r) => ({
          entryNumber: r.entryNumber,
          entryDate: r.entryDate.toISOString(),
          sourceType: r.sourceType,
          referenceNumber: r.referenceNumber,
          status: r.status,
          memo: r.memo,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }

    case "movements": {
      const scopeCond = buildBranchScopeCondition(stockMovements.branchId, actor, query.branchId);
      const conds: SQL[] = [eq(stockMovements.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (pattern) {
        conds.push(
          or(ilikeEscaped(stockMovements.referenceNumber, pattern), ilikeEscaped(stockMovements.notes, pattern))!
        );
      }
      if (fromDate) conds.push(gte(stockMovements.createdAt, fromDate));
      if (toDate) conds.push(lte(stockMovements.createdAt, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(stockMovements)
              .where(and(...conds))
              .orderBy(desc(stockMovements.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Stock Movements",
        columns: [
          { key: "createdAt", header: "Timestamp", width: 22 },
          { key: "movementType", header: "Type", width: 18 },
          { key: "referenceType", header: "Reference Type", width: 16 },
          { key: "referenceNumber", header: "Reference #", width: 18 },
          { key: "qtyDelta", header: "Qty Delta", width: 12 },
          { key: "unitCost", header: "Unit Cost", width: 12 },
          { key: "balanceAfter", header: "Balance After", width: 14 },
          { key: "notes", header: "Notes", width: 32 },
        ],
        rows: rows.map((r) => ({
          createdAt: r.createdAt.toISOString(),
          movementType: r.movementType,
          referenceType: r.referenceType,
          referenceNumber: r.referenceNumber,
          qtyDelta: num(r.qtyDelta),
          unitCost: num(r.unitCost),
          balanceAfter: num(r.balanceAfter),
          notes: r.notes,
        })),
      };
    }

    case "audit-logs": {
      const scopeCond = buildBranchScopeCondition(auditLogs.branchId, actor, query.branchId, true);
      const conds: SQL[] = [eq(auditLogs.companyId, companyId)];
      if (scopeCond && scopeCond !== "EMPTY") conds.push(scopeCond);
      if (pattern) {
        conds.push(
          or(
            ilikeEscaped(auditLogs.action, pattern),
            ilikeEscaped(auditLogs.entityType, pattern),
            ilikeEscaped(auditLogs.entityLabel, pattern),
            ilikeEscaped(auditLogs.userName, pattern)
          )!
        );
      }
      if (fromDate) conds.push(gte(auditLogs.createdAt, fromDate));
      if (toDate) conds.push(lte(auditLogs.createdAt, toDate));
      const rows =
        scopeCond === "EMPTY"
          ? []
          : await db
              .select()
              .from(auditLogs)
              .where(and(...conds))
              .orderBy(desc(auditLogs.createdAt))
              .limit(MAX_EXPORT_ROWS);
      return {
        sheetName: "Audit Logs",
        columns: [
          { key: "createdAt", header: "Timestamp", width: 22 },
          { key: "userName", header: "User", width: 20 },
          { key: "userRole", header: "Role", width: 12 },
          { key: "action", header: "Action", width: 24 },
          { key: "entityType", header: "Entity Type", width: 18 },
          { key: "entityLabel", header: "Entity", width: 24 },
          { key: "changedFields", header: "Changed Fields", width: 30 },
        ],
        rows: rows.map((r) => ({
          createdAt: r.createdAt.toISOString(),
          userName: r.userName,
          userRole: r.userRole ?? "",
          action: r.action,
          entityType: r.entityType,
          entityLabel: r.entityLabel ?? "",
          changedFields: Array.isArray(r.changedFields) ? r.changedFields.join(", ") : "",
        })),
      };
    }
  }
}

export async function generateResourceExport(
  db: AppDatabase,
  actor: AuthUser,
  rawParams: unknown,
  rawQuery: unknown
): Promise<{
  format: ExportFormat;
  contentType: string;
  fileName: string;
  payload: Buffer | string;
}> {
  const { resource } = parseOrThrow(exportParamsSchema, rawParams, "Unsupported export resource");
  const query = parseOrThrow(exportQuerySchema, rawQuery, "Invalid export query");
  assertExportPermission(actor, resource);

  const dataset = await fetchDataset(db, actor, resource, query);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  if (query.format === "xlsx") {
    const buffer = await buildXlsxBuffer(dataset);
    return {
      format: "xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: `${resource}-${stamp}.xlsx`,
      payload: buffer,
    };
  }

  const csv = buildRfc4180Csv(dataset.columns, dataset.rows);
  return {
    format: "csv",
    contentType: "text/csv; charset=utf-8",
    fileName: `${resource}-${stamp}.csv`,
    payload: csv,
  };
}
