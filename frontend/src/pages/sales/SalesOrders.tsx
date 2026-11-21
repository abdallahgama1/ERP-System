import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Plus, Search, Eye, Edit, Trash2, ShoppingCart, Truck, CheckCircle, XCircle } from "lucide-react";
import { TablePagination } from "@/components/TablePagination";
import { useSalesOrdersPageQuery } from "@/hooks/queries/useSalesQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useBranch } from "@/contexts/BranchContext";
import { useSales } from "@/contexts/SalesContext";
import { useInventory } from "@/contexts/InventoryContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import type { SalesOrder, SalesOrderStatus } from "@/types";

const statusClass = (status: SalesOrderStatus) => {
  switch (status) {
    case "Draft":
      return "bg-muted text-muted-foreground";
    case "Confirmed":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
    case "Partially Fulfilled":
      return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300";
    case "Fulfilled":
    case "Closed":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
    case "Cancelled":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
    default:
      return "";
  }
};

export default function SalesOrders() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettings();
  const { activeBranchId } = useBranch();
  const { salesOrders, customers, deleteSalesOrder, confirmSalesOrder, cancelSalesOrder, fulfillSalesOrder } = useSales();
  const { branchProducts, products, branches } = useInventory();
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [fulfillId, setFulfillId] = useState<string | null>(null);
  const [shipQty, setShipQty] = useState<Record<string, number>>({});

  const { data: salesOrdersPage } = useSalesOrdersPageQuery({
    page,
    pageSize: 25,
    q: searchTerm,
    branchId: activeBranchId,
  });

  const customerMap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const branchMap = useMemo(() => new Map(branches.map((b) => [b.branchId, b])), [branches]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);

  const filtered = useMemo<SalesOrder[]>(
    () =>
      (salesOrdersPage?.salesOrders ?? []).map((so) => ({
        id: so.id,
        soNumber: so.soNumber,
        customerId: so.customerId,
        customerName: customerMap.get(so.customerId)?.displayName ?? "",
        branchId: so.branchId,
        branchName: branchMap.get(so.branchId)?.branch_name ?? "",
        orderDate: so.orderDate.slice(0, 10),
        expectedShipDate: (so.expectedShipmentDate ?? so.orderDate).slice(0, 10),
        status: so.status,
        subtotal: so.subtotal,
        totalTax: so.taxTotal,
        grandTotal: so.totalAmount,
        internalNotes: so.notes || undefined,
        createdAt: so.createdAt,
        updatedAt: so.updatedAt,
        items: (so.lines ?? []).map((l) => {
          const p = productMap.get(l.productId);
          return {
            id: l.id,
            productId: l.productId,
            product_name: p?.product_name ?? "",
            product_sku: p?.product_sku ?? "",
            quantity: l.quantity,
            fulfilledQty: l.invoicedQty,
            unitPrice: l.unitPrice,
            taxPercent: l.taxRate,
            amount: l.lineTotal,
          };
        }),
      })),
    [salesOrdersPage, customerMap, branchMap, productMap]
  );

  const fulfillOrder = salesOrders.find((o) => o.id === fulfillId);

  const openFulfill = (id: string) => {
    const order = salesOrders.find((o) => o.id === id);
    if (!order) return;
    const defaults: Record<string, number> = {};
    for (const item of order.items) {
      const stock = branchProducts.find((bp) => bp.productId === item.productId && bp.branchId === order.branchId)?.quantity ?? 0;
      defaults[item.id] = Math.max(0, Math.min(item.quantity - item.fulfilledQty, stock));
    }
    setShipQty(defaults);
    setFulfillId(id);
  };

  const submitFulfill = async () => {
    if (!fulfillOrder) return;
    const res = await fulfillSalesOrder(fulfillOrder.id, Object.entries(shipQty).map(([itemId, qty]) => ({ itemId, qty })));
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({ title: t("salesOrders.fulfilled") });
    setFulfillId(null);
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("salesOrders.title")}</h1>
          <p className="text-muted-foreground">{t("salesOrders.description")}</p>
        </div>
        <Button asChild>
          <Link to="/sales/orders/new">
            <Plus className="me-2 h-4 w-4" />
            {t("salesOrders.createSO")}
          </Link>
        </Button>
      </div>

      {salesOrders.length === 0 && (salesOrdersPage?.pageInfo?.total ?? 0) === 0 && !searchTerm.trim() ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <ShoppingCart className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="mt-6 text-xl font-semibold">{t("salesOrders.noOrders")}</h3>
          <p className="mt-2 max-w-sm text-center text-muted-foreground">{t("salesOrders.noOrdersDescription")}</p>
          <Button className="mt-6" asChild>
            <Link to="/sales/orders/new">
              <Plus className="me-2 h-4 w-4" />
              {t("salesOrders.createFirstSO")}
            </Link>
          </Button>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t("salesOrders.allOrders")}</CardTitle>
              <div className="relative w-72">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("salesOrders.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setPage(1);
                  }}
                  className="ps-9"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("salesOrders.soNumber")}</TableHead>
                  <TableHead>{t("salesOrders.customer")}</TableHead>
                  <TableHead>{t("salesOrders.orderDate")}</TableHead>
                  <TableHead>{t("salesOrders.shipFromBranch")}</TableHead>
                  <TableHead className="text-end">{t("salesOrders.grandTotal")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      {t("salesOrders.noResults")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.soNumber}</TableCell>
                      <TableCell>{o.customerName}</TableCell>
                      <TableCell>{formatDate(o.orderDate)}</TableCell>
                      <TableCell>{o.branchName}</TableCell>
                      <TableCell className="text-end font-medium">{formatMoney(o.grandTotal, settings.currency)}</TableCell>
                      <TableCell>
                        <Badge className={statusClass(o.status)}>
                          {t(`salesOrders.statuses.${o.status.toLowerCase().split(" ").join("_")}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" asChild title={t("common.view")}>
                            <Link to={`/sales/orders/${o.id}`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                          {o.status === "Draft" && (
                            <>
                              <Button variant="ghost" size="icon" asChild title={t("common.edit")}>
                                <Link to={`/sales/orders/${o.id}/edit`}>
                                  <Edit className="h-4 w-4" />
                                </Link>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("salesOrders.confirm")}
                                onClick={async () => {
                                  const res = await confirmSalesOrder(o.id);
                                  if (res.ok === false) toast({ title: res.error, variant: "destructive" });
                                  else toast({ title: t("salesOrders.confirmed") });
                                }}
                              >
                                <CheckCircle className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="icon" title={t("common.delete")} onClick={() => setDeleteId(o.id)}>
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </>
                          )}
                          {(o.status === "Confirmed" || o.status === "Partially Fulfilled") && (
                            <Button variant="ghost" size="icon" title={t("salesOrders.fulfill")} onClick={() => openFulfill(o.id)}>
                              <Truck className="h-4 w-4" />
                            </Button>
                          )}
                          {o.status === "Confirmed" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("salesOrders.cancel")}
                              onClick={async () => {
                                const res = await cancelSalesOrder(o.id);
                                if (res.ok === false) toast({ title: res.error, variant: "destructive" });
                              }}
                            >
                              <XCircle className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <TablePagination pageInfo={salesOrdersPage?.pageInfo} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <Dialog open={fulfillId !== null} onOpenChange={(open) => !open && setFulfillId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("salesOrders.fulfillTitle", { number: fulfillOrder?.soNumber ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("salesOrders.fulfillDescription", { branch: fulfillOrder?.branchName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {fulfillOrder?.items.map((item) => {
              const stock =
                branchProducts.find((bp) => bp.productId === item.productId && bp.branchId === fulfillOrder.branchId)?.quantity ?? 0;
              const remaining = item.quantity - item.fulfilledQty;
              return (
                <div key={item.id} className="flex items-end gap-3 rounded-md border p-3">
                  <div className="flex-1">
                    <p className="font-medium">{item.product_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("salesOrders.remaining")}: {remaining} • {t("salesOrders.available")}: {stock}
                    </p>
                  </div>
                  <div className="w-28 space-y-1">
                    <Label htmlFor={`ship-${item.id}`} className="text-xs">
                      {t("salesOrders.shipNow")}
                    </Label>
                    <Input
                      id={`ship-${item.id}`}
                      type="number"
                      min={0}
                      max={Math.min(remaining, stock)}
                      value={shipQty[item.id] ?? 0}
                      onChange={(e) =>
                        setShipQty((prev) => ({
                          ...prev,
                          [item.id]: Math.max(0, Math.min(Math.min(remaining, stock), Number(e.target.value) || 0)),
                        }))
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFulfillId(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitFulfill}>{t("salesOrders.confirmShipment")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={async () => {
          if (deleteId) {
            const res = await deleteSalesOrder(deleteId);
            if (res.ok === false) toast({ title: res.error, variant: "destructive" });
            else toast({ title: t("salesOrders.deleted", "Sales order deleted") });
          }
          setDeleteId(null);
        }}
        itemName={salesOrders.find((o) => o.id === deleteId)?.soNumber}
      />
    </div>
  );
}