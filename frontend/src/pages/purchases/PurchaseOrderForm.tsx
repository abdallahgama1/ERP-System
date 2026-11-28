import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Trash2, Save, Send, Download, Printer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { VendorCombobox } from "@/components/purchases/VendorCombobox";
import { ProductSelector } from "@/components/purchases/ProductSelector";
import { downloadPurchaseOrderPdf, printPurchaseOrder } from "@/lib/pdf/purchaseOrderPdf";
import type { Vendor, PurchaseOrder, PurchaseOrderItem, Product } from "@/types";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";

interface LineItem extends PurchaseOrderItem {
  tempId: string;
}

const generateTempId = () => `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// Monotonic counter for line item ids — avoids Date.now() collisions when the
// user adds multiple items inside the same millisecond.
let lineItemIdCounter = 1;
const nextLineItemId = () => `po-line-${lineItemIdCounter++}`;

const PurchaseOrderForm = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { orderId } = useParams();
  const { toast } = useToast();
  const { vendors, purchaseOrders, createPurchaseOrder, updatePurchaseOrder, nextPoNumber } = usePurchasingScope({ vendors: true, purchaseOrders: true, products: true });
  const { products } = useInventoryScope({ products: true });
  const { settings, taxCodes } = useSettings();
  const defaultTaxRate = useMemo(
    () => (taxCodes.find((tc) => tc.isDefault && tc.isActive) ?? taxCodes.find((tc) => tc.isActive))?.rate ?? 15,
    [taxCodes]
  );
  const isEditing = !!orderId;
  const existingPO = useMemo(
    () => (orderId ? purchaseOrders.find(p => p.id === orderId) : undefined),
    [orderId, purchaseOrders]
  );

  // Form state
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [orderDate, setOrderDate] = useState(new Date().toISOString().split("T")[0]);
  const [expectedDate, setExpectedDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [isLocked, setIsLocked] = useState(false);
  const [poNumber, setPoNumber] = useState<string>("");

  // Load existing PO or generate a new PO number once
  useEffect(() => {
    if (existingPO) {
      setPoNumber(existingPO.poNumber);
      setSelectedVendor(vendors.find(v => v.id === existingPO.vendorId) ?? {
        id: existingPO.vendorId,
        displayName: existingPO.vendorName,
        currency: 'USD',
        paymentTerms: 'NET30',
        payablesBalance: 0,
        createdAt: existingPO.createdAt,
        updatedAt: existingPO.updatedAt,
      });
      setOrderDate(existingPO.orderDate);
      setExpectedDate(existingPO.expectedDate);
      setReferenceNumber(existingPO.referenceNumber ?? "");
      setInternalNotes(existingPO.internalNotes ?? "");
      setTermsAndConditions(existingPO.termsAndConditions ?? "");
      setLineItems(existingPO.items.map(item => ({ ...item, tempId: generateTempId() })));
      setIsLocked(existingPO.status !== "Draft");
    } else if (!poNumber) {
      setPoNumber(nextPoNumber());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingPO]);

  // Real-time calculations
  const calculations = useMemo(() => {
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    const totalTax = lineItems.reduce(
      (sum, item) => sum + (item.amount * item.taxPercent) / 100,
      0
    );
    const grandTotal = subtotal + totalTax;
    return { subtotal, totalTax, grandTotal };
  }, [lineItems]);

  // Handle adding product from selector
  // Functional updater keeps deps stable so the callback identity doesn't
  // change every time a line item is added.
  const handleAddProduct = useCallback((product: Product) => {
    setLineItems((prev) => {
      if (prev.some((item) => item.productId === product.productId)) {
        toast({
          title: t("purchaseOrders.productAlreadyAdded"),
          variant: "destructive",
        });
        return prev;
      }
      const newItem: LineItem = {
        tempId: generateTempId(),
        id: nextLineItemId(),
        productId: product.productId,
        product_name: product.product_name,
        product_sku: product.product_sku,
        quantity: 1,
        receivedQty: 0,
        unitPrice: product.costPrice,
        taxPercent: defaultTaxRate,
        amount: product.costPrice,
      };
      return [...prev, newItem];
    });
  }, [defaultTaxRate, t, toast]);

  // Handle line item updates
  const handleUpdateLineItem = useCallback(
    (tempId: string, field: keyof LineItem, value: number) => {
      setLineItems((prev) =>
        prev.map((item) => {
          if (item.tempId !== tempId) return item;

          const updated = { ...item, [field]: value };
          // Recalculate amount when quantity or price changes
          if (field === "quantity" || field === "unitPrice") {
            updated.amount = updated.quantity * updated.unitPrice;
          }
          return updated;
        })
      );
    },
    []
  );

  // Handle removing line item
  const handleRemoveLineItem = useCallback((tempId: string) => {
    setLineItems((prev) => prev.filter((item) => item.tempId !== tempId));
  }, []);

  const saveDraftAction = useIdempotentAction(async () => {
    if (!selectedVendor) {
      toast({
        title: t("purchaseOrders.vendorRequired"),
        variant: "destructive",
      });
      return;
    }

    if (lineItems.length === 0) {
      toast({
        title: t("purchaseOrders.itemsRequired"),
        variant: "destructive",
      });
      return;
    }

    const ok = await persistPO("Draft");
    if (!ok) return { ok: false };
    toast({ title: t("purchaseOrders.savedAsDraft") });
    navigate("/purchases/orders");
    return { ok: true };
  });

  const issuePoAction = useIdempotentAction(async () => {
    if (!selectedVendor) {
      toast({
        title: t("purchaseOrders.vendorRequired"),
        variant: "destructive",
      });
      return;
    }

    if (lineItems.length === 0) {
      toast({
        title: t("purchaseOrders.itemsRequired"),
        variant: "destructive",
      });
      return;
    }

    if (!expectedDate) {
      toast({
        title: t("purchaseOrders.expectedDateRequired"),
        variant: "destructive",
      });
      return;
    }

    if (expectedDate < orderDate) {
      toast({
        title: t("purchaseOrders.expectedBeforeOrder", "Expected date must be on or after the order date"),
        variant: "destructive",
      });
      return;
    }

    const invalidLine = lineItems.find(
      i => !i.productId || i.quantity <= 0 || i.unitPrice < 0 || i.taxPercent < 0 || i.taxPercent > 100
    );
    if (invalidLine) {
      toast({
        title: t("purchaseOrders.invalidLineItems", "Line items must have a product, quantity > 0, and non-negative price"),
        variant: "destructive",
      });
      return;
    }

    const ok = await persistPO("Issued");
    if (!ok) return { ok: false };
    setIsLocked(true);
    toast({ title: t("purchaseOrders.issued") });
    return { ok: true };
  });

  const persistPO = async (status: PurchaseOrder["status"]): Promise<boolean> => {
    if (!selectedVendor) return false;
    const payload = {
      poNumber,
      vendorId: selectedVendor.id,
      vendorName: selectedVendor.displayName,
      orderDate,
      expectedDate,
      referenceNumber,
      status,
      items: lineItems.map(({ tempId, ...item }) => item),
      subtotal: calculations.subtotal,
      totalTax: calculations.totalTax,
      grandTotal: calculations.grandTotal,
      internalNotes,
      termsAndConditions,
    };
    if (existingPO) {
      const res = await updatePurchaseOrder(existingPO.id, payload);
      if (res.ok === false) {
        toast({ title: res.error, variant: "destructive" });
        return false;
      }
      return true;
    } else {
      const res = await createPurchaseOrder(payload);
      if (res.ok === false) {
        toast({ title: res.error, variant: "destructive" });
        return false;
      }
      return true;
    }
  };

  // Build current PO object for PDF
  const currentPO: PurchaseOrder = useMemo(() => ({
    id: existingPO?.id ?? "",
    poNumber,
    vendorId: selectedVendor?.id ?? "",
    vendorName: selectedVendor?.displayName ?? "",
    orderDate,
    expectedDate,
    referenceNumber,
    status: isLocked ? "Issued" : "Draft",
    items: lineItems.map(({ tempId, ...item }) => item),
    subtotal: calculations.subtotal,
    totalTax: calculations.totalTax,
    grandTotal: calculations.grandTotal,
    internalNotes,
    termsAndConditions,
    createdAt: existingPO?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }), [
    existingPO, poNumber, selectedVendor, orderDate, expectedDate, referenceNumber,
    isLocked, lineItems, calculations, internalNotes, termsAndConditions
  ]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/purchases/orders")}>
            <ArrowLeft className="me-2 h-4 w-4" />
            {t("common.back")}
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {isEditing ? t("purchaseOrders.editPO") : t("purchaseOrders.createPO")}
            </h1>
            <p className="text-muted-foreground">{poNumber}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {isLocked && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Download className="me-2 h-4 w-4" />
                  {t("purchaseOrders.export")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => downloadPurchaseOrderPdf(currentPO, settings.currency)}>
                  <Download className="me-2 h-4 w-4" />
                  {t("purchaseOrders.downloadPdf")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => printPurchaseOrder(currentPO, settings.currency)}>
                  <Printer className="me-2 h-4 w-4" />
                  {t("purchaseOrders.print")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <SubmitButton
            type="button"
            variant="outline"
            pending={saveDraftAction.isPending}
            isSlow={saveDraftAction.isSlow}
            onClick={() => void saveDraftAction.run()}
            disabled={isLocked || issuePoAction.isPending}
          >
            <Save className="me-2 h-4 w-4" />
            {t("purchaseOrders.saveDraft")}
          </SubmitButton>
          <SubmitButton
            type="button"
            pending={issuePoAction.isPending}
            isSlow={issuePoAction.isSlow}
            onClick={() => void issuePoAction.run()}
            disabled={isLocked || saveDraftAction.isPending}
          >
            <Send className="me-2 h-4 w-4" />
            {t("purchaseOrders.issuePO")}
          </SubmitButton>
        </div>
      </div>

      {/* Header Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("purchaseOrders.orderDetails")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label>{t("purchaseOrders.vendor")} *</Label>
              <VendorCombobox
                vendors={vendors}
                value={selectedVendor?.id ?? null}
                onSelect={setSelectedVendor}
                disabled={isLocked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="orderDate">{t("purchaseOrders.orderDate")}</Label>
              <Input
                id="orderDate"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
                disabled={isLocked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expectedDate">{t("purchaseOrders.expectedDate")} *</Label>
              <Input
                id="expectedDate"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                disabled={isLocked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="referenceNumber">{t("purchaseOrders.referenceNumber")}</Label>
              <Input
                id="referenceNumber"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder={t("purchaseOrders.referencePlaceholder")}
                disabled={isLocked}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Line Items Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t("purchaseOrders.lineItems")}</CardTitle>
            {!isLocked && (
              <div className="w-80">
                <ProductSelector
                  products={products}
                  onSelect={handleAddProduct}
                  disabled={isLocked}
                />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {lineItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground">
                {t("purchaseOrders.noLineItems")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("purchaseOrders.searchToAdd")}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">{t("purchaseOrders.itemDetails")}</TableHead>
                  <TableHead className="w-[100px]">{t("purchaseOrders.quantity")}</TableHead>
                  <TableHead className="w-[120px]">{t("purchaseOrders.unitPrice")}</TableHead>
                  <TableHead className="w-[100px]">{t("purchaseOrders.taxPercent")}</TableHead>
                  <TableHead className="w-[120px] text-end">{t("purchaseOrders.amount")}</TableHead>
                  {!isLocked && <TableHead className="w-[60px]"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineItems.map((item) => (
                  <TableRow key={item.tempId}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{item.product_name}</p>
                        <p className="text-sm text-muted-foreground">{item.product_sku}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) =>
                          handleUpdateLineItem(item.tempId, "quantity", parseInt(e.target.value) || 1)
                        }
                        className="w-20"
                        disabled={isLocked}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step={0.01}
                        value={item.unitPrice}
                        onChange={(e) =>
                          handleUpdateLineItem(item.tempId, "unitPrice", parseFloat(e.target.value) || 0)
                        }
                        className="w-24"
                        disabled={isLocked}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        list="po-tax-codes"
                        value={item.taxPercent}
                        onChange={(e) =>
                          handleUpdateLineItem(item.tempId, "taxPercent", parseFloat(e.target.value) || 0)
                        }
                        className="w-20"
                        disabled={isLocked}
                      />
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatMoney(item.amount, settings.currency)}
                    </TableCell>
                    {!isLocked && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveLineItem(item.tempId)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Totals */}
          {lineItems.length > 0 && (
            <>
              <datalist id="po-tax-codes">
                {taxCodes.map((tc) => (
                  <option key={tc.id} value={tc.rate}>
                    {tc.code} ({tc.rate}%)
                  </option>
                ))}
              </datalist>
              <Separator className="my-4" />
              <div className="flex justify-end">
                <div className="w-64 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t("purchaseOrders.subtotal")}</span>
                    <span>{formatMoney(calculations.subtotal, settings.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t("purchaseOrders.totalTax")}</span>
                    <span>{formatMoney(calculations.totalTax, settings.currency)}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between font-semibold">
                    <span>{t("purchaseOrders.grandTotal")}</span>
                    <span>{formatMoney(calculations.grandTotal, settings.currency)}</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Notes Section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("purchaseOrders.notes")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="internalNotes">{t("purchaseOrders.internalNotes")}</Label>
              <Textarea
                id="internalNotes"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                placeholder={t("purchaseOrders.internalNotesPlaceholder")}
                rows={4}
                disabled={isLocked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="termsAndConditions">{t("purchaseOrders.termsAndConditions")}</Label>
              <Textarea
                id="termsAndConditions"
                value={termsAndConditions}
                onChange={(e) => setTermsAndConditions(e.target.value)}
                placeholder={t("purchaseOrders.termsPlaceholder")}
                rows={4}
                disabled={isLocked}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PurchaseOrderForm;
