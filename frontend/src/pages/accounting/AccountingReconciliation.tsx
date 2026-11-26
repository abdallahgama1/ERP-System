import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Landmark,
  RefreshCw,
  Scale,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useSubledgerReconciliationQuery } from "@/hooks/queries/useAccountingQueries";

export default function AccountingReconciliation() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const ccy = settings.currency || "EGP";

  const [asOfDate, setAsOfDate] = useState<string>("");
  const { data: report, isLoading, isFetching, error, refetch } =
    useSubledgerReconciliationQuery(asOfDate ? { asOfDate } : undefined);

  const passedCount = report ? report.items.filter((i) => i.isReconciled).length : 0;
  const totalCount = report ? report.items.length : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Scale className="h-7 w-7 text-primary" />
            {t("accounting.reconciliation.title", "Subledger-to-GL Reconciliation")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.reconciliation.description",
              "Compare operational subledgers (AR, AP, Inventory, VAT, Fixed Assets, and Treasury) against their General Ledger control accounts."
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="reconciliation-as-of" className="text-xs text-muted-foreground">
              {t("accounting.reconciliation.asOfDate", "As of Date")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="reconciliation-as-of"
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="w-44"
                data-testid="reconciliation-as-of-input"
              />
              {asOfDate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAsOfDate("")}
                  data-testid="reconciliation-clear-date"
                >
                  {t("common.clear", "Clear")}
                </Button>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="reconciliation-refresh"
          >
            <RefreshCw className={`h-4 w-4 me-2 ${isFetching ? "animate-spin" : ""}`} />
            {t("common.refresh", "Refresh")}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive" role="alert">
          <CardContent className="py-4 text-sm text-destructive">
            {error instanceof Error ? error.message : t("common.error")}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t("common.loading")}
          </CardContent>
        </Card>
      ) : report ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card data-testid="reconciliation-overall-card">
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.reconciliation.overallStatus", "Reconciliation Status")}
                </CardDescription>
                <CardTitle className="flex items-center gap-2 text-xl">
                  {report.allReconciled ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {t("accounting.reconciliation.allPassed", "All Reconciled")}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                      <span className="text-destructive">
                        {t("accounting.reconciliation.discrepancyDetected", "Discrepancy Detected")}
                      </span>
                    </>
                  )}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.reconciliation.controlsPassing", "Controls Passing")}
                </CardDescription>
                <CardTitle className="text-2xl font-mono" data-testid="reconciliation-pass-count">
                  {passedCount} / {totalCount}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.reconciliation.asOfLabel", "Cutoff / As Of")}
                </CardDescription>
                <CardTitle className="text-xl font-mono" data-testid="reconciliation-as-of-display">
                  {report.asOfDate || t("accounting.reconciliation.liveAllDates", "Live (All Dates)")}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                {t("accounting.reconciliation.controlAccountsTitle", "Control Account Checks")}
              </CardTitle>
              <CardDescription>
                {t(
                  "accounting.reconciliation.controlAccountsDesc",
                  "Subledger balance compared against posted General Ledger balance (tolerance 0.01)."
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">
                      {t("accounting.reconciliation.columns.control", "Control Account")}
                    </TableHead>
                    <TableHead className="text-start">
                      {t("accounting.reconciliation.columns.glAccount", "GL Account")}
                    </TableHead>
                    <TableHead className="text-end">
                      {t("accounting.reconciliation.columns.subledger", "Subledger")}
                    </TableHead>
                    <TableHead className="text-end">
                      {t("accounting.reconciliation.columns.glBalance", "GL Balance")}
                    </TableHead>
                    <TableHead className="text-end">
                      {t("accounting.reconciliation.columns.difference", "Difference")}
                    </TableHead>
                    <TableHead className="text-center">
                      {t("common.status", "Status")}
                    </TableHead>
                    <TableHead className="text-start">
                      {t("accounting.reconciliation.columns.details", "Details")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.items.map((item) => (
                    <TableRow key={item.key} data-testid={`reconciliation-row-${item.key}`}>
                      <TableCell className="font-medium">{item.label}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.glAccountCode} {item.glAccountName}
                      </TableCell>
                      <TableCell className="text-end font-mono">
                        {formatMoney(item.subledgerBalance, ccy)}
                      </TableCell>
                      <TableCell className="text-end font-mono">
                        {formatMoney(item.glBalance, ccy)}
                      </TableCell>
                      <TableCell
                        className={`text-end font-mono font-semibold ${
                          item.isReconciled ? "text-muted-foreground" : "text-destructive"
                        }`}
                      >
                        {formatMoney(item.variance, ccy)}
                      </TableCell>
                      <TableCell className="text-center">
                        {item.isReconciled ? (
                          <Badge
                            variant="secondary"
                            className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            data-testid={`reconciliation-status-${item.key}`}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 me-1" />
                            {t("accounting.reconciliation.pass", "Pass")}
                          </Badge>
                        ) : (
                          <Badge
                            variant="destructive"
                            data-testid={`reconciliation-status-${item.key}`}
                          >
                            <XCircle className="h-3.5 w-3.5 me-1" />
                            {t("accounting.reconciliation.fail", "Fail")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-xs">
                        {item.details || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {report.treasuryAccounts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Landmark className="h-5 w-5 text-primary" />
                  {t("accounting.reconciliation.treasuryBreakdownTitle", "Treasury Accounts Breakdown")}
                </CardTitle>
                <CardDescription>
                  {t(
                    "accounting.reconciliation.treasuryBreakdownDesc",
                    "Posted GL balance vs reconciled bank statement balance for each active treasury account."
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-start">
                        {t("accounting.reconciliation.columns.treasuryAccount", "Treasury Account")}
                      </TableHead>
                      <TableHead className="text-start">
                        {t("accounting.reconciliation.columns.glAccount", "GL Account")}
                      </TableHead>
                      <TableHead className="text-end">
                        {t("accounting.reconciliation.columns.glBalance", "GL Balance")}
                      </TableHead>
                      <TableHead className="text-end">
                        {t("accounting.reconciliation.columns.reconciledStatement", "Reconciled Statement")}
                      </TableHead>
                      <TableHead className="text-end">
                        {t("accounting.reconciliation.columns.unreconciledDelta", "Unreconciled Delta")}
                      </TableHead>
                      <TableHead className="text-center">
                        {t("common.status", "Status")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.treasuryAccounts.map((tr) => (
                      <TableRow key={tr.treasuryAccountId}>
                        <TableCell className="font-medium">
                          <span className="font-mono me-1.5">{tr.code}</span>
                          {tr.name}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {tr.glAccountCode} {tr.glAccountName}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {formatMoney(tr.glBalance, ccy)}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {formatMoney(tr.reconciledStatementBalance, ccy)}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {formatMoney(tr.unreconciledGlDelta, ccy)}
                        </TableCell>
                        <TableCell className="text-center">
                          {tr.isValidAssetAccount ? (
                            <Badge variant="secondary">
                              {t("accounting.reconciliation.pass", "Pass")}
                            </Badge>
                          ) : (
                            <Badge variant="destructive">
                              {t("accounting.reconciliation.fail", "Fail")}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
