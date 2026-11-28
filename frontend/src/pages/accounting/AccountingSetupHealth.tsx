import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountingMappingIssueDto, GlMappingKey } from "@erp/shared";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  useAccountingMutations,
  useAccountingSetupHealthQuery,
  useAccountsQuery,
} from "@/hooks/queries/useAccountingQueries";

export default function AccountingSetupHealth() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const {
    data: health,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useAccountingSetupHealthQuery();
  const { data: accounts = [] } = useAccountsQuery();
  const { updateMapping } = useAccountingMutations();

  const [remapIssue, setRemapIssue] = useState<AccountingMappingIssueDto | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [remapError, setRemapError] = useState<string | null>(null);

  const eligibleAccounts = useMemo(() => {
    if (!remapIssue) return [];
    return accounts.filter(
      (a) => a.isActive && a.accountType === remapIssue.expectedAccountType
    );
  }, [accounts, remapIssue]);

  const openRemapDialog = (issue: AccountingMappingIssueDto) => {
    setRemapIssue(issue);
    setRemapError(null);
    const matching = accounts.filter(
      (a) => a.isActive && a.accountType === issue.expectedAccountType
    );
    const exactCode = matching.find((a) => a.code === issue.expectedCode);
    setSelectedAccountId(exactCode?.id ?? matching[0]?.id ?? "");
  };

  const handleConfirmRemap = async () => {
    if (!remapIssue || !selectedAccountId) {
      setRemapError(
        t("accounting.setupHealth.selectAccountRequired", "Please select a target GL account.")
      );
      return;
    }
    setRemapError(null);
    try {
      await updateMapping.mutateAsync({
        mappingKey: remapIssue.mappingKey as GlMappingKey,
        accountId: selectedAccountId,
      });
      toast({
        title: t("accounting.setupHealth.remapSuccess", "GL mapping updated"),
        description: `${remapIssue.mappingKey}`,
      });
      setRemapIssue(null);
      setSelectedAccountId("");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("common.error");
      setRemapError(message);
      toast({
        title: message,
        variant: "destructive",
      });
    }
  };

  const statusBadgeVariant = (status: AccountingMappingIssueDto["status"]) => {
    if (status === "type_mismatch") return "destructive" as const;
    if (status === "missing") return "destructive" as const;
    return "secondary" as const;
  };

  const statusLabel = (status: AccountingMappingIssueDto["status"]) => {
    switch (status) {
      case "missing":
        return t("accounting.setupHealth.statuses.missing", "Missing");
      case "type_mismatch":
        return t("accounting.setupHealth.statuses.type_mismatch", "Type Mismatch");
      case "inactive":
        return t("accounting.setupHealth.statuses.inactive", "Inactive Account");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-7 w-7 text-primary" />
            {t("accounting.setupHealth.title", "Accounting Setup Health")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.setupHealth.description",
              "Verify required GL control account mappings, detect Chart of Accounts code/type collisions, and remap affected posting keys safely."
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refetch()}
          disabled={isFetching}
          data-testid="setup-health-refresh"
        >
          <RefreshCw className={`h-4 w-4 me-2 ${isFetching ? "animate-spin" : ""}`} />
          {t("common.refresh", "Refresh")}
        </Button>
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
      ) : health ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card data-testid="setup-health-status-card">
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.setupHealth.overallStatus", "Overall Status")}
                </CardDescription>
                <CardTitle className="flex items-center gap-2 text-xl">
                  {health.healthy ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {t("accounting.setupHealth.healthy", "Healthy")}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                      <span className="text-destructive">
                        {t("accounting.setupHealth.attentionRequired", "Action Required")}
                      </span>
                    </>
                  )}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.setupHealth.validMappings", "Valid Mappings")}
                </CardDescription>
                <CardTitle className="text-2xl font-mono" data-testid="setup-health-valid-count">
                  {health.validMappings} / {health.totalMappings}
                </CardTitle>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>
                  {t("accounting.setupHealth.issuesFound", "Issues Detected")}
                </CardDescription>
                <CardTitle
                  className={`text-2xl font-mono ${health.issues.length > 0 ? "text-destructive" : "text-emerald-600"}`}
                  data-testid="setup-health-issue-count"
                >
                  {health.issues.length}
                </CardTitle>
              </CardHeader>
            </Card>
          </div>

          {health.healthy ? (
            <Card data-testid="setup-health-clean-card">
              <CardContent className="py-10 flex flex-col items-center text-center gap-2">
                <CheckCircle2 className="h-10 w-10 text-emerald-600" />
                <p className="text-lg font-medium">
                  {t(
                    "accounting.setupHealth.allHealthyTitle",
                    "All required GL mappings are properly configured"
                  )}
                </p>
                <p className="text-sm text-muted-foreground max-w-lg">
                  {t(
                    "accounting.setupHealth.allHealthyDesc",
                    "Every automated posting key is bound to an active Chart of Accounts entry with the expected account type."
                  )}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>
                  {t("accounting.setupHealth.issuesTableTitle", "Mapping Issues & Collisions")}
                </CardTitle>
                <CardDescription>
                  {t(
                    "accounting.setupHealth.issuesTableDesc",
                    "Resolve each issue by remapping the posting key to an active account of the expected type."
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-start">
                        {t("accounting.setupHealth.columns.mappingKey", "Mapping Key")}
                      </TableHead>
                      <TableHead className="text-start">
                        {t("common.status", "Status")}
                      </TableHead>
                      <TableHead className="text-start">
                        {t("accounting.setupHealth.columns.expected", "Expected")}
                      </TableHead>
                      <TableHead className="text-start">
                        {t("accounting.setupHealth.columns.currentOrColliding", "Bound / Colliding Account")}
                      </TableHead>
                      <TableHead className="text-start">
                        {t("accounting.setupHealth.columns.instructions", "Instructions")}
                      </TableHead>
                      <TableHead className="text-end">
                        {t("common.actions", "Actions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.issues.map((issue) => (
                      <TableRow key={issue.mappingKey} data-testid={`setup-issue-row-${issue.mappingKey}`}>
                        <TableCell className="font-mono font-medium">
                          {issue.mappingKey}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusBadgeVariant(issue.status)}>
                            {statusLabel(issue.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="font-mono">
                            {issue.expectedCode} — {issue.expectedName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t(`accounting.accountTypes.${issue.expectedAccountType}`, issue.expectedAccountType)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {issue.boundAccountCode ? (
                            <div>
                              <span className="font-mono font-medium">
                                {issue.boundAccountCode} {issue.boundAccountName}
                              </span>
                              {issue.boundAccountType && (
                                <span className="ms-1 text-xs text-muted-foreground">
                                  ({t(`accounting.accountTypes.${issue.boundAccountType}`, issue.boundAccountType)})
                                </span>
                              )}
                            </div>
                          ) : null}
                          {issue.collidingAccountCode ? (
                            <div
                              className="text-xs text-amber-700 dark:text-amber-400"
                              data-testid={`setup-collision-${issue.mappingKey}`}
                            >
                              {t("accounting.setupHealth.collidingPrefix", "Colliding")}:{" "}
                              <span className="font-mono">
                                {issue.collidingAccountCode} {issue.collidingAccountName}
                              </span>
                              {issue.collidingAccountType ? ` (${issue.collidingAccountType})` : ""}
                            </div>
                          ) : !issue.boundAccountCode ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-md">
                          {issue.instructions}
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openRemapDialog(issue)}
                            data-testid={`remap-btn-${issue.mappingKey}`}
                          >
                            <Wrench className="h-3.5 w-3.5 me-1.5" />
                            {t("accounting.setupHealth.remap", "Remap")}
                          </Button>
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

      {/* One-click Remap Dialog */}
      <Dialog
        open={Boolean(remapIssue)}
        onOpenChange={(open) => {
          if (!open && updateMapping.isPending) return;
          if (!open) setRemapIssue(null);
        }}
      >
        <DialogContent className="max-w-lg" locked={updateMapping.isPending}>
          <DialogHeader>
            <DialogTitle>
              {t("accounting.setupHealth.remapDialogTitle", "Remap GL Posting Key")} —{" "}
              <span className="font-mono">{remapIssue?.mappingKey}</span>
            </DialogTitle>
            <DialogDescription>
              {t(
                "accounting.setupHealth.remapDialogDesc",
                "Select an active account matching the required account type. Changes take effect immediately for future postings."
              )}
            </DialogDescription>
          </DialogHeader>

          {remapIssue && (
            <div className="space-y-4 py-2">
              <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
                <div>
                  <span className="font-medium">
                    {t("accounting.setupHealth.requiredType", "Required Account Type")}:
                  </span>{" "}
                  <Badge variant="outline" className="ms-1">
                    {t(
                      `accounting.accountTypes.${remapIssue.expectedAccountType}`,
                      remapIssue.expectedAccountType
                    )}
                  </Badge>
                </div>
                {remapIssue.collidingAccountCode && (
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    {t("accounting.setupHealth.collidingPrefix", "Colliding")}:{" "}
                    <span className="font-mono">
                      {remapIssue.collidingAccountCode} {remapIssue.collidingAccountName}
                    </span>{" "}
                    ({remapIssue.collidingAccountType})
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="remap-account-select">
                  {t("accounting.mappings.account", "Target GL Account")} *
                </Label>
                {eligibleAccounts.length === 0 ? (
                  <p className="text-sm text-destructive" role="alert">
                    {t(
                      "accounting.setupHealth.noEligibleAccounts",
                      "No active accounts of the required type were found. Create one in Chart of Accounts first."
                    )}
                  </p>
                ) : (
                  <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                    <SelectTrigger id="remap-account-select" data-testid="remap-account-select">
                      <SelectValue
                        placeholder={t("accounting.mappings.selectAccount", "Select account")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {eligibleAccounts.map((acct) => (
                        <SelectItem key={acct.id} value={acct.id}>
                          {acct.code} — {acct.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {remapError && (
                <p className="text-sm text-destructive" role="alert" data-testid="remap-error">
                  {remapError}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={updateMapping.isPending} onClick={() => setRemapIssue(null)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <SubmitButton
              type="button"
              pending={updateMapping.isPending}
              onClick={() => void handleConfirmRemap()}
              disabled={!selectedAccountId}
              data-testid="remap-confirm-btn"
            >
              {t("accounting.setupHealth.confirmRemap", "Save Mapping")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
