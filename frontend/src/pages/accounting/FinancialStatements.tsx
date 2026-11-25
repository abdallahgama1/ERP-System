import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Scale, Download, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { csvTimestamp, downloadCsv } from "@/lib/export/csv";
import {
  useBalanceSheetQuery,
  useCashFlowQuery,
  useCostCentersQuery,
  useProfitLossQuery,
  useTrialBalanceQuery,
  useVatReturnQuery,
} from "@/hooks/queries/useAccountingQueries";

export default function FinancialStatements() {
  const { t } = useTranslation();
  const { branches } = useInventoryScope();
  const { settings } = useSettings();
  const { data: costCenters = [] } = useCostCentersQuery(false);

  const [tab, setTab] = useState("trial-balance");
  const [branchFilter, setBranchFilter] = useState("all");
  const [costCenterFilter, setCostCenterFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareFromDate, setCompareFromDate] = useState("");
  const [compareToDate, setCompareToDate] = useState("");

  const supportsCostCenter = tab === "trial-balance" || tab === "profit-loss";
  const filter = {
    branchId: branchFilter,
    costCenterId: supportsCostCenter ? costCenterFilter : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    asOfDate: toDate || undefined,
    compareFromDate: tab === "profit-loss" && compareEnabled && compareFromDate ? compareFromDate : undefined,
    compareToDate: tab === "profit-loss" && compareEnabled && compareToDate ? compareToDate : undefined,
  };

  const { data: tb, isLoading: loadingTb } = useTrialBalanceQuery(filter, tab === "trial-balance");
  const { data: pnl, isLoading: loadingPnl } = useProfitLossQuery(filter, tab === "profit-loss");
  const { data: bs, isLoading: loadingBs } = useBalanceSheetQuery(filter, tab === "balance-sheet");
  const { data: cf, isLoading: loadingCf } = useCashFlowQuery(filter, tab === "cash-flow");
  const { data: vat, isLoading: loadingVat } = useVatReturnQuery(filter, tab === "vat-return");

  const ccy = settings.currency || "USD";
  const grossMarginPct =
    pnl && pnl.totalRevenue > 0 ? ((pnl.grossProfit / pnl.totalRevenue) * 100).toFixed(1) : "0.0";

  const exportCurrentCsv = () => {
    if (tab === "trial-balance" && tb) {
      downloadCsv(`trial-balance-${csvTimestamp()}`, tb.rows, [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Type", value: (r) => r.accountType },
        { header: "Debit", value: (r) => r.debit.toFixed(2) },
        { header: "Credit", value: (r) => r.credit.toFixed(2) },
        { header: "Closing Debit", value: (r) => r.closingDebit.toFixed(2) },
        { header: "Closing Credit", value: (r) => r.closingCredit.toFixed(2) },
      ]);
      return;
    }
    if (tab === "profit-loss" && pnl) {
      const combined = [...pnl.revenueAccounts, ...pnl.expenseAccounts];
      downloadCsv(`profit-loss-${csvTimestamp()}`, combined, [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Section", value: (r) => r.accountType },
        { header: "Balance", value: (r) => r.balance.toFixed(2) },
      ]);
      return;
    }
    if (tab === "balance-sheet" && bs) {
      const combined = [...bs.assets, ...bs.liabilities, ...bs.equity];
      downloadCsv(`balance-sheet-${csvTimestamp()}`, combined, [
        { header: "Code", value: (r) => r.code },
        { header: "Account", value: (r) => r.name },
        { header: "Section", value: (r) => r.accountType },
        { header: "Balance", value: (r) => r.balance.toFixed(2) },
      ]);
      return;
    }
    if (tab === "cash-flow" && cf) {
      const rows = [
        { section: "Operating", label: "Net Income", amount: cf.operating.netIncome },
        ...cf.operating.nonCashAdjustments.map((i) => ({ section: "Operating", label: i.label, amount: i.amount })),
        ...cf.operating.workingCapitalChanges.map((i) => ({ section: "Operating", label: i.label, amount: i.amount })),
        ...cf.investing.items.map((i) => ({ section: "Investing", label: i.label, amount: i.amount })),
        ...cf.financing.items.map((i) => ({ section: "Financing", label: i.label, amount: i.amount })),
      ];
      downloadCsv(`cash-flow-${csvTimestamp()}`, rows, [
        { header: "Section", value: (r) => r.section },
        { header: "Line", value: (r) => r.label },
        { header: "Amount", value: (r) => r.amount.toFixed(2) },
      ]);
      return;
    }
    if (tab === "vat-return" && vat) {
      const rows = [
        ...vat.outputSales.map((b) => ({ direction: "Output VAT", ...b })),
        ...vat.inputPurchasesAndExpenses.map((b) => ({ direction: "Input VAT", ...b })),
      ];
      downloadCsv(`vat-return-${csvTimestamp()}`, rows, [
        { header: "Direction", value: (r) => r.direction },
        { header: "Rate %", value: (r) => r.taxRate.toFixed(2) },
        { header: "Taxable", value: (r) => r.taxableAmount.toFixed(2) },
        { header: "VAT", value: (r) => r.vatAmount.toFixed(2) },
      ]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Scale className="h-7 w-7 text-primary" />
            {t("accounting.statements.title", "Financial Statements")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.statements.description",
              "Real-time Trial Balance, Comparative P&L, Balance Sheet, Indirect Cash Flow, and VAT Return Summary."
            )}
          </p>
        </div>
        <Button variant="outline" onClick={exportCurrentCsv}>
          <Download className="h-4 w-4 me-2" />
          CSV
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.allBranches", "All Branches")}</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.branchId} value={b.branchId}>
                    {b.branch_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {supportsCostCenter && (
              <Select value={costCenterFilter} onValueChange={setCostCenterFilter}>
                <SelectTrigger
                  className="w-[220px]"
                  aria-label="Cost Center Filter"
                  data-testid="statement-cost-center-filter"
                >
                  <SelectValue placeholder="All Cost Centers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("accounting.costCenters.all", "All Cost Centers")}
                  </SelectItem>
                  {costCenters.map((cc) => (
                    <SelectItem key={cc.id} value={cc.id}>
                      {cc.code} — {cc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {tab !== "balance-sheet" && (
              <Input
                type="date"
                className="w-40"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
              />
            )}
            <Input
              type="date"
              className="w-40"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              aria-label={tab === "balance-sheet" ? "As of date" : "To date"}
            />

            {tab === "profit-loss" && (
              <div className="flex items-center gap-2 ms-auto">
                <Switch
                  id="pnl-compare-toggle"
                  checked={compareEnabled}
                  onCheckedChange={setCompareEnabled}
                />
                <Label htmlFor="pnl-compare-toggle" className="text-sm">
                  Compare Prior Period
                </Label>
                {compareEnabled && (
                  <>
                    <Input
                      type="date"
                      className="w-36"
                      value={compareFromDate}
                      onChange={(e) => setCompareFromDate(e.target.value)}
                      aria-label="Compare from date"
                    />
                    <Input
                      type="date"
                      className="w-36"
                      value={compareToDate}
                      onChange={(e) => setCompareToDate(e.target.value)}
                      aria-label="Compare to date"
                    />
                  </>
                )}
              </div>
            )}
          </div>
        </CardHeader>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="trial-balance">
            {t("accounting.statements.trialBalance", "Trial Balance")}
          </TabsTrigger>
          <TabsTrigger value="profit-loss">
            {t("accounting.statements.profitLoss", "Profit & Loss")}
          </TabsTrigger>
          <TabsTrigger value="balance-sheet">
            {t("accounting.statements.balanceSheet", "Balance Sheet")}
          </TabsTrigger>
          <TabsTrigger value="cash-flow">
            {t("accounting.statements.cashFlow", "Cash Flow")}
          </TabsTrigger>
          <TabsTrigger value="vat-return">
            {t("accounting.statements.vatReturn", "VAT Return")}
          </TabsTrigger>
        </TabsList>

        {/* Trial Balance */}
        <TabsContent value="trial-balance">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div>
                <CardTitle>{t("accounting.statements.trialBalance", "Trial Balance")}</CardTitle>
                <CardDescription>
                  {t("accounting.statements.trialBalanceDesc", "Posted period totals and net closing balances")}
                </CardDescription>
              </div>
              {tb && (
                <Badge variant={tb.isBalanced ? "default" : "destructive"} className="gap-1">
                  {tb.isBalanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {tb.isBalanced
                    ? t("accounting.journals.balanced", "Balanced")
                    : t("accounting.statements.outOfBalance", "Out of Balance")}
                </Badge>
              )}
            </CardHeader>
            <CardContent>
              {loadingTb || !tb ? (
                <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">{t("accounting.accounts.code", "Code")}</TableHead>
                      <TableHead>{t("accounting.accounts.name", "Account")}</TableHead>
                      <TableHead>{t("accounting.accounts.type", "Type")}</TableHead>
                      <TableHead className="text-end">{t("accounting.journals.debit", "Debit")}</TableHead>
                      <TableHead className="text-end">{t("accounting.journals.credit", "Credit")}</TableHead>
                      <TableHead className="text-end">{t("accounting.statements.closingDebit", "Net Dr")}</TableHead>
                      <TableHead className="text-end">{t("accounting.statements.closingCredit", "Net Cr")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tb.rows.map((r) => (
                      <TableRow key={r.accountId}>
                        <TableCell className="font-mono font-medium">{r.code}</TableCell>
                        <TableCell>{r.name}</TableCell>
                        <TableCell className="capitalize text-muted-foreground">{r.accountType}</TableCell>
                        <TableCell className="text-end font-mono">{formatMoney(r.debit, ccy)}</TableCell>
                        <TableCell className="text-end font-mono">{formatMoney(r.credit, ccy)}</TableCell>
                        <TableCell className="text-end font-mono">
                          {r.closingDebit > 0 ? formatMoney(r.closingDebit, ccy) : "—"}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {r.closingCredit > 0 ? formatMoney(r.closingCredit, ccy) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={3} className="font-semibold">
                        {t("common.total", "Totals")}
                      </TableCell>
                      <TableCell className="text-end font-mono font-bold">
                        {formatMoney(tb.totalDebit, ccy)}
                      </TableCell>
                      <TableCell className="text-end font-mono font-bold">
                        {formatMoney(tb.totalCredit, ccy)}
                      </TableCell>
                      <TableCell colSpan={2} />
                    </TableRow>
                  </TableFooter>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Profit & Loss (with optional Comparative Prior Period) */}
        <TabsContent value="profit-loss" className="space-y-4">
          {loadingPnl || !pnl ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading")}</CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>{t("accounting.statements.revenue", "Revenue")}</CardDescription>
                    <CardTitle className="text-2xl">{formatMoney(pnl.totalRevenue, ccy)}</CardTitle>
                    {pnl.comparative && (
                      <div className="text-xs text-muted-foreground">
                        Prior: {formatMoney(pnl.comparative.totalRevenue, ccy)} (
                        {pnl.comparative.revenueVariance >= 0 ? "+" : ""}
                        {formatMoney(pnl.comparative.revenueVariance, ccy)})
                      </div>
                    )}
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>{t("accounting.statements.cogs", "Cost of Goods Sold")}</CardDescription>
                    <CardTitle className="text-2xl">{formatMoney(pnl.cogsTotal, ccy)}</CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>{t("accounting.statements.grossProfit", "Gross Profit")}</CardDescription>
                    <CardTitle className="text-2xl">
                      {formatMoney(pnl.grossProfit, ccy)}{" "}
                      <span className="text-sm font-normal text-muted-foreground">({grossMarginPct}%)</span>
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>{t("accounting.statements.netIncome", "Net Income")}</CardDescription>
                    <CardTitle className={`text-2xl ${pnl.netIncome < 0 ? "text-destructive" : "text-green-600"}`}>
                      {formatMoney(pnl.netIncome, ccy)}
                    </CardTitle>
                    {pnl.comparative && (
                      <div className="text-xs text-muted-foreground">
                        Prior: {formatMoney(pnl.comparative.netIncome, ccy)} (
                        {pnl.comparative.netIncomeVariance >= 0 ? "+" : ""}
                        {formatMoney(pnl.comparative.netIncomeVariance, ccy)})
                      </div>
                    )}
                  </CardHeader>
                </Card>
              </div>

              <Card>
                <CardContent className="pt-6 space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      {t("accounting.statements.revenue", "Revenue")}
                    </h3>
                    <Table>
                      {pnl.comparative && (
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">Code</TableHead>
                            <TableHead>Account</TableHead>
                            <TableHead className="text-end">Current</TableHead>
                            <TableHead className="text-end">Prior</TableHead>
                            <TableHead className="text-end">Variance</TableHead>
                          </TableRow>
                        </TableHeader>
                      )}
                      <TableBody>
                        {pnl.revenueAccounts.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-24 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
                            {pnl.comparative && (
                              <>
                                <TableCell className="text-end font-mono text-muted-foreground">
                                  {formatMoney(a.priorBalance ?? 0, ccy)}
                                </TableCell>
                                <TableCell className="text-end font-mono">
                                  {(a.variance ?? 0) >= 0 ? "+" : ""}
                                  {formatMoney(a.variance ?? 0, ccy)}
                                </TableCell>
                              </>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      {t("accounting.statements.expenses", "COGS & Expenses")}
                    </h3>
                    <Table>
                      <TableBody>
                        {pnl.expenseAccounts.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-24 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
                            {pnl.comparative && (
                              <>
                                <TableCell className="text-end font-mono text-muted-foreground">
                                  {formatMoney(a.priorBalance ?? 0, ccy)}
                                </TableCell>
                                <TableCell className="text-end font-mono">
                                  {(a.variance ?? 0) >= 0 ? "+" : ""}
                                  {formatMoney(a.variance ?? 0, ccy)}
                                </TableCell>
                              </>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* Balance Sheet */}
        <TabsContent value="balance-sheet" className="space-y-4">
          {loadingBs || !bs ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading")}</CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="grid gap-4 md:grid-cols-3 flex-1">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>{t("accounting.statements.assets", "Total Assets")}</CardDescription>
                      <CardTitle className="text-2xl">{formatMoney(bs.totalAssets, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>{t("accounting.statements.liabilities", "Total Liabilities")}</CardDescription>
                      <CardTitle className="text-2xl">{formatMoney(bs.totalLiabilities, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>{t("accounting.statements.equity", "Total Equity")}</CardDescription>
                      <CardTitle className="text-2xl">{formatMoney(bs.totalEquity, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                </div>
                <Badge variant={bs.isBalanced ? "default" : "destructive"} className="gap-1">
                  {bs.isBalanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {bs.isBalanced
                    ? t("accounting.journals.balanced", "Assets = L + E")
                    : t("accounting.statements.outOfBalance", "Out of Balance")}
                </Badge>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("accounting.statements.assets", "Assets")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableBody>
                        {bs.assets.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-20 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={2} className="font-semibold">
                            {t("accounting.statements.assets", "Total Assets")}
                          </TableCell>
                          <TableCell className="text-end font-mono font-bold">
                            {formatMoney(bs.totalAssets, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{t("accounting.statements.liabilitiesAndEquity", "Liabilities & Equity")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Table>
                      <TableBody>
                        {bs.liabilities.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-20 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
                          </TableRow>
                        ))}
                        {bs.equity.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-20 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell className="w-20 font-mono">—</TableCell>
                          <TableCell className="font-medium">
                            {t("accounting.statements.currentYearEarnings", "Current Year Earnings")}
                          </TableCell>
                          <TableCell className="text-end font-mono">
                            {formatMoney(bs.currentYearEarnings, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={2} className="font-semibold">
                            {t("accounting.statements.totalLAndE", "Total Liabilities & Equity")}
                          </TableCell>
                          <TableCell className="text-end font-mono font-bold">
                            {formatMoney(bs.totalLiabilitiesAndEquity, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* Indirect Cash Flow Statement */}
        <TabsContent value="cash-flow" className="space-y-4">
          {loadingCf || !cf ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading")}</CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="grid gap-4 md:grid-cols-3 flex-1">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Opening Cash & Bank</CardDescription>
                      <CardTitle className="text-2xl">{formatMoney(cf.openingCash, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Net Change in Cash</CardDescription>
                      <CardTitle className="text-2xl">{formatMoney(cf.netCashChange, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Closing Cash & Bank</CardDescription>
                      <CardTitle className="text-2xl text-primary">{formatMoney(cf.closingCash, ccy)}</CardTitle>
                    </CardHeader>
                  </Card>
                </div>
                <Badge variant={cf.isReconciled ? "default" : "destructive"} className="gap-1">
                  {cf.isReconciled ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {cf.isReconciled ? "Reconciled to Cash GL" : "Out of Reconciliation"}
                </Badge>
              </div>

              <Card>
                <CardContent className="pt-6 space-y-6">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Operating Activities
                    </h3>
                    <Table>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">Net Income</TableCell>
                          <TableCell className="text-end font-mono">
                            {formatMoney(cf.operating.netIncome, ccy)}
                          </TableCell>
                        </TableRow>
                        {cf.operating.nonCashAdjustments.map((item) => (
                          <TableRow key={`nc-${item.code}`}>
                            <TableCell>{item.label}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(item.amount, ccy)}</TableCell>
                          </TableRow>
                        ))}
                        {cf.operating.workingCapitalChanges.map((item) => (
                          <TableRow key={`wc-${item.code}`}>
                            <TableCell>{item.label}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(item.amount, ccy)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell className="font-semibold">Net Cash from Operating Activities</TableCell>
                          <TableCell className="text-end font-mono font-bold">
                            {formatMoney(cf.operating.total, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Investing Activities
                    </h3>
                    <Table>
                      <TableBody>
                        {cf.investing.items.length === 0 ? (
                          <TableRow>
                            <TableCell className="text-muted-foreground">No capital expenditure movements</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(0, ccy)}</TableCell>
                          </TableRow>
                        ) : (
                          cf.investing.items.map((item) => (
                            <TableRow key={`inv-${item.code}`}>
                              <TableCell>{item.label}</TableCell>
                              <TableCell className="text-end font-mono">{formatMoney(item.amount, ccy)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell className="font-semibold">Net Cash from Investing Activities</TableCell>
                          <TableCell className="text-end font-mono font-bold">
                            {formatMoney(cf.investing.total, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Financing Activities
                    </h3>
                    <Table>
                      <TableBody>
                        {cf.financing.items.length === 0 ? (
                          <TableRow>
                            <TableCell className="text-muted-foreground">No equity financing movements</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(0, ccy)}</TableCell>
                          </TableRow>
                        ) : (
                          cf.financing.items.map((item) => (
                            <TableRow key={`fin-${item.code}`}>
                              <TableCell>{item.label}</TableCell>
                              <TableCell className="text-end font-mono">{formatMoney(item.amount, ccy)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell className="font-semibold">Net Cash from Financing Activities</TableCell>
                          <TableCell className="text-end font-mono font-bold">
                            {formatMoney(cf.financing.total, ccy)}
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* VAT / Tax Return Summary */}
        <TabsContent value="vat-return" className="space-y-4">
          {loadingVat || !vat ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading")}</CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Output VAT (Sales & POS)</CardDescription>
                    <CardTitle className="text-2xl">{formatMoney(vat.totalOutputVat, ccy)}</CardTitle>
                    <div className="text-xs text-muted-foreground">
                      GL 2300 Balance: {formatMoney(vat.glOutputVatBalance, ccy)}
                    </div>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Input VAT (Bills & Expenses)</CardDescription>
                    <CardTitle className="text-2xl">{formatMoney(vat.totalInputVat, ccy)}</CardTitle>
                    <div className="text-xs text-muted-foreground">
                      GL 1300 Balance: {formatMoney(vat.glInputVatBalance, ccy)}
                    </div>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>
                      {vat.netVatPayable >= 0 ? "Net VAT Payable to Authority" : "Net VAT Refundable Credit"}
                    </CardDescription>
                    <CardTitle className="text-2xl text-primary">
                      {formatMoney(vat.netVatPayable, ccy)}
                    </CardTitle>
                  </CardHeader>
                </Card>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Output VAT by Tax Rate</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rate %</TableHead>
                          <TableHead className="text-end">Docs</TableHead>
                          <TableHead className="text-end">Taxable Sales</TableHead>
                          <TableHead className="text-end">Output VAT</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vat.outputSales.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No taxable sales in range
                            </TableCell>
                          </TableRow>
                        ) : (
                          vat.outputSales.map((b) => (
                            <TableRow key={`out-${b.taxRate}`}>
                              <TableCell className="font-mono">{b.taxRate}%</TableCell>
                              <TableCell className="text-end">{b.documentCount}</TableCell>
                              <TableCell className="text-end font-mono">
                                {formatMoney(b.taxableAmount, ccy)}
                              </TableCell>
                              <TableCell className="text-end font-mono font-semibold">
                                {formatMoney(b.vatAmount, ccy)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Input VAT by Tax Rate</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rate %</TableHead>
                          <TableHead className="text-end">Docs</TableHead>
                          <TableHead className="text-end">Taxable Purchases</TableHead>
                          <TableHead className="text-end">Input VAT</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vat.inputPurchasesAndExpenses.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                              No recoverable input VAT in range
                            </TableCell>
                          </TableRow>
                        ) : (
                          vat.inputPurchasesAndExpenses.map((b) => (
                            <TableRow key={`in-${b.taxRate}`}>
                              <TableCell className="font-mono">{b.taxRate}%</TableCell>
                              <TableCell className="text-end">{b.documentCount}</TableCell>
                              <TableCell className="text-end font-mono">
                                {formatMoney(b.taxableAmount, ccy)}
                              </TableCell>
                              <TableCell className="text-end font-mono font-semibold">
                                {formatMoney(b.vatAmount, ccy)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
