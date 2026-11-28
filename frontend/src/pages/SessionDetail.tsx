import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Package,
  ClipboardList,
  Edit,
  Trash2,
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { SessionItem, Product } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useSessionsScope } from "@/hooks/queries/useSessionsScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { ScannerInput } from "@/components/session/ScannerInput";
import { ScannedProductDisplay } from "@/components/session/ScannedProductDisplay";
import { useIsMobile } from "@/hooks/use-mobile";

const SessionDetail = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { can } = usePermissions();
  const { sessionId } = useParams();
  const resolvedSessionId = sessionId ?? "";
  const { products, branchProducts, branches } = useInventoryScope({ products: true });
  const {
    getSession,
    getSessionItems,
    upsertSessionItemCount,
    removeSessionItem,
    completeSession,
  } = useSessionsScope({ includeProducts: true });
  const isMobile = useIsMobile();
  const { toast } = useToast();

  const session = resolvedSessionId ? getSession(resolvedSessionId) : undefined;
  const sessionItems = resolvedSessionId ? getSessionItems(resolvedSessionId) : [];

  const [scannedProduct, setScannedProduct] = useState<Product | null>(null);
  const [editingItem, setEditingItem] = useState<SessionItem | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editQuantity, setEditQuantity] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [deleteProductId, setDeleteProductId] = useState<string | null>(null);
  const [confirmCompleteOpen, setConfirmCompleteOpen] = useState(false);

  const updateQtyAction = useIdempotentAction(async () => {
    if (!session || !editingItem || session.status === "Completed" || session.status === "Cancelled") return;
    const product = products.find((p) => p.productId === editingItem.productId) ?? {
      productId: editingItem.productId,
      product_name: editingItem.product_name,
      product_sku: editingItem.product_sku,
      quantity: editingItem.quantity,
      sellingPrice: editingItem.sellingPrice,
      costPrice: editingItem.costPrice,
      brand: "",
      category: "",
    };
    const res = await upsertSessionItemCount(session.id, product, Math.max(0, editQuantity), "set");
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    toast({ title: t("sessionDetail.quantityUpdated") });
    setIsEditDialogOpen(false);
    setEditingItem(null);
    return { ok: true };
  });

  const completeSessionAction = useIdempotentAction(async () => {
    if (!session) return;
    const resolvedBranchName =
      session.branchName ||
      branches.find((b) => b.branchId === session.branchId)?.branch_name ||
      `Branch #${session.branchId}`;
    const res = await completeSession(session.id);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    setConfirmCompleteOpen(false);
    toast({
      title: t("sessions.completedSuccess", "Session completed & stock reconciled"),
      description:
        res.adjustedCount > 0
          ? `${res.adjustedCount} variance adjustment(s) posted to ${resolvedBranchName}.`
          : "All counted items matched expected branch stock.",
    });
    return { ok: true };
  });

  if (!session) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/sessions">
            <ArrowLeft className="h-4 w-4 me-2" />
            {t("sessionDetail.backToSessions")}
          </Link>
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("sessions.notFound", "Stock-take session not found.")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const isLocked = session.status === "Completed" || session.status === "Cancelled";
  const branchName =
    session.branchName ||
    branches.find((b) => b.branchId === session.branchId)?.branch_name ||
    `Branch #${session.branchId}`;

  const filteredItems = sessionItems.filter(
    (item) =>
      item.product_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.product_sku.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const handleProductScanned = (product: Product) => {
    if (isLocked) return;
    setScannedProduct(product);
  };

  const handleConfirmCount = async (quantity: number) => {
    if (!scannedProduct || isLocked) return;
    const existing = sessionItems.find((item) => item.productId === scannedProduct.productId);
    const res = await upsertSessionItemCount(session.id, scannedProduct, quantity, "increment");
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: existing
        ? t("sessionDetail.productQuantityUpdated")
        : t("sessionDetail.productAddedToSession"),
    });
    setScannedProduct(null);
  };

  const handleCancelScan = () => setScannedProduct(null);

  const handleEdit = (item: SessionItem) => {
    if (isLocked) return;
    setEditingItem(item);
    setEditQuantity(item.quantity);
    setIsEditDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!deleteProductId || isLocked) return;
    const res = await removeSessionItem(session.id, deleteProductId);
    setDeleteProductId(null);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({ title: t("sessionDetail.productRemovedFromSession") });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "Over Count":
        return <TrendingUp className="h-4 w-4 text-green-600" />;
      case "Under Count":
        return <TrendingDown className="h-4 w-4 text-red-600" />;
      default:
        return <Minus className="h-4 w-4 text-blue-600" />;
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "Over Count":
        return t("sessionDetail.overCount");
      case "Under Count":
        return t("sessionDetail.underCount");
      default:
        return t("sessionDetail.exact");
    }
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "Over Count":
        return "default" as const;
      case "Under Count":
        return "destructive" as const;
      default:
        return "secondary" as const;
    }
  };

  const varianceCount = sessionItems.filter((i) => i.variance !== 0).length;

  const sessionSummary = {
    totalItems: sessionItems.length,
    overCount: sessionItems.filter((item) => item.status === "Over Count").length,
    underCount: sessionItems.filter((item) => item.status === "Under Count").length,
    exact: sessionItems.filter((item) => item.status === "Exact").length,
  };

  const scannedBranchExpected = scannedProduct
    ? branchProducts.find(
        (bp) => bp.branchId === session.branchId && bp.productId === scannedProduct.productId,
      )?.quantity ?? 0
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions">
              <ArrowLeft className="h-4 w-4 me-2" />
              {t("sessionDetail.backToSessions")}
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">
                {t("sessionDetail.session")} #{session.id}
              </h1>
              <Badge variant={session.status === "Cancelled" ? "destructive" : "outline"}>
                {session.status}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {branchName}
              {session.description ? ` · ${session.description}` : ""}
            </p>
          </div>
        </div>

        {!isLocked && (can("sessions", "approve") || can("sessions", "edit")) && (
          <Button onClick={() => setConfirmCompleteOpen(true)}>
            <CheckCircle2 className="h-4 w-4 me-2" />
            {t("sessions.completeAndReconcile", "Complete & Reconcile Stock")}
          </Button>
        )}
      </div>

      {isLocked && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertDescription>
            {session.status === "Completed"
              ? t(
                  "sessions.completedLocked",
                  "This stock-take session is completed and locked. Variances have been reconciled to branch stock.",
                )
              : t("sessions.cancelledLocked", "This stock-take session is cancelled and locked.")}
          </AlertDescription>
        </Alert>
      )}

      {!isLocked && (
        <Card>
          <CardHeader>
            <CardTitle>{t("sessionDetail.scanProducts")}</CardTitle>
            <CardDescription>{t("sessionDetail.scanDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {scannedProduct ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {branchName} {t("sessionDetail.expectedQty")}:{" "}
                  <span className="font-semibold text-foreground">{scannedBranchExpected}</span>
                </p>
                <ScannedProductDisplay
                  product={scannedProduct}
                  onConfirm={(qty) => handleConfirmCount(qty)}
                  onCancel={handleCancelScan}
                />
              </>
            ) : (
              <ScannerInput
                onProductScanned={handleProductScanned}
                products={products}
                disabled={!!scannedProduct || isLocked}
              />
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("sessionDetail.totalItems")}</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessionSummary.totalItems}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("sessionDetail.exactCounts")}</CardTitle>
            <Minus className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessionSummary.exact}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("sessionDetail.overCounts")}</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessionSummary.overCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("sessionDetail.underCounts")}</CardTitle>
            <TrendingDown className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{sessionSummary.underCount}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            <span>{t("sessionDetail.sessionItems")}</span>
          </CardTitle>
          <CardDescription>{t("sessionDetail.productsCounted")}</CardDescription>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("sessionDetail.searchInSession")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isMobile ? (
            <div className="space-y-3">
              {filteredItems.map((item) => {
                const expectedQty = item.expectedQty ?? item.quantity - item.variance;
                return (
                  <div key={item.productId} className="rounded-lg border p-3 bg-card">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{item.product_name}</div>
                        <div className="text-xs text-muted-foreground">{item.product_sku}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        {getStatusIcon(item.status)}
                        <Badge variant={getStatusBadgeVariant(item.status)}>
                          {getStatusLabel(item.status)}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
                      <div className="rounded-md bg-muted/50 p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">
                          {t("sessionDetail.expectedQty")}
                        </div>
                        <div className="font-semibold">{expectedQty}</div>
                      </div>
                      <div className="rounded-md bg-muted/50 p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">
                          {t("sessionDetail.countedQty")}
                        </div>
                        <div className="font-semibold">{item.quantity}</div>
                      </div>
                      <div className="rounded-md bg-muted/50 p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">
                          {t("sessionDetail.variance")}
                        </div>
                        <div
                          className={`font-semibold ${
                            item.variance > 0
                              ? "text-green-600"
                              : item.variance < 0
                                ? "text-red-600"
                                : "text-blue-600"
                          }`}
                        >
                          {item.variance > 0 ? "+" : ""}
                          {item.variance}
                        </div>
                      </div>
                    </div>
                    {!isLocked && (
                      <div className="mt-3 flex justify-end gap-2">
                        <Button variant="outline" size="sm" className="h-10" onClick={() => handleEdit(item)}>
                          <Edit className="h-4 w-4 me-1" />
                          {t("common.edit")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10"
                          onClick={() => setDeleteProductId(item.productId)}
                        >
                          <Trash2 className="h-4 w-4 me-1" />
                          {t("common.delete")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sessionDetail.product")}</TableHead>
                  <TableHead>{t("products.sku")}</TableHead>
                  <TableHead>{t("sessionDetail.expectedQty")}</TableHead>
                  <TableHead>{t("sessionDetail.countedQty")}</TableHead>
                  <TableHead>{t("products.sellingPrice")}</TableHead>
                  <TableHead>{t("products.costPrice")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("sessionDetail.variance")}</TableHead>
                  {!isLocked && <TableHead>{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => {
                  const expectedQty = item.expectedQty ?? item.quantity - item.variance;
                  return (
                    <TableRow key={item.productId}>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell>{item.product_sku}</TableCell>
                      <TableCell>{expectedQty}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{formatMoney(item.sellingPrice, settings.currency)}</TableCell>
                      <TableCell>{formatMoney(item.costPrice, settings.currency)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(item.status)}
                          <Badge variant={getStatusBadgeVariant(item.status)}>
                            {getStatusLabel(item.status)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`font-medium ${
                            item.variance > 0
                              ? "text-green-600"
                              : item.variance < 0
                                ? "text-red-600"
                                : "text-blue-600"
                          }`}
                        >
                          {item.variance > 0 ? "+" : ""}
                          {item.variance}
                        </span>
                      </TableCell>
                      {!isLocked && (
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button variant="ghost" size="sm" onClick={() => handleEdit(item)}>
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteProductId(item.productId)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {filteredItems.length === 0 && (
            <div className="text-center py-8">
              <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">{t("sessionDetail.noItemsInSession")}</h3>
              <p className="text-muted-foreground">{t("sessionDetail.startScanning")}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isEditDialogOpen} onOpenChange={updateQtyAction.guardOpenChange(setIsEditDialogOpen)}>
        <DialogContent className="max-w-sm" locked={updateQtyAction.isPending}>
          <DialogHeader>
            <DialogTitle>{t("sessionDetail.editQuantity")}</DialogTitle>
            <DialogDescription>
              {t("sessionDetail.editQuantityDescription", { product: editingItem?.product_name })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editQuantity">{t("sessionDetail.countedQuantity")}</Label>
              <Input
                id="editQuantity"
                type="number"
                min={0}
                value={editQuantity}
                onChange={(e) => setEditQuantity(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="h-12 text-lg"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={updateQtyAction.isPending} onClick={() => setIsEditDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <SubmitButton
                type="button"
                pending={updateQtyAction.isPending}
                isSlow={updateQtyAction.isSlow}
                onClick={() => void updateQtyAction.run()}
              >
                {t("sessionDetail.updateQuantity")}
              </SubmitButton>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteProductId !== null}
        onOpenChange={(open) => !open && setDeleteProductId(null)}
        onConfirm={() => handleConfirmDelete()}
        itemName={sessionItems.find((i) => i.productId === deleteProductId)?.product_name}
      />

      <AlertDialog open={confirmCompleteOpen} onOpenChange={completeSessionAction.guardOpenChange(setConfirmCompleteOpen)}>
        <AlertDialogContent
          onEscapeKeyDown={(e) => {
            if (completeSessionAction.isPending) e.preventDefault();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sessions.completeConfirmTitle", "Complete Session & Reconcile Stock?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {varianceCount > 0
                ? t(
                    "sessions.completeConfirmVariance",
                    `This will lock Session #${session.id} and create ${varianceCount} stock adjustment(s) at ${branchName} to match your counted quantities.`,
                  )
                : t(
                    "sessions.completeConfirmExact",
                    `This will mark Session #${session.id} as Completed and lock it from further edits.`,
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={completeSessionAction.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <SubmitButton
              type="button"
              pending={completeSessionAction.isPending}
              isSlow={completeSessionAction.isSlow}
              onClick={() => void completeSessionAction.run()}
            >
              {t("sessions.completeAndReconcile", "Complete & Reconcile Stock")}
            </SubmitButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SessionDetail;
