import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { ArrowLeft, Trash2, Save, CheckCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { CustomerCombobox } from "@/components/sales/CustomerCombobox";
import { ProductSelector } from "@/components/purchases/ProductSelector";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import type { SalesOrderItem } from "@/types";

const today = () => new Date().toISOString().slice(0, 10);

const SalesOrderForm = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { orderId } = useParams();
  const location = useLocation();
  const isEditRoute = location.pathname.endsWith("/edit");

  const { customers, salesOrders, createSalesOrder, updateSalesOrder, confirmSalesOrder, nextSoNumber } = useSalesScope({ customers: true, salesOrders: true, products: true });
  const { products, branches, branchProducts } = useInventoryScope({ products: true });
  const { settings, taxCodes } = useSettings();
  const defaultTaxRate = useMemo(
    () => (taxCodes.find((tc) => tc.isDefault && tc.isActive) ?? taxCodes.find((tc) => tc.isActive))?.rate ?? 0,
    [taxCodes]
  );

  const existing = orderId ? salesOrders.find((o) => o.id === orderId) : undefined;
  const readOnly = Boolean(existing) && (!isEditRoute || existing?.status !== "Draft");

  const [customerId, setCustomerId] = useState<string | null>(existing?.customerId ?? null);
  const [branchId, setBranchId] = useState<string | null>(existing?.branchId ?? branches[0]?.branchId ?? null);
  const [orderDate, setOrderDate] = useState(existing?.orderDate ?? today());
  const [expectedShipDate, setExpectedShipDate] = useState(existing?.expectedShipDate ?? today());
  const [referenceNumber, setReferenceNumber] = useState(existing?.referenceNumber ?? "");
  const [internalNotes, setInternalNotes] = useState(existing?.internalNotes ?? "");
  const [terms, setTerms] = useState(existing?.termsAndConditions ?? "");
  const [items, setItems] = useState<SalesOrderItem[]>(existing?.items ?? []);

  const branchStock = (productId: string) =>
    branchProducts.find((bp) => bp.productId === productId && bp.branchId === branchId)?.quantity ?? 0;

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    const totalTax = items.reduce((s, i) => s + (i.quantity * i.unitPrice * i.taxPercent) / 100, 0);
    return { subtotal, totalTax, grandTotal: subtotal + totalTax };
  }, [items]);

  const updateItem = (id: string, patch: Partial<SalesOrderItem>) =>
    setItems((prev) =>
      prev.map((i) => {
        if (i.id !== id) return i;
        const next = { ...i, ...patch };
        next.amount = next.quantity * next.unitPrice * (1 + next.taxPercent / 100);
        return next;
      }),
    );

  const buildPayload = () => ({
    customerId: customerId!,
    customerName: customers.find((c) => c.id === customerId)?.displayName ?? "",
    branchId: branchId!,
    branchName: branches.find((b) => b.branchId === branchId)?.branch_name ?? "",
    orderDate,
    expectedShipDate,
    referenceNumber: referenceNumber || undefined,
    items,
    internalNotes: internalNotes || undefined,
    termsAndConditions: terms || undefined,
  });

  const saveOrderAction = useIdempotentAction(async (confirmAfter: boolean) => {
    const payload = buildPayload();
    if (existing) {
      const res = await updateSalesOrder(existing.id, payload);
      if (res.ok === false) {
        toast({ title: res.error, variant: "destructive" });
        return res;
      }
      if (confirmAfter) {
        const c = await confirmSalesOrder(existing.id);
        if (c.ok === false) {
          toast({ title: c.error, variant: "destructive" });
          return c;
        }
      }
      toast({ title: t("salesOrders.saved") });
      navigate("/sales/orders");
      return { ok: true };
    }
    const res = await createSalesOrder({ ...payload, status: confirmAfter ? "Confirmed" : "Draft" });
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    toast({ title: t("salesOrders.saved") });
    navigate("/sales/orders");
    return { ok: true };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/sales/orders" aria-label={t("common.back")}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{existing ? existing.soNumber : nextSoNumber()}</h1>
          <p className="text-muted-foreground">
            {existing ? t("salesOrders.orderDetails") : t("salesOrders.createSO")}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("salesOrders.orderInfo")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("salesOrders.customer")}</Label>
            <CustomerCombobox
              customers={customers}
              value={customerId}
              onSelect={(c) => setCustomerId(c.id)}
              disabled={readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("salesOrders.shipFromBranch")}</Label>
            <Select
              value={branchId ? String(branchId) : undefined}
              onValueChange={(v) => setBranchId(v)}
              disabled={readOnly}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("salesOrders.selectBranch")} />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.branchId} value={String(b.branchId)}>
                    {b.branch_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="orderDate">{t("salesOrders.orderDate")}</Label>
            <Input id="orderDate" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={readOnly} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shipDate">{t("salesOrders.expectedShipDate")}</Label>
            <Input id="shipDate" type="date" value={expectedShipDate} onChange={(e) => setExpectedShipDate(e.target.value)} disabled={readOnly} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="ref">{t("salesOrders.reference")}</Label>
            <Input id="ref" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} disabled={readOnly} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("salesOrders.lineItems")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!readOnly && (
            <ProductSelector
              products={products}
              onSelect={(p) => {
                if (items.some((i) => i.productId === p.productId)) return;
                setItems((prev) => [
                  ...prev,
                  {
                    id: `so-line-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                    productId: p.productId,
                    product_name: p.product_name,
                    product_sku: p.product_sku,
                    quantity: 1,
                    fulfilledQty: 0,
                    unitPrice: p.sellingPrice,
                    taxPercent: defaultTaxRate,
                    amount: p.sellingPrice * (1 + defaultTaxRate / 100),
                  },
                ]);
              }}
            />
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("salesOrders.item")}</TableHead>
                <TableHead className="w-24">{t("salesOrders.available")}</TableHead>
                <TableHead className="w-24">{t("salesOrders.qty")}</TableHead>
                <TableHead className="w-28">{t("salesOrders.unitPrice")}</TableHead>
                <TableHead className="w-20">{t("salesOrders.tax")}</TableHead>
                <TableHead className="w-28 text-end">{t("salesOrders.amount")}</TableHead>
                {!readOnly && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={readOnly ? 6 : 7} className="h-20 text-center text-muted-foreground">
                    {t("salesOrders.noItems")}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <p className="font-medium">{item.product_name}</p>
                      <p className="text-xs text-muted-foreground">{item.product_sku}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{branchStock(item.productId)}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) => updateItem(item.id, { quantity: Math.max(1, Number(e.target.value) || 0) })}
                        disabled={readOnly}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(e) => updateItem(item.id, { unitPrice: Math.max(0, Number(e.target.value) || 0) })}
                        disabled={readOnly}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        list="so-tax-codes"
                        value={item.taxPercent}
                        onChange={(e) => updateItem(item.id, { taxPercent: Math.max(0, Number(e.target.value) || 0) })}
                        disabled={readOnly}
                      />
                    </TableCell>
                    <TableCell className="text-end font-medium">{formatMoney(item.amount, settings.currency)}</TableCell>
                    {!readOnly && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
                          aria-label={t("common.delete")}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <datalist id="so-tax-codes">
            {taxCodes.map((tc) => (
              <option key={tc.id} value={tc.rate}>
                {tc.code} ({tc.rate}%)
              </option>
            ))}
          </datalist>

          <div className="ms-auto w-full max-w-xs space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("salesOrders.subtotal")}</span>
              <span>{formatMoney(totals.subtotal, settings.currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("salesOrders.totalTax")}</span>
              <span>{formatMoney(totals.totalTax, settings.currency)}</span>
            </div>
            <div className="flex justify-between border-t pt-2 text-base font-semibold">
              <span>{t("salesOrders.grandTotal")}</span>
              <span>{formatMoney(totals.grandTotal, settings.currency)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("salesOrders.notes")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="internal">{t("salesOrders.internalNotes")}</Label>
            <Textarea id="internal" value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} disabled={readOnly} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="terms">{t("salesOrders.terms")}</Label>
            <Textarea id="terms" value={terms} onChange={(e) => setTerms(e.target.value)} disabled={readOnly} />
          </div>
        </CardContent>
      </Card>

      {!readOnly && (
        <div className="flex justify-end gap-2">
          <SubmitButton
            type="button"
            variant="outline"
            pending={saveOrderAction.isPending}
            isSlow={saveOrderAction.isSlow}
            onClick={() => void saveOrderAction.run(false)}
          >
            <Save className="me-2 h-4 w-4" />
            {t("salesOrders.saveDraft")}
          </SubmitButton>
          <SubmitButton
            type="button"
            pending={saveOrderAction.isPending}
            isSlow={saveOrderAction.isSlow}
            onClick={() => void saveOrderAction.run(true)}
          >
            <CheckCircle className="me-2 h-4 w-4" />
            {t("salesOrders.saveAndConfirm")}
          </SubmitButton>
        </div>
      )}
    </div>
  );
};

export default SalesOrderForm;