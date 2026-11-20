import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { usePurchases } from "@/contexts/PurchasesContext";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { PurchaseReturnReason } from "@/types";

const REASONS: PurchaseReturnReason[] = ["damaged", "wrong_item", "expired", "quality", "other"];

export default function PurchaseReturns() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { receives, purchaseReturns, createPurchaseReturn, returnedQtyForReceive } = usePurchases();
  const { user } = useAuth();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedReceiveId, setSelectedReceiveId] = useState<string>("");
  const [reason, setReason] = useState<PurchaseReturnReason>("damaged");
  const [note, setNote] = useState("");
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});

  const selectedReceive = useMemo(
    () => receives.find((r) => r.id === selectedReceiveId),
    [receives, selectedReceiveId],
  );

  const alreadyReturned = useMemo(
    () => (selectedReceive ? returnedQtyForReceive(selectedReceive.id) : {}),
    [selectedReceive, returnedQtyForReceive],
  );

  const resetForm = () => {
    setSelectedReceiveId("");
    setReason("damaged");
    setNote("");
    setReturnQtys({});
  };

  const handleSubmit = async () => {
    if (!selectedReceive) {
      toast({ title: "Select a Goods Receipt", variant: "destructive" });
      return;
    }
    const items = selectedReceive.items
      .map((i) => ({ receiveItemId: i.id, returnQty: returnQtys[i.id] ?? 0 }))
      .filter((i) => i.returnQty > 0);
    if (!items.length) {
      toast({ title: "Enter at least one return quantity", variant: "destructive" });
      return;
    }

    const result = await createPurchaseReturn({
      receiveId: selectedReceive.id,
      reason,
      note,
      createdBy: user?.name || user?.email,
      items,
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return;
    }

    toast({ title: `${result.purchaseReturn.reference} created` });
    setDialogOpen(false);
    resetForm();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <RotateCcw className="h-7 w-7" />
            {t("pages.purchases.purchaseReturns.title", "Purchase Returns")}
          </h1>
          <p className="text-muted-foreground">
            {t("pages.purchases.purchaseReturns.description", "Debit notes returned to vendors against a Goods Receipt.")}
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} disabled={receives.length === 0}>
          <Plus className="me-2 h-4 w-4" />
          New Return
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Returns ({purchaseReturns.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {purchaseReturns.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">No purchase returns yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>GRN</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-end">Items</TableHead>
                  <TableHead className="text-end">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchaseReturns.map((pr) => (
                  <TableRow key={pr.id}>
                    <TableCell className="font-medium">{pr.reference}</TableCell>
                    <TableCell>{pr.returnDate}</TableCell>
                    <TableCell>{pr.vendorName}</TableCell>
                    <TableCell>{pr.branchName}</TableCell>
                    <TableCell>{pr.receiveNumber}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{pr.reason}</Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      {pr.items.reduce((sum, i) => sum + i.returnQty, 0)}
                    </TableCell>
                    <TableCell className="text-end font-medium">{formatMoney(pr.creditAmount, settings.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>New Purchase Return</DialogTitle>
            <DialogDescription>
              Return items to a vendor against a specific Goods Receipt. Stock is deducted from the receiving branch and a vendor credit is recorded.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Goods Receipt *</Label>
                <Select
                  value={selectedReceiveId}
                  onValueChange={(v) => {
                    setSelectedReceiveId(v);
                    setReturnQtys({});
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a GRN" />
                  </SelectTrigger>
                  <SelectContent>
                    {receives.map((r) => (
                      <SelectItem key={r.id} value={r.id.toString()}>
                        {r.receiveNumber} — {r.vendorName} ({r.branchName})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Reason *</Label>
                <Select value={reason} onValueChange={(v) => setReason(v as PurchaseReturnReason)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r.replace("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedReceive && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-center">Received</TableHead>
                      <TableHead className="text-center">Returnable</TableHead>
                      <TableHead className="w-32">Return Qty</TableHead>
                      <TableHead className="text-end">Unit Price</TableHead>
                      <TableHead className="text-end">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedReceive.items.map((item) => {
                      const remaining = Math.max(0, item.receivingNow - (alreadyReturned[item.productId] ?? 0));
                      const q = Math.min(remaining, returnQtys[item.id] ?? 0);
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="font-medium">{item.product_name}</div>
                            <div className="text-xs text-muted-foreground">{item.product_sku}</div>
                          </TableCell>
                          <TableCell className="text-center">{item.receivingNow}</TableCell>
                          <TableCell className="text-center">{remaining}</TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              max={remaining}
                              disabled={remaining === 0}
                              value={q}
                              onChange={(e) => {
                                const val = Math.max(0, Math.min(remaining, parseInt(e.target.value) || 0));
                                setReturnQtys((prev) => ({ ...prev, [item.id]: val }));
                              }}
                              className="w-24"
                            />
                          </TableCell>
                          <TableCell className="text-end">{formatMoney(item.unitPrice, settings.currency)}</TableCell>
                          <TableCell className="text-end font-medium">{formatMoney(q * item.unitPrice, settings.currency)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="space-y-2">
              <Label>Note</Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit}>Create Return</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
