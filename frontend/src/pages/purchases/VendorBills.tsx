import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Receipt, Plus, AlertTriangle, Trash2, Ban, Mail } from "lucide-react";
import { useVendorBillsPageQuery } from "@/hooks/queries/usePurchasingQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { EnterpriseDataTable, type EnterpriseColumn } from "@/components/EnterpriseDataTable";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { EmailDocumentDialog } from "@/components/EmailDocumentDialog";
import { useBranch } from "@/contexts/BranchContext";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { BillMatchStatus, BillStatus, VendorBill } from "@/types";

const statusVariant: Record<BillStatus, "default" | "secondary" | "outline" | "destructive"> = {
  Draft: "secondary",
  Open: "default",
  "Partially Paid": "outline",
  Paid: "secondary",
  Overdue: "destructive",
  Cancelled: "outline",
};

const matchLabel: Record<BillMatchStatus, string> = {
  matched: "Matched",
  qty_mismatch: "Qty mismatch",
  price_mismatch: "Price mismatch",
  unmatched: "Unmatched",
};

const today = () => new Date().toISOString().split("T")[0];
const addDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
};

interface DraftLine {
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  receivedQty: number;
}

export default function VendorBills() {
  const { t } = useTranslation();
  const { activeBranchId } = useBranch();
  const { products } = useInventoryScope({ products: true });
  const { bills, receives, purchaseOrders, vendors, createBill, deleteBill, voidBill, billBalance } = usePurchasingScope({ bills: true, receives: true, purchaseOrders: true, vendors: true, products: true });
  const { user } = useAuth();
  const { can } = usePermissions();
  const { settings, taxCodes } = useSettings();
  const { toast } = useToast();
  const canCreate = can("purchases", "create");
  const canDelete = can("purchases", "delete");
  const [emailTarget, setEmailTarget] = useState<VendorBill | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [receiveId, setReceiveId] = useState<string>("");
  const [vendorId, setVendorId] = useState<string>("");
  const [vendorRef, setVendorRef] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(30));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [detailBill, setDetailBill] = useState<VendorBill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<VendorBill | null>(null);
  const [pendingVoid, setPendingVoid] = useState<VendorBill | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);

  const { data: billsPage } = useVendorBillsPageQuery({
    page,
    pageSize: 25,
    q: searchTerm,
    branchId: activeBranchId,
  });

  const vendorMap = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);
  const poMap = useMemo(() => new Map(purchaseOrders.map((po) => [po.id, po])), [purchaseOrders]);
  const receiveMap = useMemo(() => new Map(receives.map((r) => [r.id, r])), [receives]);

  const paginatedBills = useMemo<VendorBill[]>(
    () =>
      (billsPage?.bills ?? []).map((b) => {
        const linkedPo = b.poId ? poMap.get(b.poId) : undefined;
        const linkedReceive = b.receiveId ? receiveMap.get(b.receiveId) : undefined;
        const matchNotes: string[] = [];
        let matchStatus: BillMatchStatus = linkedReceive ? "matched" : "unmatched";

        const items = (b.lines ?? []).map((l) => {
          const p = l.productId ? productMap.get(l.productId) : undefined;
          const recLine = linkedReceive?.items.find((rl) => rl.productId === l.productId);
          const poLine = linkedPo?.items.find((pl) => pl.productId === l.productId);
          if (recLine && Math.abs(l.quantity - recLine.receivingNow) > 0.001) {
            matchStatus = "qty_mismatch";
            matchNotes.push(`${p?.product_name ?? "Item"}: billed ${l.quantity}, received ${recLine.receivingNow}`);
          }
          if (poLine && Math.abs(l.unitCost - poLine.unitPrice) > 0.01) {
            if (matchStatus === "matched") matchStatus = "price_mismatch";
            matchNotes.push(`${p?.product_name ?? "Item"}: bill price ${l.unitCost}, PO price ${poLine.unitPrice}`);
          }
          return {
            id: l.id,
            productId: l.productId ?? "",
            product_name: p?.product_name ?? l.description ?? "",
            product_sku: p?.product_sku ?? "",
            quantity: l.quantity,
            unitPrice: l.unitCost,
            taxPercent: l.taxRate,
            amount: l.lineTotal,
            receivedQty: recLine?.receivingNow,
            orderedUnitPrice: poLine?.unitPrice,
          };
        });

        return {
          id: b.id,
          billNumber: b.billNumber,
          vendorId: b.vendorId,
          vendorName: vendorMap.get(b.vendorId)?.displayName ?? "",
          branchId: b.branchId,
          receiveId: b.receiveId ?? undefined,
          receiveNumber: linkedReceive?.receiveNumber,
          purchaseOrderId: b.poId ?? undefined,
          poNumber: linkedPo?.poNumber,
          billDate: b.billDate.slice(0, 10),
          dueDate: b.dueDate.slice(0, 10),
          status: b.status,
          matchStatus,
          matchNotes,
          items,
          subtotal: b.subtotal,
          totalTax: b.taxTotal,
          grandTotal: b.totalAmount,
          amountPaid: b.paidAmount,
          voidReason: b.voidReason ?? undefined,
          notes: b.notes || undefined,
          createdAt: b.createdAt,
        };
      }),
    [billsPage, poMap, productMap, receiveMap, vendorMap]
  );

  const billedReceiveIds = useMemo(
    () =>
      new Set(
        bills
          .filter((b) => b.status !== "Cancelled")
          .map((b) => b.receiveId)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    [bills],
  );
  const availableReceives = useMemo(
    () => receives.filter((r) => !billedReceiveIds.has(r.id)),
    [receives, billedReceiveIds],
  );

  const resetForm = () => {
    setReceiveId("");
    setVendorId("");
    setVendorRef("");
    setBillDate(today());
    setDueDate(addDays(30));
    setNotes("");
    setLines([]);
  };

  const handlePickReceive = (value: string) => {
    setReceiveId(value);
    const receive = receives.find((r) => r.id === value);
    if (!receive) return;
    setVendorId(String(receive.vendorId));
    setLines(
      receive.items
        .filter((i) => i.receivingNow > 0)
        .map((i) => ({
          productId: i.productId,
          product_name: i.product_name,
          product_sku: i.product_sku,
          quantity: i.receivingNow,
          unitPrice: i.unitPrice,
          taxPercent: 0,
          receivedQty: i.receivingNow,
        })),
    );
  };

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const totalTax = lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxPercent / 100), 0);

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const handleSubmit = async () => {
    if (!vendorId) {
      toast({ title: "Select a vendor", variant: "destructive" });
      return;
    }
    const result = await createBill({
      vendorId,
      receiveId: receiveId || undefined,
      vendorBillReference: vendorRef || undefined,
      billDate,
      dueDate,
      notes: notes || undefined,
      createdBy: user?.name,
      items: lines.map((l) => ({
        productId: l.productId,
        product_name: l.product_name,
        product_sku: l.product_sku,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxPercent: l.taxPercent,
        receivedQty: l.receivedQty,
      })),
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return;
    }
    toast({ title: `${result.bill.billNumber} created` });
    setDialogOpen(false);
    resetForm();
    if (result.bill.matchStatus !== "matched") setDetailBill(result.bill);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const res = await deleteBill(pendingDelete.id);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
    } else {
      toast({ title: `${pendingDelete.billNumber} deleted` });
    }
    setPendingDelete(null);
  };

  const confirmVoid = async () => {
    if (!pendingVoid) return;
    const res = await voidBill(pendingVoid.id, voidReason, user?.name || user?.email);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({ title: `${pendingVoid.billNumber} voided` });
    setPendingVoid(null);
    setVoidReason("");
  };

  const totalOutstanding = bills
    .filter((b) => b.status !== "Cancelled" && b.status !== "Draft")
    .reduce((s, b) => s + billBalance(b), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-7 w-7" />
            {t("pages.purchases.bills.title", "Vendor Bills")}
          </h1>
          <p className="text-muted-foreground">
            {t("pages.purchases.bills.description", "Vendor invoices matched against purchase orders and goods receipts.")}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setDialogOpen(true)} disabled={vendors.length === 0}>
            <Plus className="me-2 h-4 w-4" />
            New Bill
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bills</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{bills.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalOutstanding, settings.currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Needs review</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            {bills.filter((b) => b.status !== "Cancelled" && b.matchStatus !== "matched").length}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Bills ({billsPage?.pageInfo?.total ?? bills.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <EnterpriseDataTable
            data={paginatedBills}
            columns={
              [
                {
                  id: "billNumber",
                  header: "Bill #",
                  hideable: false,
                  sortable: true,
                  cell: (bill) => <span className="font-medium">{bill.billNumber}</span>,
                },
                {
                  id: "vendorName",
                  header: "Vendor",
                  sortable: true,
                  accessorKey: "vendorName",
                },
                {
                  id: "billDate",
                  header: "Bill Date",
                  sortable: true,
                  accessorKey: "billDate",
                },
                {
                  id: "dueDate",
                  header: "Due Date",
                  sortable: true,
                  accessorKey: "dueDate",
                },
                {
                  id: "matchStatus",
                  header: "Match",
                  cell: (bill) => (
                    <Badge variant={bill.matchStatus === "matched" ? "secondary" : "destructive"}>
                      {matchLabel[bill.matchStatus]}
                    </Badge>
                  ),
                },
                {
                  id: "status",
                  header: "Status",
                  cell: (bill) => <Badge variant={statusVariant[bill.status]}>{bill.status}</Badge>,
                },
                {
                  id: "grandTotal",
                  header: "Amount",
                  align: "end",
                  sortable: true,
                  cell: (bill) => formatMoney(bill.grandTotal, settings.currency),
                },
                {
                  id: "balance",
                  header: "Balance",
                  align: "end",
                  cell: (bill) => (
                    <span className="font-medium">{formatMoney(billBalance(bill), settings.currency)}</span>
                  ),
                },
                {
                  id: "actions",
                  header: "",
                  hideable: false,
                  align: "end",
                  cell: (bill) => (
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Email ${bill.billNumber}`}
                        onClick={() => setEmailTarget(bill)}
                      >
                        <Mail className="h-4 w-4" />
                      </Button>
                      {canDelete && bill.status === "Draft" && bill.amountPaid === 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${bill.billNumber}`}
                          onClick={() => setPendingDelete(bill)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      {canDelete && bill.status !== "Draft" && bill.status !== "Cancelled" && bill.amountPaid === 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Void ${bill.billNumber}`}
                          title={t("common.void", "Void")}
                          onClick={() => {
                            setPendingVoid(bill);
                            setVoidReason("");
                          }}
                        >
                          <Ban className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  ),
                },
              ] satisfies EnterpriseColumn<VendorBill>[]
            }
            getRowId={(bill) => bill.id}
            emptyMessage="No bills yet. Create one from a goods receipt to start tracking payables."
            searchValue={searchTerm}
            onSearchChange={(val) => {
              setSearchTerm(val);
              setPage(1);
            }}
            searchPlaceholder={t("common.search", "Search bills...")}
            selectable
            savedViewsResource="vendor-bills"
            exportResource="vendor-bills"
            pageInfo={billsPage?.pageInfo}
            onPageChange={setPage}
            onRowClick={(bill) => setDetailBill(bill)}
            testId="vendor-bills-table"
          />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Vendor Bill</DialogTitle>
            <DialogDescription>
              Pick a goods receipt to prefill the lines, or bill a vendor directly. Lines are matched against the PO price and the received quantity.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Goods Receipt</Label>
                <Select value={receiveId} onValueChange={handlePickReceive}>
                  <SelectTrigger>
                    <SelectValue placeholder={availableReceives.length ? "Select a GRN (optional)" : "No unbilled receipts"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableReceives.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.receiveNumber} — {r.vendorName} ({r.poNumber})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Vendor *</Label>
                <Select value={vendorId} onValueChange={setVendorId} disabled={!!receiveId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>
                        {v.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Vendor Invoice #</Label>
                <Input
                  value={vendorRef}
                  onChange={(e) => setVendorRef(e.target.value)}
                  placeholder="INV-2024-001"
                  maxLength={60}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Bill Date</Label>
                  <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Due Date</Label>
                  <Input type="date" value={dueDate} min={billDate} onChange={(e) => setDueDate(e.target.value)} />
                </div>
              </div>
            </div>

            {lines.length > 0 && (
              <>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="text-center">Received</TableHead>
                        <TableHead className="w-24">Billed Qty</TableHead>
                        <TableHead className="w-28">Unit Price</TableHead>
                        <TableHead className="w-20">Tax %</TableHead>
                        <TableHead className="text-end">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line, index) => (
                        <TableRow key={line.productId}>
                          <TableCell>
                            <div className="font-medium">{line.product_name}</div>
                            <div className="text-xs text-muted-foreground">{line.product_sku}</div>
                          </TableCell>
                          <TableCell className="text-center">{line.receivedQty}</TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              value={line.quantity}
                              aria-label={`Billed quantity for ${line.product_name}`}
                              onChange={(e) =>
                                updateLine(index, { quantity: Math.max(0, parseInt(e.target.value) || 0) })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={line.unitPrice}
                              aria-label={`Unit price for ${line.product_name}`}
                              onChange={(e) =>
                                updateLine(index, { unitPrice: Math.max(0, parseFloat(e.target.value) || 0) })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              list="bill-tax-codes"
                              value={line.taxPercent}
                              aria-label={`Tax percent for ${line.product_name}`}
                              onChange={(e) =>
                                updateLine(index, {
                                  taxPercent: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)),
                                })
                              }
                            />
                          </TableCell>
                          <TableCell className="text-end font-medium">
                            {formatMoney(line.quantity * line.unitPrice * (1 + line.taxPercent / 100), settings.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <datalist id="bill-tax-codes">
                    {taxCodes.map((tc) => (
                      <option key={tc.id} value={tc.rate}>
                        {tc.code} ({tc.rate}%)
                      </option>
                    ))}
                  </datalist>
                </div>

                <div className="flex justify-end">
                  <div className="w-64 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span>{formatMoney(subtotal, settings.currency)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tax</span>
                      <span>{formatMoney(totalTax, settings.currency)}</span>
                    </div>
                    <div className="flex justify-between font-semibold text-base">
                      <span>Total</span>
                      <span>{formatMoney(subtotal + totalTax, settings.currency)}</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={lines.length === 0}>
              Create Bill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detailBill} onOpenChange={(open) => !open && setDetailBill(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {detailBill && (
            <>
              <DialogHeader>
                <DialogTitle>{detailBill.billNumber}</DialogTitle>
                <DialogDescription>
                  {detailBill.vendorName}
                  {detailBill.receiveNumber ? ` · ${detailBill.receiveNumber}` : ""}
                  {detailBill.poNumber ? ` · ${detailBill.poNumber}` : ""}
                </DialogDescription>
              </DialogHeader>

              {detailBill.matchStatus !== "matched" && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    {matchLabel[detailBill.matchStatus]}
                  </div>
                  <ul className="mt-2 list-disc ps-5 space-y-1">
                    {detailBill.matchNotes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-center">Qty</TableHead>
                    <TableHead className="text-end">Price</TableHead>
                    <TableHead className="text-end">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailBill.items.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <div className="font-medium">{i.product_name}</div>
                        <div className="text-xs text-muted-foreground">{i.product_sku}</div>
                      </TableCell>
                      <TableCell className="text-center">{i.quantity}</TableCell>
                      <TableCell className="text-end">{formatMoney(i.unitPrice, settings.currency)}</TableCell>
                      <TableCell className="text-end">{formatMoney(i.amount, settings.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex justify-end">
                <div className="w-64 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatMoney(detailBill.subtotal, settings.currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax</span>
                    <span>{formatMoney(detailBill.totalTax, settings.currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Paid</span>
                    <span>{formatMoney(detailBill.amountPaid, settings.currency)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-base">
                    <span>Balance due</span>
                    <span>{formatMoney(billBalance(detailBill), settings.currency)}</span>
                  </div>
                </div>
              </div>
              {detailBill.voidReason && (
                <p className="text-sm text-destructive">Void reason: {detailBill.voidReason}</p>
              )}
              {detailBill.notes && <p className="text-sm text-muted-foreground">{detailBill.notes}</p>}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEmailTarget(detailBill)}
                >
                  <Mail className="h-4 w-4 me-1.5" />
                  {t("emailDialog.sendEmail", "Email Bill")}
                </Button>
              </div>
              <AttachmentsPanel entityType="vendor_bill" entityId={detailBill.id} />
            </>
          )}
        </DialogContent>
      </Dialog>

      {emailTarget && (
        <EmailDocumentDialog
          open={emailTarget !== null}
          onOpenChange={(open) => !open && setEmailTarget(null)}
          documentType="vendor_bill"
          documentId={emailTarget.id}
          documentNumber={emailTarget.billNumber}
          defaultRecipient={vendors.find((v) => v.id === emailTarget.vendorId)?.email ?? ""}
        />
      )}

      <ConfirmDeleteDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={confirmDelete}
        itemName={pendingDelete?.billNumber}
      />

      <Dialog open={!!pendingVoid} onOpenChange={(open) => !open && setPendingVoid(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void {pendingVoid?.billNumber}</DialogTitle>
            <DialogDescription>
              Voiding cancels this unpaid vendor bill while keeping its document number in the audit ledger.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-bill-reason">Reason *</Label>
            <Textarea
              id="void-bill-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Duplicate vendor bill, billing error"
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingVoid(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmVoid} disabled={!voidReason.trim()}>
              Confirm Void
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
