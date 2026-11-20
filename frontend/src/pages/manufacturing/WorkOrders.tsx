import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Factory, Play, Plus, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBranch } from "@/contexts/BranchContext";
import { useInventory } from "@/contexts/InventoryContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import {
  useBomsQuery,
  useCancelWorkOrderMutation,
  useCompleteWorkOrderMutation,
  useCreateWorkOrderMutation,
  useIssueWorkOrderMutation,
  useWorkOrdersQuery,
  type WorkOrderRow,
} from "@/hooks/queries/useManufacturingQueries";
import { useToast } from "@/hooks/use-toast";
import { formatMoney } from "@/lib/money";

export default function WorkOrders() {
  const { t } = useTranslation();
  const { branches } = useInventory();
  const { activeBranchId } = useBranch();
  const { can } = usePermissions();
  const { settings } = useSettings();
  const { toast } = useToast();

  const { data: woData, isLoading } = useWorkOrdersQuery();
  const { data: bomData } = useBomsQuery();
  const createWo = useCreateWorkOrderMutation();
  const issueWo = useIssueWorkOrderMutation();
  const completeWo = useCompleteWorkOrderMutation();
  const cancelWo = useCancelWorkOrderMutation();

  const workOrders = woData?.workOrders ?? [];
  const boms = (bomData?.boms ?? []).filter((b) => b.isActive);

  const [createOpen, setCreateOpen] = useState(false);
  const [bomId, setBomId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [plannedQty, setPlannedQty] = useState("1");
  const [notes, setNotes] = useState("");

  const [completingWo, setCompletingWo] = useState<WorkOrderRow | null>(null);
  const [completeQty, setCompleteQty] = useState("1");
  const [lotNumber, setLotNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [serialsText, setSerialsText] = useState("");

  const canCreate = can("inventory", "create");
  const canEdit = can("inventory", "edit");

  const defaultBranchId =
    activeBranchId !== "all"
      ? activeBranchId
      : (branches.find((b) => b.isDefault)?.branchId ?? branches[0]?.branchId ?? "");

  const handleCreate = async () => {
    const targetBranch = branchId || defaultBranchId;
    if (!bomId || !targetBranch) {
      toast({
        title: t("common.error", "Error"),
        description: t("manufacturing.workOrders.selectBomBranch", "Select a BOM and Branch."),
        variant: "destructive",
      });
      return;
    }
    try {
      await createWo.mutateAsync({
        bomId,
        branchId: targetBranch,
        plannedQty: Math.max(0.0001, Number(plannedQty) || 1),
        status: "Released",
        notes: notes.trim(),
      });
      toast({ title: t("manufacturing.workOrders.created", "Work Order created") });
      setBomId("");
      setPlannedQty("1");
      setNotes("");
      setCreateOpen(false);
    } catch (err) {
      toast({
        title: t("common.error", "Error"),
        description: err instanceof Error ? err.message : "Failed to create Work Order",
        variant: "destructive",
      });
    }
  };

  const handleIssue = async (wo: WorkOrderRow) => {
    try {
      await issueWo.mutateAsync({ id: wo.id });
      toast({
        title: t("manufacturing.workOrders.issued", "Materials issued to WIP"),
        description: `${wo.woNumber} — Dr 1220 WIP / Cr 1200 Inventory`,
      });
    } catch (err) {
      toast({
        title: t("common.error", "Error"),
        description: err instanceof Error ? err.message : "Failed to issue materials",
        variant: "destructive",
      });
    }
  };

  const handleComplete = async () => {
    if (!completingWo) return;
    try {
      const serials = serialsText
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await completeWo.mutateAsync({
        id: completingWo.id,
        qtyCompleted: Math.max(0.0001, Number(completeQty) || 0),
        lotNumber: lotNumber.trim() || undefined,
        expiryDate: expiryDate || null,
        serialNumbers: serials.length > 0 ? serials : undefined,
      });
      toast({
        title: t("manufacturing.workOrders.completedToast", "Finished goods received from WIP"),
        description: `${completingWo.woNumber} — Dr 1200 Inventory / Cr 1220 WIP`,
      });
      setCompletingWo(null);
      setLotNumber("");
      setExpiryDate("");
      setSerialsText("");
    } catch (err) {
      toast({
        title: t("common.error", "Error"),
        description: err instanceof Error ? err.message : "Failed to complete work order",
        variant: "destructive",
      });
    }
  };

  const handleCancel = async (wo: WorkOrderRow) => {
    try {
      await cancelWo.mutateAsync({ id: wo.id, reason: "Cancelled by operator" });
      toast({ title: t("manufacturing.workOrders.cancelledToast", "Work Order cancelled & WIP reversed") });
    } catch (err) {
      toast({
        title: t("common.error", "Error"),
        description: err instanceof Error ? err.message : "Failed to cancel work order",
        variant: "destructive",
      });
    }
  };

  const statusVariant = (status: WorkOrderRow["status"]): "default" | "secondary" | "destructive" | "outline" => {
    if (status === "Completed") return "default";
    if (status === "In Progress") return "secondary";
    if (status === "Cancelled") return "destructive";
    return "outline";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Factory className="h-7 w-7 text-primary" />
            {t("manufacturing.workOrders.title", "Work Orders")}
          </h1>
          <p className="text-muted-foreground">
            {t("manufacturing.workOrders.description", "Issue raw materials into 1220 WIP Inventory and absorb production cost into Finished Goods.")}
          </p>
        </div>
        {canCreate && (
          <Button
            onClick={() => {
              setBranchId(defaultBranchId);
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4 me-2" />
            {t("manufacturing.workOrders.new", "New Work Order")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading", "Loading...")}</CardContent>
        </Card>
      ) : workOrders.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t("manufacturing.workOrders.empty", "No work orders created yet.")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {workOrders.map((wo) => {
            const remaining = Math.max(0, wo.plannedQty - wo.completedQty);
            const hasUnissued = wo.materials.some((m) => m.requiredQty - m.issuedQty > 0.0001);
            const isTerminal = wo.status === "Completed" || wo.status === "Cancelled";
            return (
              <Card key={wo.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <span className="font-mono">{wo.woNumber}</span>
                        <Badge variant={statusVariant(wo.status)}>{wo.status}</Badge>
                      </CardTitle>
                      <CardDescription>
                        {wo.productName} ({wo.productSku}) · {wo.branchName} · {wo.bomNumber} ({wo.bomName})
                      </CardDescription>
                    </div>
                    {canEdit && !isTerminal && (
                      <div className="flex flex-wrap gap-2">
                        {hasUnissued && (
                          <Button size="sm" variant="outline" onClick={() => void handleIssue(wo)} disabled={issueWo.isPending}>
                            <Play className="h-3.5 w-3.5 me-1.5" />
                            {t("manufacturing.workOrders.issueMaterials", "Issue Materials")}
                          </Button>
                        )}
                        {wo.wipValueIssued > 0 && remaining > 0 && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setCompletingWo(wo);
                              setCompleteQty(String(remaining));
                            }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 me-1.5" />
                            {t("manufacturing.workOrders.complete", "Complete")}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => void handleCancel(wo)} disabled={cancelWo.isPending}>
                          <XCircle className="h-3.5 w-3.5 me-1.5 text-destructive" />
                          {t("common.cancel", "Cancel")}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-4 text-sm">
                    <div className="rounded-md border p-2.5">
                      <div className="text-xs text-muted-foreground">{t("manufacturing.workOrders.progress", "Progress")}</div>
                      <div className="font-semibold font-mono">
                        {wo.completedQty} / {wo.plannedQty}
                      </div>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <div className="text-xs text-muted-foreground">{t("manufacturing.workOrders.wipIssued", "WIP Issued")}</div>
                      <div className="font-semibold">{formatMoney(wo.wipValueIssued, settings.currency)}</div>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <div className="text-xs text-muted-foreground">{t("manufacturing.workOrders.wipAbsorbed", "WIP Absorbed")}</div>
                      <div className="font-semibold">{formatMoney(wo.wipValueAbsorbed, settings.currency)}</div>
                    </div>
                    <div className="rounded-md border p-2.5">
                      <div className="text-xs text-muted-foreground">{t("manufacturing.workOrders.wipBalance", "Open WIP Balance")}</div>
                      <div className="font-semibold">{formatMoney(wo.wipBalance, settings.currency)}</div>
                    </div>
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("manufacturing.boms.component", "Material")}</TableHead>
                        <TableHead className="text-end">{t("manufacturing.workOrders.required", "Required")}</TableHead>
                        <TableHead className="text-end">{t("manufacturing.workOrders.issuedQty", "Issued")}</TableHead>
                        <TableHead className="text-end">{t("products.costPrice", "Issued Unit Cost")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {wo.materials.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>
                            <span className="font-medium">{m.componentName}</span>{" "}
                            <span className="text-xs text-muted-foreground">({m.componentSku})</span>
                          </TableCell>
                          <TableCell className="text-end font-mono">{m.requiredQty}</TableCell>
                          <TableCell className="text-end font-mono">{m.issuedQty}</TableCell>
                          <TableCell className="text-end">
                            {m.unitCostSnapshot > 0 ? formatMoney(m.unitCostSnapshot, settings.currency) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("manufacturing.workOrders.new", "New Work Order")}</DialogTitle>
            <DialogDescription>
              {t("manufacturing.workOrders.newDesc", "Schedule production from an active Bill of Materials.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("manufacturing.boms.title", "Bill of Materials")}</Label>
              <Select value={bomId} onValueChange={setBomId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("common.select", "Select BOM...")} />
                </SelectTrigger>
                <SelectContent>
                  {boms.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.bomNumber} — {b.name} ({b.productName})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("branches.branch", "Branch")}</Label>
              <Select value={branchId || defaultBranchId} onValueChange={setBranchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.branchId} value={b.branchId}>
                      {b.branch_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("manufacturing.workOrders.plannedQty", "Planned Output Quantity")}</Label>
              <Input type="number" min="0.01" step="0.01" value={plannedQty} onChange={(e) => setPlannedQty(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t("common.notes", "Notes")}</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={createWo.isPending}>
              {t("common.create", "Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!completingWo} onOpenChange={(o) => !o && setCompletingWo(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("manufacturing.workOrders.complete", "Complete Work Order")} — {completingWo?.woNumber}
            </DialogTitle>
            <DialogDescription>
              {t("manufacturing.workOrders.completeDesc", "Absorb WIP into finished goods inventory.")}
            </DialogDescription>
          </DialogHeader>
          {completingWo && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t("manufacturing.workOrders.qtyCompleted", "Quantity Produced")}</Label>
                <Input
                  type="number"
                  min="0.01"
                  max={Math.max(0.01, completingWo.plannedQty - completingWo.completedQty)}
                  step="0.01"
                  value={completeQty}
                  onChange={(e) => setCompleteQty(e.target.value)}
                />
              </div>
              {completingWo.productTrackingMode === "lot" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>{t("tracking.lots.lotNumber", "Lot #")}</Label>
                    <Input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder="LOT-001" />
                  </div>
                  <div className="space-y-1">
                    <Label>{t("tracking.lots.expiryDate", "Expiry Date")}</Label>
                    <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
                  </div>
                </div>
              )}
              {completingWo.productTrackingMode === "serial" && (
                <div className="space-y-1">
                  <Label>{t("tracking.serials.serialNumbers", "Serial Numbers (comma or newline separated)")}</Label>
                  <Input
                    value={serialsText}
                    onChange={(e) => setSerialsText(e.target.value)}
                    placeholder="SN-001, SN-002"
                  />
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompletingWo(null)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={handleComplete} disabled={completeWo.isPending}>
              {t("manufacturing.workOrders.receiveFinished", "Receive Finished Goods")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
