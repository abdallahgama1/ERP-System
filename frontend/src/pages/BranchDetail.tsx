import { lazy, Suspense, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Warehouse, Plus, Search, Edit, Trash2, Building2, Package, AlertCircle, History, Upload, Download, ArrowLeft, MapPin, Phone } from "lucide-react";
import { exportJsonToExcel } from "@/lib/export/excel";
import { BranchProduct } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { Alert, AlertDescription } from "@/components/ui/alert";
import MovementHistoryTable from "@/components/inventory/MovementHistoryTable";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

const CsvImportDialog = lazy(() => import("@/components/import/CsvImportDialog"));

const BranchDetail = () => {
  const { branchId } = useParams<{ branchId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { can } = usePermissions();
  const canEditStock = can("inventory", "edit") || can("inventory", "create");
  const {
    products,
    branchProducts,
    branches,
    movements,
    getAvailableQuantity, 
    assignToBranch, 
    updateBranchProduct, 
    removeFromBranch 
  } = useInventoryScope({ products: true, movements: true });
  
  const selectedBranchId = branchId || "";
  const selectedBranch = branches.find(b => b.branchId === selectedBranchId);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [movementSearchTerm, setMovementSearchTerm] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<BranchProduct | null>(null);
  const [deleteProductId, setDeleteProductId] = useState<string | null>(null);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    productId: "",
    product_name: "",
    product_sku: "",
    quantity: 0,
    sellingPrice: 0,
    costPrice: 0
  });

  const [selectedProductAvailable, setSelectedProductAvailable] = useState(0);

  const filteredBranchProducts = branchProducts.filter(item => 
    item.branchId === selectedBranchId &&
    (item.product_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
     item.product_sku.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const resetForm = () => {
    setFormData({
      productId: "",
      product_name: "",
      product_sku: "",
      quantity: 0,
      sellingPrice: 0,
      costPrice: 0
    });
    setEditingItem(null);
    setSelectedProductAvailable(0);
  };

  const handleProductSelect = (productId: string) => {
    const product = products.find(p => p.productId === productId);
    if (product) {
      const available = getAvailableQuantity(product.productId);
      setSelectedProductAvailable(available);
      setFormData({
        ...formData,
        productId: product.productId,
        product_name: product.product_name,
        product_sku: product.product_sku,
        sellingPrice: product.sellingPrice,
        costPrice: product.costPrice,
        quantity: 0
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (editingItem) {
      const currentBranchQty = editingItem.quantity;
      const productAvailable = getAvailableQuantity(editingItem.productId);
      const maxAllowed = currentBranchQty + productAvailable;
      
      if (formData.quantity > maxAllowed) {
        toast({ 
          title: t("branchInventory.quantityExceeds"), 
          description: t("branchInventory.maxAvailable", { count: maxAllowed }),
          variant: "destructive"
        });
        return;
      }

      const success = await updateBranchProduct(
        editingItem.productId,
        selectedBranchId,
        formData.quantity,
        formData.sellingPrice,
        formData.costPrice
      );
      
      if (success) {
        toast({ title: t("branchInventory.productUpdated") });
      } else {
        toast({ title: t("branchInventory.updateFailed"), variant: "destructive" });
        return;
      }
    } else {
      const existingItem = branchProducts.find(
        item => item.productId === formData.productId && item.branchId === selectedBranchId
      );
      
      if (existingItem) {
        toast({ 
          title: t("branchInventory.productExists"), 
          description: t("branchInventory.productExistsDescription"),
          variant: "destructive"
        });
        return;
      }

      if (formData.quantity > selectedProductAvailable) {
        toast({ 
          title: t("branchInventory.quantityExceeds"), 
          description: t("branchInventory.onlyAvailable", { count: selectedProductAvailable }),
          variant: "destructive"
        });
        return;
      }

      if (formData.quantity <= 0) {
        toast({ 
          title: t("branchInventory.invalidQuantity"), 
          description: t("branchInventory.enterQuantityGreaterThanZero"),
          variant: "destructive"
        });
        return;
      }

      const success = await assignToBranch(
        formData.productId,
        selectedBranchId,
        formData.quantity,
        formData.sellingPrice,
        formData.costPrice
      );
      
      if (success) {
        toast({ title: t("branchInventory.productAssigned") });
      } else {
        toast({ title: t("branchInventory.assignFailed"), variant: "destructive" });
        return;
      }
    }
    
    resetForm();
    setIsAddDialogOpen(false);
  };

  const handleEdit = (item: BranchProduct) => {
    setEditingItem(item);
    const productAvailable = getAvailableQuantity(item.productId);
    setSelectedProductAvailable(productAvailable + item.quantity);
    setFormData({
      productId: item.productId,
      product_name: item.product_name,
      product_sku: item.product_sku,
      quantity: item.quantity,
      sellingPrice: item.sellingPrice,
      costPrice: item.costPrice
    });
    setIsAddDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (deleteProductId) {
      await removeFromBranch(deleteProductId, selectedBranchId);
      toast({ title: t("branchInventory.productRemoved") });
      setDeleteProductId(null);
    }
  };

  // Branch-wide totals: always computed from the full branch inventory so the
  // summary cards don't shift when the user types in the search box.
  const branchAllProducts = branchProducts.filter(
    (item) => item.branchId === selectedBranchId
  );
  const totalValue = branchAllProducts.reduce(
    (sum, item) => sum + item.quantity * item.costPrice,
    0
  );
  const totalItems = branchAllProducts.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  const availableProductsForBranch = products.filter(product => {
    const isAlreadyInBranch = branchProducts.some(
      bp => bp.productId === product.productId && bp.branchId === selectedBranchId
    );
    const available = getAvailableQuantity(product.productId);
    return !isAlreadyInBranch && available > 0;
  });

  const handleExportBranchInventory = async () => {
    const exportData = filteredBranchProducts.map(item => ({
      SKU: item.product_sku,
      "Product Name": item.product_name,
      "Branch Name": selectedBranch?.branch_name || "",
      Quantity: item.quantity,
      "Selling Price": item.sellingPrice,
      "Cost Price": item.costPrice,
      "Total Value": item.quantity * item.costPrice,
    }));

    await exportJsonToExcel({
      rows: exportData,
      sheetName: "Branch Inventory",
      fileName: `${selectedBranch?.branch_name || "branch"}_inventory_${new Date().toISOString().split('T')[0]}.xlsx`,
    });
    
    toast({
      title: t('bulkImport.exportSuccess'),
      description: t('bulkImport.dataExported', { count: exportData.length }),
    });
  };

  if (!selectedBranch) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/branches")}>
          <ArrowLeft className="me-2 h-4 w-4" />
          {t("common.back")}
        </Button>
        <Card>
          <CardContent className="text-center py-8">
            <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium">{t("branches.branchNotFound")}</h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/branches")}>
            <ArrowLeft className="me-2 h-4 w-4" />
            {t("common.back")}
          </Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{selectedBranch.branch_name}</h1>
            <div className="flex items-center gap-4 text-muted-foreground">
              <span className="flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {selectedBranch.branch_location}
              </span>
              <span className="flex items-center gap-1">
                <Phone className="h-4 w-4" />
                {selectedBranch.contact_number}
              </span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportBranchInventory} disabled={filteredBranchProducts.length === 0}>
            <Download className="me-2 h-4 w-4" />
            {t('bulkImport.export')}
          </Button>
          
          {canEditStock && (
            <Button variant="outline" onClick={() => setIsImportDialogOpen(true)}>
              <Upload className="me-2 h-4 w-4" />
              {t('bulkImport.title')}
            </Button>
          )}
          
          <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
            setIsAddDialogOpen(open);
            if (!open) resetForm();
          }}>
            {canEditStock && (
              <DialogTrigger asChild>
                <Button onClick={resetForm}>
                  <Plus className="me-2 h-4 w-4" />
                  {t("branchInventory.assignProduct")}
                </Button>
              </DialogTrigger>
            )}
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingItem ? t("branchInventory.editBranchProduct") : t("branchInventory.assignProduct")}
                </DialogTitle>
                <DialogDescription>
                  {editingItem 
                    ? t("branchInventory.updateQuantity", { branch: selectedBranch?.branch_name })
                    : t("branchInventory.assignStock", { branch: selectedBranch?.branch_name })
                  }
                </DialogDescription>
              </DialogHeader>
            
              <form onSubmit={handleSubmit} className="space-y-4">
                {!editingItem && (
                  <div className="space-y-2">
                    <Label htmlFor="product">{t("branchInventory.selectProduct")}</Label>
                    <Select onValueChange={handleProductSelect} required>
                      <SelectTrigger>
                        <SelectValue placeholder={t("branchInventory.chooseProduct")} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableProductsForBranch.length === 0 ? (
                          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
                            {t("branchInventory.noProductsAvailable")}
                          </div>
                        ) : (
                          availableProductsForBranch.map((product) => (
                            <SelectItem key={product.productId} value={product.productId.toString()}>
                              {product.product_name} ({product.product_sku}) - {getAvailableQuantity(product.productId)} {t("branchInventory.available")}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {(Boolean(formData.productId) || editingItem) && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {editingItem 
                        ? t("branchInventory.maxQuantity", { max: selectedProductAvailable, current: editingItem.quantity, additional: selectedProductAvailable - editingItem.quantity })
                        : t("branchInventory.availableForAssignment", { count: selectedProductAvailable })
                      }
                    </AlertDescription>
                  </Alert>
                )}
                
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="quantity">{t("branchInventory.quantityToAssign")}</Label>
                    <Input
                      id="quantity"
                      type="number"
                      min={1}
                      max={selectedProductAvailable}
                      value={formData.quantity}
                      onChange={(e) => setFormData({...formData, quantity: parseInt(e.target.value) || 0})}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sellingPrice">{t("branchInventory.sellingPrice")}</Label>
                    <Input
                      id="sellingPrice"
                      type="number"
                      step="0.01"
                      value={formData.sellingPrice}
                      onChange={(e) => setFormData({...formData, sellingPrice: parseFloat(e.target.value) || 0})}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="costPrice">{t("branchInventory.costPrice")}</Label>
                    <Input
                      id="costPrice"
                      type="number"
                      step="0.01"
                      value={formData.costPrice}
                      onChange={(e) => setFormData({...formData, costPrice: parseFloat(e.target.value) || 0})}
                      required
                    />
                  </div>
                </div>
                
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button 
                    type="submit" 
                    disabled={!editingItem && (!formData.productId || formData.quantity <= 0 || formData.quantity > selectedProductAvailable)}
                  >
                    {editingItem ? t("branchInventory.updateProduct") : t("branchInventory.assignProductBtn")}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Inventory Summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("branchInventory.totalProducts")}</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredBranchProducts.length}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("branchInventory.totalItems")}</CardTitle>
            <Warehouse className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalItems}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("branchInventory.totalValue")}</CardTitle>
            <span className="text-xs text-muted-foreground">{settings.currency}</span>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatMoney(totalValue, settings.currency)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Branch Inventory Tabs */}
      <Tabs defaultValue="inventory" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="inventory" className="gap-2">
            <Package className="h-4 w-4" />
            {t("movements.inventoryTab")}
          </TabsTrigger>
          <TabsTrigger value="movements" className="gap-2">
            <History className="h-4 w-4" />
            {t("movements.movementHistoryTab")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inventory">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Warehouse className="h-5 w-5" />
                <span>{selectedBranch.branch_name} {t("branchInventory.inventory")}</span>
              </CardTitle>
              <CardDescription>
                {t("branchInventory.productsAssigned")}
              </CardDescription>
              
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t("branchInventory.searchProducts")}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
              </div>
            </CardHeader>
            
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("branchInventory.productName")}</TableHead>
                    <TableHead>{t("branchInventory.sku")}</TableHead>
                    <TableHead>{t("branchInventory.quantity")}</TableHead>
                    <TableHead>{t("branchInventory.sellingPrice")}</TableHead>
                    <TableHead>{t("branchInventory.costPrice")}</TableHead>
                    <TableHead>{t("branchInventory.totalValueColumn")}</TableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBranchProducts.map((item) => (
                    <TableRow key={`${item.branchId}-${item.productId}`}>
                      <TableCell className="font-medium">{item.product_name}</TableCell>
                      <TableCell>{item.product_sku}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{formatMoney(item.sellingPrice, settings.currency)}</TableCell>
                      <TableCell>{formatMoney(item.costPrice, settings.currency)}</TableCell>
                      <TableCell>{formatMoney(item.quantity * item.costPrice, settings.currency)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(item)}
                          >
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
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              
              {filteredBranchProducts.length === 0 && (
                <div className="text-center py-8">
                  <Warehouse className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium">{t("branchInventory.noProductsAtBranch")}</h3>
                  <p className="text-muted-foreground">
                    {searchTerm 
                      ? t("common.noSearchResults") 
                      : t("branchInventory.startAssigning")
                    }
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="movements">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                <span>{selectedBranch.branch_name} - {t("movements.title")}</span>
              </CardTitle>
              <CardDescription>
                {t("movements.description")}
              </CardDescription>
              
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t("movements.searchMovements")}
                  value={movementSearchTerm}
                  onChange={(e) => setMovementSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
              </div>
            </CardHeader>
            
            <CardContent>
              {(() => {
                const branchMovements = movements.filter(
                  (m) => m.branchId === selectedBranchId,
                );
                const filteredMovements = branchMovements.filter(m =>
                  m.product_name.toLowerCase().includes(movementSearchTerm.toLowerCase()) ||
                  (m.reference?.toLowerCase().includes(movementSearchTerm.toLowerCase()))
                );
                return (
                  <MovementHistoryTable 
                    movements={filteredMovements} 
                    showProduct={true}
                    showBranch={false}
                  />
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Unified Server CSV Import Dialog (Opening Stock per Branch) */}
      {isImportDialogOpen && (
        <Suspense fallback={null}>
          <CsvImportDialog
            open={isImportDialogOpen}
            onOpenChange={setIsImportDialogOpen}
            kind="opening_stock"
            title={t('imports.datasets.openingStock', 'Opening Stock per Branch')}
            description={t('imports.datasets.openingStockDesc', 'Load physical opening stock quantities and unit costs per branch (reconciled to GL 1200).')}
          />
        </Suspense>
      )}

      <ConfirmDeleteDialog
        open={deleteProductId !== null}
        onOpenChange={(open) => !open && setDeleteProductId(null)}
        onConfirm={handleConfirmDelete}
        itemName={branchProducts.find(bp => bp.productId === deleteProductId && bp.branchId === selectedBranchId)?.product_name}
      />
    </div>
  );
};

export default BranchDetail;
