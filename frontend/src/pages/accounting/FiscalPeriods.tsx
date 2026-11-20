import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarClock, Lock, Unlock, Plus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAccountingMutations, useFiscalYearsQuery } from "@/hooks/queries/useAccountingQueries";

export default function FiscalPeriods() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { can } = usePermissions();

  const { data: fiscalYears = [], isLoading } = useFiscalYearsQuery();
  const { createFiscalYear, togglePeriodLock } = useAccountingMutations();

  const [createOpen, setCreateOpen] = useState(false);
  const currentYear = new Date().getUTCFullYear();
  const [name, setName] = useState(`FY ${currentYear + 2}`);
  const [startDate, setStartDate] = useState(`${currentYear + 2}-01-01`);
  const [endDate, setEndDate] = useState(`${currentYear + 2}-12-31`);

  const canCreate = can("accounting", "create");
  const canLock = can("accounting", "approve") || can("accounting", "edit");

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarClock className="h-7 w-7 text-primary" />
            {t("accounting.periods.title", "Fiscal Years & Periods")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.periods.description",
              "Lock closed accounting periods to prevent backdated inventory, invoice, bill, or journal postings."
            )}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 me-2" />
            {t("accounting.periods.addYear", "New Fiscal Year")}
          </Button>
        )}
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
                  <Badge variant={fy.status === "open" ? "default" : "secondary"}>{fy.status}</Badge>
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
    </div>
  );
}
