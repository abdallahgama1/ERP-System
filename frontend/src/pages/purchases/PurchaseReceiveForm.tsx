import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Save, Package, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import type { PurchaseOrder, PurchaseOrderItem, Branch } from "@/types";

interface ReceiveLineItem extends PurchaseOrderItem {
  receivingNow: number;
  remainingQty: number;
  lotNumber?: string;
  expiryDate?: string;
  serialsInput?: string;
}

const PurchaseReceiveForm = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { branches, products } = useInventoryScope({ products: true });
  const { purchaseOrders, addReceive, nextReceiveNumber } = usePurchasingScope({ purchaseOrders: true, receives: true, vendors: true, products: true });
  const productById = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);

  const poId = searchParams.get("poId");

  // Find the PO
  const purchaseOrder = useMemo(() => {
    return purchaseOrders.find((po) => po.id === poId);
  }, [poId, purchaseOrders]);

  // Form state
  const [selectedBranchId, setSelectedBranchId] = useState<string>(
    branches[0]?.branchId.toString() || ""
  );
  const [receiveDate, setReceiveDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [lineItems, setLineItems] = useState<ReceiveLineItem[]>([]);

  // Initialize line items from PO
  useEffect(() => {
    if (purchaseOrder) {
      const items: ReceiveLineItem[] = purchaseOrder.items.map((item) => {
        const remaining = item.quantity - item.receivedQty;
        return {
          ...item,
          remainingQty: remaining,
          receivingNow: remaining, // Default to receiving all remaining
        };
      });
      setLineItems(items);
    }
  }, [purchaseOrder]);

  // Generate receive number once on mount
  const [receiveNumber] = useState<string>(() => nextReceiveNumber());

  // Get selected branch
  const selectedBranch = useMemo(() => {
    return branches.find((b) => b.branchId === selectedBranchId);
  }, [selectedBranchId, branches]);

  // Handle quantity update
  const handleQuantityChange = (itemId: string, value: number) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        // Clamp value between 0 and remaining
        const clampedValue = Math.max(0, Math.min(value, item.remainingQty));
        return { ...item, receivingNow: clampedValue };
      })
    );
  };

  // Check if any items are being received
  const hasItemsToReceive = lineItems.some((item) => item.receivingNow > 0);

  // Calculate totals
  const totalItemsReceiving = lineItems.reduce((sum, item) => sum + item.receivingNow, 0);

  // Handle submit
  const handleSubmit = async () => {
    if (!selectedBranchId) {
      toast({
        title: t("purchaseReceives.branchRequired"),
        variant: "destructive",
      });
      return;
    }

    if (!hasItemsToReceive) {
      toast({
        title: t("purchaseReceives.noItemsToReceive"),
        variant: "destructive",
      });
      return;
    }

    const res = await addReceive({
      receiveNumber,
      purchaseOrderId: purchaseOrder!.id,
      poNumber: purchaseOrder!.poNumber,
      vendorId: purchaseOrder!.vendorId,
      vendorName: purchaseOrder!.vendorName,
      branchId: selectedBranchId,
      branchName: selectedBranch?.branch_name ?? "",
      receiveDate,
      notes,
      items: lineItems
        .filter(i => i.receivingNow > 0)
        .map(i => {
          const serialNumbers = (i.serialsInput ?? "")
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          return {
            id: i.id,
            productId: i.productId,
            product_name: i.product_name,
            product_sku: i.product_sku,
            orderedQty: i.quantity,
            previouslyReceivedQty: i.receivedQty,
            receivingNow: i.receivingNow,
            unitPrice: i.unitPrice,
            lotNumber: i.lotNumber?.trim() || undefined,
            expiryDate: i.expiryDate || undefined,
            serialNumbers: serialNumbers.length > 0 ? serialNumbers : undefined,
          };
        }),
    });

    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }

    // Determine if fully received or partially received
    const allFullyReceived = lineItems.every(
      (item) => item.receivingNow === item.remainingQty
    );

    toast({
      title: t("purchaseReceives.received"),
      description: allFullyReceived
        ? t("purchaseReceives.poFullyReceived")
        : t("purchaseReceives.poPartiallyReceived"),
    });

    navigate("/purchases/receives");
  };

  if (!purchaseOrder) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h2 className="mt-4 text-xl font-semibold">{t("purchaseReceives.poNotFound")}</h2>
        <Button className="mt-4" onClick={() => navigate("/purchases/receives")}>
          <ArrowLeft className="me-2 h-4 w-4" />
          {t("common.back")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/purchases/receives")}>
            <ArrowLeft className="me-2 h-4 w-4" />
            {t("common.back")}
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {t("purchaseReceives.receiveItems")}
            </h1>
            <p className="text-muted-foreground">{receiveNumber}</p>
          </div>
        </div>
        <Button onClick={handleSubmit} disabled={!hasItemsToReceive}>
          <Check className="me-2 h-4 w-4" />
          {t("purchaseReceives.confirmReceive")}
        </Button>
      </div>

      {/* PO Info */}
      <Card>
        <CardHeader>
          <CardTitle>{t("purchaseReceives.orderInfo")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label className="text-muted-foreground">{t("purchaseOrders.poNumber")}</Label>
              <p className="font-medium">{purchaseOrder.poNumber}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">{t("purchaseOrders.vendor")}</Label>
              <p className="font-medium">{purchaseOrder.vendorName}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">{t("purchaseOrders.orderDate")}</Label>
              <p className="font-medium">{new Date(purchaseOrder.orderDate).toLocaleDateString()}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">{t("common.status")}</Label>
              <Badge
                className={
                  purchaseOrder.status === "Issued"
                    ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
                    : "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
                }
              >
                {t(`purchaseOrders.statuses.${purchaseOrder.status.toLowerCase().split(' ').join('_')}`)}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Receive Details */}
      <Card>
        <CardHeader>
          <CardTitle>{t("purchaseReceives.receiveDetails")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="branch">{t("purchaseReceives.destinationBranch")} *</Label>
              <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                <SelectTrigger id="branch">
                  <SelectValue placeholder={t("purchaseReceives.selectBranch")} />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.branchId} value={branch.branchId.toString()}>
                      {branch.branch_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {t("purchaseReceives.branchHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="receiveDate">{t("purchaseReceives.receiveDate")}</Label>
              <Input
                id="receiveDate"
                type="date"
                value={receiveDate}
                onChange={(e) => setReceiveDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">{t("purchaseReceives.notes")}</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("purchaseReceives.notesPlaceholder")}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Items to Receive */}
      <Card>
        <CardHeader>
          <CardTitle>{t("purchaseReceives.itemsToReceive")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[300px]">{t("purchaseOrders.itemDetails")}</TableHead>
                <TableHead className="text-center">{t("purchaseReceives.orderedQty")}</TableHead>
                <TableHead className="text-center">{t("purchaseReceives.previouslyReceived")}</TableHead>
                <TableHead className="text-center">{t("purchaseReceives.remainingQty")}</TableHead>
                <TableHead className="w-[150px]">{t("purchaseReceives.receivingNow")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{item.product_name}</p>
                      <p className="text-sm text-muted-foreground">{item.product_sku}</p>
                      {productById.get(item.productId)?.trackingMode === "lot" && (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <Input
                            placeholder={t("tracking.lots.lotNumber", "Lot #")}
                            value={item.lotNumber ?? ""}
                            onChange={(e) =>
                              setLineItems((prev) =>
                                prev.map((li) => (li.id === item.id ? { ...li, lotNumber: e.target.value } : li))
                              )
                            }
                            className="h-8 text-xs"
                          />
                          <Input
                            type="date"
                            value={item.expiryDate ?? ""}
                            onChange={(e) =>
                              setLineItems((prev) =>
                                prev.map((li) => (li.id === item.id ? { ...li, expiryDate: e.target.value } : li))
                              )
                            }
                            className="h-8 text-xs"
                          />
                        </div>
                      )}
                      {productById.get(item.productId)?.trackingMode === "serial" && (
                        <div className="mt-2">
                          <Input
                            placeholder={t("tracking.serials.serialNumbers", "Scan/enter serials (comma separated)")}
                            value={item.serialsInput ?? ""}
                            onChange={(e) =>
                              setLineItems((prev) =>
                                prev.map((li) => (li.id === item.id ? { ...li, serialsInput: e.target.value } : li))
                              )
                            }
                            className="h-8 text-xs font-mono"
                          />
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-medium">{item.quantity}</TableCell>
                  <TableCell className="text-center">
                    {item.receivedQty > 0 ? (
                      <Badge variant="secondary">{item.receivedQty}</Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge
                      variant={item.remainingQty > 0 ? "outline" : "secondary"}
                      className={item.remainingQty > 0 ? "border-orange-500 text-orange-600" : ""}
                    >
                      {item.remainingQty}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={item.remainingQty}
                      value={item.receivingNow}
                      onChange={(e) =>
                        handleQuantityChange(item.id, parseInt(e.target.value) || 0)
                      }
                      className="w-24"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Separator className="my-4" />

          {/* Summary */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Package className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t("purchaseReceives.totalReceiving")}:
              </span>
              <Badge variant="default" className="text-lg px-3 py-1">
                {totalItemsReceiving} {t("purchaseReceives.units")}
              </Badge>
            </div>
            {selectedBranch && (
              <div className="text-sm text-muted-foreground">
                {t("purchaseReceives.receivingTo")}: <span className="font-medium">{selectedBranch.branch_name}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PurchaseReceiveForm;
