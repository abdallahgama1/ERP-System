import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Receipt, Plus, Trash2, Check, X, CreditCard } from "lucide-react";
import { toast } from "sonner";
import type { ExpenseClaimDto, ExpensePaymentMode } from "@erp/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useTreasuryAccountsQuery } from "@/hooks/queries/useTreasuryQueries";
import { useExpenseClaimsQuery, useExpenseMutations } from "@/hooks/queries/useExpensesQueries";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks } from "@/hooks/useIdempotentSubmit";

interface DraftExpenseLine {
  key: string;
  expenseAccountId: string;
  costCenterId: string;
  description: string;
  netAmount: string;
  taxRate: string;
}

let expLineSeq = 1;
const makeEmptyLine = (defaultAccountId = ""): DraftExpenseLine => ({
  key: `exp-line-${expLineSeq++}`,
  expenseAccountId: defaultAccountId,
  costCenterId: "none",
  description: "",
  netAmount: "",
  taxRate: "0",
});

export default function Expenses() {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const { settings } = useSettings();
  const { branches } = useInventoryScope();
  const ccy = settings.currency || "USD";

  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data: claimsPage, isLoading } = useExpenseClaimsQuery({
    status: statusFilter,
    q: search || undefined,
    page: 1,
    pageSize: 50,
  });
  const claims = claimsPage?.claims ?? [];

  const { data: accounts = [] } = useAccountsQuery();
  const { data: costCenters = [] } = useCostCentersQuery(true);
  const { data: treasuryAccounts = [] } = useTreasuryAccountsQuery();
  const { createClaim, submitClaim, reviewClaim, payClaim } = useExpenseMutations();
  const rowLocks = useActionLocks();

  const canCreate = can("expenses", "create");
  const canApprove = can("expenses", "approve");

  const expenseGlAccounts = useMemo(
    () => accounts.filter((a) => a.isActive && a.accountType === "expense"),
    [accounts]
  );
  const defaultExpenseAccountId = useMemo(
    () => expenseGlAccounts.find((a) => a.code === "5500")?.id ?? expenseGlAccounts[0]?.id ?? "",
    [expenseGlAccounts]
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [paymentMode, setPaymentMode] = useState<ExpensePaymentMode>("direct_treasury");
  const [treasuryAccountId, setTreasuryAccountId] = useState("none");
  const [branchId, setBranchId] = useState("none");
  const [payeeName, setPayeeName] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftExpenseLine[]>(() => [makeEmptyLine()]);

  useEffect(() => {
    if (!defaultExpenseAccountId) return;
    setLines((prev) =>
      prev.some((l) => !l.expenseAccountId)
        ? prev.map((l) => (l.expenseAccountId ? l : { ...l, expenseAccountId: defaultExpenseAccountId }))
        : prev
    );
  }, [defaultExpenseAccountId]);

  const [payTarget, setPayTarget] = useState<ExpenseClaimDto | null>(null);
  const [settleTreasuryId, setSettleTreasuryId] = useState("");
  const [settleRef, setSettleRef] = useState("");

  const openCreateDialog = () => {
    setPaymentMode("direct_treasury");
    setTreasuryAccountId(treasuryAccounts[0]?.id ?? "none");
    setBranchId("none");
    setPayeeName("");
    setReference("");
    setNotes("");
    setLines([makeEmptyLine(defaultExpenseAccountId)]);
    setCreateOpen(true);
  };

  const updateLine = (key: string, patch: Partial<DraftExpenseLine>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const draftTotals = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const l of lines) {
      const net = Number.parseFloat(l.netAmount) || 0;
      const rate = Number.parseFloat(l.taxRate) || 0;
      sub += net;
      tax += (net * rate) / 100;
    }
    return { sub, tax, total: sub + tax };
  }, [lines]);

  const handleCreateClaim = async (submitNow: boolean) => {
    const validLines = lines
      .map((l) => ({
        expenseAccountId: l.expenseAccountId,
        costCenterId: l.costCenterId === "none" ? null : l.costCenterId,
        description: l.description.trim(),
        netAmount: Number.parseFloat(l.netAmount),
        taxRate: Number.parseFloat(l.taxRate) || 0,
      }))
      .filter((l) => l.expenseAccountId && l.description && Number.isFinite(l.netAmount) && l.netAmount > 0);

    if (validLines.length === 0) {
      toast.error("Add at least one valid expense line with account, description, and positive amount");
      return;
    }
    if (paymentMode === "direct_treasury" && treasuryAccountId === "none") {
      toast.error("Select a bank or petty cash account for direct treasury expenses");
      return;
    }

    try {
      const res = await createClaim.mutateAsync({
        paymentMode,
        treasuryAccountId: treasuryAccountId === "none" ? null : treasuryAccountId,
        branchId: branchId === "none" ? null : branchId,
        payeeName: payeeName.trim(),
        reference: reference.trim(),
        notes: notes.trim(),
        submitNow,
        lines: validLines,
      });
      toast.success(`Created ${res.claim.claimNumber}`);
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create expense claim");
    }
  };

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    try {
      const res = await reviewClaim.mutateAsync({ id, data: { decision } });
      toast.success(`Expense ${res.claim.claimNumber} ${res.claim.status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Review failed");
    }
  };

  const handleSettleClaim = async () => {
    if (!payTarget || !settleTreasuryId) {
      toast.error("Select a treasury account to disburse payment");
      return;
    }
    try {
      const res = await payClaim.mutateAsync({
        id: payTarget.id,
        data: { treasuryAccountId: settleTreasuryId, reference: settleRef.trim() },
      });
      toast.success(`Paid ${res.claim.claimNumber}`);
      setPayTarget(null);
      setSettleRef("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payment failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-7 w-7 text-primary" />
            {t("expenses.title", "Operating Expenses & Petty Cash")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "expenses.description",
              "Record direct petty cash / bank expenses and employee reimbursement claims with Input VAT, cost centers, and maker-checker approval."
            )}
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreateDialog}>
            <Plus className="h-4 w-4 me-2" />
            {t("expenses.new", "New Expense / Claim")}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3">
          <CardTitle>{t("expenses.listTitle", "Expense Vouchers & Claims")}</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              className="w-56"
              placeholder={t("common.search", "Search claim #, payee...")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="pending_approval">Pending Approval</SelectItem>
                <SelectItem value="approved">Approved (Unpaid)</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Claim #</TableHead>
                <TableHead>{t("common.date", "Date")}</TableHead>
                <TableHead>Payee / Submitter</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-end">Net</TableHead>
                <TableHead className="text-end">VAT</TableHead>
                <TableHead className="text-end">Total</TableHead>
                <TableHead>{t("common.status", "Status")}</TableHead>
                <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    {t("common.loading", "Loading...")}
                  </TableCell>
                </TableRow>
              ) : claims.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    {t("expenses.empty", "No operating expenses or claims recorded yet.")}
                  </TableCell>
                </TableRow>
              ) : (
                claims.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-medium">{c.claimNumber}</TableCell>
                    <TableCell>{c.claimDate.slice(0, 10)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{c.payeeName || c.submittedByName}</div>
                      {c.treasuryAccountName && (
                        <div className="text-xs text-muted-foreground">{c.treasuryAccountName}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {c.paymentMode === "direct_treasury" ? "Direct Treasury" : "Reimbursement"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">{formatMoney(c.subtotal, c.currency)}</TableCell>
                    <TableCell className="text-end">{formatMoney(c.taxTotal, c.currency)}</TableCell>
                    <TableCell className="text-end font-semibold">
                      {formatMoney(c.totalAmount, c.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === "paid"
                            ? "default"
                            : c.status === "rejected"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {c.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end space-x-1">
                      {canCreate && c.status === "draft" && (
                        <SubmitButton
                          type="button"
                          size="sm"
                          variant="outline"
                          hideSlowText
                          pending={rowLocks.isPending(`submit:${c.id}`)}
                          onClick={() => void rowLocks.runLocked(`submit:${c.id}`, () => submitClaim.mutateAsync(c.id))}
                        >
                          Submit
                        </SubmitButton>
                      )}
                      {canApprove && c.status === "pending_approval" && (
                        <>
                          <SubmitButton
                            type="button"
                            size="sm"
                            hideSlowText
                            pending={rowLocks.isPending(`review:${c.id}`)}
                            onClick={() => void rowLocks.runLocked(`review:${c.id}`, () => handleReview(c.id, "approved"))}
                          >
                            <Check className="h-4 w-4 me-1" /> Approve
                          </SubmitButton>
                          <SubmitButton
                            type="button"
                            size="sm"
                            variant="outline"
                            hideSlowText
                            pending={rowLocks.isPending(`review:${c.id}`)}
                            onClick={() => void rowLocks.runLocked(`review:${c.id}`, () => handleReview(c.id, "rejected"))}
                          >
                            <X className="h-4 w-4" />
                          </SubmitButton>
                        </>
                      )}
                      {canApprove && c.status === "approved" && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setPayTarget(c);
                            setSettleTreasuryId(c.treasuryAccountId ?? treasuryAccounts[0]?.id ?? "");
                          }}
                        >
                          <CreditCard className="h-4 w-4 me-1" /> Pay
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New Expense / Claim Dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o && createClaim.isPending) return; setCreateOpen(o); }}>
        <DialogContent locked={createClaim.isPending} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("expenses.new", "New Operating Expense / Petty Cash Claim")}</DialogTitle>
            <DialogDescription>
              Posts Expense + Input VAT to the General Ledger upon approval.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Payment Mode</Label>
                <Select
                  value={paymentMode}
                  onValueChange={(v) => setPaymentMode(v as ExpensePaymentMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct_treasury">Direct Bank / Petty Cash</SelectItem>
                    <SelectItem value="employee_reimbursement">Employee Reimbursement</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {paymentMode === "direct_treasury" && (
                <div className="space-y-2">
                  <Label>Treasury Account</Label>
                  <Select value={treasuryAccountId} onValueChange={setTreasuryAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select bank/cashbox" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Select account...</SelectItem>
                      {treasuryAccounts
                        .filter((a) => a.isActive)
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} — {a.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Branch</Label>
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
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="exp-payee">Payee / Supplier / Employee</Label>
                <Input
                  id="exp-payee"
                  value={payeeName}
                  onChange={(e) => setPayeeName(e.target.value)}
                  placeholder="Cairo Electricity / Office Courier"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="exp-ref">Receipt / Invoice Ref</Label>
                <Input
                  id="exp-ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="RCPT-901"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Expense Lines</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setLines((prev) => [
                      ...prev,
                      makeEmptyLine(expenseGlAccounts[0]?.id ?? ""),
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5 me-1" /> Add Line
                </Button>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {lines.map((l) => (
                  <div key={l.key} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-3">
                      <Select
                        value={l.expenseAccountId}
                        onValueChange={(v) => updateLine(l.key, { expenseAccountId: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Expense Account" />
                        </SelectTrigger>
                        <SelectContent>
                          {expenseGlAccounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.code} — {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Input
                        placeholder="Description"
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      />
                    </div>
                    <div className="col-span-2">
                      <Select
                        value={l.costCenterId}
                        onValueChange={(v) => updateLine(l.key, { costCenterId: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Cost Center" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No CC</SelectItem>
                          {costCenters.map((cc) => (
                            <SelectItem key={cc.id} value={cc.id}>
                              {cc.code}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Net"
                        value={l.netAmount}
                        onChange={(e) => updateLine(l.key, { netAmount: e.target.value })}
                      />
                    </div>
                    <div className="col-span-1">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        placeholder="VAT%"
                        value={l.taxRate}
                        onChange={(e) => updateLine(l.key, { taxRate: e.target.value })}
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      {lines.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-6 pt-2 text-sm border-t">
              <span>Net: {formatMoney(draftTotals.sub, ccy)}</span>
              <span>VAT: {formatMoney(draftTotals.tax, ccy)}</span>
              <span className="font-bold text-base">Total: {formatMoney(draftTotals.total, ccy)}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={createClaim.isPending} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <SubmitButton
              type="button"
              variant="secondary"
              onClick={() => void handleCreateClaim(false)}
              pending={createClaim.isPending}
            >
              Save Draft
            </SubmitButton>
            <SubmitButton type="button" onClick={() => void handleCreateClaim(true)} pending={createClaim.isPending}>
              Submit for Approval
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pay Approved Reimbursement Dialog */}
      <Dialog open={Boolean(payTarget)} onOpenChange={(o) => { if (!o && !payClaim.isPending) setPayTarget(null); }}>
        <DialogContent locked={payClaim.isPending}>
          <DialogHeader>
            <DialogTitle>Settle Approved Expense Claim</DialogTitle>
            <DialogDescription>
              {payTarget &&
                `${payTarget.claimNumber} • ${formatMoney(payTarget.totalAmount, payTarget.currency)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Disburse From Treasury Account</Label>
              <Select value={settleTreasuryId} onValueChange={setSettleTreasuryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select bank or cashbox" />
                </SelectTrigger>
                <SelectContent>
                  {treasuryAccounts
                    .filter((a) => a.isActive)
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name} ({formatMoney(a.bookBalance, a.currency)})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="settle-ref">Payment Reference</Label>
              <Input
                id="settle-ref"
                value={settleRef}
                onChange={(e) => setSettleRef(e.target.value)}
                placeholder="PAY-REF-01"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={payClaim.isPending} onClick={() => setPayTarget(null)}>
              Cancel
            </Button>
            <SubmitButton type="button" onClick={() => void handleSettleClaim()} pending={payClaim.isPending}>
              Confirm Payment
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
