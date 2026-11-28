import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Building, Plus, Play, Trash2, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import type { FixedAssetDepreciationMethod, FixedAssetDto } from "@erp/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
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
import {
  useFixedAssetMutations,
  useFixedAssetScheduleQuery,
  useFixedAssetsQuery,
} from "@/hooks/queries/useFixedAssetsQueries";

export default function FixedAssets() {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const { settings } = useSettings();
  const { branches } = useInventoryScope();
  const ccy = settings.currency || "USD";

  const { data: assets = [], isLoading } = useFixedAssetsQuery();
  const { data: accounts = [] } = useAccountsQuery();
  const { data: costCenters = [] } = useCostCentersQuery(true);
  const { createAsset, runDepreciation, disposeAsset } = useFixedAssetMutations();

  const canCreate = can("fixed_assets", "create");
  const canApprove = can("fixed_assets", "approve");

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Equipment");
  const [serialNumber, setSerialNumber] = useState("");
  const [branchId, setBranchId] = useState("none");
  const [costCenterId, setCostCenterId] = useState("none");
  const [acquisitionDate, setAcquisitionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("36");
  const [depreciationMethod, setDepreciationMethod] =
    useState<FixedAssetDepreciationMethod>("straight_line");
  const [fundingAccountId, setFundingAccountId] = useState("default");

  const [depOpen, setDepOpen] = useState(false);
  const [periodKey, setPeriodKey] = useState(() => new Date().toISOString().slice(0, 7));

  const [disposeTarget, setDisposeTarget] = useState<FixedAssetDto | null>(null);
  const [disposalDate, setDisposalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [proceedsAmount, setProceedsAmount] = useState("0");

  const [scheduleAssetId, setScheduleAssetId] = useState<string | null>(null);
  const { data: scheduleData, isLoading: loadingSchedule } = useFixedAssetScheduleQuery(
    scheduleAssetId,
    Boolean(scheduleAssetId)
  );

  const summary = useMemo(() => {
    const active = assets.filter((a) => a.status !== "disposed");
    const totalCost = active.reduce((s, a) => s + a.acquisitionCost, 0);
    const totalAccum = active.reduce((s, a) => s + a.accumulatedDepreciation, 0);
    const totalNbv = active.reduce((s, a) => s + a.netBookValue, 0);
    return { count: active.length, totalCost, totalAccum, totalNbv };
  }, [assets]);

  const fundingCandidates = useMemo(
    () => accounts.filter((a) => a.isActive && (a.accountType === "asset" || a.accountType === "liability")),
    [accounts]
  );

  const handleCreate = async () => {
    const cost = Number.parseFloat(acquisitionCost);
    const salvage = Number.parseFloat(salvageValue) || 0;
    const months = Number.parseInt(usefulLifeMonths, 10);
    if (!name.trim() || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(months) || months < 1) {
      toast.error("Enter valid asset name, positive cost, and useful life in months");
      return;
    }
    try {
      const res = await createAsset.mutateAsync({
        name: name.trim(),
        category: category.trim() || "Equipment",
        serialNumber: serialNumber.trim(),
        branchId: branchId === "none" ? null : branchId,
        costCenterId: costCenterId === "none" ? null : costCenterId,
        acquisitionDate,
        acquisitionCost: cost,
        salvageValue: salvage,
        usefulLifeMonths: months,
        depreciationMethod,
        fundingAccountId: fundingAccountId === "default" ? null : fundingAccountId,
        postAcquisitionEntry: true,
      });
      toast.success(`Registered asset ${res.asset.assetCode}`);
      setCreateOpen(false);
      setName("");
      setSerialNumber("");
      setAcquisitionCost("");
      setSalvageValue("0");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to register fixed asset");
    }
  };

  const handleRunDep = async () => {
    try {
      const res = await runDepreciation.mutateAsync({ periodKey });
      toast.success(
        `Depreciation ${res.periodKey}: posted ${res.processedAssets} asset(s), skipped ${res.skippedAlreadyPosted}`
      );
      setDepOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Depreciation run failed");
    }
  };

  const handleDispose = async () => {
    if (!disposeTarget) return;
    try {
      const res = await disposeAsset.mutateAsync({
        id: disposeTarget.id,
        data: {
          disposalDate,
          proceedsAmount: Number.parseFloat(proceedsAmount) || 0,
        },
      });
      toast.success(`Disposed ${res.asset.assetCode}`);
      setDisposeTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Asset disposal failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Building className="h-7 w-7 text-primary" />
            {t("fixedAssets.title", "Fixed Assets & Automated Depreciation")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "fixedAssets.description",
              "Capital asset register with Straight-Line and Declining-Balance monthly depreciation runs and GL disposal accounting."
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canApprove && (
            <Button variant="outline" onClick={() => setDepOpen(true)}>
              <Play className="h-4 w-4 me-2" />
              {t("fixedAssets.runDepreciation", "Run Monthly Depreciation")}
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 me-2" />
              {t("fixedAssets.new", "Register Fixed Asset")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>In-Service Assets</CardDescription>
            <CardTitle className="text-2xl">{summary.count}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Gross Acquisition Cost</CardDescription>
            <CardTitle className="text-2xl">{formatMoney(summary.totalCost, ccy)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Accumulated Depreciation</CardDescription>
            <CardTitle className="text-2xl">{formatMoney(summary.totalAccum, ccy)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net Book Value (NBV)</CardDescription>
            <CardTitle className="text-2xl text-primary">{formatMoney(summary.totalNbv, ccy)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("fixedAssets.register", "Fixed Asset Register")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset Code</TableHead>
                <TableHead>{t("common.name", "Name")}</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Acquired</TableHead>
                <TableHead className="text-end">Cost</TableHead>
                <TableHead className="text-end">Accum. Dep.</TableHead>
                <TableHead className="text-end">Net Book Value</TableHead>
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
              ) : assets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    No fixed assets registered yet.
                  </TableCell>
                </TableRow>
              ) : (
                assets.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono font-medium">{a.assetCode}</TableCell>
                    <TableCell>
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.category}
                        {a.costCenterCode ? ` • ${a.costCenterCode}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {a.depreciationMethod === "straight_line" ? "Straight-Line" : "Declining"} (
                        {a.usefulLifeMonths}m)
                      </Badge>
                    </TableCell>
                    <TableCell>{a.acquisitionDate.slice(0, 10)}</TableCell>
                    <TableCell className="text-end font-mono">{formatMoney(a.acquisitionCost, ccy)}</TableCell>
                    <TableCell className="text-end font-mono">
                      {formatMoney(a.accumulatedDepreciation, ccy)}
                    </TableCell>
                    <TableCell className="text-end font-mono font-semibold">
                      {formatMoney(a.netBookValue, ccy)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          a.status === "active"
                            ? "default"
                            : a.status === "disposed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {a.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end space-x-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setScheduleAssetId(a.id)}
                      >
                        <CalendarClock className="h-4 w-4 me-1" /> History
                      </Button>
                      {canApprove && a.status !== "disposed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDisposeTarget(a);
                            setProceedsAmount("0");
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 me-1" /> Dispose
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

      {/* Register Fixed Asset Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (!o && createAsset.isPending) return;
          setCreateOpen(o);
        }}
      >
        <DialogContent className="max-w-xl" locked={createAsset.isPending}>
          <DialogHeader>
            <DialogTitle>Register Fixed Asset</DialogTitle>
            <DialogDescription>
              Capitalizes the asset to 1500 Fixed Assets — Cost and schedules monthly depreciation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fa-name">Asset Name *</Label>
                <Input
                  id="fa-name"
                  placeholder="Delivery Van / CNC Lathe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fa-cat">Category</Label>
                <Input
                  id="fa-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fa-date">Acquisition Date *</Label>
                <Input
                  id="fa-date"
                  type="date"
                  value={acquisitionDate}
                  onChange={(e) => setAcquisitionDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fa-cost">Acquisition Cost *</Label>
                <Input
                  id="fa-cost"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={acquisitionCost}
                  onChange={(e) => setAcquisitionCost(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fa-salvage">Salvage Value</Label>
                <Input
                  id="fa-salvage"
                  type="number"
                  min="0"
                  step="0.01"
                  value={salvageValue}
                  onChange={(e) => setSalvageValue(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Depreciation Method</Label>
                <Select
                  value={depreciationMethod}
                  onValueChange={(v) => setDepreciationMethod(v as FixedAssetDepreciationMethod)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="straight_line">Straight-Line</SelectItem>
                    <SelectItem value="declining_balance">Double-Declining Balance</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fa-life">Useful Life (Months) *</Label>
                <Input
                  id="fa-life"
                  type="number"
                  min="1"
                  max="600"
                  value={usefulLifeMonths}
                  onChange={(e) => setUsefulLifeMonths(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
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
              <div className="space-y-2">
                <Label>Cost Center</Label>
                <Select value={costCenterId} onValueChange={setCostCenterId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {costCenters.map((cc) => (
                      <SelectItem key={cc.id} value={cc.id}>
                        {cc.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Paid From / Payable</Label>
                <Select value={fundingAccountId} onValueChange={setFundingAccountId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">1000 Cash & Bank</SelectItem>
                    {fundingCandidates.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createAsset.isPending} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <SubmitButton type="button" pending={createAsset.isPending} onClick={() => void handleCreate()}>
              Capitalize Asset
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run Monthly Depreciation Dialog */}
      <Dialog
        open={depOpen}
        onOpenChange={(o) => {
          if (!o && runDepreciation.isPending) return;
          setDepOpen(o);
        }}
      >
        <DialogContent className="max-w-md" locked={runDepreciation.isPending}>
          <DialogHeader>
            <DialogTitle>Run Automated Monthly Depreciation</DialogTitle>
            <DialogDescription>
              Posts monthly depreciation (Dr 5700 / Cr 1510) idempotently for all active in-service assets.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="dep-period">Accounting Month (YYYY-MM)</Label>
            <Input
              id="dep-period"
              type="month"
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={runDepreciation.isPending} onClick={() => setDepOpen(false)}>
              Cancel
            </Button>
            <SubmitButton type="button" pending={runDepreciation.isPending} onClick={() => void handleRunDep()}>
              Post Depreciation Run
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dispose Asset Dialog */}
      <Dialog
        open={Boolean(disposeTarget)}
        onOpenChange={(o) => {
          if (!o && disposeAsset.isPending) return;
          if (!o) setDisposeTarget(null);
        }}
      >
        <DialogContent className="max-w-md" locked={disposeAsset.isPending}>
          <DialogHeader>
            <DialogTitle>Dispose Fixed Asset</DialogTitle>
            <DialogDescription>
              {disposeTarget &&
                `${disposeTarget.assetCode} — ${disposeTarget.name} (NBV: ${formatMoney(disposeTarget.netBookValue, ccy)})`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="disp-date">Disposal Date</Label>
              <Input
                id="disp-date"
                type="date"
                value={disposalDate}
                onChange={(e) => setDisposalDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="disp-proceeds">Sale / Scrap Proceeds ({ccy})</Label>
              <Input
                id="disp-proceeds"
                type="number"
                min="0"
                step="0.01"
                value={proceedsAmount}
                onChange={(e) => setProceedsAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={disposeAsset.isPending} onClick={() => setDisposeTarget(null)}>
              Cancel
            </Button>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={disposeAsset.isPending}
              onClick={() => void handleDispose()}
            >
              Confirm Disposal
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Depreciation History Dialog */}
      <Dialog open={Boolean(scheduleAssetId)} onOpenChange={(o) => !o && setScheduleAssetId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Depreciation Ledger — {scheduleData?.asset.assetCode} {scheduleData?.asset.name}
            </DialogTitle>
          </DialogHeader>
          {loadingSchedule ? (
            <div className="py-6 text-center text-muted-foreground">Loading...</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-end">Depreciation</TableHead>
                  <TableHead className="text-end">Accumulated</TableHead>
                  <TableHead className="text-end">Closing NBV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(scheduleData?.entries ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                      No monthly depreciation runs posted for this asset yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  (scheduleData?.entries ?? []).map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-mono">{e.periodKey}</TableCell>
                      <TableCell>{e.depreciationDate.slice(0, 10)}</TableCell>
                      <TableCell className="text-end font-mono">
                        {formatMoney(e.depreciationAmount, ccy)}
                      </TableCell>
                      <TableCell className="text-end font-mono">
                        {formatMoney(e.accumulatedAfter, ccy)}
                      </TableCell>
                      <TableCell className="text-end font-mono font-medium">
                        {formatMoney(e.netBookValueAfter, ccy)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
