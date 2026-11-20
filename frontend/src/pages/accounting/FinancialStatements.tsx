import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Scale, Download, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useInventory } from "@/contexts/InventoryContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { csvTimestamp, downloadCsv } from "@/lib/export/csv";
import {
  useBalanceSheetQuery,
  useProfitLossQuery,
  useTrialBalanceQuery,
} from "@/hooks/queries/useAccountingQueries";

export default function FinancialStatements() {
  const { t } = useTranslation();
  const { branches } = useInventory();
  const { settings } = useSettings();

  const [tab, setTab] = useState("trial-balance");
  const [branchFilter, setBranchFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const filter = {
    branchId: branchFilter,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    asOfDate: toDate || undefined,
  };

  const { data: tb, isLoading: loadingTb } = useTrialBalanceQuery(filter, tab === "trial-balance");
  const { data: pnl, isLoading: loadingPnl } = useProfitLossQuery(filter, tab === "profit-loss");
  const { data: bs, isLoading: loadingBs } = useBalanceSheetQuery(filter, tab === "balance-sheet");

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
              "Real-time Trial Balance, Profit & Loss (COGS gross margin), and Balance Sheet derived directly from posted GL journals."
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
          </div>
        </CardHeader>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="trial-balance">
            {t("accounting.statements.trialBalance", "Trial Balance")}
          </TabsTrigger>
          <TabsTrigger value="profit-loss">
            {t("accounting.statements.profitLoss", "Profit & Loss")}
          </TabsTrigger>
          <TabsTrigger value="balance-sheet">
            {t("accounting.statements.balanceSheet", "Balance Sheet")}
          </TabsTrigger>
        </TabsList>

        {/* Trial Balance */}
        <TabsContent value="trial-balance">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div>
                <CardTitle>{t("accounting.statements.trialBalance", "Trial Balance")}</CardTitle>
                <CardDescription>{t("accounting.statements.trialBalanceDesc", "Posted period totals and net closing balances")}</CardDescription>
              </div>
              {tb && (
                <Badge variant={tb.isBalanced ? "default" : "destructive"} className="gap-1">
                  {tb.isBalanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {tb.isBalanced ? t("accounting.journals.balanced", "Balanced") : t("accounting.statements.outOfBalance", "Out of Balance")}
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
                        <TableCell className="text-end font-mono">{r.closingDebit > 0 ? formatMoney(r.closingDebit, ccy) : "—"}</TableCell>
                        <TableCell className="text-end font-mono">{r.closingCredit > 0 ? formatMoney(r.closingCredit, ccy) : "—"}</TableCell>
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

        {/* Profit & Loss */}
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
                      <TableBody>
                        {pnl.revenueAccounts.map((a) => (
                          <TableRow key={a.accountId}>
                            <TableCell className="w-24 font-mono">{a.code}</TableCell>
                            <TableCell>{a.name}</TableCell>
                            <TableCell className="text-end font-mono">{formatMoney(a.balance, ccy)}</TableCell>
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
                  {bs.isBalanced ? t("accounting.journals.balanced", "Assets = L + E") : t("accounting.statements.outOfBalance", "Out of Balance")}
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
                          <TableCell colSpan={2} className="font-semibold">{t("accounting.statements.assets", "Total Assets")}</TableCell>
                          <TableCell className="text-end font-mono font-bold">{formatMoney(bs.totalAssets, ccy)}</TableCell>
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
      </Tabs>
    </div>
  );
}
