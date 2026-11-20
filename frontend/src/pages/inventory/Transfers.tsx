import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Plus, ArrowRightLeft, Search, X } from "lucide-react";
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
import { useInventory } from "@/contexts/InventoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { useAuditLog } from "@/contexts/AuditLogContext";
import { TrackingLinePicker, type LotAllocationDraft } from "@/components/tracking/TrackingLinePicker";
import type { TransferStatus } from "@/types";

const STATUSES: (TransferStatus | "All")[] = ["All", "Draft", "In Transit", "Received", "Cancelled"];

const statusVariant: Record<TransferStatus, "default" | "secondary" | "destructive" | "outline"> = {
  Draft: "outline",
  "In Transit": "secondary",
  Received: "default",
  Cancelled: "destructive",
};

type Line = {
  productId: string;
  quantity: number;
  lotAllocations?: LotAllocationDraft[];
  serialNumbers?: string[];
};

export default function Transfers() {
  const { t } = useTranslation();
  const { transfers, branches, products, branchProducts, createTransfer } = useInventory();
  const { user } = useAuth();
  const { record } = useAuditLog();

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<TransferStatus | "All">("All");

  const [sourceId, setSourceId] = useState<string>("");
  const [destId, setDestId] = useState<string>("");
  const [lines, setLines] = useState<Line[]>([{ productId: "", quantity: 1 }]);
  const [notes, setNotes] = useState("");

  const filtered = useMemo(
    () =>
      transfers.filter(tr => {
        if (status !== "All" && tr.status !== status) return false;
        const s = q.toLowerCase();
        return !s || tr.reference.toLowerCase().includes(s) || tr.sourceBranchName.toLowerCase().includes(s) || tr.destBranchName.toLowerCase().includes(s);
      }),
    [transfers, status, q],
  );

  const availableAt = (productId: string, branchId: string) => {
    if (!productId || !branchId) return 0;
    return branchProducts.find(x => x.productId === productId && x.branchId === branchId)?.quantity ?? 0;
  };

  const reset = () => {
    setSourceId(""); setDestId(""); setLines([{ productId: "", quantity: 1 }]); setNotes("");
  };

  const submit = async () => {
    if (!sourceId || !destId) {
      toast.error(t("transfers.pickBranches", "Select source and destination"));
      return;
    }
    const items = lines.filter(l => l.productId && l.quantity > 0);
    if (!items.length) {
      toast.error(t("transfers.addItems", "Add at least one item"));
      return;
    }
    const res = await createTransfer({
      sourceBranchId: sourceId,
      destBranchId: destId,
      items,
      notes: notes || undefined,
      createdBy: user?.name,
    });
    if (res.ok === false) {
      toast.error(res.error);
      return;
    }
    record("transfers", `Transfer ${res.transfer.reference} created (${res.transfer.sourceBranchName} → ${res.transfer.destBranchName})`, {
      entity: "Transfer",
      entityId: res.transfer.reference,
      user: user?.name,
    });
    toast.success(t("transfers.created", "Transfer created"));
    reset();
    setOpen(false);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <ArrowRightLeft className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">{t("pages.inventoryOps.transfers.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("pages.inventoryOps.transfers.description")}</p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("transfers.new", "New Transfer")}
        </Button>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative max-w-sm flex-1 min-w-[200px]">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("common.search")} className="ps-9" />
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map(s => (
              <Badge
                key={s}
                variant={status === s ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setStatus(s)}
              >
                {s === "All" ? t("common.all", "All") : t(`transfers.status.${s}`, s)}
              </Badge>
            ))}
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common.reference", "Reference")}</TableHead>
              <TableHead>{t("movements.date")}</TableHead>
              <TableHead>{t("transfers.source", "Source")}</TableHead>
              <TableHead>{t("transfers.destination", "Destination")}</TableHead>
              <TableHead className="text-right">{t("transfers.items", "Items")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">{t("common.noResults")}</TableCell></TableRow>
            ) : (
              filtered.map(tr => (
                <TableRow key={tr.id}>
                  <TableCell className="font-mono text-sm">{tr.reference}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{format(new Date(tr.createdAt), "MMM d, HH:mm")}</TableCell>
                  <TableCell>{tr.sourceBranchName}</TableCell>
                  <TableCell>{tr.destBranchName}</TableCell>
                  <TableCell className="text-right">{tr.items.length}</TableCell>
                  <TableCell><Badge variant={statusVariant[tr.status]}>{t(`transfers.status.${tr.status}`, tr.status)}</Badge></TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/inventory/transfers/${tr.id}`}>{t("common.view")}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("transfers.new", "New Transfer")}</DialogTitle>
            <DialogDescription>{t("transfers.dialogDesc", "Move stock from one branch to another. Goods sit in transit until received.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("transfers.source", "Source")}</Label>
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger><SelectValue placeholder={t("common.select", "Select")} /></SelectTrigger>
                  <SelectContent>
                    {branches.map(b => <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("transfers.destination", "Destination")}</Label>
                <Select value={destId} onValueChange={setDestId}>
                  <SelectTrigger><SelectValue placeholder={t("common.select", "Select")} /></SelectTrigger>
                  <SelectContent>
                    {branches.filter(b => String(b.branchId) !== sourceId).map(b => (
                      <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("transfers.items", "Items")}</Label>
              {lines.map((line, idx) => {
                const avail = availableAt(line.productId, sourceId);
                const selectedProd = products.find((p) => p.productId === line.productId);
                return (
                  <div key={idx} className="space-y-2 rounded-md border p-2.5">
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <Select value={line.productId ? String(line.productId) : ""} onValueChange={v => {
                          const copy = [...lines]; copy[idx] = { productId: v, quantity: copy[idx].quantity }; setLines(copy);
                        }}>
                          <SelectTrigger><SelectValue placeholder={t("movements.product")} /></SelectTrigger>
                          <SelectContent>
                            {products.map(p => <SelectItem key={p.productId} value={String(p.productId)}>{p.product_name} • {p.product_sku}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {line.productId && sourceId && (
                          <p className="text-xs text-muted-foreground">{t("transfers.availableAtSource", "Available at source")}: {avail}</p>
                        )}
                      </div>
                      <div className="w-28 space-y-1">
                        <Input type="number" min={1} value={line.quantity} onChange={e => {
                          const copy = [...lines]; copy[idx] = { ...copy[idx], quantity: Number(e.target.value) }; setLines(copy);
                        }} />
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => setLines(lines.filter((_, i) => i !== idx))} disabled={lines.length === 1}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <TrackingLinePicker
                      product={selectedProd}
                      branchId={sourceId || undefined}
                      quantity={line.quantity}
                      lotAllocations={line.lotAllocations}
                      serialNumbers={line.serialNumbers}
                      onChange={(patch) => {
                        const copy = [...lines];
                        copy[idx] = { ...copy[idx], ...patch };
                        setLines(copy);
                      }}
                    />
                  </div>
                );
              })}
              <Button variant="outline" size="sm" onClick={() => setLines([...lines, { productId: "", quantity: 1 }])}>
                <Plus className="h-4 w-4 me-2" /> {t("transfers.addLine", "Add line")}
              </Button>
            </div>

            <div className="space-y-1">
              <Label>{t("common.note", "Note")}</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={submit}>{t("transfers.createDraft", "Create Draft")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}