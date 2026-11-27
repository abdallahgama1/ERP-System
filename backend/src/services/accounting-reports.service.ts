import {
  encodeCursor,
  roundCurrency,
  type CashFlowLineDto,
  type CashFlowStatementDto,
  type CursorPageInfo,
  type SubledgerReconciliationItemDto,
  type SubledgerReconciliationReportDto,
  type TreasuryReconciliationItemDto,
  type VatReturnRateBucketDto,
  type VatReturnReportDto,
} from "@erp/shared";
import { and, asc, eq, gte, inArray, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  bankStatementLines,
  branchProducts,
  chartOfAccounts,
  expenseClaimLines,
  expenseClaims,
  fixedAssets,
  journalEntries,
  journalLines,
  paymentMadeAllocations,
  paymentsMade,
  posReturnLines,
  posReturns,
  purchaseReturnLines,
  purchaseReturns,
  receivedPaymentAllocations,
  receivedPayments,
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
    conds.push(ne(journalEntries.sourceType, "year_end_close_reversal"));
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
    ne(salesInvoices.source, "opening_balance"),
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

  const posRetConds: SQL[] = [eq(posReturns.companyId, companyId)];
  if (filter.branchId) posRetConds.push(eq(posReturns.branchId, filter.branchId));
  if (fromDt) posRetConds.push(gte(posReturns.createdAt, fromDt));
  if (toDt) posRetConds.push(lte(posReturns.createdAt, toDt));

  const billConds: SQL[] = [
    eq(vendorBills.companyId, companyId),
    ne(vendorBills.status, "Cancelled"),
    ne(vendorBills.source, "opening_balance"),
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

  const [invRows, sretRows, posRetRows, billRows, pretRows, expRows, tb] = await Promise.all([
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
        docId: posReturns.id,
        taxRate: posReturnLines.taxRate,
        taxAmount: posReturnLines.taxAmount,
        lineTotal: posReturnLines.lineTotal,
      })
      .from(posReturnLines)
      .innerJoin(posReturns, eq(posReturns.id, posReturnLines.posReturnId))
      .where(and(...posRetConds)),
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
  for (const r of posRetRows) {
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

  // Query opening-balance VAT carryover (from cutover opening journal & any reversal) separately
  // so opening VAT reconciles to GL 2300/1300 without polluting current-period sales/purchase VAT buckets.
  const openingVatConds: SQL[] = [
    eq(journalEntries.companyId, companyId),
    eq(journalEntries.status, "posted"),
    inArray(journalEntries.sourceType, ["opening_balance", "opening_balance_reversal"]),
    inArray(journalLines.accountId, [glMap.output_vat, glMap.input_vat].filter(Boolean)),
  ];
  if (filter.branchId) openingVatConds.push(eq(journalEntries.branchId, filter.branchId));
  if (fromDt) openingVatConds.push(gte(journalEntries.entryDate, fromDt));
  if (toDt) openingVatConds.push(lte(journalEntries.entryDate, toDt));

  const openingVatRows =
    glMap.output_vat || glMap.input_vat
      ? await db
          .select({
            accountId: journalLines.accountId,
            debit: sql<string>`coalesce(sum(${journalLines.debitBase}), 0)`,
            credit: sql<string>`coalesce(sum(${journalLines.creditBase}), 0)`,
          })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
          .where(and(...openingVatConds))
          .groupBy(journalLines.accountId)
      : [];

  const openOutRow = openingVatRows.find((r) => r.accountId === glMap.output_vat);
  const openInRow = openingVatRows.find((r) => r.accountId === glMap.input_vat);
  const openingOutputVatCarryover = openOutRow
    ? roundCurrency(num(openOutRow.credit) - num(openOutRow.debit), 4)
    : 0;
  const openingInputVatCarryover = openInRow
    ? roundCurrency(num(openInRow.debit) - num(openInRow.credit), 4)
    : 0;

  const openingVatReconciliationNote =
    openingOutputVatCarryover !== 0 || openingInputVatCarryover !== 0
      ? `Opening cutover VAT carryover (Output: ${openingOutputVatCarryover.toFixed(2)}, Input: ${openingInputVatCarryover.toFixed(2)}) is excluded from current-period VAT return document buckets and reconciled separately against GL 2300/1300.`
      : undefined;

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
    openingOutputVatCarryover,
    openingInputVatCarryover,
    ...(openingVatReconciliationNote ? { openingVatReconciliationNote } : {}),
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

/**
 * Full Subledger-to-GL Control Account Reconciliation Report:
 * Verifies AR, AP, Inventory, Output VAT, Input VAT, Fixed Assets Cost,
 * Accumulated Depreciation, and Treasury subledgers against their bound GL control accounts.
 */
export async function getSubledgerReconciliation(
  db: AppDatabase,
  actor: RequestActor,
  filter: { asOfDate?: string; branchId?: string } = {}
): Promise<SubledgerReconciliationReportDto> {
  const companyId = actorCompanyId(actor);
  await ensureAccountingDefaults(db, companyId);
  const glMap = await getGlAccountMap(db, companyId);

  const [
    tb,
    vat,
    invRows,
    sretRows,
    rpRows,
    rpAllocRows,
    billRows,
    pretRows,
    pmRows,
    pmAllocRows,
    bpRows,
    faRows,
    treasuryRows,
    stmtRows,
    coaRows,
  ] = await Promise.all([
    getTrialBalance(db, actor, { asOfDate: filter.asOfDate, branchId: filter.branchId }),
    getVatReturnSummary(db, actor, { toDate: filter.asOfDate, branchId: filter.branchId }),
    db
      .select({
        totalAmount: salesInvoices.totalAmount,
        paidAmount: salesInvoices.paidAmount,
        creditAppliedAmount: salesInvoices.creditAppliedAmount,
        retainerAppliedAmount: salesInvoices.retainerAppliedAmount,
        fxRate: salesInvoices.fxRate,
      })
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.companyId, companyId),
          ne(salesInvoices.status, "Draft"),
          ne(salesInvoices.status, "Cancelled"),
          ...(filter.branchId ? [eq(salesInvoices.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select({
        totalAmount: salesReturns.totalAmount,
        appliedAmount: salesReturns.appliedAmount,
      })
      .from(salesReturns)
      .where(
        and(
          eq(salesReturns.companyId, companyId),
          ne(salesReturns.status, "Voided"),
          ...(filter.branchId ? [eq(salesReturns.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select({
        id: receivedPayments.id,
        amount: receivedPayments.amount,
        fxRate: receivedPayments.fxRate,
      })
      .from(receivedPayments)
      .where(and(eq(receivedPayments.companyId, companyId), ne(receivedPayments.status, "Voided"))),
    db
      .select({
        paymentId: receivedPaymentAllocations.paymentId,
        allocated: sql<string>`coalesce(sum(${receivedPaymentAllocations.amount}), 0)`,
      })
      .from(receivedPaymentAllocations)
      .groupBy(receivedPaymentAllocations.paymentId),
    db
      .select({
        totalAmount: vendorBills.totalAmount,
        paidAmount: vendorBills.paidAmount,
        fxRate: vendorBills.fxRate,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          ne(vendorBills.status, "Cancelled"),
          ...(filter.branchId ? [eq(vendorBills.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select({
        totalAmount: purchaseReturns.totalAmount,
        billId: purchaseReturns.billId,
      })
      .from(purchaseReturns)
      .where(
        and(
          eq(purchaseReturns.companyId, companyId),
          ne(purchaseReturns.status, "Voided"),
          ...(filter.branchId ? [eq(purchaseReturns.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select({
        id: paymentsMade.id,
        amount: paymentsMade.amount,
        fxRate: paymentsMade.fxRate,
      })
      .from(paymentsMade)
      .where(and(eq(paymentsMade.companyId, companyId), ne(paymentsMade.status, "Voided"))),
    db
      .select({
        paymentId: paymentMadeAllocations.paymentId,
        allocated: sql<string>`coalesce(sum(${paymentMadeAllocations.amount}), 0)`,
      })
      .from(paymentMadeAllocations)
      .groupBy(paymentMadeAllocations.paymentId),
    db
      .select({
        qtyOnHand: branchProducts.qtyOnHand,
        avgCost: branchProducts.avgCost,
      })
      .from(branchProducts)
      .where(
        and(
          eq(branchProducts.companyId, companyId),
          ...(filter.branchId ? [eq(branchProducts.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select({
        acquisitionCost: fixedAssets.acquisitionCost,
        accumulatedDepreciation: fixedAssets.accumulatedDepreciation,
        status: fixedAssets.status,
      })
      .from(fixedAssets)
      .where(
        and(
          eq(fixedAssets.companyId, companyId),
          ne(fixedAssets.status, "disposed"),
          ...(filter.branchId ? [eq(fixedAssets.branchId, filter.branchId)] : [])
        )
      ),
    db
      .select()
      .from(treasuryAccounts)
      .where(eq(treasuryAccounts.companyId, companyId))
      .orderBy(asc(treasuryAccounts.code)),
    db
      .select({
        treasuryAccountId: bankStatementLines.treasuryAccountId,
        reconciledSum: sql<string>`coalesce(sum(case when ${bankStatementLines.status} = 'reconciled' then ${bankStatementLines.amount} else 0 end), 0)`,
      })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.companyId, companyId))
      .groupBy(bankStatementLines.treasuryAccountId),
    db
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.companyId, companyId)),
  ]);

  const tbById = new Map(tb.rows.map((r) => [r.accountId, r]));
  const coaById = new Map(coaRows.map((a) => [a.id, a]));
  const glNetDebit = (accountId: string | undefined) => {
    if (!accountId) return 0;
    const row = tbById.get(accountId);
    return row ? roundCurrency(row.debit - row.credit, 4) : 0;
  };
  const glNetCredit = (accountId: string | undefined) => {
    if (!accountId) return 0;
    const row = tbById.get(accountId);
    return row ? roundCurrency(row.credit - row.debit, 4) : 0;
  };
  const glMeta = (accountId: string | undefined, fallbackCode: string, fallbackName: string) => {
    const a = accountId ? coaById.get(accountId) : undefined;
    return {
      code: a?.code ?? fallbackCode,
      name: a?.name ?? fallbackName,
    };
  };

  // 1. AR Subledger vs GL 1100
  const rpAllocByPay = new Map(rpAllocRows.map((r) => [r.paymentId, num(r.allocated)]));
  const openInvBase = invRows.reduce((sum, inv) => {
    const open = Math.max(
      0,
      num(inv.totalAmount) - num(inv.paidAmount) - num(inv.creditAppliedAmount) - num(inv.retainerAppliedAmount)
    );
    return roundCurrency(sum + open * (num(inv.fxRate) || 1), 4);
  }, 0);
  const unappliedCreditNotes = sretRows.reduce(
    (sum, r) => roundCurrency(sum + Math.max(0, num(r.totalAmount) - num(r.appliedAmount)), 4),
    0
  );
  const unallocatedCustomerPayments = rpRows.reduce((sum, rp) => {
    const unalloc = Math.max(0, num(rp.amount) - (rpAllocByPay.get(rp.id) ?? 0));
    return roundCurrency(sum + unalloc * (num(rp.fxRate) || 1), 4);
  }, 0);
  const arSubledger = roundCurrency(openInvBase - unappliedCreditNotes - unallocatedCustomerPayments, 4);
  const arGl = glNetDebit(glMap.accounts_receivable);
  const arMeta = glMeta(glMap.accounts_receivable, "1100", "Accounts Receivable");

  // 2. AP Subledger vs GL 2000
  const pmAllocByPay = new Map(pmAllocRows.map((r) => [r.paymentId, num(r.allocated)]));
  const openBillsBase = billRows.reduce((sum, b) => {
    const open = Math.max(0, num(b.totalAmount) - num(b.paidAmount));
    return roundCurrency(sum + open * (num(b.fxRate) || 1), 4);
  }, 0);
  const billedPurchaseReturns = pretRows.reduce(
    (sum, r) => (r.billId ? roundCurrency(sum + num(r.totalAmount), 4) : sum),
    0
  );
  const unallocatedVendorPayments = pmRows.reduce((sum, pm) => {
    const unalloc = Math.max(0, num(pm.amount) - (pmAllocByPay.get(pm.id) ?? 0));
    return roundCurrency(sum + unalloc * (num(pm.fxRate) || 1), 4);
  }, 0);
  const apSubledger = roundCurrency(openBillsBase - billedPurchaseReturns - unallocatedVendorPayments, 4);
  const apGl = glNetCredit(glMap.accounts_payable);
  const apMeta = glMeta(glMap.accounts_payable, "2000", "Accounts Payable");

  // 3. Inventory Valuation vs GL 1200
  const invSubledger = bpRows.reduce(
    (sum, bp) => roundCurrency(sum + num(bp.qtyOnHand) * num(bp.avgCost), 4),
    0
  );
  const invGl = glNetDebit(glMap.inventory_asset);
  const invMeta = glMeta(glMap.inventory_asset, "1200", "Inventory Asset");

  // 4. Output VAT vs GL 2300
  const outVatMeta = glMeta(glMap.output_vat, "2300", "Output VAT Payable");

  // 5. Input VAT vs GL 1300
  const inVatMeta = glMeta(glMap.input_vat, "1300", "Input VAT Recoverable");

  // 6. Fixed Assets Cost vs GL 1500 & Accum Dep vs GL 1510
  const faCostSubledger = faRows.reduce((sum, a) => roundCurrency(sum + num(a.acquisitionCost), 4), 0);
  const faCostGl = glNetDebit(glMap.fixed_assets_cost);
  const faCostMeta = glMeta(glMap.fixed_assets_cost, "1500", "Fixed Assets — Cost");

  const faAccumSubledger = faRows.reduce(
    (sum, a) => roundCurrency(sum + num(a.accumulatedDepreciation), 4),
    0
  );
  const faAccumGl = glNetCredit(glMap.accumulated_depreciation);
  const faAccumMeta = glMeta(glMap.accumulated_depreciation, "1510", "Accumulated Depreciation");

  // 7. Treasury Accounts vs Bound GL Accounts
  const stmtByTreasury = new Map(stmtRows.map((s) => [s.treasuryAccountId, roundCurrency(num(s.reconciledSum), 4)]));
  const treasuryItems: TreasuryReconciliationItemDto[] = treasuryRows.map((ta) => {
    const coa = coaById.get(ta.glAccountId);
    const glBal = glNetDebit(ta.glAccountId);
    const reconBal = stmtByTreasury.get(ta.id) ?? 0;
    return {
      treasuryAccountId: ta.id,
      code: ta.code,
      name: ta.name,
      glAccountCode: coa?.code ?? "MISSING",
      glAccountName: coa?.name ?? "Unlinked GL Account",
      glBalance: glBal,
      reconciledStatementBalance: reconBal,
      unreconciledGlDelta: roundCurrency(glBal - reconBal, 4),
      isValidAssetAccount: Boolean(coa && coa.accountType === "asset" && coa.isActive),
    };
  });
  const totalTreasuryGl = roundCurrency(
    treasuryItems.reduce((sum, t) => sum + t.glBalance, 0),
    4
  );
  const allTreasuryValid = treasuryItems.every((t) => t.isValidAssetAccount);

  const makeItem = (
    key: SubledgerReconciliationItemDto["key"],
    label: string,
    meta: { code: string; name: string },
    subledgerBalance: number,
    glBalance: number,
    details?: string
  ): SubledgerReconciliationItemDto => {
    const variance = roundCurrency(subledgerBalance - glBalance, 4);
    return {
      key,
      label,
      glAccountCode: meta.code,
      glAccountName: meta.name,
      subledgerBalance,
      glBalance,
      variance,
      isReconciled: Math.abs(variance) <= 0.02,
      ...(details ? { details } : {}),
    };
  };

  const outputVatSubledgerTotal = roundCurrency(
    vat.totalOutputVat + (vat.openingOutputVatCarryover ?? 0),
    4
  );
  const inputVatSubledgerTotal = roundCurrency(
    vat.totalInputVat + (vat.openingInputVatCarryover ?? 0),
    4
  );

  const items: SubledgerReconciliationItemDto[] = [
    makeItem("accounts_receivable", "Accounts Receivable vs Customer Balances", arMeta, arSubledger, arGl),
    makeItem("accounts_payable", "Accounts Payable vs Vendor Balances", apMeta, apSubledger, apGl),
    makeItem("inventory_asset", "Inventory Valuation vs Inventory Control", invMeta, invSubledger, invGl),
    makeItem(
      "output_vat",
      "Output VAT Subledger vs Output VAT Payable",
      outVatMeta,
      outputVatSubledgerTotal,
      vat.glOutputVatBalance,
      (vat.openingOutputVatCarryover ?? 0) !== 0
        ? `Includes ${(vat.openingOutputVatCarryover ?? 0).toFixed(2)} opening cutover VAT carryover (excluded from current-period VAT return sales buckets).`
        : undefined
    ),
    makeItem(
      "input_vat",
      "Input VAT Subledger vs Input VAT Recoverable",
      inVatMeta,
      inputVatSubledgerTotal,
      vat.glInputVatBalance,
      (vat.openingInputVatCarryover ?? 0) !== 0
        ? `Includes ${(vat.openingInputVatCarryover ?? 0).toFixed(2)} opening cutover VAT carryover (excluded from current-period VAT return purchase buckets).`
        : undefined
    ),
    makeItem("fixed_assets_cost", "Fixed Assets Register Cost vs Asset Control", faCostMeta, faCostSubledger, faCostGl),
    makeItem(
      "accumulated_depreciation",
      "Fixed Assets Accumulated Depreciation vs Contra-Asset Control",
      faAccumMeta,
      faAccumSubledger,
      faAccumGl
    ),
    {
      key: "treasury",
      label: "Treasury Accounts vs Bound GL Accounts",
      glAccountCode: treasuryItems.map((t) => t.glAccountCode).join(", ") || "1030+",
      glAccountName: `${treasuryItems.length} treasury account(s)`,
      subledgerBalance: totalTreasuryGl,
      glBalance: totalTreasuryGl,
      variance: 0,
      isReconciled: allTreasuryValid,
      details: allTreasuryValid
        ? "All treasury accounts are linked 1-to-1 to active Asset GL accounts."
        : "One or more treasury accounts are linked to a missing, inactive, or non-asset GL account.",
    },
  ];

  return {
    asOfDate: filter.asOfDate ?? null,
    items,
    treasuryAccounts: treasuryItems,
    allReconciled: items.every((i) => i.isReconciled),
  };
}
