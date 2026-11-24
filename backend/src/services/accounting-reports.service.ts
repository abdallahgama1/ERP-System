import { encodeCursor, roundCurrency, type CursorPageInfo } from "@erp/shared";
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { chartOfAccounts, journalEntries, journalLines } from "../../drizzle/schema.ts";
import { AppError, num } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { ensureAccountingDefaults } from "./gl.service.ts";
import { buildKeysetCondition, parseCursorOrThrow } from "./query-helpers.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

export interface ReportFilter {
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  branchId?: string;
  costCenterId?: string;
  cursor?: string;
  limit?: number;
}

function buildEntryConditions(actor: RequestActor, filter: ReportFilter): SQL[] {
  const companyId = actorCompanyId(actor);
  const conds: SQL[] = [
    eq(journalEntries.companyId, companyId),
    eq(journalEntries.status, "posted"),
  ];
  if (filter.branchId) {
    conds.push(eq(journalEntries.branchId, filter.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length > 0) {
      conds.push(inArray(journalEntries.branchId, actor.branchIds));
    } else {
      conds.push(sql`1 = 0`);
    }
  }
  if (filter.costCenterId) {
    conds.push(eq(journalLines.costCenterId, filter.costCenterId));
  }
  if (filter.fromDate) conds.push(gte(journalEntries.entryDate, new Date(filter.fromDate)));
  if (filter.toDate) conds.push(lte(journalEntries.entryDate, new Date(filter.toDate)));
  if (filter.asOfDate) conds.push(lte(journalEntries.entryDate, new Date(filter.asOfDate)));
  return conds;
}

/**
 * Single-pass PostgreSQL GROUP BY aggregation for Trial Balance.
 */
export async function getTrialBalance(db: AppDatabase, actor: RequestActor, filter: ReportFilter) {
  const companyId = actorCompanyId(actor);
  await ensureAccountingDefaults(db, companyId);
  const accounts = await db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId))
    .orderBy(asc(chartOfAccounts.code));
  const conds = buildEntryConditions(actor, filter);

  const grouped = await db
    .select({
      accountId: journalLines.accountId,
      totalDebit: sql<string>`coalesce(sum(${journalLines.debitBase}), 0)`,
      totalCredit: sql<string>`coalesce(sum(${journalLines.creditBase}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conds))
    .groupBy(journalLines.accountId);

  const totalsByAcct = new Map<string, { debit: number; credit: number }>();
  for (const row of grouped) {
    totalsByAcct.set(row.accountId, {
      debit: roundCurrency(num(row.totalDebit), 4),
      credit: roundCurrency(num(row.totalCredit), 4),
    });
  }

  let grandDebit = 0;
  let grandCredit = 0;
  const rows = accounts.map((a) => {
    const t = totalsByAcct.get(a.id) ?? { debit: 0, credit: 0 };
    const net = roundCurrency(t.debit - t.credit, 4);
    const closingDebit = net > 0 ? net : 0;
    const closingCredit = net < 0 ? Math.abs(net) : 0;
    grandDebit = roundCurrency(grandDebit + t.debit, 4);
    grandCredit = roundCurrency(grandCredit + t.credit, 4);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      normalBalance: a.normalBalance,
      debit: t.debit,
      credit: t.credit,
      closingDebit,
      closingCredit,
    };
  });

  return {
    rows,
    totalDebit: grandDebit,
    totalCredit: grandCredit,
    isBalanced: Math.abs(grandDebit - grandCredit) <= 0.01,
  };
}

export async function getProfitAndLoss(db: AppDatabase, actor: RequestActor, filter: ReportFilter) {
  const tb = await getTrialBalance(db, actor, filter);
  const revenueAccounts = tb.rows
    .filter((r) => r.accountType === "revenue")
    .map((r) => ({ ...r, balance: roundCurrency(r.credit - r.debit, 4) }));
  const expenseAccounts = tb.rows
    .filter((r) => r.accountType === "expense")
    .map((r) => ({ ...r, balance: roundCurrency(r.debit - r.credit, 4) }));

  const totalRevenue = roundCurrency(revenueAccounts.reduce((s, a) => s + a.balance, 0), 4);
  const cogsTotal = roundCurrency(
    expenseAccounts.filter((a) => a.code === "5000").reduce((s, a) => s + a.balance, 0),
    4
  );
  const operatingExpenses = roundCurrency(
    expenseAccounts.filter((a) => a.code !== "5000").reduce((s, a) => s + a.balance, 0),
    4
  );
  const grossProfit = roundCurrency(totalRevenue - cogsTotal, 4);
  const netIncome = roundCurrency(grossProfit - operatingExpenses, 4);

  return {
    revenueAccounts,
    expenseAccounts,
    totalRevenue,
    cogsTotal,
    grossProfit,
    operatingExpenses,
    netIncome,
  };
}

/**
 * Single-pass Balance Sheet deriving assets, liabilities, equity, and current-year earnings
 * from one SQL GROUP BY Trial Balance query instead of scanning journal_lines twice.
 */
export async function getBalanceSheet(db: AppDatabase, actor: RequestActor, filter: ReportFilter) {
  const tb = await getTrialBalance(db, actor, { branchId: filter.branchId, asOfDate: filter.asOfDate });

  const assets = tb.rows
    .filter((r) => r.accountType === "asset")
    .map((r) => ({ ...r, balance: roundCurrency(r.debit - r.credit, 4) }));
  const liabilities = tb.rows
    .filter((r) => r.accountType === "liability")
    .map((r) => ({ ...r, balance: roundCurrency(r.credit - r.debit, 4) }));
  const equity = tb.rows
    .filter((r) => r.accountType === "equity")
    .map((r) => ({ ...r, balance: roundCurrency(r.credit - r.debit, 4) }));

  const totalRevenue = roundCurrency(
    tb.rows
      .filter((r) => r.accountType === "revenue")
      .reduce((s, r) => s + roundCurrency(r.credit - r.debit, 4), 0),
    4
  );
  const totalExpenses = roundCurrency(
    tb.rows
      .filter((r) => r.accountType === "expense")
      .reduce((s, r) => s + roundCurrency(r.debit - r.credit, 4), 0),
    4
  );

  const totalAssets = roundCurrency(assets.reduce((s, a) => s + a.balance, 0), 4);
  const totalLiabilities = roundCurrency(liabilities.reduce((s, l) => s + l.balance, 0), 4);
  const totalEquityAccounts = roundCurrency(equity.reduce((s, e) => s + e.balance, 0), 4);
  const currentYearEarnings = roundCurrency(totalRevenue - totalExpenses, 4);
  const totalEquity = roundCurrency(totalEquityAccounts + currentYearEarnings, 4);
  const totalLiabilitiesAndEquity = roundCurrency(totalLiabilities + totalEquity, 4);

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    currentYearEarnings,
    totalEquity,
    totalLiabilitiesAndEquity,
    isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) <= 0.01,
  };
}

export async function getAccountLedger(
  db: AppDatabase,
  actor: RequestActor,
  accountId: string,
  filter: ReportFilter
) {
  const companyId = actorCompanyId(actor);
  const [acct] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.companyId, companyId)))
    .limit(1);
  if (!acct) {
    throw new AppError(404, "Account not found", "NOT_FOUND");
  }

  const conds: SQL[] = [eq(journalLines.accountId, accountId), ...buildEntryConditions(actor, filter)];
  const cursor = parseCursorOrThrow(filter.cursor);
  if (cursor) {
    conds.push(buildKeysetCondition(journalEntries.entryDate, journalLines.id, cursor, "asc"));
  }
  const limit = Math.min(500, Math.max(1, filter.limit ?? 200));

  const rows = await db
    .select({
      lineId: journalLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      sourceType: journalEntries.sourceType,
      referenceNumber: journalEntries.referenceNumber,
      memo: journalEntries.memo,
      description: journalLines.description,
      debitBase: journalLines.debitBase,
      creditBase: journalLines.creditBase,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conds))
    .orderBy(asc(journalEntries.entryDate), asc(journalLines.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const pageInfo: CursorPageInfo = {
    nextCursor: hasMore && last ? encodeCursor(last.entryDate, last.lineId) : null,
    hasMore,
    limit,
  };

  let runningBalance = 0;
  const entries = pageRows.map((r) => {
    const debit = num(r.debitBase);
    const credit = num(r.creditBase);
    runningBalance = roundCurrency(runningBalance + debit - credit, 4);
    return {
      ...r,
      entryDate: r.entryDate.toISOString(),
      debit,
      credit,
      runningBalance,
    };
  });

  return { entries, items: entries, pageInfo };
}
