import {
  encodeCursor,
  roundCurrency,
  type CashFlowLineDto,
  type CashFlowStatementDto,
  type CursorPageInfo,
  type VatReturnRateBucketDto,
  type VatReturnReportDto,
} from "@erp/shared";
import { and, asc, eq, gte, inArray, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  chartOfAccounts,
  expenseClaimLines,
  expenseClaims,
  journalEntries,
  journalLines,
  purchaseReturnLines,
  purchaseReturns,
  salesInvoiceLines,
  salesInvoices,
  salesReturnLines,
  salesReturns,
  treasuryAccounts,
  vendorBillLines,
  vendorBills,
} from "../../drizzle/schema.ts";
import { AppError, num } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { ensureAccountingDefaults, getGlAccountMap } from "./gl.service.ts";
import { buildKeysetCondition, parseCursorOrThrow } from "./query-helpers.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

export interface ReportFilter {
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  compareFromDate?: string;
  compareToDate?: string;
  branchId?: string;
  costCenterId?: string;
  excludeClosingEntries?: boolean;
  cursor?: string;
  limit?: number;
}

function buildEntryConditions(actor: RequestActor, filter: ReportFilter): SQL[] {
  const companyId = actorCompanyId(actor);
  const conds: SQL[] = [
    eq(journalEntries.companyId, companyId),
    eq(journalEntries.status, "posted"),
  ];
  if (filter.excludeClosingEntries) {
    conds.push(ne(journalEntries.sourceType, "year_end_close"));
  }
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

function summarizePnlFromTrialBalance(tb: Awaited<ReturnType<typeof getTrialBalance>>) {
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

export async function getProfitAndLoss(db: AppDatabase, actor: RequestActor, filter: ReportFilter) {
  const currentTb = await getTrialBalance(db, actor, { ...filter, excludeClosingEntries: true });
  const current = summarizePnlFromTrialBalance(currentTb);

  if (!filter.compareFromDate && !filter.compareToDate) {
    return current;
  }

  const priorTb = await getTrialBalance(db, actor, {
    branchId: filter.branchId,
    costCenterId: filter.costCenterId,
    fromDate: filter.compareFromDate,
    toDate: filter.compareToDate,
    excludeClosingEntries: true,
  });
  const prior = summarizePnlFromTrialBalance(priorTb);
  const priorByAcct = new Map<string, number>();
  for (const r of [...prior.revenueAccounts, ...prior.expenseAccounts]) {
    priorByAcct.set(r.accountId, r.balance);
  }

  const enrich = <T extends { accountId: string; balance: number }>(rows: T[]) =>
    rows.map((r) => {
      const priorBalance = priorByAcct.get(r.accountId) ?? 0;
      const variance = roundCurrency(r.balance - priorBalance, 4);
      const variancePct =
        Math.abs(priorBalance) > 0.0001
          ? roundCurrency((variance / Math.abs(priorBalance)) * 100, 2)
          : null;
      return { ...r, priorBalance, variance, variancePct };
    });

  const revenueVariance = roundCurrency(current.totalRevenue - prior.totalRevenue, 4);
  const netIncomeVariance = roundCurrency(current.netIncome - prior.netIncome, 4);

  return {
    ...current,
    revenueAccounts: enrich(current.revenueAccounts),
    expenseAccounts: enrich(current.expenseAccounts),
    comparative: {
      fromDate: filter.compareFromDate ?? null,
      toDate: filter.compareToDate ?? null,
      totalRevenue: prior.totalRevenue,
      cogsTotal: prior.cogsTotal,
      grossProfit: prior.grossProfit,
      operatingExpenses: prior.operatingExpenses,
      netIncome: prior.netIncome,
      revenueVariance,
      revenueVariancePct:
        Math.abs(prior.totalRevenue) > 0.0001
          ? roundCurrency((revenueVariance / Math.abs(prior.totalRevenue)) * 100, 2)
          : null,
      netIncomeVariance,
      netIncomeVariancePct:
        Math.abs(prior.netIncome) > 0.0001
          ? roundCurrency((netIncomeVariance / Math.abs(prior.netIncome)) * 100, 2)
          : null,
    },
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

/**
 * Indirect Cash Flow Statement (IAS 7) reconciling Operating, Investing, and Financing
 * cash flows cleanly against Opening Cash & Bank -> Closing Cash & Bank.
 */
export async function getCashFlowStatement(
  db: AppDatabase,
  actor: RequestActor,
  filter: ReportFilter
): Promise<CashFlowStatementDto> {
  const companyId = actorCompanyId(actor);
  await ensureAccountingDefaults(db, companyId);

  const [accounts, treasuryRows, glMap] = await Promise.all([
    db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.companyId, companyId))
      .orderBy(asc(chartOfAccounts.code)),
    db
      .select({ glAccountId: treasuryAccounts.glAccountId })
      .from(treasuryAccounts)
      .where(eq(treasuryAccounts.companyId, companyId)),
    getGlAccountMap(db, companyId),
  ]);

  const cashParentId = accounts.find((a) => a.code === "1000")?.id ?? null;
  const cashAccountIds = new Set<string>(treasuryRows.map((t) => t.glAccountId));
  for (const a of accounts) {
    if (["1000", "1010", "1020"].includes(a.code) || (cashParentId && a.parentId === cashParentId)) {
      cashAccountIds.add(a.id);
    }
  }

  const fixedAssetCostIds = new Set<string>(
    accounts.filter((a) => a.id === glMap.fixed_assets_cost || a.code === "1500").map((a) => a.id)
  );
  const accumDepIds = new Set<string>(
    accounts.filter((a) => a.id === glMap.accumulated_depreciation || a.code === "1510").map((a) => a.id)
  );
  const depExpenseIds = new Set<string>(
    accounts.filter((a) => a.id === glMap.depreciation_expense || a.code === "5700").map((a) => a.id)
  );
  const disposalGainLossIds = new Set<string>(
    accounts.filter((a) => a.id === glMap.asset_disposal_gain_loss || a.code === "5710").map((a) => a.id)
  );

  // Opening cash strictly before fromDate
  let openingCash = 0;
  if (filter.fromDate && cashAccountIds.size > 0) {
    const openConds: SQL[] = [
      eq(journalEntries.companyId, companyId),
      eq(journalEntries.status, "posted"),
      inArray(journalLines.accountId, Array.from(cashAccountIds)),
      lt(journalEntries.entryDate, new Date(filter.fromDate)),
    ];
    if (filter.branchId) {
      openConds.push(eq(journalEntries.branchId, filter.branchId));
    } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
      openConds.push(
        actor.branchIds.length > 0 ? inArray(journalEntries.branchId, actor.branchIds) : sql`1 = 0`
      );
    }
    const [openRow] = await db
      .select({
        netCash: sql<string>`coalesce(sum(${journalLines.debitBase} - ${journalLines.creditBase}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(...openConds));
    openingCash = roundCurrency(num(openRow?.netCash ?? 0), 4);
  }

  // Period movements (excluding year_end_close sweeps, which are zero-sum between P&L and Equity)
  const periodTb = await getTrialBalance(db, actor, {
    branchId: filter.branchId,
    fromDate: filter.fromDate,
    toDate: filter.toDate,
    excludeClosingEntries: true,
  });

  let periodCashDelta = 0;
  let netIncome = 0;
  let depExpenseAddBack = 0;
  let disposalNonCashAdj = 0;
  let fixedAssetsNetMovement = 0;

  const nonCashAdjustments: CashFlowLineDto[] = [];
  const workingCapitalChanges: CashFlowLineDto[] = [];
  const investingItems: CashFlowLineDto[] = [];
  const financingItems: CashFlowLineDto[] = [];

  for (const row of periodTb.rows) {
    const drMinusCr = roundCurrency(row.debit - row.credit, 4);
    const crMinusDr = roundCurrency(row.credit - row.debit, 4);
    if (Math.abs(drMinusCr) < 0.0001) continue;

    if (cashAccountIds.has(row.accountId)) {
      periodCashDelta = roundCurrency(periodCashDelta + drMinusCr, 4);
      continue;
    }

    if (row.accountType === "revenue") {
      netIncome = roundCurrency(netIncome + crMinusDr, 4);
      continue;
    }

    if (row.accountType === "expense") {
      netIncome = roundCurrency(netIncome - drMinusCr, 4);
      if (depExpenseIds.has(row.accountId)) {
        depExpenseAddBack = roundCurrency(depExpenseAddBack + drMinusCr, 4);
      } else if (disposalGainLossIds.has(row.accountId)) {
        // +drMinusCr reverses loss (+add-back) or gain (-deduction) out of Operating
        disposalNonCashAdj = roundCurrency(disposalNonCashAdj + drMinusCr, 4);
      }
      continue;
    }

    if (fixedAssetCostIds.has(row.accountId) || accumDepIds.has(row.accountId)) {
      fixedAssetsNetMovement = roundCurrency(fixedAssetsNetMovement + drMinusCr, 4);
      continue;
    }

    if (row.accountType === "asset") {
      // Increase in non-cash working capital asset consumes cash (-drMinusCr)
      workingCapitalChanges.push({
        code: row.code,
        label: `Change in ${row.name}`,
        amount: roundCurrency(-drMinusCr, 4),
      });
      continue;
    }

    if (row.accountType === "liability") {
      // Increase in operating liability provides cash (+crMinusDr)
      workingCapitalChanges.push({
        code: row.code,
        label: `Change in ${row.name}`,
        amount: crMinusDr,
      });
      continue;
    }

    if (row.accountType === "equity") {
      financingItems.push({
        code: row.code,
        label: row.name,
        amount: crMinusDr,
      });
    }
  }

  if (Math.abs(depExpenseAddBack) >= 0.0001) {
    nonCashAdjustments.push({
      code: "5700",
      label: "Depreciation & Amortization",
      amount: depExpenseAddBack,
    });
  }
  if (Math.abs(disposalNonCashAdj) >= 0.0001) {
    nonCashAdjustments.push({
      code: "5710",
      label: "Loss / (Gain) on Fixed Asset Disposal",
      amount: disposalNonCashAdj,
    });
  }

  // Exact net investing cash flow = -(ΔFixedAssetCost + ΔAccumDep + depExpenseAddBack + disposalNonCashAdj)
  const netCapexAndProceeds = roundCurrency(
    -(fixedAssetsNetMovement + depExpenseAddBack + disposalNonCashAdj),
    4
  );
  if (Math.abs(netCapexAndProceeds) >= 0.0001) {
    investingItems.push({
      code: "1500",
      label: "Fixed Asset Capital Expenditures & Disposal Proceeds",
      amount: netCapexAndProceeds,
    });
  }

  const operatingTotal = roundCurrency(
    netIncome +
      nonCashAdjustments.reduce((s, i) => s + i.amount, 0) +
      workingCapitalChanges.reduce((s, i) => s + i.amount, 0),
    4
  );
  const investingTotal = roundCurrency(investingItems.reduce((s, i) => s + i.amount, 0), 4);
  const financingTotal = roundCurrency(financingItems.reduce((s, i) => s + i.amount, 0), 4);
  const netCashChange = roundCurrency(operatingTotal + investingTotal + financingTotal, 4);
  const closingCash = roundCurrency(openingCash + periodCashDelta, 4);

  return {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    openingCash,
    closingCash,
    netCashChange,
    operating: {
      netIncome,
      nonCashAdjustments,
      workingCapitalChanges,
      total: operatingTotal,
    },
    investing: {
      items: investingItems,
      total: investingTotal,
    },
    financing: {
      items: financingItems,
      total: financingTotal,
    },
    isReconciled:
      Math.abs(netCashChange - periodCashDelta) <= 0.02 &&
      Math.abs(openingCash + netCashChange - closingCash) <= 0.02,
  };
}

/**
 * VAT / Tax Return Summary aggregating Output VAT (Sales & POS less Sales Returns)
 * vs Input VAT (Vendor Bills & Approved/Paid Expenses less Purchase Returns) by rate,
 * reconciled against 2300 Output VAT Payable and 1300 Input VAT Recoverable GL balances.
 */
export async function getVatReturnSummary(
  db: AppDatabase,
  actor: RequestActor,
  filter: ReportFilter
): Promise<VatReturnReportDto> {
  const companyId = actorCompanyId(actor);
  await ensureAccountingDefaults(db, companyId);
  const glMap = await getGlAccountMap(db, companyId);

  const fromDt = filter.fromDate ? new Date(filter.fromDate) : undefined;
  const toDt = filter.toDate ? new Date(filter.toDate) : undefined;

  const invConds: SQL[] = [
    eq(salesInvoices.companyId, companyId),
    ne(salesInvoices.status, "Cancelled"),
    ne(salesInvoices.status, "Draft"),
  ];
  if (filter.branchId) invConds.push(eq(salesInvoices.branchId, filter.branchId));
  if (fromDt) invConds.push(gte(salesInvoices.invoiceDate, fromDt));
  if (toDt) invConds.push(lte(salesInvoices.invoiceDate, toDt));

  const sretConds: SQL[] = [
    eq(salesReturns.companyId, companyId),
    ne(salesReturns.status, "Voided"),
  ];
  if (filter.branchId) sretConds.push(eq(salesReturns.branchId, filter.branchId));
  if (fromDt) sretConds.push(gte(salesReturns.returnDate, fromDt));
  if (toDt) sretConds.push(lte(salesReturns.returnDate, toDt));

  const billConds: SQL[] = [
    eq(vendorBills.companyId, companyId),
    ne(vendorBills.status, "Cancelled"),
  ];
  if (filter.branchId) billConds.push(eq(vendorBills.branchId, filter.branchId));
  if (fromDt) billConds.push(gte(vendorBills.billDate, fromDt));
  if (toDt) billConds.push(lte(vendorBills.billDate, toDt));

  const pretConds: SQL[] = [
    eq(purchaseReturns.companyId, companyId),
    ne(purchaseReturns.status, "Voided"),
  ];
  if (filter.branchId) pretConds.push(eq(purchaseReturns.branchId, filter.branchId));
  if (fromDt) pretConds.push(gte(purchaseReturns.returnDate, fromDt));
  if (toDt) pretConds.push(lte(purchaseReturns.returnDate, toDt));

  const expConds: SQL[] = [
    eq(expenseClaims.companyId, companyId),
    inArray(expenseClaims.status, ["approved", "paid"]),
  ];
  if (filter.branchId) expConds.push(eq(expenseClaims.branchId, filter.branchId));
  if (fromDt) expConds.push(gte(expenseClaims.claimDate, fromDt));
  if (toDt) expConds.push(lte(expenseClaims.claimDate, toDt));

  const [invRows, sretRows, billRows, pretRows, expRows, tb] = await Promise.all([
    db
      .select({
        docId: salesInvoices.id,
        fxRate: salesInvoices.fxRate,
        taxRate: salesInvoiceLines.taxRate,
        taxAmount: salesInvoiceLines.taxAmount,
        lineTotal: salesInvoiceLines.lineTotal,
      })
      .from(salesInvoiceLines)
      .innerJoin(salesInvoices, eq(salesInvoices.id, salesInvoiceLines.invoiceId))
      .where(and(...invConds)),
    db
      .select({
        docId: salesReturns.id,
        taxRate: salesReturnLines.taxRate,
        taxAmount: salesReturnLines.taxAmount,
        lineTotal: salesReturnLines.lineTotal,
      })
      .from(salesReturnLines)
      .innerJoin(salesReturns, eq(salesReturns.id, salesReturnLines.returnId))
      .where(and(...sretConds)),
    db
      .select({
        docId: vendorBills.id,
        fxRate: vendorBills.fxRate,
        taxRate: vendorBillLines.taxRate,
        taxAmount: vendorBillLines.taxAmount,
        lineTotal: vendorBillLines.lineTotal,
      })
      .from(vendorBillLines)
      .innerJoin(vendorBills, eq(vendorBills.id, vendorBillLines.billId))
      .where(and(...billConds)),
    db
      .select({
        docId: purchaseReturns.id,
        taxRate: purchaseReturnLines.taxRate,
        taxAmount: purchaseReturnLines.taxAmount,
        lineTotal: purchaseReturnLines.lineTotal,
      })
      .from(purchaseReturnLines)
      .innerJoin(purchaseReturns, eq(purchaseReturns.id, purchaseReturnLines.returnId))
      .where(and(...pretConds)),
    db
      .select({
        docId: expenseClaims.id,
        taxRate: expenseClaimLines.taxRate,
        netAmount: expenseClaimLines.netAmount,
        taxAmount: expenseClaimLines.taxAmount,
      })
      .from(expenseClaimLines)
      .innerJoin(expenseClaims, eq(expenseClaims.id, expenseClaimLines.claimId))
      .where(and(...expConds)),
    getTrialBalance(db, actor, {
      branchId: filter.branchId,
      fromDate: filter.fromDate,
      toDate: filter.toDate,
      excludeClosingEntries: true,
    }),
  ]);

  const outputMap = new Map<number, { taxable: number; vat: number; docs: Set<string> }>();
  const addBucket = (
    map: Map<number, { taxable: number; vat: number; docs: Set<string> }>,
    rate: number,
    taxableDelta: number,
    vatDelta: number,
    docId: string
  ) => {
    const key = roundCurrency(rate, 2);
    const cur = map.get(key) ?? { taxable: 0, vat: 0, docs: new Set<string>() };
    cur.taxable = roundCurrency(cur.taxable + taxableDelta, 4);
    cur.vat = roundCurrency(cur.vat + vatDelta, 4);
    cur.docs.add(docId);
    map.set(key, cur);
  };

  for (const r of invRows) {
    const fx = num(r.fxRate) || 1;
    const vat = num(r.taxAmount) * fx;
    const taxable = (num(r.lineTotal) - num(r.taxAmount)) * fx;
    addBucket(outputMap, num(r.taxRate), taxable, vat, r.docId);
  }
  for (const r of sretRows) {
    const vat = num(r.taxAmount);
    const taxable = num(r.lineTotal) - vat;
    addBucket(outputMap, num(r.taxRate), -taxable, -vat, r.docId);
  }

  const inputMap = new Map<number, { taxable: number; vat: number; docs: Set<string> }>();
  for (const r of billRows) {
    const fx = num(r.fxRate) || 1;
    const vat = num(r.taxAmount) * fx;
    const taxable = (num(r.lineTotal) - num(r.taxAmount)) * fx;
    addBucket(inputMap, num(r.taxRate), taxable, vat, r.docId);
  }
  for (const r of pretRows) {
    const vat = num(r.taxAmount);
    const taxable = num(r.lineTotal) - vat;
    addBucket(inputMap, num(r.taxRate), -taxable, -vat, r.docId);
  }
  for (const r of expRows) {
    addBucket(inputMap, num(r.taxRate), num(r.netAmount), num(r.taxAmount), r.docId);
  }

  const toSortedArray = (
    map: Map<number, { taxable: number; vat: number; docs: Set<string> }>
  ): VatReturnRateBucketDto[] =>
    Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([taxRate, v]) => ({
        taxRate,
        taxableAmount: v.taxable,
        vatAmount: v.vat,
        documentCount: v.docs.size,
      }));

  const outputSales = toSortedArray(outputMap);
  const inputPurchasesAndExpenses = toSortedArray(inputMap);

  const totalOutputTaxable = roundCurrency(outputSales.reduce((s, b) => s + b.taxableAmount, 0), 4);
  const totalOutputVat = roundCurrency(outputSales.reduce((s, b) => s + b.vatAmount, 0), 4);
  const totalInputTaxable = roundCurrency(
    inputPurchasesAndExpenses.reduce((s, b) => s + b.taxableAmount, 0),
    4
  );
  const totalInputVat = roundCurrency(inputPurchasesAndExpenses.reduce((s, b) => s + b.vatAmount, 0), 4);
  const netVatPayable = roundCurrency(totalOutputVat - totalInputVat, 4);

  const outGlRow = tb.rows.find((r) => r.accountId === glMap.output_vat);
  const inGlRow = tb.rows.find((r) => r.accountId === glMap.input_vat);
  const glOutputVatBalance = outGlRow ? roundCurrency(outGlRow.credit - outGlRow.debit, 4) : 0;
  const glInputVatBalance = inGlRow ? roundCurrency(inGlRow.debit - inGlRow.credit, 4) : 0;

  return {
    fromDate: filter.fromDate ?? null,
    toDate: filter.toDate ?? null,
    outputSales,
    inputPurchasesAndExpenses,
    totalOutputTaxable,
    totalOutputVat,
    totalInputTaxable,
    totalInputVat,
    netVatPayable,
    glOutputVatBalance,
    glInputVatBalance,
    glNetVatPayable: roundCurrency(glOutputVatBalance - glInputVatBalance, 4),
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
