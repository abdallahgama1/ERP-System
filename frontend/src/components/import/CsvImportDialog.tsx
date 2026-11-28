import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CSV_TEMPLATES, type CsvImportResultDto, type StandardImportKind } from "@erp/shared";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Play,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { downloadImportTemplate, useImportMutations } from "@/hooks/queries/useImportsQueries";

export interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: StandardImportKind;
  title: string;
  description: string;
  onCommitted?: (result: CsvImportResultDto) => void;
}

export default function CsvImportDialog({
  open,
  onOpenChange,
  kind,
  title,
  description,
  onCommitted,
}: CsvImportDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { runStandardImport } = useImportMutations();

  const [fileName, setFileName] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [updateExisting, setUpdateExisting] = useState<boolean>(false);
  const [result, setResult] = useState<CsvImportResultDto | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const supportsUpdateExisting =
    kind === "chart_of_accounts" ||
    kind === "customers" ||
    kind === "vendors" ||
    kind === "products";
  const templateDef = CSV_TEMPLATES[kind];

  const reset = () => {
    setFileName("");
    setCsvText("");
    setUpdateExisting(false);
    setResult(null);
    setRequestError(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && runStandardImport.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setRequestError(null);
    const text = await file.text();
    setCsvText(text);
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadImportTemplate(kind, templateDef.fileName);
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleDryRun = async () => {
    if (!csvText.trim()) return;
    setRequestError(null);
    try {
      const res = await runStandardImport.mutateAsync({
        kind,
        csv: csvText,
        dryRun: true,
        updateExisting: supportsUpdateExisting ? updateExisting : false,
      });
      setResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error");
      setRequestError(msg);
      toast({ title: msg, variant: "destructive" });
    }
  };

  const handleCommit = async () => {
    if (!csvText.trim()) return;
    setRequestError(null);
    try {
      const res = await runStandardImport.mutateAsync({
        kind,
        csv: csvText,
        dryRun: false,
        updateExisting: supportsUpdateExisting ? updateExisting : false,
      });
      setResult(res);
      if (res.valid) {
        toast({
          title: t("imports.commitSuccess", "CSV import committed"),
          description: t(
            "imports.commitSummary",
            "{{created}} created, {{updated}} updated",
            { created: res.createdCount, updated: res.updatedCount }
          ),
        });
        onCommitted?.(res);
        handleOpenChange(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error");
      setRequestError(msg);
      toast({ title: msg, variant: "destructive" });
    }
  };

  const canCommit = Boolean(result && result.dryRun && result.valid && result.totalRows > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent locked={runStandardImport.isPending} className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">
                {t("imports.expectedHeaders", "CSV Columns")}:
              </div>
              <div className="font-mono break-all">{templateDef.headers.join(", ")}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleDownloadTemplate()}
              data-testid={`csv-template-btn-${kind}`}
            >
              <Download className="h-4 w-4 me-1.5" />
              {t("imports.downloadTemplate", "Download CSV Template")}
            </Button>
          </div>

          <div className="space-y-2">
            <label
              htmlFor={`csv-file-input-${kind}`}
              className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 cursor-pointer hover:bg-muted/30 transition-colors"
            >
              <Upload className="h-7 w-7 text-muted-foreground mb-2" />
              <span className="text-sm font-medium">
                {fileName || t("imports.chooseCsvFile", "Choose a UTF-8 CSV file (supports Arabic & Excel numbers)")}
              </span>
              <span className="text-xs text-muted-foreground mt-1">
                {t("imports.limitsHint", "Max 5 MB, 10,000 rows · All-or-nothing transactional commit")}
              </span>
              <input
                id={`csv-file-input-${kind}`}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(e) => void handleFileChange(e)}
                data-testid={`csv-file-input-${kind}`}
              />
            </label>
          </div>

          {supportsUpdateExisting && (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor={`csv-update-existing-${kind}`}>
                  {t("imports.updateExistingLabel", "Update existing records")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "imports.updateExistingHint",
                    "Off by default: rows matching an existing code/SKU fail with 'already exists'. Enable to update only the columns present in the CSV (balances are never modified)."
                  )}
                </p>
              </div>
              <Switch
                id={`csv-update-existing-${kind}`}
                checked={updateExisting}
                onCheckedChange={(checked) => {
                  setUpdateExisting(checked);
                  setResult(null);
                }}
                data-testid={`csv-update-existing-${kind}`}
              />
            </div>
          )}

          {requestError && (
            <Alert variant="destructive" role="alert" data-testid="csv-import-request-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{requestError}</AlertDescription>
            </Alert>
          )}

          {result && (
            <div className="space-y-3" data-testid="csv-import-result">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={result.valid ? "default" : "destructive"} data-testid="csv-result-badge">
                  {result.valid
                    ? t("imports.dryRunPassed", "Dry-Run Valid")
                    : t("imports.dryRunFailed", "Validation Errors")}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {t("imports.rowStats", "{{total}} rows ({{created}} create, {{updated}} update)", {
                    total: result.totalRows,
                    created: result.createdCount,
                    updated: result.updatedCount,
                  })}
                </span>
              </div>

              {result.setupHealth && (
                <Alert
                  variant={result.setupHealth.healthy ? "default" : "destructive"}
                  data-testid="csv-coa-setup-health"
                >
                  {result.setupHealth.healthy ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                  <AlertDescription>
                    {t(
                      "imports.projectedSetupHealth",
                      "Projected Accounting Setup Health: {{valid}} / {{total}} mappings valid ({{issues}} issues).",
                      {
                        valid: result.setupHealth.validMappings,
                        total: result.setupHealth.totalMappings,
                        issues: result.setupHealth.issues.length,
                      }
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {result.warnings.length > 0 && (
                <Alert data-testid="csv-import-warnings">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="space-y-1">
                    {result.warnings.map((w, idx) => (
                      <div key={idx} className="text-xs">
                        <span className="font-mono font-medium">
                          Row {w.row} [{w.column}]:
                        </span>{" "}
                        {w.message}
                      </div>
                    ))}
                  </AlertDescription>
                </Alert>
              )}

              {result.errors.length > 0 && (
                <div className="rounded-md border border-destructive/50 overflow-hidden" data-testid="csv-import-errors-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20 text-start">{t("imports.colRow", "Row")}</TableHead>
                        <TableHead className="w-40 text-start">{t("imports.colColumn", "Column")}</TableHead>
                        <TableHead className="text-start">{t("imports.colError", "Error")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.errors.slice(0, 50).map((err, idx) => (
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

              {result.errors.length === 0 && result.preview.length > 0 && (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20 text-start">{t("imports.colRow", "Row")}</TableHead>
                        <TableHead className="w-28 text-start">{t("imports.colAction", "Action")}</TableHead>
                        <TableHead className="text-start">{t("imports.colPreview", "Preview")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.preview.slice(0, 15).map((p) => (
                        <TableRow key={p.row}>
                          <TableCell className="font-mono text-xs">{p.row}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{p.action}</Badge>
                          </TableCell>
                          <TableCell className="text-xs">{p.summary}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={runStandardImport.isPending} onClick={() => handleOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <SubmitButton
            type="button"
            variant="secondary"
            pending={runStandardImport.isPending}
            disabled={!csvText.trim()}
            onClick={() => void handleDryRun()}
            data-testid="csv-dry-run-btn"
          >
            <Play className="h-4 w-4 me-1.5" />
            {t("imports.runDryRun", "Validate (Dry Run)")}
          </SubmitButton>
          <SubmitButton
            type="button"
            pending={runStandardImport.isPending}
            disabled={!canCommit}
            onClick={() => void handleCommit()}
            data-testid="csv-commit-btn"
          >
            <CheckCircle2 className="h-4 w-4 me-1.5" />
            {t("imports.commitImport", "Commit All-or-Nothing")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
