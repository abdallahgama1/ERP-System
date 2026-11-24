import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Receipt, Plus, Send, Ban, Trash2, Wallet, Download, QrCode, Mail } from "lucide-react";
import { downloadInvoicePdf } from "@/lib/pdf/invoicePdf";
import { useSalesInvoicesPageQuery } from "@/hooks/queries/useSalesQueries";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ProductSelector } from "@/components/purchases/ProductSelector";
import { TrackingLinePicker, type LotAllocationDraft } from "@/components/tracking/TrackingLinePicker";
import { EnterpriseDataTable, type EnterpriseColumn } from "@/components/EnterpriseDataTable";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { EmailDocumentDialog } from "@/components/EmailDocumentDialog";
import { useBranch } from "@/contexts/BranchContext";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { Customer, Invoice, InvoiceStatus } from "@/types";

const statusVariant: Record<InvoiceStatus, "default" | "secondary" | "outline" | "destructive"> = {
  Draft: "secondary",
  Sent: "default",
  "Partially Paid": "outline",
  Paid: "secondary",
  Overdue: "destructive",
  Cancelled: "outline",
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
  lotAllocations?: LotAllocationDraft[];
  serialNumbers?: string[];
}

export default function Invoices() {
  const { t } = useTranslation();
  const { invoices, customers, salesOrders, createInvoice, sendInvoice, cancelInvoice, deleteInvoice, recordInvoicePayment, invoiceBalance } = useSalesScope({ invoices: true, customers: true, salesOrders: true, products: true });
  const { products, branches } = useInventoryScope({ products: true });
  const { activeBranchId } = useBranch();
  const { user } = useAuth();
  const { can } = usePermissions();
  const { settings, taxCodes } = useSettings();
  const { toast } = useToast();
  const canCreate = can("sales", "create");
  const canEdit = can("sales", "edit");
  const canDelete = can("sales", "delete");
  const [emailTarget, setEmailTarget] = useState<Invoice | null>(null);
  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);
  const effectiveBranchId = useMemo(
    () =>
      activeBranchId !== "all"
        ? activeBranchId
        : (branches.find((b) => b.isDefault)?.branchId ?? branches[0]?.branchId),
    [activeBranchId, branches]
  );
  const defaultTaxRate = useMemo(
    () => (taxCodes.find((tc) => tc.isDefault && tc.isActive) ?? taxCodes.find((tc) => tc.isActive))?.rate ?? 0,
    [taxCodes]
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [soId, setSoId] = useState<string>("none");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(30));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [detailQrUrl, setDetailQrUrl] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Invoice | null>(null);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: invoicesPage, isLoading: isInvoicesLoading } = useSalesInvoicesPageQuery({
    page,
    pageSize: 25,
    status: statusFilter,
    branchId: activeBranchId,
    q: searchQuery,
  });

  const customerMap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const branchMap = useMemo(() => new Map(branches.map((b) => [b.branchId, b])), [branches]);
  const soNumberMap = useMemo(() => new Map(salesOrders.map((o) => [o.id, o.soNumber])), [salesOrders]);

  const paginatedInvoices = useMemo<Invoice[]>(
    () =>
      (invoicesPage?.invoices ?? []).map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        customerName: customerMap.get(inv.customerId)?.displayName ?? "",
        branchId: inv.branchId,
        branchName: branchMap.get(inv.branchId)?.branch_name ?? "",
        salesOrderId: inv.soId ?? undefined,
        soNumber: inv.soId ? soNumberMap.get(inv.soId) : undefined,
        invoiceDate: inv.invoiceDate.slice(0, 10),
        dueDate: inv.dueDate.slice(0, 10),
        status: inv.status,
        subtotal: inv.subtotal,
        totalTax: inv.taxTotal,
        grandTotal: inv.totalAmount,
        amountPaid: inv.paidAmount + inv.creditAppliedAmount + inv.retainerAppliedAmount,
        creditAppliedAmount: inv.creditAppliedAmount,
        retainerAppliedAmount: inv.retainerAppliedAmount,
        icv: inv.icv ?? null,
        invoiceHash: inv.invoiceHash ?? null,
        prevInvoiceHash: inv.prevInvoiceHash ?? null,
        qrTlv: inv.qrTlv ?? null,
        eInvoiceStatus: inv.eInvoiceStatus,
        voidReason: inv.voidReason ?? undefined,
        notes: inv.notes || undefined,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
        items: (inv.lines ?? []).map((l) => {
          const p = l.productId ? productMap.get(l.productId) : undefined;
          return {
            id: l.id,
            productId: l.productId ?? "",
            product_name: p?.product_name ?? l.description ?? "",
            product_sku: p?.product_sku ?? "",
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxPercent: l.taxRate,
            amount: l.lineTotal,
          };
        }),
      })),
    [branchMap, customerMap, invoicesPage, productMap, soNumberMap]
  );

  useEffect(() => {
    let active = true;
    if (!detail?.qrTlv) {
      setDetailQrUrl(null);
      return;
    }
    void import("qrcode")
      .then((QRCode) => QRCode.toDataURL(detail.qrTlv!, { width: 144, margin: 1 }))
      .then((url) => {
        if (active) setDetailQrUrl(url);
      })
      .catch(() => {
        if (active) setDetailQrUrl(null);
      });
    return () => {
      active = false;
    };
  }, [detail]);

  const invoicedSoIds = useMemo(
    () => new Set(invoices.map(i => i.salesOrderId).filter((v): v is string => typeof v === "string" && v.length > 0)),
    [invoices],
  );

  const eligibleOrders = useMemo(
    () =>
      salesOrders.filter(
        o => !invoicedSoIds.has(o.id) && o.status !== "Draft" && o.status !== "Cancelled" &&
          (customerId ? o.customerId === customerId : true),
      ),
    [salesOrders, invoicedSoIds, customerId],
  );

  const currency = customers.find(c => c.id === customerId)?.currency || settings.currency;
  const fmt = (n: number, cur = currency) => formatMoney(n, cur || settings.currency);

  const resetForm = () => {
    setCustomerId(null);
    setSoId("none");
    setInvoiceDate(today());
    setDueDate(addDays(30));
    setNotes("");
    setLines([]);
  };

  const pickCustomer = (customer: Customer) => {
    setCustomerId(customer.id);
    setSoId("none");
    setDueDate(addDays(customer.paymentTerms === "NET15" ? 15 : customer.paymentTerms === "COD" ? 0 : 30));
  };

  const pickOrder = (value: string) => {
    setSoId(value);
    if (value === "none") { setLines([]); return; }
    const order = salesOrders.find(o => o.id === value);
    if (!order) return;
    setCustomerId(order.customerId);
    setLines(
      order.items.map(i => ({
        productId: i.productId,
        product_name: i.product_name,
        product_sku: i.product_sku,
        quantity: i.fulfilledQty > 0 ? i.fulfilledQty : i.quantity,
        unitPrice: i.unitPrice,
        taxPercent: i.taxPercent,
      })),
    );
  };

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines(prev => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const totalTax = lines.reduce((s, l) => s + (l.quantity * l.unitPrice * l.taxPercent) / 100, 0);

  const handleSubmit = async () => {
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      toast({ title: t("invoices.selectCustomer", "Select a customer"), variant: "destructive" });
      return;
    }
    const order = soId !== "none" ? salesOrders.find(o => o.id === soId) : undefined;
    const result = await createInvoice({
      customerId: customer.id,
      customerName: customer.displayName,
      salesOrderId: order?.id,
      soNumber: order?.soNumber,
      invoiceDate,
      dueDate,
      notes: notes || undefined,
      createdBy: user?.name,
      items: lines,
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return;
    }
    toast({ title: `${result.invoice.invoiceNumber} ${t("invoices.created", "created")}` });
    setDialogOpen(false);
    resetForm();
  };

  const act = async (promise: Promise<{ ok: true } | { ok: false; error: string }>, okTitle: string) => {
    const res = await promise;
    if (res.ok === false) toast({ title: res.error, variant: "destructive" });
    else toast({ title: okTitle });
  };

  const outstanding = invoices
    .filter(i => i.status !== "Draft" && i.status !== "Cancelled")
    .reduce((s, i) => s + invoiceBalance(i), 0);
  const overdueCount = invoices.filter(i => i.status === "Overdue").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-7 w-7" />
            {t("nav.sales.invoices")}
          </h1>
          <p className="text-muted-foreground">
            {t("invoices.description", "Customer invoices, receivables and payment status.")}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setDialogOpen(true)} disabled={customers.length === 0}>
            <Plus className="me-2 h-4 w-4" />
            {t("invoices.new", "New Invoice")}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.count", "Invoices")}</CardDescription><CardTitle className="text-2xl">{invoices.length}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.outstanding", "Outstanding")}</CardDescription><CardTitle className="text-2xl">{fmt(outstanding, "USD")}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.overdue", "Overdue")}</CardDescription><CardTitle className="text-2xl">{overdueCount}</CardTitle></CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("nav.sales.invoices")} ({invoicesPage?.pageInfo?.total ?? invoices.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EnterpriseDataTable
            data={paginatedInvoices}
            columns={
              [
                {
                  id: "invoiceNumber",
                  header: t("invoices.number", "Invoice #"),
                  hideable: false,
                  sortable: true,
                  cell: (inv) => <span className="font-medium">{inv.invoiceNumber}</span>,
                },
                {
                  id: "customerName",
                  header: t("invoices.customer", "Customer"),
                  sortable: true,
                  accessorKey: "customerName",
                },
                {
                  id: "invoiceDate",
                  header: t("invoices.invoiceDate", "Invoice Date"),
                  sortable: true,
                  cell: (inv) => new Date(inv.invoiceDate).toLocaleDateString(),
                },
                {
                  id: "dueDate",
                  header: t("invoices.dueDate", "Due Date"),
                  sortable: true,
                  cell: (inv) => new Date(inv.dueDate).toLocaleDateString(),
                },
                {
                  id: "soNumber",
                  header: t("salesOrders.soNumber"),
                  cell: (inv) => inv.soNumber || "-",
                },
                {
                  id: "status",
                  header: t("common.status"),
                  cell: (inv) => <Badge variant={statusVariant[inv.status]}>{inv.status}</Badge>,
                },
                {
                  id: "grandTotal",
                  header: t("invoices.amount", "Amount"),
                  align: "end",
                  sortable: true,
                  cell: (inv) => formatMoney(inv.grandTotal, settings.currency),
                },
                {
                  id: "balance",
                  header: t("invoices.balance", "Balance"),
                  align: "end",
                  cell: (inv) => (
                    <span className="font-medium">{formatMoney(invoiceBalance(inv), settings.currency)}</span>
                  ),
                },
                {
                  id: "actions",
                  header: "",
                  hideable: false,
                  align: "end",
                  cell: (inv) => (
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Download ${inv.invoiceNumber} PDF`}
                        onClick={() => void downloadInvoicePdf(inv, settings.currency)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Email ${inv.invoiceNumber}`}
                        onClick={() => setEmailTarget(inv)}
                      >
                        <Mail className="h-4 w-4" />
                      </Button>
                      {canEdit && inv.status === "Draft" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Send ${inv.invoiceNumber}`}
                          onClick={() => act(sendInvoice(inv.id), `${inv.invoiceNumber} sent`)}
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      )}
                      {canEdit && inv.status !== "Draft" && inv.status !== "Paid" && inv.status !== "Cancelled" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Record payment for ${inv.invoiceNumber}`}
                          onClick={() => {
                            setPayFor(inv);
                            setPayAmount(invoiceBalance(inv).toFixed(2));
                          }}
                        >
                          <Wallet className="h-4 w-4" />
                        </Button>
                      )}
                      {canEdit && inv.status !== "Cancelled" && inv.amountPaid === 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Cancel ${inv.invoiceNumber}`}
                          onClick={() => act(cancelInvoice(inv.id), `${inv.invoiceNumber} cancelled`)}
                        >
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && inv.status === "Draft" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${inv.invoiceNumber}`}
                          onClick={() => setPendingDelete(inv)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  ),
                },
              ] satisfies EnterpriseColumn<Invoice>[]
            }
            getRowId={(inv) => inv.id}
            isLoading={isInvoicesLoading}
            emptyMessage={t(
              "invoices.empty",
              "No invoices yet. Raise one from a confirmed sales order to start tracking receivables."
            )}
            searchValue={searchQuery}
            onSearchChange={(val) => {
              setSearchQuery(val);
              setPage(1);
            }}
            searchPlaceholder={t("common.search")}
            toolbarExtra={
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("common.all", "All statuses")}</SelectItem>
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="Sent">Sent</SelectItem>
                  <SelectItem value="Partially Paid">Partially Paid</SelectItem>
                  <SelectItem value="Paid">Paid</SelectItem>
                  <SelectItem value="Overdue">Overdue</SelectItem>
                  <SelectItem value="Cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            }
            selectable
            savedViewsResource="invoices"
            exportResource="invoices"
            pageInfo={invoicesPage?.pageInfo}
            onPageChange={setPage}
            onRowClick={(inv) => setDetail(inv)}
            testId="invoices-data-table"
          />
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={open => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("invoices.new", "New Invoice")}</DialogTitle>
            <DialogDescription>
              {t("invoices.newDescription", "Raise an invoice from a sales order, or build one line by line.")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("invoices.customer", "Customer")}</Label>
              <Select
                value={customerId ? String(customerId) : ""}
                onValueChange={value => {
                  const customer = customers.find(c => c.id === value);
                  if (customer) pickCustomer(customer);
                }}
              >
                <SelectTrigger aria-label={t("invoices.customer", "Customer")}>
                  <SelectValue placeholder={t("salesOrders.selectCustomer")} />
                </SelectTrigger>
                <SelectContent>
                  {customers.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("salesOrders.soNumber")}</Label>
              <Select value={soId} onValueChange={pickOrder}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("invoices.noOrder", "Without a sales order")}</SelectItem>
                  {eligibleOrders.map(o => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.soNumber} — {o.customerName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-date">{t("invoices.invoiceDate", "Invoice Date")}</Label>
              <Input id="inv-date" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-due">{t("invoices.dueDate", "Due Date")}</Label>
              <Input id="inv-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-3">
            <Label>{t("invoices.lineItems", "Line Items")}</Label>
            <ProductSelector
              products={products}
              onSelect={p =>
                setLines(prev => [
                  ...prev,
                  {
                    productId: p.productId,
                    product_name: p.product_name,
                    product_sku: p.product_sku,
                    quantity: 1,
                    unitPrice: p.sellingPrice,
                    taxPercent: defaultTaxRate,
                  },
                ])
              }
            />
            <datalist id="inv-tax-codes">
              {taxCodes.map((tc) => (
                <option key={tc.id} value={tc.rate}>
                  {tc.code} ({tc.rate}%)
                </option>
              ))}
            </datalist>
            {lines.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("invoices.item", "Item")}</TableHead>
                    <TableHead className="w-24">{t("common.quantity", "Qty")}</TableHead>
                    <TableHead className="w-28">{t("invoices.unitPrice", "Price")}</TableHead>
                    <TableHead className="w-24">{t("invoices.tax", "Tax %")}</TableHead>
                    <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, i) => (
                    <TableRow key={`${l.productId}-${i}`}>
                      <TableCell>
                        <div className="font-medium">{l.product_name}</div>
                        <div className="text-xs text-muted-foreground">{l.product_sku}</div>
                        <TrackingLinePicker
                          product={productMap.get(l.productId)}
                          branchId={effectiveBranchId}
                          quantity={l.quantity}
                          lotAllocations={l.lotAllocations}
                          serialNumbers={l.serialNumbers}
                          onChange={(patch) => updateLine(i, patch)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={1} value={l.quantity}
                          onChange={e => updateLine(i, { quantity: Math.max(1, Number(e.target.value) || 0) })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={0} step="0.01" value={l.unitPrice}
                          onChange={e => updateLine(i, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={0} max={100} list="inv-tax-codes" value={l.taxPercent}
                          onChange={e => updateLine(i, { taxPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                      </TableCell>
                      <TableCell className="text-end">
                        {fmt(l.quantity * l.unitPrice * (1 + l.taxPercent / 100))}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" aria-label={`Remove ${l.product_name}`}
                          onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="inv-notes">{t("common.notes", "Notes")}</Label>
              <Textarea id="inv-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} />
            </div>
            <div className="space-y-1 text-sm self-end">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.subtotal", "Subtotal")}</span><span>{fmt(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.totalTax", "Total Tax")}</span><span>{fmt(totalTax)}</span></div>
              <div className="flex justify-between font-semibold text-base"><span>{t("invoices.grandTotal", "Grand Total")}</span><span>{fmt(subtotal + totalTax)}</span></div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleSubmit}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={open => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detail.invoiceNumber}
                  <Badge variant={statusVariant[detail.status]}>{detail.status}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {detail.customerName}
                  {detail.soNumber ? ` — ${detail.soNumber}` : ""}
                </DialogDescription>
              </DialogHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("invoices.item", "Item")}</TableHead>
                    <TableHead className="text-end">{t("common.quantity", "Qty")}</TableHead>
                    <TableHead className="text-end">{t("invoices.unitPrice", "Price")}</TableHead>
                    <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map(item => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.product_name}</div>
                        <div className="text-xs text-muted-foreground">{item.product_sku}</div>
                      </TableCell>
                      <TableCell className="text-end">{item.quantity}</TableCell>
                      <TableCell className="text-end">{formatMoney(item.unitPrice, settings.currency)}</TableCell>
                      <TableCell className="text-end">{formatMoney(item.amount, settings.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.subtotal", "Subtotal")}</span><span>{formatMoney(detail.subtotal, settings.currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.totalTax", "Total Tax")}</span><span>{formatMoney(detail.totalTax, settings.currency)}</span></div>
                <div className="flex justify-between font-semibold"><span>{t("invoices.grandTotal", "Grand Total")}</span><span>{formatMoney(detail.grandTotal, settings.currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.paid", "Paid")}</span><span>{formatMoney(detail.amountPaid, settings.currency)}</span></div>
                <div className="flex justify-between font-semibold"><span>{t("invoices.balance", "Balance")}</span><span>{formatMoney(invoiceBalance(detail), settings.currency)}</span></div>
              </div>
              {detail.notes && <p className="text-sm whitespace-pre-line text-muted-foreground">{detail.notes}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void downloadInvoicePdf(detail, settings.currency)}
                >
                  <Download className="h-4 w-4 me-1.5" />
                  {t("common.downloadPdf", "Download PDF")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEmailTarget(detail)}
                >
                  <Mail className="h-4 w-4 me-1.5" />
                  {t("emailDialog.sendEmail", "Email Invoice")}
                </Button>
              </div>
              <AttachmentsPanel entityType="invoice" entityId={detail.id} />
              {detail.qrTlv && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-4 rounded-md border p-3 bg-muted/30">
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-sm">
                      <QrCode className="h-4 w-4 text-primary" />
                      {t("invoices.einvoiceTitle", "E-Invoice Compliance (ZATCA TLV)")}
                    </div>
                    {detail.icv && (
                      <div className="text-muted-foreground">
                        ICV: <span className="font-mono text-foreground">#{detail.icv}</span>
                      </div>
                    )}
                    {detail.invoiceHash && (
                      <div className="text-muted-foreground">
                        SHA-256: <span className="font-mono text-foreground">{detail.invoiceHash.slice(0, 24)}...</span>
                      </div>
                    )}
                  </div>
                  {detailQrUrl && (
                    <img
                      src={detailQrUrl}
                      alt={`ZATCA QR ${detail.invoiceNumber}`}
                      className="h-28 w-28 rounded border bg-white p-1"
                    />
                  )}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment dialog */}
      <Dialog open={!!payFor} onOpenChange={open => !open && setPayFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("invoices.recordPayment", "Record Payment")}</DialogTitle>
            <DialogDescription>
              {payFor ? `${payFor.invoiceNumber} — ${t("invoices.balance", "Balance")} ${formatMoney(invoiceBalance(payFor), settings.currency)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pay-amount">{t("invoices.amount", "Amount")}</Label>
            <Input id="pay-amount" type="number" min={0} step="0.01" value={payAmount}
              onChange={e => setPayAmount(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>{t("common.cancel")}</Button>
            <Button
              onClick={async () => {
                if (!payFor) return;
                const res = await recordInvoicePayment(payFor.id, Number(payAmount));
                if (res.ok === false) { toast({ title: res.error, variant: "destructive" }); return; }
                toast({ title: t("invoices.paymentRecorded", "Payment recorded") });
                setPayFor(null);
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={!!pendingDelete}
        onOpenChange={open => !open && setPendingDelete(null)}
        itemName={pendingDelete?.invoiceNumber ?? ""}
        onConfirm={async () => {
          if (pendingDelete) {
            const res = await deleteInvoice(pendingDelete.id);
            if (res.ok === false) toast({ title: res.error, variant: "destructive" });
            else toast({ title: `${pendingDelete.invoiceNumber} deleted` });
          }
          setPendingDelete(null);
        }}
      />

      {emailTarget && (
        <EmailDocumentDialog
          open={emailTarget !== null}
          onOpenChange={(open) => !open && setEmailTarget(null)}
          documentType="invoice"
          documentId={emailTarget.id}
          documentNumber={emailTarget.invoiceNumber}
          defaultRecipient={customers.find((c) => c.id === emailTarget.customerId)?.email ?? ""}
        />
      )}
    </div>
  );
}
