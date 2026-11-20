import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Sliders, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { toast } from "sonner";
import { useInventory } from "@/contexts/InventoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { useAuditLog } from "@/contexts/AuditLogContext";
import type { AdjustmentReason } from "@/types";

const REASONS: AdjustmentReason[] = ["recount", "damage", "theft", "expiry", "correction", "other"];

export default function Adjustments() {
  const { t } = useTranslation();
  const { adjustments, branches, products, branchProducts, createAdjustment } = useInventory();
  const { user } = useAuth();
  const { record } = useAuditLog();

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [newQty, setNewQty] = useState<string>("");
  const [reason, setReason] = useState<AdjustmentReason>("recount");
  const [note, setNote] = useState("");

  const filtered = useMemo(
    () =>
      adjustments.filter(a => {
        const s = q.toLowerCase();
        return (
          !s ||
          a.reference.toLowerCase().includes(s) ||
          a.product_name.toLowerCase().includes(s) ||
          a.branchName.toLowerCase().includes(s)
        );
      }),
    [adjustments, q],
  );

  const beforeQty = useMemo(() => {
    if (!branchId || !productId) return null;
    const bp = branchProducts.find(
      x => x.branchId === branchId && x.productId === productId,
    );
    return bp?.quantity ?? 0;
  }, [branchId, productId, branchProducts]);

  const reset = () => {
    setBranchId("");
    setProductId("");
    setNewQty("");
    setReason("recount");
    setNote("");
  };

  const submit = async () => {
    if (!branchId || !productId || newQty === "") {
      toast.error(t("common.fillRequired", "Please fill all required fields"));
      return;
    }
    const res = await createAdjustment({
      productId,
      branchId,
      newQty: Number(newQty),
      reason,
      note: note || undefined,
      createdBy: user?.name,
    });
    if (res.ok === false) {
      toast.error(res.error);
      return;
    }
    record("adjustments", `Adjustment ${res.adjustment.reference} (${res.adjustment.delta > 0 ? "+" : ""}${res.adjustment.delta}) for ${res.adjustment.product_name}`, {
      entity: "Adjustment",
      entityId: res.adjustment.reference,
      user: user?.name,
    });
    toast.success(t("adjustments.created", "Adjustment recorded"));
    reset();
    setOpen(false);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Sliders className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">{t("pages.inventoryOps.adjustments.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("pages.inventoryOps.adjustments.description")}</p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("adjustments.new", "New Adjustment")}
        </Button>
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
              <TableHead className="text-right">{t("adjustments.before", "Before")}</TableHead>
              <TableHead className="text-right">{t("adjustments.after", "After")}</TableHead>
              <TableHead className="text-right">{t("movements.change")}</TableHead>
              <TableHead>{t("adjustments.reason", "Reason")}</TableHead>
              <TableHead>{t("adjustments.by", "By")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  {t("common.noResults")}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(a => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-sm">{a.reference}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{format(new Date(a.createdAt), "MMM d, HH:mm")}</TableCell>
                  <TableCell>
                    <div className="font-medium">{a.product_name}</div>
                    <div className="text-xs text-muted-foreground">{a.product_sku}</div>
                  </TableCell>
                  <TableCell>{a.branchName}</TableCell>
                  <TableCell className="text-right font-mono">{a.beforeQty}</TableCell>
                  <TableCell className="text-right font-mono">{a.newQty}</TableCell>
                  <TableCell className="text-right font-mono">
                    <span className={a.delta > 0 ? "text-green-600" : "text-red-600"}>
                      {a.delta > 0 ? "+" : ""}
                      {a.delta}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`adjustments.reasons.${a.reason}`, a.reason)}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.createdBy || "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adjustments.new", "New Adjustment")}</DialogTitle>
            <DialogDescription>
              {t("adjustments.dialogDesc", "Correct on-hand quantity for a product at a branch.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("movements.branch")}</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("common.select", "Select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map(b => (
                      <SelectItem key={b.branchId} value={String(b.branchId)}>
                        {b.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("movements.product")}</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("common.select", "Select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map(p => (
                      <SelectItem key={p.productId} value={String(p.productId)}>
                        {p.product_name} • {p.product_sku}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("adjustments.before", "Before")}</Label>
                <Input value={beforeQty ?? ""} disabled />
              </div>
              <div className="space-y-1">
                <Label>{t("adjustments.after", "After")}</Label>
                <Input type="number" min={0} value={newQty} onChange={e => setNewQty(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("adjustments.reason", "Reason")}</Label>
              <Select value={reason} onValueChange={v => setReason(v as AdjustmentReason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map(r => (
                    <SelectItem key={r} value={r}>
                      {t(`adjustments.reasons.${r}`, r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t("common.note", "Note")}</Label>
              <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={submit}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}