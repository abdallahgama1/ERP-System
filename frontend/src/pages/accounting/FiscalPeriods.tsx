import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, Lock, Unlock, Plus, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import {
  useAccountingMutations,
  useFiscalYearsQuery,
  useFxRevaluationPreviewQuery,
  type FiscalYearDto,
} from "@/hooks/queries/useAccountingQueries";

export default function FiscalPeriods() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { can } = usePermissions();
  const { settings } = useSettings();
  const ccy = settings.currency || "USD";

  const { data: fiscalYears = [], isLoading } = useFiscalYearsQuery();
  const { createFiscalYear, togglePeriodLock, closeFiscalYear, runFxRevaluation } =
    useAccountingMutations();

  const [createOpen, setCreateOpen] = useState(false);
  const currentYear = new Date().getUTCFullYear();
  const [name, setName] = useState(`FY ${currentYear + 2}`);
  const [startDate, setStartDate] = useState(`${currentYear + 2}-01-01`);
  const [endDate, setEndDate] = useState(`${currentYear + 2}-12-31`);

  // Year-End Closing Wizard
  const [closeTarget, setCloseTarget] = useState<FiscalYearDto | null>(null);
  const [closeMemo, setCloseMemo] = useState("");

  // Period-End FX Revaluation Wizard
  const [fxOpen, setFxOpen] = useState(false);
  const [fxAsOfDate, setFxAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fxAutoReverse, setFxAutoReverse] = useState(true);
  const { data: fxPreview, isLoading: loadingFxPreview } = useFxRevaluationPreviewQuery(
    fxAsOfDate,
    fxOpen
  );

  const canCreate = can("accounting", "create");
  const canApprove = can("accounting", "approve");
  const canLock = canApprove || can("accounting", "edit");

  const handleCreateYear = async () => {
    if (!name.trim() || !startDate || !endDate) {
      toast({
        title: t("accounting.periods.requiredFields", "All fiscal year fields are required"),
        variant: "destructive",
      });
      return;
    }
    try {
      await createFiscalYear.mutateAsync({ name: name.trim(), startDate, endDate });
      toast({ title: t("accounting.periods.yearCreated", "Fiscal year created") });
      setCreateOpen(false);
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleToggleLock = async (id: string, currentlyLocked: boolean) => {
    try {
      await togglePeriodLock.mutateAsync({ id, lock: !currentlyLocked });
      toast({
        title: currentlyLocked
          ? t("accounting.periods.unlocked", "Period unlocked")
          : t("accounting.periods.locked", "Period locked"),
      });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleCloseYear = async () => {
    if (!closeTarget) return;
    try {
      const res = await closeFiscalYear.mutateAsync({
        id: closeTarget.id,
        memo: closeMemo.trim() || undefined,
      });
      toast({
        title: `Closed ${res.fiscalYearName} — Net Income ${formatMoney(res.netIncomeTransferred, ccy)} swept to 3100 Retained Earnings`,
      });
      setCloseTarget(null);
      setCloseMemo("");
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handlePostFxReval = async () => {
    try {
      const res = await runFxRevaluation.mutateAsync({
        asOfDate: fxAsOfDate,
        autoReverse: fxAutoReverse,
      });
      toast({
        title: res.entryNumber
          ? `Posted FX Revaluation ${res.entryNumber}${res.reversalEntryNumber ? ` (Auto-Reversal ${res.reversalEntryNumber})` : ""}`
          : "No open foreign-currency valuation differences to post",
      });
      setFxOpen(false);
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarClock className="h-7 w-7 text-primary" />
            {t("accounting.periods.title", "Fiscal Years, Period Locks & Closing")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.periods.description",
              "Manage monthly period locks, run Period-End FX Revaluation, and execute Year-End P&L Closing to Retained Earnings."
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Button variant="outline" onClick={() => setFxOpen(true)}>
              <RefreshCw className="h-4 w-4 me-2" />
              FX Revaluation Wizard
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 me-2" />
              {t("accounting.periods.addYear", "New Fiscal Year")}
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading")}</CardContent>
        </Card>
      ) : fiscalYears.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">{t("common.noResults")}</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {fiscalYears.map((fy) => (
            <Card key={fy.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle>{fy.name}</CardTitle>
                    <CardDescription>
                      {new Date(fy.startDate).toLocaleDateString()} — {new Date(fy.endDate).toLocaleDateString()}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={fy.status === "open" ? "default" : "secondary"}>{fy.status}</Badge>
                    {canApprove && fy.status === "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCloseTarget(fy);
                          setCloseMemo(`Year-end closing entry for ${fy.name}`);
                        }}
                      >
                        <CheckCircle2 className="h-4 w-4 me-1.5" />
                        Close Fiscal Year
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">#</TableHead>
                      <TableHead>{t("accounting.periods.period", "Period")}</TableHead>
                      <TableHead>{t("accounting.periods.startDate", "Start")}</TableHead>
                      <TableHead>{t("accounting.periods.endDate", "End")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                      <TableHead>{t("accounting.periods.lockedAt", "Locked At")}</TableHead>
                      <TableHead className="text-end">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fy.periods.map((p) => {
                      const isLocked = p.status !== "open";
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="font-mono text-muted-foreground">{p.periodNumber}</TableCell>
                          <TableCell className="font-medium font-mono">{p.name}</TableCell>
                          <TableCell>{new Date(p.startDate).toLocaleDateString()}</TableCell>
                          <TableCell>{new Date(p.endDate).toLocaleDateString()}</TableCell>
                          <TableCell>
                            <Badge variant={isLocked ? "destructive" : "secondary"}>
                              {t(`accounting.periods.statuses.${p.status}`, p.status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {p.lockedAt ? new Date(p.lockedAt).toLocaleString() : "—"}
                          </TableCell>
                          <TableCell className="text-end">
                            {canLock && fy.status === "open" && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={togglePeriodLock.isPending}
                                onClick={() => void handleToggleLock(p.id, isLocked)}
                              >
                                {isLocked ? (
                                  <>
                                    <Unlock className="h-3.5 w-3.5 me-1.5" />
                                    {t("accounting.periods.unlock", "Unlock")}
                                  </>
                                ) : (
                                  <>
                                    <Lock className="h-3.5 w-3.5 me-1.5" />
                                    {t("accounting.periods.lock", "Lock")}
                                  </>
                                )}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* New Fiscal Year Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounting.periods.addYear", "New Fiscal Year")}</DialogTitle>
            <DialogDescription>
              {t("accounting.periods.addYearDesc", "Automatically generates monthly accounting periods within the range.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fy-name">{t("common.name")} *</Label>
              <Input id="fy-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="fy-start">{t("accounting.periods.startDate", "Start Date")} *</Label>
                <Input id="fy-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fy-end">{t("accounting.periods.endDate", "End Date")} *</Label>
                <Input id="fy-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreateYear()} disabled={createFiscalYear.isPending}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Year-End Fiscal Closing Wizard */}
      <Dialog open={Boolean(closeTarget)} onOpenChange={(o) => !o && setCloseTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Year-End Closing Wizard — {closeTarget?.name}</DialogTitle>
            <DialogDescription>
              Sweeps all Revenue and Expense account balances for {closeTarget?.name} into 3100 Retained
              Earnings and permanently closes all monthly periods in this fiscal year.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="close-memo">Closing Journal Memo</Label>
            <Input
              id="close-memo"
              value={closeMemo}
              onChange={(e) => setCloseMemo(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleCloseYear()}
              disabled={closeFiscalYear.isPending}
            >
              Execute Year-End Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Period-End FX Revaluation Wizard */}
      <Dialog open={fxOpen} onOpenChange={setFxOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Period-End Foreign Currency Revaluation</DialogTitle>
            <DialogDescription>
              Revalues open foreign-currency AR, AP, and Bank balances at the closing exchange rate and
              posts an Unrealized FX Gain/Loss entry (5610) with optional next-day auto-reversal.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4 items-center">
              <div className="space-y-2">
                <Label htmlFor="fx-date">Valuation As-Of Date</Label>
                <Input
                  id="fx-date"
                  type="date"
                  value={fxAsOfDate}
                  onChange={(e) => setFxAsOfDate(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 mt-6">
                <Label htmlFor="fx-rev">Auto-Reverse Next Day</Label>
                <Switch id="fx-rev" checked={fxAutoReverse} onCheckedChange={setFxAutoReverse} />
              </div>
            </div>

            {loadingFxPreview ? (
              <div className="py-6 text-center text-muted-foreground">Calculating FX exposures...</div>
            ) : (fxPreview?.lines ?? []).length === 0 ? (
              <div className="rounded-md border p-4 text-sm text-muted-foreground text-center">
                No open foreign-currency monetary differences detected as of {fxAsOfDate}.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead>CCY</TableHead>
                    <TableHead className="text-end">Foreign Bal.</TableHead>
                    <TableHead className="text-end">Booked → Close</TableHead>
                    <TableHead className="text-end">Unrealized G/L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fxPreview!.lines.map((l) => (
                    <TableRow key={`${l.entityType}-${l.entityId}`}>
                      <TableCell className="font-mono text-xs">{l.documentNumber}</TableCell>
                      <TableCell>{l.currency}</TableCell>
                      <TableCell className="text-end font-mono">{l.foreignBalance.toFixed(2)}</TableCell>
                      <TableCell className="text-end font-mono text-xs">
                        {l.bookedRate} → {l.closingRate}
                      </TableCell>
                      <TableCell
                        className={`text-end font-mono font-semibold ${
                          l.unrealizedGainLoss >= 0 ? "text-emerald-600" : "text-rose-600"
                        }`}
                      >
                        {l.unrealizedGainLoss >= 0 ? "+" : ""}
                        {formatMoney(l.unrealizedGainLoss, fxPreview!.baseCurrency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFxOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handlePostFxReval()}
              disabled={runFxRevaluation.isPending || (fxPreview?.lines.length ?? 0) === 0}
            >
              Post FX Revaluation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
