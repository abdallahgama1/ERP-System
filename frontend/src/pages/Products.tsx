import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProductsPageQuery } from "@/hooks/queries/useInventoryQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Package, Plus, Edit, Trash2, ChevronDown, ChevronRight, MapPin, FileText, Upload, Download, Paperclip } from "lucide-react";
import { exportJsonToExcel } from "@/lib/export/excel";
import { Product } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useAuditRecorder } from "@/hooks/queries/useAuditLogsCursorQuery";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import ProductLedgerDialog from "@/components/inventory/ProductLedgerDialog";
import type { ImportColumn } from "@/components/import/BulkImportDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { TaxonomySelect } from "@/components/taxonomy/TaxonomySelect";
import { useTaxonomyQuery } from "@/hooks/queries/useTaxonomyQueries";
import { EnterpriseDataTable, type EnterpriseColumn } from "@/components/EnterpriseDataTable";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";

const BulkImportDialog = lazy(() => import("@/components/import/BulkImportDialog"));

const Products = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { can } = usePermissions();
  const { products, addProduct, updateProduct, deleteProduct, getAvailableQuantity, getAssignedQuantity, branchProducts, branches } = useInventoryScope({ products: true });
  const { record } = useAuditRecorder();
  const { data: taxonomyData } = useTaxonomyQuery();
  const brands = taxonomyData?.brands ?? [];
  const categories = taxonomyData?.categories ?? [];
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [attachmentsProduct, setAttachmentsProduct] = useState<Product | null>(null);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [ledgerProduct, setLedgerProduct] = useState<Product | null>(null);
  const [deleteProductId, setDeleteProductId] = useState<string | null>(null);
  const { toast } = useToast();
  const canCreate = can("products", "create");
  const canEdit = can("products", "edit");
  const canDelete = can("products", "delete");

  const getBranchAssignments = (productId: string) => {
    return branchProducts
      .filter(bp => bp.productId === productId)
      .map(bp => {
        const branch = branches.find(b => b.branchId === bp.branchId);
        return {
          ...bp,
          branchName: branch?.branch_name || `Branch ${bp.branchId}`
        };
      });
  };

  const toggleProductExpansion = (productId: string) => {
    setExpandedProducts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  const [formData, setFormData] = useState<{
    product_name: string;
    product_sku: string;
    quantity: number;
    sellingPrice: number;
    costPrice: number;
    brand: string;
    category: string;
    itemType: "stock" | "non_stock" | "service" | "manufactured";
    trackingMode: "none" | "lot" | "serial";
    requiresExpiry: boolean;
    shelfLifeDays: number | null;
    pickingStrategy: "FEFO" | "FIFO" | "LIFO";
  }>({
    product_name: "",
    product_sku: "",
    quantity: 0,
    sellingPrice: 0,
    costPrice: 0,
    brand: "",
    category: "",
    itemType: "stock",
    trackingMode: "none",
    requiresExpiry: false,
    shelfLifeDays: null,
    pickingStrategy: "FEFO",
  });

  const { data: productsPage } = useProductsPageQuery({
    page,
    pageSize: 25,
    q: searchTerm,
  });

  const filteredProducts = useMemo<Product[]>(
    () =>
      (productsPage?.products ?? []).map((p) => ({
        productId: p.id,
        product_name: p.name,
        product_sku: p.sku,
        quantity: p.totalQuantity,
        sellingPrice: p.sellingPrice,
        costPrice: p.costPrice,
        brand: p.brand,
        category: p.category,
        unit: p.unit,
        minStockLevel: p.minStockLevel,
        barcode: p.barcode,
        itemType: p.itemType ?? "stock",
        trackingMode: p.trackingMode ?? "none",
        requiresExpiry: p.requiresExpiry ?? false,
        shelfLifeDays: p.shelfLifeDays ?? null,
        pickingStrategy: p.pickingStrategy ?? "FEFO",
        hasBom: p.hasBom ?? false,
      })),
    [productsPage]
  );

  const resetForm = () => {
    setFormData({
      product_name: "",
      product_sku: "",
      quantity: 0,
      sellingPrice: 0,
      costPrice: 0,
      brand: "",
      category: "",
      itemType: "stock",
      trackingMode: "none",
      requiresExpiry: false,
      shelfLifeDays: null,
      pickingStrategy: "FEFO",
    });
    setEditingProduct(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Duplicate SKU guard (case-insensitive)
    const normalizedSku = formData.product_sku.trim().toLowerCase();
    if (!normalizedSku) {
      toast({ title: t('products.skuRequired', 'SKU is required'), variant: 'destructive' });
      return;
    }
    const skuTaken = products.some(
      p => p.product_sku.trim().toLowerCase() === normalizedSku &&
           (!editingProduct || p.productId !== editingProduct.productId)
    );
    if (skuTaken) {
      toast({
        title: t('products.duplicateSku', 'Duplicate SKU'),
        description: t('products.duplicateSkuDescription', 'A product with this SKU already exists.'),
        variant: 'destructive',
      });
      return;
    }

    // Numeric guards
    if (formData.quantity < 0 || formData.sellingPrice < 0 || formData.costPrice < 0) {
      toast({ title: t('products.negativeValues', 'Values cannot be negative'), variant: 'destructive' });
      return;
    }

    // Taxonomy guards — brand and category must be picked from the managed lists.
    if (!formData.brand.trim() || !formData.category.trim()) {
      toast({
        title: t('products.taxonomyRequired', 'Brand and category are required'),
        variant: 'destructive',
      });
      return;
    }

    if (editingProduct) {
      const assignedQty = getAssignedQuantity(editingProduct.productId);
      if (formData.quantity < assignedQty) {
        toast({ 
          title: t('products.cannotReduceQuantity'), 
          description: t('products.unitsAssigned', { count: assignedQty }),
          variant: "destructive"
        });
        return;
      }
      
      const res = await updateProduct(editingProduct.productId, formData);
      if (res.ok === false) {
        toast({ title: t('common.error'), description: res.error, variant: "destructive" });
        return;
      }
      toast({ title: t('products.productUpdated') });
    } else {
      const res = await addProduct(formData);
      if (res.ok === false) {
        toast({ title: t('common.error'), description: res.error, variant: "destructive" });
        return;
      }
      toast({ title: t('products.productAdded') });
    }
    
    resetForm();
    setIsAddDialogOpen(false);
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setFormData({
      product_name: product.product_name,
      product_sku: product.product_sku,
      quantity: product.quantity,
      sellingPrice: product.sellingPrice,
      costPrice: product.costPrice,
      brand: product.brand,
      category: product.category,
      itemType: product.itemType ?? "stock",
      trackingMode: product.trackingMode ?? "none",
      requiresExpiry: product.requiresExpiry ?? false,
      shelfLifeDays: product.shelfLifeDays ?? null,
      pickingStrategy: product.pickingStrategy ?? "FEFO",
    });
    setIsAddDialogOpen(true);
  };

  const handleDeleteClick = (productId: string) => {
    const assignedQty = getAssignedQuantity(productId);
    if (assignedQty > 0) {
      toast({ 
        title: t('products.cannotDeleteProduct'), 
        description: t('products.unitsAssignedRemoveFirst', { count: assignedQty }),
        variant: "destructive"
      });
      return;
    }
    setDeleteProductId(productId);
  };

  const handleConfirmDelete = async () => {
    if (deleteProductId) {
      const res = await deleteProduct(deleteProductId);
      if (res.ok === false) {
        toast({ title: t('products.cannotDeleteProduct'), description: res.error, variant: "destructive" });
      } else {
        toast({ title: t('products.productDeleted') });
      }
      setDeleteProductId(null);
    }
  };

  const getStockStatus = (available: number, total: number) => {
    if (total === 0) return { label: t('products.outOfStock'), variant: "destructive" as const };
    if (available <= 10) return { label: t('products.lowAvailable'), variant: "destructive" as const };
    if (available <= 25) return { label: t('products.mediumStock'), variant: "secondary" as const };
    return { label: t('products.inStock'), variant: "default" as const };
  };

  // Product import columns configuration
  const productImportColumns: ImportColumn[] = [
    { key: "sku", label: "SKU", required: true },
    { key: "name", label: "Name", required: true },
    { key: "category", label: "Category", required: true },
    { key: "brand", label: "Brand", required: true },
    { key: "cost_price", label: "Cost Price", required: true },
    { key: "selling_price", label: "Selling Price", required: true },
    { key: "quantity", label: "Quantity", required: true },
  ];

  const handleProductImport = async (data: Record<string, unknown>[]) => {
    // Validate brand / category against the managed taxonomy lists.
    const knownBrands = new Set(brands.map(b => b.name.trim().toLowerCase()));
    const knownCategories = new Set(categories.map(c => c.name.trim().toLowerCase()));
    const unknown: string[] = [];
    for (const row of data) {
      const b = String(row.brand || '').trim();
      const c = String(row.category || '').trim();
      if (b && !knownBrands.has(b.toLowerCase())) unknown.push(b);
      if (c && !knownCategories.has(c.toLowerCase())) unknown.push(c);
    }
    if (unknown.length > 0) {
      toast({
        title: t('products.unknownTaxonomy', 'Unknown brand or category'),
        description: t('products.unknownTaxonomyDescription', {
          defaultValue: 'Create these in Brands / Categories first: {{values}}',
          values: [...new Set(unknown)].slice(0, 5).join(', '),
        }),
        variant: 'destructive',
      });
      throw new Error('unknown_taxonomy');
    }

    // Duplicate-SKU guard: check within the file AND against existing products.
    const existingSkus = new Set(products.map(p => p.product_sku.trim().toLowerCase()));
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const row of data) {
        const sku = String(row.sku || '').trim().toLowerCase();
        if (!sku) continue;
        if (existingSkus.has(sku) || seen.has(sku)) {
          dupes.push(sku);
        }
        seen.add(sku);
      }
      if (dupes.length > 0) {
        toast({
          title: t('products.duplicateSku', 'Duplicate SKU'),
          description: t('products.duplicateSkuImport', {
            defaultValue: 'Duplicate SKUs detected: {{skus}}',
            skus: [...new Set(dupes)].slice(0, 5).join(', '),
          }),
          variant: 'destructive',
        });
        throw new Error('duplicate_sku');
      }

    let importedCount = 0;
    for (const row of data) {
      const res = await addProduct({
        product_name: String(row.name || ""),
        product_sku: String(row.sku || ""),
        category: String(row.category || ""),
        brand: String(row.brand || ""),
        costPrice: Math.max(0, Number(row.cost_price) || 0),
        sellingPrice: Math.max(0, Number(row.selling_price) || 0),
        quantity: Math.max(0, Number(row.quantity) || 0),
      });
      if (res.ok) importedCount += 1;
    }
    record('inventory', `Bulk imported ${importedCount} products`, { entity: 'product' });
  };

  const handleExportProducts = async () => {
    const exportData = filteredProducts.map(product => ({
      SKU: product.product_sku,
      Name: product.product_name,
      Category: product.category,
      Brand: product.brand,
      "Cost Price": product.costPrice,
      "Selling Price": product.sellingPrice,
      "Total Quantity": product.quantity,
      "Assigned": getAssignedQuantity(product.productId),
      "Available": getAvailableQuantity(product.productId),
    }));

    await exportJsonToExcel({
      rows: exportData,
      sheetName: "Products",
      fileName: `products_export_${new Date().toISOString().split('T')[0]}.xlsx`,
    });
    
    toast({
      title: t('bulkImport.exportSuccess'),
      description: t('bulkImport.dataExported', { count: exportData.length }),
    });
  };


  const productColumns: EnterpriseColumn<Product>[] = [
    {
      id: "name",
      header: t("products.productName"),
      sortable: true,
      hideable: false,
      cell: (product) => (
        <div className="flex items-center gap-1.5 flex-wrap font-medium">
          <span>{product.product_name}</span>
          {product.trackingMode && product.trackingMode !== "none" && (
            <Badge variant="outline" className="text-[10px] uppercase">
              {product.trackingMode}
            </Badge>
          )}
          {product.itemType === "manufactured" && (
            <Badge variant="secondary" className="text-[10px]">
              MFG
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "sku",
      header: t("products.sku"),
      accessorKey: "product_sku",
      sortable: true,
    },
    {
      id: "brand",
      header: t("products.brand"),
      accessorKey: "brand",
      sortable: true,
    },
    {
      id: "category",
      header: t("products.category"),
      accessorKey: "category",
      sortable: true,
    },
    {
      id: "quantity",
      header: t("products.totalQty"),
      accessorKey: "quantity",
      sortable: true,
    },
    {
      id: "assigned",
      header: t("products.assigned"),
      cell: (product) => {
        const assignedQty = getAssignedQuantity(product.productId);
        const isExpanded = expandedProducts.has(product.productId);
        return assignedQty > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto p-1 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggleProductExpansion(product.productId);
            }}
          >
            {isExpanded ? <ChevronDown className="h-4 w-4 me-1" /> : <ChevronRight className="h-4 w-4 me-1" />}
            {assignedQty}
          </Button>
        ) : (
          <span className="text-muted-foreground">0</span>
        );
      },
    },
    {
      id: "available",
      header: t("products.available"),
      cell: (product) => {
        const assignedQty = getAssignedQuantity(product.productId);
        const availableQty = Math.max(0, product.quantity - assignedQty);
        return (
          <span className={availableQty <= 10 ? "text-destructive font-medium" : ""}>
            {availableQty}
          </span>
        );
      },
    },
    {
      id: "sellingPrice",
      header: t("products.sellingPrice"),
      sortable: true,
      cell: (product) => formatMoney(product.sellingPrice, settings.currency),
    },
    {
      id: "costPrice",
      header: t("products.costPrice"),
      sortable: true,
      cell: (product) => formatMoney(product.costPrice, settings.currency),
    },
    {
      id: "status",
      header: t("common.status"),
      cell: (product) => {
        const assignedQty = getAssignedQuantity(product.productId);
        const availableQty = Math.max(0, product.quantity - assignedQty);
        const stockStatus = getStockStatus(availableQty, product.quantity);
        return <Badge variant={stockStatus.variant}>{stockStatus.label}</Badge>;
      },
    },
    {
      id: "actions",
      header: t("common.actions"),
      hideable: false,
      cell: (product) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("attachments.title", "Attachments")}
            onClick={() => setAttachmentsProduct(product)}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("common.edit", "Edit")}
              onClick={() => handleEdit(product)}
            >
              <Edit className="h-4 w-4" />
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("common.delete", "Delete")}
              onClick={() => handleDeleteClick(product.productId)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('products.title')}</h1>
          <p className="text-muted-foreground">
            {t('products.catalogDescription')}
          </p>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={handleExportProducts}>
            <Download className="me-2 h-4 w-4" />
            {t('bulkImport.export')}
          </Button>
          
          {canCreate && (
            <Button variant="outline" onClick={() => setIsImportDialogOpen(true)}>
              <Upload className="me-2 h-4 w-4" />
              {t('bulkImport.title')}
            </Button>
          )}
          
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            {canCreate && (
              <DialogTrigger asChild>
                <Button onClick={resetForm}>
                  <Plus className="me-2 h-4 w-4" />
                  {t('products.addProduct')}
                </Button>
              </DialogTrigger>
            )}
            <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingProduct ? t('products.editProduct') : t('products.addNewProduct')}
              </DialogTitle>
              <DialogDescription>
                {editingProduct 
                  ? t('products.editDescription')
                  : t('products.addDescription')
                }
              </DialogDescription>
            </DialogHeader>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="product_name">{t('products.productName')}</Label>
                  <Input
                    id="product_name"
                    value={formData.product_name}
                    onChange={(e) => setFormData({...formData, product_name: e.target.value})}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="product_sku">{t('products.sku')}</Label>
                  <Input
                    id="product_sku"
                    value={formData.product_sku}
                    onChange={(e) => setFormData({...formData, product_sku: e.target.value})}
                    required
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">{t('products.totalQuantity')}</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min={editingProduct ? getAssignedQuantity(editingProduct.productId) : 0}
                    value={formData.quantity}
                    onChange={(e) => setFormData({...formData, quantity: parseInt(e.target.value) || 0})}
                    required
                  />
                  {editingProduct && (
                    <span className="text-xs text-muted-foreground">
                      {t('products.minAssigned', { count: getAssignedQuantity(editingProduct.productId) })}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sellingPrice">{t('products.sellingPrice')}</Label>
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
                  <Label htmlFor="costPrice">{t('products.costPrice')}</Label>
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
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="brand">{t('products.brand')}</Label>
                  <TaxonomySelect
                    kind="brands"
                    id="brand"
                    value={formData.brand}
                    onChange={(v) => setFormData({...formData, brand: v})}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">{t('products.category')}</Label>
                  <TaxonomySelect
                    kind="categories"
                    id="category"
                    value={formData.category}
                    onChange={(v) => setFormData({...formData, category: v})}
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t("products.itemType", "Item Type")}</Label>
                  <Select
                    value={formData.itemType}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        itemType: v as "stock" | "non_stock" | "service" | "manufactured",
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stock">{t("products.types.stock", "Stock Item")}</SelectItem>
                      <SelectItem value="manufactured">{t("products.types.manufactured", "Manufactured")}</SelectItem>
                      <SelectItem value="non_stock">{t("products.types.non_stock", "Non-Stock")}</SelectItem>
                      <SelectItem value="service">{t("products.types.service", "Service")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("products.trackingMode", "Tracking Mode")}</Label>
                  <Select
                    value={formData.trackingMode}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        trackingMode: v as "none" | "lot" | "serial",
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("products.tracking.none", "None (Standard)")}</SelectItem>
                      <SelectItem value="lot">{t("products.tracking.lot", "Lot / Batch")}</SelectItem>
                      <SelectItem value="serial">{t("products.tracking.serial", "Serial Number")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {formData.trackingMode === "lot" && (
                <div className="grid grid-cols-3 gap-3 rounded-md border p-3 bg-muted/30">
                  <div className="space-y-1">
                    <Label className="text-xs">{t("products.pickingStrategy", "Picking")}</Label>
                    <Select
                      value={formData.pickingStrategy}
                      onValueChange={(v) =>
                        setFormData({ ...formData, pickingStrategy: v as "FEFO" | "FIFO" | "LIFO" })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FEFO">FEFO</SelectItem>
                        <SelectItem value="FIFO">FIFO</SelectItem>
                        <SelectItem value="LIFO">LIFO</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="shelfLifeDays">
                      {t("products.shelfLifeDays", "Shelf Life (days)")}
                    </Label>
                    <Input
                      id="shelfLifeDays"
                      type="number"
                      min={1}
                      className="h-8"
                      value={formData.shelfLifeDays ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          shelfLifeDays: e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null,
                        })
                      }
                      placeholder="Optional"
                    />
                  </div>
                  <div className="flex flex-col justify-between">
                    <Label className="text-xs" htmlFor="requiresExpiry">
                      {t("products.requiresExpiry", "Requires Expiry")}
                    </Label>
                    <div className="h-8 flex items-center">
                      <Switch
                        id="requiresExpiry"
                        checked={formData.requiresExpiry}
                        onCheckedChange={(v) => setFormData({ ...formData, requiresExpiry: v })}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">
                  {editingProduct ? t('common.update') : t('common.add')} {t('products.title').slice(0, -1)}
                </Button>
              </div>
            </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            <span>{t('products.productCatalog')}</span>
          </CardTitle>
          <CardDescription>
            {t('products.catalogInfo')}
          </CardDescription>
        </CardHeader>
        
        <CardContent>
          <EnterpriseDataTable
            data={filteredProducts}
            columns={productColumns}
            getRowId={(product) => product.productId}
            searchValue={searchTerm}
            onSearchChange={(val) => {
              setSearchTerm(val);
              setPage(1);
            }}
            searchPlaceholder={t("products.searchProducts")}
            selectable
            enableColumnVisibility
            savedViewsResource="products"
            exportResource="products"
            pageInfo={productsPage?.pageInfo}
            onPageChange={setPage}
            isRowExpanded={(product) => expandedProducts.has(product.productId)}
            renderRowExpansion={(product) => {
              const branchAssignments = getBranchAssignments(product.productId);
              return (
                <div className="ps-4 space-y-2 py-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {t("products.branchAssignments")}
                    </p>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => setLedgerProduct(product)}
                          >
                            <FileText className="h-4 w-4" />
                            {t("movements.viewLedger")}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("movements.stockLedger")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                    {branchAssignments.map((assignment) => (
                      <div
                        key={`${assignment.productId}-${assignment.branchId}`}
                        className="flex items-center justify-between bg-background rounded-md px-3 py-2 border"
                      >
                        <span className="text-sm">{assignment.branchName}</span>
                        <Badge variant="secondary" className="ms-2">
                          {assignment.quantity}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }}
            testId="products-data-table"
          />
        </CardContent>
      </Card>

      {/* Product Attachments Dialog */}
      <Dialog open={attachmentsProduct !== null} onOpenChange={(open) => !open && setAttachmentsProduct(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {attachmentsProduct && (
            <>
              <DialogHeader>
                <DialogTitle>{attachmentsProduct.product_name}</DialogTitle>
                <DialogDescription>{attachmentsProduct.product_sku}</DialogDescription>
              </DialogHeader>
              <AttachmentsPanel entityType="product" entityId={attachmentsProduct.productId} />
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Product Ledger Dialog */}
      {ledgerProduct && (
        <ProductLedgerDialog
          open={!!ledgerProduct}
          onOpenChange={(open) => !open && setLedgerProduct(null)}
          productId={ledgerProduct.productId}
          productName={ledgerProduct.product_name}
          productSku={ledgerProduct.product_sku}
        />
      )}

      {/* Bulk Import Dialog */}
      {isImportDialogOpen && (
        <Suspense fallback={null}>
          <BulkImportDialog
            open={isImportDialogOpen}
            onOpenChange={setIsImportDialogOpen}
            title={t('bulkImport.importProducts')}
            description={t('bulkImport.productsDescription')}
            columns={productImportColumns}
            templateFileName="products_import_template.xlsx"
            onConfirmImport={handleProductImport}
          />
        </Suspense>
      )}

      <ConfirmDeleteDialog
        open={deleteProductId !== null}
        onOpenChange={(open) => !open && setDeleteProductId(null)}
        onConfirm={handleConfirmDelete}
        itemName={products.find(p => p.productId === deleteProductId)?.product_name}
      />
    </div>
  );
};

export default Products;