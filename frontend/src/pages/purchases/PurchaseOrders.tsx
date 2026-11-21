import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Plus, Search, Eye, Edit, Trash2, FileText, Download, Printer, Ban } from "lucide-react";
import { TablePagination } from "@/components/TablePagination";
import { usePurchaseOrdersPageQuery } from "@/hooks/queries/usePurchasingQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { downloadPurchaseOrderPdf, printPurchaseOrder } from "@/lib/pdf/purchaseOrderPdf";
import type { PurchaseOrder, PurchaseOrderStatus } from "@/types";
import { useBranch } from "@/contexts/BranchContext";
import { useInventory } from "@/contexts/InventoryContext";
import { usePurchases } from "@/contexts/PurchasesContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";

const PurchaseOrders = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettings();
  const { activeBranchId } = useBranch();
  const { products, branches } = useInventory();
  const { purchaseOrders, vendors, deletePurchaseOrder, cancelPurchaseOrder } = usePurchases();
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [deletePoId, setDeletePoId] = useState<string | null>(null);

  const { data: purchaseOrdersPage } = usePurchaseOrdersPageQuery({
    page,
    pageSize: 25,
    q: searchTerm,
    branchId: activeBranchId,
  });

  const vendorMap = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const branchMap = useMemo(() => new Map(branches.map((b) => [b.branchId, b])), [branches]);
  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);

  const filteredOrders = useMemo<PurchaseOrder[]>(
    () =>
      (purchaseOrdersPage?.purchaseOrders ?? []).map((po) => ({
        id: po.id,
        poNumber: po.poNumber,
        vendorId: po.vendorId,
        vendorName: vendorMap.get(po.vendorId)?.displayName ?? "",
        branchId: po.branchId,
        branchName: branchMap.get(po.branchId)?.branch_name ?? "",
        orderDate: po.orderDate.slice(0, 10),
        expectedDate: (po.expectedDate ?? po.orderDate).slice(0, 10),
        status: po.status,
        subtotal: po.subtotal,
        totalTax: po.taxTotal,
        grandTotal: po.totalAmount,
        internalNotes: po.notes || undefined,
        createdAt: po.createdAt,
        updatedAt: po.updatedAt,
        items: (po.lines ?? []).map((l) => {
          const p = productMap.get(l.productId);
          return {
            id: l.id,
            productId: l.productId,
            product_name: p?.product_name ?? "",
            product_sku: p?.product_sku ?? "",
            quantity: l.quantity,
            receivedQty: l.receivedQty,
            unitPrice: l.unitCost,
            taxPercent: l.taxRate,
            amount: l.lineTotal,
          };
        }),
      })),
    [purchaseOrdersPage, vendorMap, branchMap, productMap]
  );

  const getStatusBadgeVariant = (status: PurchaseOrderStatus) => {
    switch (status) {
      case "Draft":
        return "secondary";
      case "Issued":
        return "default";
      case "Partially Received":
        return "outline";
      case "Closed":
        return "default";
      case "Cancelled":
        return "destructive";
      default:
        return "secondary";
    }
  };

  const getStatusClassName = (status: PurchaseOrderStatus) => {
    switch (status) {
      case "Draft":
        return "bg-muted text-muted-foreground";
      case "Issued":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
      case "Partially Received":
        return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300";
      case "Closed":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
      case "Cancelled":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
      default:
        return "";
    }
  };

  const handleConfirmDelete = async () => {
    if (deletePoId) {
      const res = await deletePurchaseOrder(deletePoId);
      if (res.ok === false) toast({ title: res.error, variant: "destructive" });
      else toast({ title: t("purchaseOrders.deleted") });
      setDeletePoId(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("purchaseOrders.title")}</h1>
          <p className="text-muted-foreground">{t("purchaseOrders.description")}</p>
        </div>
        <Button asChild>
          <Link to="/purchases/orders/new">
            <Plus className="me-2 h-4 w-4" />
            {t("purchaseOrders.createPO")}
          </Link>
        </Button>
      </div>

      {purchaseOrders.length === 0 && (purchaseOrdersPage?.pageInfo?.total ?? 0) === 0 && !searchTerm.trim() ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <FileText className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="mt-6 text-xl font-semibold">{t("purchaseOrders.noOrders")}</h3>
          <p className="mt-2 text-center text-muted-foreground max-w-sm">
            {t("purchaseOrders.noOrdersDescription")}
          </p>
          <Button className="mt-6" asChild>
            <Link to="/purchases/orders/new">
              <Plus className="me-2 h-4 w-4" />
              {t("purchaseOrders.createFirstPO")}
            </Link>
          </Button>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t("purchaseOrders.allOrders")}</CardTitle>
              <div className="relative w-72">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("purchaseOrders.searchPlaceholder")}
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
                  <TableHead>{t("purchaseOrders.poNumber")}</TableHead>
                  <TableHead>{t("purchaseOrders.vendor")}</TableHead>
                  <TableHead>{t("purchaseOrders.orderDate")}</TableHead>
                  <TableHead>{t("purchaseOrders.expectedDate")}</TableHead>
                  <TableHead className="text-end">{t("purchaseOrders.totalAmount")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      {t("purchaseOrders.noResults")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredOrders.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell className="font-medium">{po.poNumber}</TableCell>
                      <TableCell>{po.vendorName}</TableCell>
                      <TableCell>{formatDate(po.orderDate)}</TableCell>
                      <TableCell>{formatDate(po.expectedDate)}</TableCell>
                      <TableCell className="text-end font-medium">
                        {formatMoney(po.grandTotal, settings.currency)}
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusClassName(po.status)}>
                          {t(`purchaseOrders.statuses.${po.status.toLowerCase().split(' ').join('_')}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            asChild
                            title={t("common.view")}
                          >
                            <Link to={`/purchases/orders/${po.id}`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                          {po.status !== "Draft" && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title={t("purchaseOrders.export")}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => downloadPurchaseOrderPdf(po, settings.currency)}>
                                  <Download className="me-2 h-4 w-4" />
                                  {t("purchaseOrders.downloadPdf")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => printPurchaseOrder(po, settings.currency)}>
                                  <Printer className="me-2 h-4 w-4" />
                                  {t("purchaseOrders.print")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                          {po.status === "Draft" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              asChild
                              title={t("common.edit")}
                            >
                              <Link to={`/purchases/orders/${po.id}/edit`}>
                                <Edit className="h-4 w-4" />
                              </Link>
                            </Button>
                          )}
                          {po.status === "Draft" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeletePoId(po.id)}
                              title={t("common.delete")}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                          {po.status === "Issued" && po.items.every((i) => i.receivedQty === 0) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={async () => {
                                const res = await cancelPurchaseOrder(po.id);
                                if (res.ok === false) toast({ title: res.error, variant: "destructive" });
                                else toast({ title: t("purchaseOrders.cancelled", "Purchase order cancelled") });
                              }}
                              title={t("common.cancel")}
                            >
                              <Ban className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <TablePagination pageInfo={purchaseOrdersPage?.pageInfo} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <ConfirmDeleteDialog
        open={deletePoId !== null}
        onOpenChange={(open) => !open && setDeletePoId(null)}
        onConfirm={handleConfirmDelete}
        itemName={purchaseOrders.find((po) => po.id === deletePoId)?.poNumber}
      />
    </div>
  );
};

export default PurchaseOrders;
