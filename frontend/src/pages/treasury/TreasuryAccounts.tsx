import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Landmark,
  Wallet,
  Plus,
  ArrowLeftRight,
  Upload,
  CheckCircle2,
  RotateCcw,
  EyeOff,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { BankStatementLineDto, TreasuryAccountType } from "@erp/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { formatMoney } from "@/lib/money";
import { useAccountsQuery, useCostCentersQuery } from "@/hooks/queries/useAccountingQueries";
import {
  useTreasuryAccountsQuery,
  useTreasuryMutations,
  useTreasuryReconciliationQuery,
  useTreasuryTransfersQuery,
} from "@/hooks/queries/useTreasuryQueries";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks } from "@/hooks/useIdempotentSubmit";

export default function TreasuryAccounts() {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const { settings } = useSettings();
  const { branches } = useInventoryScope();
  const defaultCcy = settings.currency || "USD";

  const { data: accounts = [], isLoading } = useTreasuryAccountsQuery();
  const { data: transfers = [] } = useTreasuryTransfersQuery();
  const { data: glAccounts = [] } = useAccountsQuery();
  const { data: costCenters = [] } = useCostCentersQuery(true);
  const {
    createAccount,
    createTransfer,
    importCsv,
    reconcileLine,
    unreconcileLine,
    ignoreLine,
  } = useTreasuryMutations();
  const rowLocks = useActionLocks();

  const canCreate = can("treasury", "create");
  const canEdit = can("treasury", "edit");

  const [tab, setTab] = useState("accounts");
  const [selectedReconAccountId, setSelectedReconAccountId] = useState<string>("");

  const effectiveReconAccountId = selectedReconAccountId || accounts[0]?.id || "";
  const { data: reconView, isLoading: loadingRecon } = useTreasuryReconciliationQuery(
    effectiveReconAccountId || null,
    tab === "reconciliation"
  );

  // Create Account Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<TreasuryAccountType>("bank");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [iban, setIban] = useState("");
  const [branchId, setBranchId] = useState("none");
  const [openingBalance, setOpeningBalance] = useState("0");

  // Transfer Dialog state
  const [transferOpen, setTransferOpen] = useState(false);
  const [fromAcctId, setFromAcctId] = useState("");
  const [toAcctId, setToAcctId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferRef, setTransferRef] = useState("");
  const [transferMemo, setTransferMemo] = useState("");

  // Import CSV Dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [csvFileName, setCsvFileName] = useState("statement.csv");
  const [csvText, setCsvText] = useState("");

  // Reconcile Line Modal state
  const [reconTarget, setReconTarget] = useState<BankStatementLineDto | null>(null);
  const [reconMode, setReconMode] = useState<"match" | "adjust">("match");
  const [selectedJlId, setSelectedJlId] = useState("");
  const [adjAccountId, setAdjAccountId] = useState("");
  const [adjCostCenterId, setAdjCostCenterId] = useState("none");
  const [adjMemo, setAdjMemo] = useState("");

  const summary = useMemo(() => {
    const totalBook = accounts.reduce((s, a) => s + a.bookBalance, 0);
    const totalUnmatched = accounts.reduce((s, a) => s + a.unmatchedStatementLines, 0);
    return { totalBook, totalUnmatched };
  }, [accounts]);

  const handleCreateAccount = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error("Code and account name are required");
      return;
    }
    try {
      const res = await createAccount.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        accountType,
        currency: defaultCcy,
        branchId: branchId === "none" ? null : branchId,
        bankName: bankName.trim(),
        accountNumber: accountNumber.trim(),
        iban: iban.trim(),
        openingBalance: Number.parseFloat(openingBalance) || 0,
      });
      toast.success(`Created ${res.account.code}`);
      setCreateOpen(false);
      setCode("");
      setName("");
      setBankName("");
      setAccountNumber("");
      setIban("");
      setOpeningBalance("0");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create treasury account");
    }
  };

  const handleTransfer = async () => {
    const amt = Number.parseFloat(transferAmount);
    if (!fromAcctId || !toAcctId || !Number.isFinite(amt) || amt <= 0) {
      toast.error("Select source, destination, and a positive amount");
      return;
    }
    try {
      const res = await createTransfer.mutateAsync({
        fromTreasuryAccountId: fromAcctId,
        toTreasuryAccountId: toAcctId,
        amount: amt,
        reference: transferRef.trim(),
        memo: transferMemo.trim(),
      });
      toast.success(`Posted transfer ${res.transfer.transferNumber}`);
      setTransferOpen(false);
      setTransferAmount("");
      setTransferRef("");
      setTransferMemo("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    }
  };

  const handleFilePick = async (file: File | undefined) => {
    if (!file) return;
    setCsvFileName(file.name);
    const text = await file.text();
    setCsvText(text);
  };

  const handleImportCsv = async () => {
    if (!effectiveReconAccountId || !csvText.trim()) {
      toast.error("Provide bank statement CSV content");
      return;
    }
    try {
      const res = await importCsv.mutateAsync({
        accountId: effectiveReconAccountId,
        data: { fileName: csvFileName, csvText },
      });
      toast.success(
        `Imported ${res.importedLines} statement lines (${res.skippedDuplicates} duplicates skipped)`
      );
      setImportOpen(false);
      setCsvText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV import failed");
    }
  };

  const openReconcileModal = (line: BankStatementLineDto) => {
    setReconTarget(line);
    if (line.suggestedJournalLineId) {
      setReconMode("match");
      setSelectedJlId(line.suggestedJournalLineId);
    } else {
      const matchingAmount = (reconView?.unreconciledGlLines ?? []).find(
        (g) => Math.abs(g.signedAmount - line.amount) <= 0.01
      );
      if (matchingAmount) {
        setReconMode("match");
        setSelectedJlId(matchingAmount.journalLineId);
      } else {
        setReconMode("adjust");
        setSelectedJlId("");
      }
    }
    setAdjMemo(line.description || "Bank reconciliation adjustment");
    setAdjCostCenterId("none");
  };

  const handleConfirmReconcile = async () => {
    if (!reconTarget) return;
    try {
      if (reconMode === "match") {
        if (!selectedJlId) {
          toast.error("Select a matching GL journal line");
          return;
        }
        await reconcileLine.mutateAsync({
          lineId: reconTarget.id,
          data: { journalLineId: selectedJlId },
        });
      } else {
        if (!adjAccountId) {
          toast.error("Select a counterpart GL account");
          return;
        }
        await reconcileLine.mutateAsync({
          lineId: reconTarget.id,
          data: {
            createAdjustment: {
              counterpartAccountId: adjAccountId,
              costCenterId: adjCostCenterId === "none" ? null : adjCostCenterId,
              memo: adjMemo.trim() || undefined,
            },
          },
        });
      }
      toast.success("Statement line reconciled");
      setReconTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reconciliation failed");
    }
  };

  const candidateMatchesForTarget = useMemo(() => {
    if (!reconTarget || !reconView) return [];
    return reconView.unreconciledGlLines.filter(
      (g) => Math.abs(g.signedAmount - reconTarget.amount) <= 0.01
    );
  }, [reconTarget, reconView]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Landmark className="h-7 w-7 text-primary" />
            {t("treasury.title", "Treasury, Bank Accounts & Reconciliation")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "treasury.description",
              "Manage 1-to-1 GL bank accounts and cashboxes, inter-account transfers, and CSV bank statement reconciliation."
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && accounts.length >= 2 && (
            <Button variant="outline" onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight className="h-4 w-4 me-2" />
              {t("treasury.newTransfer", "Inter-Account Transfer")}
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 me-2" />
              {t("treasury.newAccount", "New Bank / Cashbox")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("treasury.kpiAccounts", "Active Bank & Cashbox Accounts")}</CardDescription>
            <CardTitle className="text-2xl">{accounts.filter((a) => a.isActive).length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("treasury.kpiBookBalance", "Total GL Book Cash & Bank")}</CardDescription>
            <CardTitle className="text-2xl">{formatMoney(summary.totalBook, defaultCcy)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("treasury.kpiUnmatched", "Unreconciled Statement Lines")}</CardDescription>
            <CardTitle className="text-2xl">{summary.totalUnmatched}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="accounts">{t("treasury.tabs.accounts", "Bank & Cashboxes")}</TabsTrigger>
          <TabsTrigger value="reconciliation">
            {t("treasury.tabs.reconciliation", "Bank Reconciliation")}
          </TabsTrigger>
          <TabsTrigger value="transfers">{t("treasury.tabs.transfers", "Transfers")}</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <Card>
            <CardHeader>
              <CardTitle>{t("treasury.accountsList", "Treasury Sub-Accounts")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("common.code", "Code")}</TableHead>
                    <TableHead>{t("common.name", "Name")}</TableHead>
                    <TableHead>{t("common.type", "Type")}</TableHead>
                    <TableHead>{t("treasury.glAccount", "GL Sub-Account")}</TableHead>
                    <TableHead className="text-end">{t("treasury.bookBalance", "Book Balance")}</TableHead>
                    <TableHead className="text-end">
                      {t("treasury.reconciledBalance", "Reconciled Stmt")}
                    </TableHead>
                    <TableHead className="text-end">{t("treasury.unmatched", "Unmatched")}</TableHead>
                    <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {t("common.loading", "Loading...")}
                      </TableCell>
                    </TableRow>
                  ) : accounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {t("treasury.empty", "No bank accounts or cashboxes configured yet.")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    accounts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono font-medium">{a.code}</TableCell>
                        <TableCell>
                          <div className="font-medium">{a.name}</div>
                          {a.bankName && (
                            <div className="text-xs text-muted-foreground">
                              {a.bankName} {a.accountNumber ? `• ${a.accountNumber}` : ""}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1">
                            {a.accountType === "bank" ? (
                              <Landmark className="h-3 w-3" />
                            ) : (
                              <Wallet className="h-3 w-3" />
                            )}
                            {a.accountType}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {a.glAccountCode} — {a.glAccountName}
                        </TableCell>
                        <TableCell className="text-end font-medium">
                          {formatMoney(a.bookBalance, a.currency)}
                        </TableCell>
                        <TableCell className="text-end">
                          {formatMoney(a.reconciledBalance, a.currency)}
                        </TableCell>
                        <TableCell className="text-end">
                          {a.unmatchedStatementLines > 0 ? (
                            <Badge variant="secondary">{a.unmatchedStatementLines}</Badge>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedReconAccountId(a.id);
                              setTab("reconciliation");
                            }}
                          >
                            {t("treasury.reconcileBtn", "Reconcile")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reconciliation">
          <Card>
            <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>{t("treasury.reconWorkspace", "Statement Reconciliation Workspace")}</CardTitle>
                <CardDescription>
                  {t(
                    "treasury.reconDesc",
                    "Import CSV bank statements, auto-match posted GL lines, or post 1-click bank fee/interest adjustments."
                  )}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Select value={effectiveReconAccountId} onValueChange={setSelectedReconAccountId}>
                  <SelectTrigger className="w-[260px]">
                    <SelectValue placeholder="Select treasury account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {canCreate && effectiveReconAccountId && (
                  <Button onClick={() => setImportOpen(true)}>
                    <Upload className="h-4 w-4 me-2" />
                    {t("treasury.importCsv", "Import Statement CSV")}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!effectiveReconAccountId ? (
                <div className="text-center py-8 text-muted-foreground">
                  Create a bank account or cashbox first to begin reconciliation.
                </div>
              ) : loadingRecon ? (
                <div className="text-center py-8 text-muted-foreground">Loading statement lines...</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.date", "Date")}</TableHead>
                      <TableHead>{t("common.description", "Description")}</TableHead>
                      <TableHead>{t("common.reference", "Reference")}</TableHead>
                      <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                      <TableHead>{t("common.status", "Status")}</TableHead>
                      <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(reconView?.statementLines ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          No statement lines imported for this account yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (reconView?.statementLines ?? []).map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="whitespace-nowrap">
                            {line.lineDate.slice(0, 10)}
                          </TableCell>
                          <TableCell>
                            <div>{line.description || "—"}</div>
                            {line.suggestedJournalLineId && line.status === "unmatched" && (
                              <div className="text-xs text-emerald-600 flex items-center gap-1 mt-0.5">
                                <Sparkles className="h-3 w-3" /> Suggested GL match available
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{line.reference || "—"}</TableCell>
                          <TableCell
                            className={`text-end font-medium ${
                              line.amount >= 0 ? "text-emerald-600" : "text-rose-600"
                            }`}
                          >
                            {line.amount >= 0 ? "+" : ""}
                            {formatMoney(line.amount, reconView?.account.currency || defaultCcy)}
                          </TableCell>
                          <TableCell>
                            {line.status === "reconciled" ? (
                              <Badge className="gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                Reconciled ({line.matchedEntryNumber ?? "GL"})
                              </Badge>
                            ) : line.status === "ignored" ? (
                              <Badge variant="outline">Ignored</Badge>
                            ) : (
                              <Badge variant="secondary">Unmatched</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-end space-x-1">
                            {canEdit && line.status === "unmatched" && (
                              <>
                                <Button size="sm" onClick={() => openReconcileModal(line)}>
                                  Match / Post
                                </Button>
                                <SubmitButton
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  title="Ignore line"
                                  hideSlowText
                                  pending={rowLocks.isPending(`ignore:${line.id}`)}
                                  onClick={() =>
                                    void rowLocks.runLocked(`ignore:${line.id}`, () =>
                                      ignoreLine.mutateAsync({ lineId: line.id, ignored: true })
                                    )
                                  }
                                >
                                  <EyeOff className="h-4 w-4" />
                                </SubmitButton>
                              </>
                            )}
                            {canEdit && line.status === "reconciled" && (
                              <SubmitButton
                                type="button"
                                size="sm"
                                variant="ghost"
                                hideSlowText
                                pending={rowLocks.isPending(`unmatch:${line.id}`)}
                                onClick={() =>
                                  void rowLocks.runLocked(`unmatch:${line.id}`, () =>
                                    unreconcileLine.mutateAsync(line.id)
                                  )
                                }
                              >
                                <RotateCcw className="h-4 w-4 me-1" /> Unmatch
                              </SubmitButton>
                            )}
                            {canEdit && line.status === "ignored" && (
                              <SubmitButton
                                type="button"
                                size="sm"
                                variant="ghost"
                                hideSlowText
                                pending={rowLocks.isPending(`restore:${line.id}`)}
                                onClick={() =>
                                  void rowLocks.runLocked(`restore:${line.id}`, () =>
                                    ignoreLine.mutateAsync({ lineId: line.id, ignored: false })
                                  )
                                }
                              >
                                Restore
                              </SubmitButton>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="transfers">
          <Card>
            <CardHeader>
              <CardTitle>{t("treasury.transfersHistory", "Inter-Account Transfers")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transfer #</TableHead>
                    <TableHead>{t("common.date", "Date")}</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                    <TableHead>Memo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        No inter-account transfers recorded yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    transfers.map((tr) => (
                      <TableRow key={tr.id}>
                        <TableCell className="font-mono font-medium">{tr.transferNumber}</TableCell>
                        <TableCell>{tr.transferDate.slice(0, 10)}</TableCell>
                        <TableCell>{tr.fromAccountName}</TableCell>
                        <TableCell>{tr.toAccountName}</TableCell>
                        <TableCell className="text-end font-medium">
                          {formatMoney(tr.amount, tr.currency)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{tr.memo}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New Treasury Account Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("treasury.newAccount", "New Bank Account or Cashbox")}</DialogTitle>
            <DialogDescription>
              Automatically creates a dedicated 1-to-1 Asset GL sub-account under 1000 Cash & Bank.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ta-code">Code</Label>
                <Input
                  id="ta-code"
                  placeholder="BNK-CIB"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={accountType} onValueChange={(v) => setAccountType(v as TreasuryAccountType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">Bank Account</SelectItem>
                    <SelectItem value="cashbox">Petty Cash / Cashbox</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ta-name">Account Name</Label>
              <Input
                id="ta-name"
                placeholder="CIB Operating Current Account"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {accountType === "bank" && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ta-bank">Bank Name</Label>
                  <Input
                    id="ta-bank"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="CIB / NBE / HSBC"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ta-accnum">Account # / IBAN</Label>
                  <Input
                    id="ta-accnum"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="100023456789"
                  />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Branch (Optional)</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Company-Wide</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.branchId} value={b.branchId}>
                        {b.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ta-open">Opening Balance ({defaultCcy})</Label>
                <Input
                  id="ta-open"
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateAccount} disabled={createAccount.isPending}>
              Create Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inter-Account Transfer Dialog */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Inter-Account Treasury Transfer</DialogTitle>
            <DialogDescription>
              Moves funds atomically between two treasury accounts and posts a balanced GL entry.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>From Account</Label>
                <Select value={fromAcctId} onValueChange={setFromAcctId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Source" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter((a) => a.isActive)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To Account</Label>
                <Select value={toAcctId} onValueChange={setToAcctId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter((a) => a.isActive && a.id !== fromAcctId)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tr-amt">Amount</Label>
                <Input
                  id="tr-amt"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tr-ref">Reference</Label>
                <Input
                  id="tr-ref"
                  value={transferRef}
                  onChange={(e) => setTransferRef(e.target.value)}
                  placeholder="WIRE-001"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tr-memo">Memo</Label>
              <Input
                id="tr-memo"
                value={transferMemo}
                onChange={(e) => setTransferMemo(e.target.value)}
                placeholder="Replenish retail petty cashbox"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleTransfer} disabled={createTransfer.isPending}>
              Post Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Bank Statement CSV Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Import Bank Statement CSV</DialogTitle>
            <DialogDescription>
              Upload or paste CSV with columns <code>date,description,reference,amount</code> (or{" "}
              <code>date,description,debit,credit</code>). Duplicate lines are skipped automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="stmt-file">Choose CSV File (Optional)</Label>
              <Input
                id="stmt-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void handleFilePick(e.target.files?.[0])}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stmt-csv">CSV Content</Label>
              <Textarea
                id="stmt-csv"
                rows={7}
                className="font-mono text-xs"
                placeholder={"date,description,reference,amount\n2026-11-24,Customer Wire,REF-101,1500.00\n2026-11-24,Monthly Bank Fee,FEE-11,-25.00"}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleImportCsv} disabled={importCsv.isPending}>
              Import Statement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reconcile Statement Line Dialog */}
      <Dialog open={Boolean(reconTarget)} onOpenChange={(o) => !o && setReconTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reconcile Bank Statement Line</DialogTitle>
            <DialogDescription>
              {reconTarget &&
                `${reconTarget.lineDate.slice(0, 10)} • ${reconTarget.description || "Statement entry"} • Amount: ${reconTarget.amount}`}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={reconMode} onValueChange={(v) => setReconMode(v as "match" | "adjust")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="match">
                Match Existing GL ({candidateMatchesForTarget.length})
              </TabsTrigger>
              <TabsTrigger value="adjust">Create Adjustment & Match</TabsTrigger>
            </TabsList>

            <TabsContent value="match" className="space-y-3 pt-3">
              {candidateMatchesForTarget.length === 0 ? (
                <div className="text-sm text-muted-foreground rounded-md border p-3">
                  No unreconciled GL journal lines match this exact amount. Switch to{" "}
                  <strong>Create Adjustment & Match</strong> to post bank fees, interest, or direct entries.
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Matching Unreconciled Journal Lines</Label>
                  <Select value={selectedJlId} onValueChange={setSelectedJlId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose matching journal line" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidateMatchesForTarget.map((g) => (
                        <SelectItem key={g.journalLineId} value={g.journalLineId}>
                          {g.entryNumber} ({g.entryDate.slice(0, 10)}) — {g.memo} [{g.signedAmount}]
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </TabsContent>

            <TabsContent value="adjust" className="space-y-3 pt-3">
              <div className="space-y-2">
                <Label>Counterpart GL Account (e.g. Bank Fees / Interest)</Label>
                <Select value={adjAccountId} onValueChange={setAdjAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select GL account" />
                  </SelectTrigger>
                  <SelectContent>
                    {glAccounts
                      .filter((a) => a.isActive && a.id !== reconView?.account.glAccountId)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name} ({a.accountType})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Cost Center (Optional)</Label>
                <Select value={adjCostCenterId} onValueChange={setAdjCostCenterId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {costCenters.map((cc) => (
                      <SelectItem key={cc.id} value={cc.id}>
                        {cc.code} — {cc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="adj-memo">Journal Memo</Label>
                <Input id="adj-memo" value={adjMemo} onChange={(e) => setAdjMemo(e.target.value)} />
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReconTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmReconcile} disabled={reconcileLine.isPending}>
              Confirm Reconciliation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
