import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Plus, RotateCcw, Search, Trash2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { EnterpriseDataTable, type EnterpriseColumn } from "@/components/EnterpriseDataTable";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import {
  useAccountingMutations,
  useAccountsQuery,
  useCostCentersQuery,
  useCurrenciesQuery,
  useJournalEntriesPageQuery,
  type JournalEntryDto,
} from "@/hooks/queries/useAccountingQueries";

interface DraftLine {
  key: string;
  accountId: string;
  costCenterId: string;
  debit: number;
  credit: number;
  currency: string;
  fxRate: number;
  description: string;
}

let lineSeq = 1;
const emptyLine = (currency: string): DraftLine => ({
  key: `je-draft-${lineSeq++}`,
  accountId: "",
  costCenterId: "none",
  debit: 0,
  credit: 0,
  currency,
  fxRate: 1,
  description: "",
});

export default function JournalEntries() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { can } = usePermissions();
  const { branches } = useInventoryScope();
  const { settings } = useSettings();

  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data: journalPage, isLoading } = useJournalEntriesPageQuery({
    branchId: branchFilter,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    search: search || undefined,
    page,
    pageSize: 50,
  });
  const filteredEntries = journalPage?.entries ?? [];
  const pageInfo = journalPage?.pageInfo;
  const { data: accounts = [] } = useAccountsQuery();
  const { data: costCenters = [] } = useCostCentersQuery();
  const { data: currencyData } = useCurrenciesQuery();
  const { createJournalEntry, reverseJournalEntry } = useAccountingMutations();

  const [selectedEntry, setSelectedEntry] = useState<JournalEntryDto | null>(null);
  const [reverseTarget, setReverseTarget] = useState<JournalEntryDto | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newBranchId, setNewBranchId] = useState<string>("none");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(() => [
    emptyLine(settings.currency || "USD"),
    emptyLine(settings.currency || "USD"),
  ]);

  const canCreate = can("accounting", "create");
  const canEdit = can("accounting", "edit");

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const costCenterById = useMemo(() => new Map(costCenters.map((cc) => [cc.id, cc])), [costCenters]);
  const branchById = useMemo(() => new Map(branches.map((b) => [b.branchId, b.branch_name])), [branches]);
  const currencies = useMemo(() => {
    const list = currencyData?.currencies ?? [];
    if (list.length > 0) return list;
    return [{ code: settings.currency || "USD", name: settings.currency || "USD", symbol: settings.currency || "$", decimals: 2, isBase: true, isActive: true }];
  }, [currencyData, settings.currency]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      debit += (Number(l.debit) || 0) * (Number(l.fxRate) || 1);
      credit += (Number(l.credit) || 0) * (Number(l.fxRate) || 1);
    }
    const diff = Math.abs(debit - credit);
    return { debit, credit, diff, isBalanced: debit > 0 && diff <= 0.01 };
  }, [lines]);

  const openCreateModal = () => {
    const base = settings.currency || "USD";
    setEntryDate(new Date().toISOString().slice(0, 10));
    setNewBranchId("none");
    setReferenceNumber("");
    setMemo("");
    setLines([emptyLine(base), emptyLine(base)]);
    setCreateOpen(true);
  };

  const updateLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const handleSubmitJournal = async () => {
    const validLines = lines.filter((l) => l.accountId && (l.debit > 0 || l.credit > 0));
    if (!memo.trim() || validLines.length < 2) {
      toast({
        title: t("accounting.journals.validationLines", "Memo and at least 2 valid debit/credit lines are required"),
        variant: "destructive",
      });
      return;
    }
    if (!totals.isBalanced) {
      toast({
        title: t("accounting.journals.unbalancedError", "Total debits must equal total credits"),
        variant: "destructive",
      });
      return;
    }

    try {
      await createJournalEntry.mutateAsync({
        entryDate,
        branchId: newBranchId === "none" ? null : newBranchId,
        referenceNumber: referenceNumber.trim() || undefined,
        memo: memo.trim(),
        lines: validLines.map((l) => ({
          accountId: l.accountId,
          costCenterId: l.costCenterId && l.costCenterId !== "none" ? l.costCenterId : null,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          currency: l.currency || settings.currency || "USD",
          fxRate: Number(l.fxRate) || 1,
          description: l.description.trim() || undefined,
        })),
      });
      toast({ title: t("accounting.journals.created", "Journal entry posted") });
      setCreateOpen(false);
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleReverse = async () => {
    if (!reverseTarget || !reverseReason.trim()) return;
    try {
      await reverseJournalEntry.mutateAsync({
        id: reverseTarget.id,
        reason: reverseReason.trim(),
      });
      toast({ title: t("accounting.journals.reversedToast", "Reversal journal entry posted") });
      setReverseTarget(null);
      setReverseReason("");
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const entryTotalDebit = (e: JournalEntryDto) =>
    e.lines.reduce((s, l) => s + l.debitBase, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-7 w-7 text-primary" />
            {t("accounting.journals.title", "Journal Entries")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.journals.description",
              "Immutable double-entry ledger generated from inventory, purchasing, sales, and manual entries."
            )}
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreateModal}>
            <Plus className="h-4 w-4 me-2" />
            {t("accounting.journals.new", "New Journal Entry")}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-9"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t("common.search")}
              />
            </div>
            <Select
              value={branchFilter}
              onValueChange={(v) => {
                setBranchFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[200px]">
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
            <Input
              type="date"
              className="w-40"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
              aria-label="From date"
            />
            <Input
              type="date"
              className="w-40"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
              aria-label="To date"
            />
          </div>
        </CardHeader>
        <CardContent>
          <EnterpriseDataTable
            data={filteredEntries}
            columns={
              [
                {
                  id: "entryNumber",
                  header: t("accounting.journals.entryNumber", "Entry #"),
                  hideable: false,
                  sortable: true,
                  cell: (entry) => <span className="font-mono font-medium">{entry.entryNumber}</span>,
                },
                {
                  id: "entryDate",
                  header: t("common.date", "Date"),
                  sortable: true,
                  cell: (entry) => (
                    <span className="whitespace-nowrap">{new Date(entry.entryDate).toLocaleDateString()}</span>
                  ),
                },
                {
                  id: "sourceType",
                  header: t("accounting.journals.source", "Source"),
                  cell: (entry) => <Badge variant="outline">{entry.sourceType}</Badge>,
                },
                {
                  id: "memo",
                  header: t("accounting.journals.memo", "Memo"),
                  cell: (entry) => (
                    <div>
                      <div className="font-medium">{entry.memo}</div>
                      {entry.referenceNumber && (
                        <div className="text-xs text-muted-foreground">{entry.referenceNumber}</div>
                      )}
                    </div>
                  ),
                },
                {
                  id: "branch",
                  header: t("common.branch", "Branch"),
                  cell: (entry) =>
                    entry.branchId ? branchById.get(entry.branchId) ?? "—" : t("common.all", "HQ / General"),
                },
                {
                  id: "amount",
                  header: t("common.amount", "Amount"),
                  align: "end",
                  cell: (entry) => (
                    <span className="font-mono font-medium">
                      {formatMoney(entryTotalDebit(entry), settings.currency)}
                    </span>
                  ),
                },
                {
                  id: "status",
                  header: t("common.status"),
                  cell: (entry) => (
                    <Badge variant={entry.status === "reversed" ? "destructive" : "secondary"}>
                      {t(`accounting.journals.statuses.${entry.status}`, entry.status)}
                    </Badge>
                  ),
                },
                {
                  id: "actions",
                  header: "",
                  hideable: false,
                  align: "end",
                  cell: (entry) => (
                    <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
                      {canEdit && entry.status === "posted" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("accounting.journals.reverse", "Reverse entry")}
                          aria-label={`Reverse ${entry.entryNumber}`}
                          onClick={() => {
                            setReverseTarget(entry);
                            setReverseReason("");
                          }}
                        >
                          <RotateCcw className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  ),
                },
              ] satisfies EnterpriseColumn<JournalEntryDto>[]
            }
            getRowId={(entry) => entry.id}
            isLoading={isLoading}
            emptyMessage={t("common.noResults")}
            selectable
            savedViewsResource="journal-entries"
            exportResource="journal-entries"
            pageInfo={pageInfo}
            onPageChange={setPage}
            onRowClick={(entry) => setSelectedEntry(entry)}
            testId="journal-entries-table"
          />
        </CardContent>
      </Card>

      {/* Journal Detail Modal */}
      <Dialog open={!!selectedEntry} onOpenChange={(open) => !open && setSelectedEntry(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {selectedEntry && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono">{selectedEntry.entryNumber}</span>
                  <Badge variant={selectedEntry.status === "reversed" ? "destructive" : "secondary"}>
                    {selectedEntry.status}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  {selectedEntry.memo} · {new Date(selectedEntry.entryDate).toLocaleString()}
                </DialogDescription>
              </DialogHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accounting.accounts.name", "Account")}</TableHead>
                    <TableHead>{t("accounting.costCenters.title", "Cost Center")}</TableHead>
                    <TableHead>{t("common.description", "Description")}</TableHead>
                    <TableHead className="text-end">{t("accounting.journals.debit", "Debit")}</TableHead>
                    <TableHead className="text-end">{t("accounting.journals.credit", "Credit")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedEntry.lines.map((line) => {
                    const acct = accountById.get(line.accountId);
                    const cc = line.costCenterId ? costCenterById.get(line.costCenterId) : null;
                    return (
                      <TableRow key={line.id}>
                        <TableCell>
                          <span className="font-mono text-xs me-2 text-muted-foreground">{acct?.code}</span>
                          <span className="font-medium">{acct?.name ?? line.accountId}</span>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {cc ? `${cc.code} · ${cc.name}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {line.description || "—"}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {line.debitBase > 0 ? formatMoney(line.debitBase, settings.currency) : "—"}
                        </TableCell>
                        <TableCell className="text-end font-mono">
                          {line.creditBase > 0 ? formatMoney(line.creditBase, settings.currency) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <AttachmentsPanel entityType="journal_entry" entityId={selectedEntry.id} className="mt-4" />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create Manual Journal Modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("accounting.journals.new", "New Journal Entry")}</DialogTitle>
            <DialogDescription>
              {t("accounting.journals.newDesc", "Post a balanced manual double-entry journal.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="je-date">{t("common.date", "Date")} *</Label>
                <Input id="je-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.branch", "Branch")}</Label>
                <Select value={newBranchId} onValueChange={setNewBranchId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("common.all", "HQ / Unscoped")}</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.branchId} value={b.branchId}>
                        {b.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="je-ref">{t("common.reference", "Reference")}</Label>
                <Input
                  id="je-ref"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="ADJ-2026-01"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="je-memo">{t("accounting.journals.memo", "Memo")} *</Label>
              <Input
                id="je-memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Opening capital injection or accrual"
              />
            </div>

            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accounting.accounts.name", "Account")}</TableHead>
                    <TableHead className="w-36">{t("accounting.costCenters.title", "Cost Center")}</TableHead>
                    <TableHead className="w-28">{t("settings.currency", "CCY")}</TableHead>
                    <TableHead className="w-24">FX</TableHead>
                    <TableHead className="w-28">{t("accounting.journals.debit", "Debit")}</TableHead>
                    <TableHead className="w-28">{t("accounting.journals.credit", "Credit")}</TableHead>
                    <TableHead>{t("common.description", "Line Note")}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.key}>
                      <TableCell>
                        <Select
                          value={line.accountId}
                          onValueChange={(val) => updateLine(line.key, { accountId: val })}
                        >
                          <SelectTrigger className="min-w-[200px]">
                            <SelectValue placeholder={t("accounting.mappings.selectAccount", "Select account")} />
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
                      </TableCell>
                      <TableCell>
                        <Select
                          value={line.costCenterId}
                          onValueChange={(val) => updateLine(line.key, { costCenterId: val })}
                        >
                          <SelectTrigger className="min-w-[140px]">
                            <SelectValue placeholder={t("common.none", "None")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t("common.none", "None")}</SelectItem>
                            {costCenters
                              .filter((cc) => cc.isActive)
                              .map((cc) => (
                                <SelectItem key={cc.id} value={cc.id}>
                                  {cc.code} — {cc.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={line.currency}
                          onValueChange={(val) => updateLine(line.key, { currency: val })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {currencies.map((c) => (
                              <SelectItem key={c.code} value={c.code}>
                                {c.code}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0.0001}
                          step="0.0001"
                          value={line.fxRate}
                          onChange={(e) => updateLine(line.key, { fxRate: parseFloat(e.target.value) || 1 })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={line.debit || ""}
                          onChange={(e) =>
                            updateLine(line.key, {
                              debit: Math.max(0, parseFloat(e.target.value) || 0),
                              credit: (parseFloat(e.target.value) || 0) > 0 ? 0 : line.credit,
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={line.credit || ""}
                          onChange={(e) =>
                            updateLine(line.key, {
                              credit: Math.max(0, parseFloat(e.target.value) || 0),
                              debit: (parseFloat(e.target.value) || 0) > 0 ? 0 : line.debit,
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          value={line.description}
                          onChange={(e) => updateLine(line.key, { description: e.target.value })}
                        />
                      </TableCell>
                      <TableCell>
                        {lines.length > 2 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setLines((prev) => prev.filter((x) => x.key !== line.key))}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine(settings.currency || "USD")])}
              >
                <Plus className="h-4 w-4 me-1" />
                {t("accounting.journals.addLine", "Add Line")}
              </Button>
              <div className="flex items-center gap-4 text-sm font-mono">
                <span>
                  {t("accounting.journals.debit", "Dr")}: {formatMoney(totals.debit, settings.currency)}
                </span>
                <span>
                  {t("accounting.journals.credit", "Cr")}: {formatMoney(totals.credit, settings.currency)}
                </span>
                <Badge variant={totals.isBalanced ? "default" : "destructive"} className="gap-1">
                  {totals.isBalanced ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("accounting.journals.balanced", "Balanced")}
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t("accounting.journals.diff", "Diff")}: {formatMoney(totals.diff, settings.currency)}
                    </>
                  )}
                </Badge>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleSubmitJournal()}
              disabled={createJournalEntry.isPending || !totals.isBalanced}
            >
              {t("accounting.journals.post", "Post Entry")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reverse Journal Confirmation */}
      <Dialog open={!!reverseTarget} onOpenChange={(open) => !open && setReverseTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("accounting.journals.reverse", "Reverse Entry")} {reverseTarget?.entryNumber}
            </DialogTitle>
            <DialogDescription>
              {t(
                "accounting.journals.reverseDesc",
                "Posts an equal and opposite reversing entry without mutating historical ledger records."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rev-reason">{t("common.reason", "Reason")} *</Label>
            <Textarea
              id="rev-reason"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              rows={2}
              placeholder={t("common.voidReasonPlaceholder", "e.g. Entered in error")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!reverseReason.trim() || reverseJournalEntry.isPending}
              onClick={() => void handleReverse()}
            >
              {t("accounting.journals.confirmReverse", "Post Reversal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
