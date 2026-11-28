import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { toast } from "sonner";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuditRecorder } from "@/hooks/queries/useAuditLogsCursorQuery";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { TrackingLinePicker, type LotAllocationDraft } from "@/components/tracking/TrackingLinePicker";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import type { WriteOffReason } from "@/types";

const REASONS: WriteOffReason[] = ["damage", "expiry", "loss", "theft", "other"];

const reasonVariant: Record<WriteOffReason, "destructive" | "outline" | "secondary"> = {
  damage: "destructive",
  expiry: "secondary",
  loss: "outline",
  theft: "destructive",
  other: "outline",
};

export default function WriteOffs() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { writeOffs, branches, products, branchProducts, createWriteOff } = useInventoryScope({ writeOffs: true, products: true });
  const { user } = useAuth();
  const { can } = usePermissions();
  const { record } = useAuditRecorder();

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [reason, setReason] = useState<WriteOffReason>("damage");
  const [note, setNote] = useState("");
  const [lotAllocations, setLotAllocations] = useState<LotAllocationDraft[] | undefined>(undefined);
  const [serialNumbers, setSerialNumbers] = useState<string[] | undefined>(undefined);
  const selectedProduct = useMemo(
    () => products.find((p) => p.productId === productId),
    [products, productId]
  );

  const available = useMemo(() => {
    if (!branchId || !productId) return null;
    const bp = branchProducts.find(x => x.branchId === branchId && x.productId === productId);
    return bp?.quantity ?? 0;
  }, [branchId, productId, branchProducts]);

  const filtered = useMemo(
    () =>
      writeOffs.filter(w => {
        const s = q.toLowerCase();
        return !s || w.reference.toLowerCase().includes(s) || w.product_name.toLowerCase().includes(s) || w.branchName.toLowerCase().includes(s);
      }),
    [writeOffs, q],
  );

  const totalImpact = filtered.reduce((s, w) => s + w.costImpact, 0);

  const reset = () => {
    setBranchId(""); setProductId(""); setQty(""); setReason("damage"); setNote("");
    setLotAllocations(undefined); setSerialNumbers(undefined);
  };

  const writeOffAction = useIdempotentAction(async () => {
    if (!branchId || !productId || !qty) {
      toast.error(t("common.fillRequired", "Please fill all required fields"));
      return;
    }
    const res = await createWriteOff({
      productId,
      branchId,
      quantity: Number(qty),
      reason,
      note: note || undefined,
      createdBy: user?.name,
      lotAllocations,
      serialNumbers,
    });
    if (res.ok === false) {
      toast.error(res.error);
      return res;
    }
    record("write_offs", `Write-off ${res.writeOff.reference} (${res.writeOff.quantity}) for ${res.writeOff.product_name}`, {
      entity: "WriteOff",
      entityId: res.writeOff.reference,
      user: user?.name,
    });
    toast.success(t("writeOffs.created", "Write-off recorded"));
    reset();
    setOpen(false);
    return { ok: true };
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Trash2 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">{t("pages.inventoryOps.writeOffs.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("pages.inventoryOps.writeOffs.description")}</p>
          </div>
        </div>
        {can("inventory", "create") && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 me-2" />
            {t("writeOffs.new", "New Write-off")}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("writeOffs.totalEntries", "Total Entries")}</div>
          <div className="text-2xl font-bold mt-1">{filtered.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("writeOffs.totalUnits", "Units Written Off")}</div>
          <div className="text-2xl font-bold mt-1">{filtered.reduce((s, w) => s + w.quantity, 0)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("writeOffs.costImpact", "Cost Impact")}</div>
          <div className="text-2xl font-bold mt-1 text-red-600">{formatMoney(totalImpact, settings.currency)}</div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="relative max-w-sm mb-4">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("common.search")} className="ps-9" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.reference", "Reference")}</TableHead>
              <TableHead>{t("movements.date")}</TableHead>
              <TableHead>{t("movements.product")}</TableHead>
              <TableHead>{t("movements.branch")}</TableHead>
              <TableHead className="text-right">{t("writeOffs.quantity", "Quantity")}</TableHead>
              <TableHead>{t("writeOffs.reason", "Reason")}</TableHead>
              <TableHead className="text-right">{t("writeOffs.costImpact", "Cost Impact")}</TableHead>
              <TableHead>{t("adjustments.by", "By")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">{t("common.noResults")}</TableCell></TableRow>
            ) : (
              filtered.map(w => (
                <TableRow key={w.id}>
                  <TableCell className="font-mono text-sm">{w.reference}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{format(new Date(w.createdAt), "MMM d, HH:mm")}</TableCell>
                  <TableCell>
                    <div className="font-medium">{w.product_name}</div>
                    <div className="text-xs text-muted-foreground">{w.product_sku}</div>
                  </TableCell>
                  <TableCell>{w.branchName}</TableCell>
                  <TableCell className="text-right font-mono text-red-600">-{w.quantity}</TableCell>
                  <TableCell><Badge variant={reasonVariant[w.reason]}>{t(`writeOffs.reasons.${w.reason}`, w.reason)}</Badge></TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(w.costImpact, settings.currency)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{w.createdBy || "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={writeOffAction.guardOpenChange((o) => { setOpen(o); if (!o) reset(); })}>
        <DialogContent locked={writeOffAction.isPending}>
          <DialogHeader>
            <DialogTitle>{t("writeOffs.new", "New Write-off")}</DialogTitle>
            <DialogDescription>{t("writeOffs.dialogDesc", "Remove damaged, lost, or expired stock from inventory.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("movements.branch")}</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger><SelectValue placeholder={t("common.select", "Select")} /></SelectTrigger>
                  <SelectContent>
                    {branches.map(b => <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("movements.product")}</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger><SelectValue placeholder={t("common.select", "Select")} /></SelectTrigger>
                  <SelectContent>
                    {products.map(p => <SelectItem key={p.productId} value={String(p.productId)}>{p.product_name} • {p.product_sku}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("writeOffs.available", "Available")}</Label>
                <Input value={available ?? ""} disabled />
              </div>
              <div className="space-y-1">
                <Label>{t("writeOffs.quantity", "Quantity")}</Label>
                <Input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} />
              </div>
            </div>
            <TrackingLinePicker
              product={selectedProduct}
              branchId={branchId || undefined}
              quantity={Number(qty) || 0}
              allowExpired
              lotAllocations={lotAllocations}
              serialNumbers={serialNumbers}
              onChange={(patch) => {
                if ("lotAllocations" in patch) setLotAllocations(patch.lotAllocations);
                if ("serialNumbers" in patch) setSerialNumbers(patch.serialNumbers);
              }}
            />
            <div className="space-y-1">
              <Label>{t("writeOffs.reason", "Reason")}</Label>
              <Select value={reason} onValueChange={v => setReason(v as WriteOffReason)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REASONS.map(r => <SelectItem key={r} value={r}>{t(`writeOffs.reasons.${r}`, r)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t("common.note", "Note")}</Label>
              <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={writeOffAction.isPending} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={writeOffAction.isPending}
              isSlow={writeOffAction.isSlow}
              onClick={() => void writeOffAction.run()}
            >
              {t("writeOffs.confirm", "Write Off")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}