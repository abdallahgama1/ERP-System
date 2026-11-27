import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  CSV_TEMPLATES,
  type OpeningBalancesImportResultDto,
  type StandardImportKind,
} from "@erp/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import CsvImportDialog from "@/components/import/CsvImportDialog";
import {
  downloadImportTemplate,
  useCutoverReadinessQuery,
  useImportMutations,
  useOpeningCutoverStatusQuery,
} from "@/hooks/queries/useImportsQueries";

const ORDERED_DATASETS: Array<{
  step: number;
  kind: StandardImportKind;
  titleKey: string;
  fallbackTitle: string;
  descKey: string;
  fallbackDesc: string;
}> = [
  {
    step: 1,
    kind: "chart_of_accounts",
    titleKey: "imports.datasets.chartOfAccounts",
    fallbackTitle: "Chart of Accounts",
    descKey: "imports.datasets.chartOfAccountsDesc",
    fallbackDesc: "Import custom GL accounts with mapping-guard validation and projected Setup Health.",
  },
  {
    step: 2,
    kind: "customers",
    titleKey: "imports.datasets.customers",
    fallbackTitle: "Customers",
    descKey: "imports.datasets.customersDesc",
    fallbackDesc: "Import customer master records with ETA receiver type (B/P/F) and 9-digit RIN / 14-digit NID checks.",
  },
  {
    step: 3,
    kind: "vendors",
    titleKey: "imports.datasets.vendors",
    fallbackTitle: "Vendors",
    descKey: "imports.datasets.vendorsDesc",
    fallbackDesc: "Import vendor master records with ETA tax/national ID validation.",
  },
  {
    step: 4,
    kind: "products",
    titleKey: "imports.datasets.products",
    fallbackTitle: "Products & Barcodes",
    descKey: "imports.datasets.productsDesc",
    fallbackDesc: "Import product catalog including barcodes, Arabic names, UOM, and ETA GS1/EGS fields.",
  },
  {
    step: 5,
    kind: "opening_stock",
    titleKey: "imports.datasets.openingStock",
    fallbackTitle: "Opening Stock per Branch",
    descKey: "imports.datasets.openingStockDesc",
    fallbackDesc: "Load physical opening stock quantities and unit costs per branch (reconciled to GL 1200).",
  },
  {
    step: 6,
    kind: "opening_fixed_assets",
    titleKey: "imports.datasets.openingFixedAssets",
    fallbackTitle: "Opening Fixed Assets Register",
    descKey: "imports.datasets.openingFixedAssetsDesc",
    fallbackDesc: "Load existing fixed assets with cost and accumulated depreciation (reconciled to GL 1500/1510).",
  },
  {
    step: 7,
    kind: "opening_treasury",
    titleKey: "imports.datasets.openingTreasury",
    fallbackTitle: "Opening Treasury Accounts",
    descKey: "imports.datasets.openingTreasuryDesc",
    fallbackDesc: "Register opening bank and cashbox accounts linked 1-to-1 to active Asset GL accounts.",
  },
];

export default function DataImports() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettings();
  const ccy = settings.currency || "EGP";

  const { data: status } = useOpeningCutoverStatusQuery();
  const {
    data: readiness,
    isFetching: readinessFetching,
    refetch: refetchReadiness,
  } = useCutoverReadinessQuery();
  const { runOpeningBalancesImport, reverseOpeningBalances } = useImportMutations();

  const [activeDialogKind, setActiveDialogKind] = useState<StandardImportKind | null>(null);

  // Opening Balances Cutover state
  const [cutoverDate, setCutoverDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [allowPnlAccounts, setAllowPnlAccounts] = useState(false);
  const [tbCsv, setTbCsv] = useState("");
  const [arCsv, setArCsv] = useState("");
  const [apCsv, setApCsv] = useState("");
  const [openingResult, setOpeningResult] = useState<OpeningBalancesImportResultDto | null>(null);
  const [openingError, setOpeningError] = useState<string | null>(null);

  // Controlled Reversal Dialog state
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseError, setReverseError] = useState<string | null>(null);

  const activeDataset = ORDERED_DATASETS.find((d) => d.kind === activeDialogKind) ?? null;

  const readCsvFile = async (e: React.ChangeEvent<HTMLInputElement>, setter: (v: string) => void) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setter(await file.text());
    setOpeningResult(null);
    setOpeningError(null);
  };

  const handleOpeningRun = async (dryRun: boolean) => {
    setOpeningError(null);
    try {
      const res = await runOpeningBalancesImport.mutateAsync({
        cutoverDate,
        allowPnlAccounts,
        trialBalanceCsv: tbCsv,
        openArCsv: arCsv,
        openApCsv: apCsv,
        dryRun,
      });
      setOpeningResult(res);
      if (!dryRun && res.valid) {
        toast({
          title: t("imports.openingCommitted", "Opening balances cutover posted"),
          description: res.journalEntryNumber ?? "",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error");
      setOpeningError(msg);
      toast({ title: msg, variant: "destructive" });
    }
  };

  const handleReverse = async () => {
    if (reverseReason.trim().length < 5) {
      setReverseError(t("imports.reverseReasonMin", "A reason of at least 5 characters is required."));
      return;
    }
    setReverseError(null);
    try {
      const res = await reverseOpeningBalances.mutateAsync({ reason: reverseReason.trim() });
      toast({
        title: t("imports.reverseSuccess", "Opening balances reversed"),
        description: `${res.reversalEntryNumber}`,
      });
      setReverseOpen(false);
      setReverseReason("");
      setOpeningResult(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error");
      setReverseError(msg);
      toast({ title: msg, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Database className="h-7 w-7 text-primary" />
            {t("imports.title", "Data Import & Go-Live Cutover")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "imports.description",
              "Import master data and opening balances in cutover order with server-side validation, dry-run previews, and all-or-nothing commits."
            )}
          </p>
        </div>
        {status?.canReverseOpening && (
          <Button
            variant="destructive"
            onClick={() => {
              setReverseOpen(true);
              setReverseReason("");
              setReverseError(null);
            }}
            data-testid="reverse-opening-btn"
          >
            <RotateCcw className="h-4 w-4 me-2" />
            {t("imports.reverseOpening", "Reverse Opening Cutover")}
          </Button>
        )}
      </div>

      {status && (
        <Alert variant={status.hasOpeningJournal ? "default" : status.canImportOpening ? "default" : "destructive"} data-testid="opening-cutover-status-banner">
          {status.hasOpeningJournal ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          <AlertDescription className="text-sm">
            {status.hasOpeningJournal
              ? t(
                  "imports.statusPosted",
                  "Opening balances posted on {{date}} ({{je}}). Opening artifacts: {{ar}} AR invoices, {{ap}} AP bills, {{fa}} fixed assets, {{tr}} treasury accounts, {{stock}} stock lots.",
                  {
                    date: status.cutoverDate,
                    je: status.openingJournalEntryNumber,
                    ar: status.counts.openingArInvoices,
                    ap: status.counts.openingApBills,
                    fa: status.counts.openingFixedAssets,
                    tr: status.counts.openingTreasuryAccounts,
                    stock: status.counts.openingStockMovements,
                  }
                )
              : status.blockedReason
                ? status.blockedReason
                : t(
                    "imports.statusReady",
                    "Ready for opening cutover. Complete steps 1–7 in order, then dry-run and commit Step 8 (Opening Balances)."
                  )}
          </AlertDescription>
        </Alert>
      )}

      {/* Read-Only Cutover Readiness Gate */}
      {readiness && (
        <Card data-testid="cutover-readiness-card">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  {t("imports.readiness.title", "Cutover Readiness Check")}
                  <Badge
                    variant={readiness.ready ? "secondary" : "destructive"}
                    className={
                      readiness.ready
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : undefined
                    }
                    data-testid="cutover-readiness-badge"
                  >
                    {readiness.ready
                      ? t("imports.readiness.ready", "PASS — Ready")
                      : t("imports.readiness.notReady", "FAIL — Action Required")}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {t(
                    "imports.readiness.description",
                    "Read-only verification across all 8 reconciliation controls, accounting setup health, and the audit-log hash chain."
                  )}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={readinessFetching}
                onClick={() => void refetchReadiness()}
                data-testid="cutover-readiness-refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${readinessFetching ? "animate-spin" : ""}`} />
                {t("common.refresh", "Refresh")}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border p-3 space-y-1" data-testid="readiness-check-reconciliation">
                <div className="flex items-center justify-between gap-2">
                  <Link to="/accounting/reconciliation" className="text-sm font-medium hover:underline">
                    {t("imports.readiness.reconciliation", "Subledger Reconciliation")}
                  </Link>
                  <Badge variant={readiness.checks.reconciliation.passed ? "secondary" : "destructive"}>
                    {readiness.checks.reconciliation.passed
                      ? t("accounting.reconciliation.pass", "Pass")
                      : t("accounting.reconciliation.fail", "Fail")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{readiness.checks.reconciliation.summary}</p>
              </div>

              <div className="rounded-lg border p-3 space-y-1" data-testid="readiness-check-setupHealth">
                <div className="flex items-center justify-between gap-2">
                  <Link to="/accounting/setup-health" className="text-sm font-medium hover:underline">
                    {t("imports.readiness.setupHealth", "Accounting Setup Health")}
                  </Link>
                  <Badge variant={readiness.checks.setupHealth.passed ? "secondary" : "destructive"}>
                    {readiness.checks.setupHealth.passed
                      ? t("accounting.reconciliation.pass", "Pass")
                      : t("accounting.reconciliation.fail", "Fail")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{readiness.checks.setupHealth.summary}</p>
              </div>

              <div className="rounded-lg border p-3 space-y-1" data-testid="readiness-check-auditChain">
                <div className="flex items-center justify-between gap-2">
                  <Link to="/audit-log" className="text-sm font-medium hover:underline">
                    {t("imports.readiness.auditChain", "Audit Hash Chain")}
                  </Link>
                  <Badge variant={readiness.checks.auditChain.passed ? "secondary" : "destructive"}>
                    {readiness.checks.auditChain.passed
                      ? t("accounting.reconciliation.pass", "Pass")
                      : t("accounting.reconciliation.fail", "Fail")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{readiness.checks.auditChain.summary}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Steps 1-7: Master Data & Staged Opening Subledgers */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {ORDERED_DATASETS.map((ds) => (
          <Card key={ds.kind} data-testid={`import-card-${ds.kind}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" className="font-mono">
                  {t("imports.step", "Step {{n}}", { n: ds.step })}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void downloadImportTemplate(ds.kind, CSV_TEMPLATES[ds.kind].fileName)}
                >
                  <Download className="h-3.5 w-3.5 me-1" />
                  {t("imports.template", "Template")}
                </Button>
              </div>
              <CardTitle className="text-lg pt-1">{t(ds.titleKey, ds.fallbackTitle)}</CardTitle>
              <CardDescription className="text-xs">{t(ds.descKey, ds.fallbackDesc)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full"
                variant="outline"
                onClick={() => setActiveDialogKind(ds.kind)}
                data-testid={`open-import-${ds.kind}`}
              >
                <Upload className="h-4 w-4 me-2" />
                {t("imports.importCsv", "Import CSV")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Step 8: Unified Opening Balances Cutover */}
      <Card data-testid="opening-balances-card">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Badge variant="outline" className="font-mono mb-2">
                {t("imports.step", "Step {{n}}", { n: 8 })}
              </Badge>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-primary" />
                {t("imports.openingBalancesTitle", "Opening Balances Cutover (Trial Balance + Open AR & AP)")}
              </CardTitle>
              <CardDescription>
                {t(
                  "imports.openingBalancesDesc",
                  "Posts ONE balanced opening journal dated at the cutover date, loads flagged open AR/AP documents (excluded from VAT/Sales/ETA), and verifies all 8 reconciliation controls."
                )}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void downloadImportTemplate("opening_trial_balance", CSV_TEMPLATES.opening_trial_balance.fileName)}
              >
                <Download className="h-3.5 w-3.5 me-1" />
                TB
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void downloadImportTemplate("opening_ar", CSV_TEMPLATES.opening_ar.fileName)}
              >
                <Download className="h-3.5 w-3.5 me-1" />
                AR
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void downloadImportTemplate("opening_ap", CSV_TEMPLATES.opening_ap.fileName)}
              >
                <Download className="h-3.5 w-3.5 me-1" />
                AP
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="cutover-date">{t("imports.cutoverDate", "Cutover Date")} *</Label>
              <Input
                id="cutover-date"
                type="date"
                value={cutoverDate}
                onChange={(e) => setCutoverDate(e.target.value)}
                data-testid="cutover-date-input"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="allow-pnl">{t("imports.allowPnl", "Allow P&L Accounts (Mid-Year Cutover)")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "imports.allowPnlHint",
                    "Off by default: Balance Sheet accounts only with prior earnings on 3100 Retained Earnings."
                  )}
                </p>
              </div>
              <Switch
                id="allow-pnl"
                checked={allowPnlAccounts}
                onCheckedChange={setAllowPnlAccounts}
                data-testid="allow-pnl-switch"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="tb-csv-file">{t("imports.tbCsv", "Opening Trial Balance CSV")} *</Label>
              <Input
                id="tb-csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void readCsvFile(e, setTbCsv)}
                data-testid="opening-tb-file-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ar-csv-file">{t("imports.arCsv", "Open AR by Document CSV")}</Label>
              <Input
                id="ar-csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void readCsvFile(e, setArCsv)}
                data-testid="opening-ar-file-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ap-csv-file">{t("imports.apCsv", "Open AP by Document CSV")}</Label>
              <Input
                id="ap-csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void readCsvFile(e, setApCsv)}
                data-testid="opening-ap-file-input"
              />
            </div>
          </div>

          {openingError && (
            <Alert variant="destructive" role="alert" data-testid="opening-error-alert">
              <AlertDescription>{openingError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!tbCsv.trim() || runOpeningBalancesImport.isPending}
              onClick={() => void handleOpeningRun(true)}
              data-testid="opening-dry-run-btn"
            >
              <Play className="h-4 w-4 me-1.5" />
              {t("imports.runDryRun", "Validate (Dry Run)")}
            </Button>
            <Button
              disabled={
                !openingResult ||
                !openingResult.dryRun ||
                !openingResult.valid ||
                !status?.canImportOpening ||
                runOpeningBalancesImport.isPending
              }
              onClick={() => void handleOpeningRun(false)}
              data-testid="opening-commit-btn"
            >
              <CheckCircle2 className="h-4 w-4 me-1.5" />
              {t("imports.commitOpening", "Post Opening Journal & Documents")}
            </Button>
          </div>

          {openingResult && (
            <div className="space-y-3 pt-2 border-t" data-testid="opening-result-panel">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant={openingResult.valid ? "default" : "destructive"}>
                  {openingResult.valid ? t("imports.dryRunPassed", "Valid") : t("imports.dryRunFailed", "Errors Found")}
                </Badge>
                <span className="font-mono">
                  Dr {formatMoney(openingResult.totalDebits, ccy)} / Cr {formatMoney(openingResult.totalCredits, ccy)}
                </span>
                <span>
                  AR: {openingResult.openArCount} ({formatMoney(openingResult.openArTotal, ccy)}) · AP:{" "}
                  {openingResult.openApCount} ({formatMoney(openingResult.openApTotal, ccy)})
                </span>
              </div>

              {openingResult.errors.length > 0 && (
                <div className="rounded-md border border-destructive/50 overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20 text-start">{t("imports.colRow", "Row")}</TableHead>
                        <TableHead className="w-44 text-start">{t("imports.colColumn", "Column")}</TableHead>
                        <TableHead className="text-start">{t("imports.colError", "Error")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openingResult.errors.map((err, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-mono text-xs">{err.row}</TableCell>
                          <TableCell className="font-mono text-xs">{err.column}</TableCell>
                          <TableCell className="text-xs text-destructive">{err.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {openingResult.reconciliation && (
                <div className="space-y-2" data-testid="opening-reconciliation-results">
                  <h3 className="text-sm font-semibold">
                    {t("imports.postCommitRecon", "Post-Cutover Reconciliation (All 8 Controls)")}
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-start">{t("accounting.reconciliation.columns.control", "Control")}</TableHead>
                        <TableHead className="text-end">{t("accounting.reconciliation.columns.subledger", "Subledger")}</TableHead>
                        <TableHead className="text-end">{t("accounting.reconciliation.columns.glBalance", "GL")}</TableHead>
                        <TableHead className="text-center">{t("common.status", "Status")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openingResult.reconciliation.items.map((item) => (
                        <TableRow key={item.key}>
                          <TableCell className="text-xs font-medium">{item.label}</TableCell>
                          <TableCell className="text-end font-mono text-xs">{formatMoney(item.subledgerBalance, ccy)}</TableCell>
                          <TableCell className="text-end font-mono text-xs">{formatMoney(item.glBalance, ccy)}</TableCell>
                          <TableCell className="text-center">
                            {item.isReconciled ? (
                              <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-700">
                                <CheckCircle2 className="h-3 w-3 me-1" />
                                {t("accounting.reconciliation.pass", "Pass")}
                              </Badge>
                            ) : (
                              <Badge variant="destructive">
                                <XCircle className="h-3 w-3 me-1" />
                                {t("accounting.reconciliation.fail", "Fail")}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {activeDataset && (
        <CsvImportDialog
          open={Boolean(activeDialogKind)}
          onOpenChange={(open) => !open && setActiveDialogKind(null)}
          kind={activeDataset.kind}
          title={t(activeDataset.titleKey, activeDataset.fallbackTitle)}
          description={t(activeDataset.descKey, activeDataset.fallbackDesc)}
        />
      )}

      {/* Controlled Opening Reversal Dialog */}
      <Dialog open={reverseOpen} onOpenChange={setReverseOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t("imports.reverseOpening", "Reverse Opening Cutover")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "imports.reverseDesc",
                "Posts a balanced reversing journal entry, removes all flagged opening AR/AP documents, opening fixed assets, opening treasury accounts, and opening stock, and logs an audit entry inside the hash chain."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="reverse-opening-reason">{t("imports.reverseReasonLabel", "Reason for Reversal")} *</Label>
            <Textarea
              id="reverse-opening-reason"
              rows={3}
              value={reverseReason}
              onChange={(e) => {
                setReverseReason(e.target.value);
                if (reverseError) setReverseError(null);
              }}
              data-testid="reverse-opening-reason"
            />
            {reverseError && (
              <p className="text-sm text-destructive" role="alert">
                {reverseError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={reverseOpeningBalances.isPending || reverseReason.trim().length < 5}
              onClick={() => void handleReverse()}
              data-testid="reverse-opening-confirm"
            >
              {t("imports.reverseConfirm", "Confirm Reversal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
