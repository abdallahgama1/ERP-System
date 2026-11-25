import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CursorPageInfo, OffsetPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type {
  Adjustment,
  AdjustmentReason,
  Branch,
  BranchProduct,
  Product,
  StockMovement,
  StockMovementType,
  Transfer,
  TransferShortageResolution,
  TransferStatus,
  WriteOff,
  WriteOffReason,
} from "@/types";

export interface ApiBranchRow {
  id: string;
  code: string;
  name: string;
  branchType: "hq_warehouse" | "warehouse" | "retail";
  location: string;
  phone: string;
  etaBranchId?: string;
  country?: string;
  governorate?: string;
  regionCity?: string;
  street?: string;
  buildingNumber?: string;
  postalCode?: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface ApiBranchFullRow extends ApiBranchRow {
  address?: string;
  email?: string;
  managerName?: string;
}

export interface ApiProductRow {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  brand: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  minStockLevel: number;
  itemType?: "stock" | "non_stock" | "service" | "manufactured";
  trackingMode?: "none" | "lot" | "serial";
  requiresExpiry?: boolean;
  shelfLifeDays?: number | null;
  pickingStrategy?: "FEFO" | "FIFO" | "LIFO";
  etaCodeType?: "EGS" | "GS1";
  etaItemCode?: string;
  etaUnitType?: string;
  hasBom?: boolean;
  totalQuantity: number;
}

export interface ApiBranchProductRow {
  id: string;
  branchId: string;
  productId: string;
  quantity: number;
  avgCost: number;
  costPrice: number;
  sellingPrice: number;
  productName: string;
  productSku: string;
}

export interface ApiMovementRow {
  id: string;
  branchId: string;
  productId: string;
  type: StockMovementType;
  qtyDelta: number;
  unitCost: number;
  balanceAfter: number;
  referenceNumber: string;
  notes: string;
  createdAt: string;
}

export interface ApiAdjustmentHeader {
  id: string;
  adjustmentNumber: string;
  branchId: string;
  reason: AdjustmentReason;
  notes: string;
  createdByName: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    qtyDelta: number;
    previousQty: number;
    newQty: number;
    notes: string;
  }>;
}

export interface ApiWriteOffHeader {
  id: string;
  writeOffNumber: string;
  branchId: string;
  reason: WriteOffReason;
  notes: string;
  createdByName: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    quantity: number;
    totalValue: number;
    notes: string;
  }>;
}

export interface ApiTransferHeader {
  id: string;
  transferNumber: string;
  fromBranchId: string;
  toBranchId: string;
  status: TransferStatus | "Partial";
  shortageResolution: TransferShortageResolution | "backorder" | "close_short" | "claim_carrier" | null;
  notes: string;
  createdByName: string;
  shippedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    qtySent: number;
    qtyReceived: number;
  }>;
}

// ============================================================================
// Pure Mappers & Domain Computation Helpers
// ============================================================================

export function mapApiBranch(b: ApiBranchRow | ApiBranchFullRow): Branch {
  return {
    branchId: b.id,
    branch_name: b.name,
    branch_location: b.location || "",
    contact_number: b.phone || "",
    code: b.code,
    branchType: b.branchType,
    etaBranchId: b.etaBranchId ?? "0",
    country: b.country ?? "EG",
    governorate: b.governorate ?? "",
    regionCity: b.regionCity ?? "",
    street: b.street ?? "",
    buildingNumber: b.buildingNumber ?? "",
    postalCode: b.postalCode ?? "",
    isDefault: b.isDefault,
    isActive: b.isActive,
  };
}

export function mapApiProduct(p: ApiProductRow): Product {
  return {
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
    etaCodeType: p.etaCodeType ?? "EGS",
    etaItemCode: p.etaItemCode ?? "",
    etaUnitType: p.etaUnitType ?? "EA",
    hasBom: p.hasBom ?? false,
  };
}

export function mapApiBranchProduct(
  bp: ApiBranchProductRow,
  productMap?: Map<string, Product>
): BranchProduct {
  const prod = productMap?.get(bp.productId);
  return {
    productId: bp.productId,
    branchId: bp.branchId,
    product_name: bp.productName || prod?.product_name || "",
    product_sku: bp.productSku || prod?.product_sku || "",
    quantity: bp.quantity,
    avgCost: bp.avgCost,
    sellingPrice: bp.sellingPrice || prod?.sellingPrice || 0,
    costPrice: bp.avgCost || bp.costPrice || prod?.costPrice || 0,
  };
}

export function mapApiMovement(
  m: ApiMovementRow,
  productMap?: Map<string, Product>,
  branchMap?: Map<string, Branch>
): StockMovement {
  const prod = productMap?.get(m.productId);
  const br = m.branchId ? branchMap?.get(m.branchId) : undefined;
  return {
    id: m.id,
    productId: m.productId,
    branchId: m.branchId || undefined,
    product_name: prod?.product_name ?? "",
    product_sku: prod?.product_sku ?? "",
    branchName: br?.branch_name,
    type: m.type,
    quantity: m.qtyDelta,
    unitCost: m.unitCost,
    reference: m.referenceNumber || undefined,
    notes: m.notes || undefined,
    createdAt: m.createdAt,
    balanceAfter: m.balanceAfter,
  };
}

export function mapApiAdjustments(
  rows: ApiAdjustmentHeader[],
  productMap?: Map<string, Product>,
  branchMap?: Map<string, Branch>
): Adjustment[] {
  const out: Adjustment[] = [];
  for (const h of rows) {
    const br = branchMap?.get(h.branchId);
    for (const l of h.lines ?? []) {
      const prod = productMap?.get(l.productId);
      out.push({
        id: `${h.id}:${l.id}`,
        reference: h.adjustmentNumber,
        productId: l.productId,
        product_name: prod?.product_name ?? "",
        product_sku: prod?.product_sku ?? "",
        branchId: h.branchId,
        branchName: br?.branch_name ?? "",
        beforeQty: l.previousQty,
        newQty: l.newQty,
        delta: l.qtyDelta,
        reason: h.reason,
        note: l.notes || h.notes || undefined,
        createdAt: h.createdAt,
        createdBy: h.createdByName,
      });
    }
  }
  return out;
}

export function mapApiWriteOffs(
  rows: ApiWriteOffHeader[],
  productMap?: Map<string, Product>,
  branchMap?: Map<string, Branch>
): WriteOff[] {
  const out: WriteOff[] = [];
  for (const h of rows) {
    const br = branchMap?.get(h.branchId);
    for (const l of h.lines ?? []) {
      const prod = productMap?.get(l.productId);
      out.push({
        id: `${h.id}:${l.id}`,
        reference: h.writeOffNumber,
        productId: l.productId,
        product_name: prod?.product_name ?? "",
        product_sku: prod?.product_sku ?? "",
        branchId: h.branchId,
        branchName: br?.branch_name ?? "",
        quantity: l.quantity,
        reason: h.reason,
        note: l.notes || h.notes || undefined,
        costImpact: l.totalValue,
        createdAt: h.createdAt,
        createdBy: h.createdByName,
      });
    }
  }
  return out;
}

export function mapApiTransfer(
  t: ApiTransferHeader,
  productMap?: Map<string, Product>,
  branchMap?: Map<string, Branch>
): Transfer {
  return {
    id: t.id,
    reference: t.transferNumber,
    sourceBranchId: t.fromBranchId,
    sourceBranchName: branchMap?.get(t.fromBranchId)?.branch_name ?? "",
    destBranchId: t.toBranchId,
    destBranchName: branchMap?.get(t.toBranchId)?.branch_name ?? "",
    status: t.status === "Partial" ? "In Transit" : t.status,
    shortageResolution:
      t.shortageResolution === "return_to_source" ||
      t.shortageResolution === "write_off_in_transit" ||
      t.shortageResolution === "none"
        ? t.shortageResolution
        : undefined,
    notes: t.notes || undefined,
    createdAt: t.createdAt,
    createdBy: t.createdByName,
    dispatchedAt: t.shippedAt ?? undefined,
    receivedAt: t.receivedAt ?? undefined,
    items: (t.lines ?? []).map((l) => {
      const prod = productMap?.get(l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: prod?.product_name ?? "",
        product_sku: prod?.product_sku ?? "",
        quantity: l.qtySent,
        receivedQty: l.qtyReceived,
      };
    }),
  };
}

export function computeAssignedQuantity(productId: string, branchProducts: BranchProduct[]): number {
  return branchProducts.filter((bp) => bp.productId === productId).reduce((sum, bp) => sum + bp.quantity, 0);
}

export function computeAvailableQuantity(
  productId: string,
  products: Product[],
  branchProducts: BranchProduct[]
): number {
  const prod = products.find((p) => p.productId === productId);
  if (!prod) return 0;
  return Math.max(0, prod.quantity - computeAssignedQuantity(productId, branchProducts));
}

export function computeInTransitQty(productId: string, transfers: Transfer[]): number {
  return transfers
    .filter((t) => t.status === "In Transit")
    .reduce(
      (sum, t) =>
        sum +
        t.items
          .filter((i) => i.productId === productId)
          .reduce((ls, i) => ls + Math.max(0, i.quantity - i.receivedQty), 0),
      0
    );
}

// ============================================================================
// Query Hooks
// ============================================================================

export function useBranchesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.branches,
    queryFn: () => apiRequest<{ branches: ApiBranchFullRow[] }>("/api/branches"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useBranchesDirectoryQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.branchesDirectory,
    queryFn: () => apiRequest<{ branches: ApiBranchRow[] }>("/api/branches?scope=directory"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useProductsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.products(),
    queryFn: () =>
      apiRequest<{ products: ApiProductRow[]; branchProducts: ApiBranchProductRow[] }>("/api/products"),
    enabled: Boolean(user) && enabled,
  });
}

export function useProductsDirectoryQuery(q?: string, enabled = true) {
  const { user } = useAuth();
  const trimmed = q?.trim() ?? "";
  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (trimmed) params.set("q", trimmed);

  return useQuery({
    queryKey: erpQueryKeys.inventory.productsDirectory(trimmed),
    queryFn: () =>
      apiRequest<{
        items?: ApiProductRow[];
        products: ApiProductRow[];
        branchProducts: ApiBranchProductRow[];
      }>(`/api/products?${params.toString()}`),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export interface ProductsPageFilters {
  page?: number;
  pageSize?: number;
  q?: string;
  category?: string;
  branchId?: string;
}

export function useProductsPageQuery(filters: ProductsPageFilters = {}, enabled = true) {
  const { user } = useAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (filters.category && filters.category !== "all") params.set("category", filters.category);
  if (filters.branchId && filters.branchId !== "all") params.set("branchId", filters.branchId);
  if (filters.q?.trim()) params.set("q", filters.q.trim());

  return useQuery({
    queryKey: [
      ...erpQueryKeys.inventory.products(),
      "page",
      {
        page,
        pageSize,
        category: filters.category ?? "all",
        branchId: filters.branchId ?? "all",
        q: filters.q?.trim() ?? "",
      },
    ],
    queryFn: () =>
      apiRequest<{
        items: ApiProductRow[];
        products: ApiProductRow[];
        branchProducts: ApiBranchProductRow[];
        pageInfo: OffsetPageInfo;
      }>(`/api/products?${params.toString()}`),
    placeholderData: keepPreviousData,
    enabled: Boolean(user) && enabled,
  });
}

export function useMovementsQuery(branchId?: string, productId?: string, enabled = true) {
  const { user } = useAuth();
  const params = new URLSearchParams();
  if (branchId && branchId !== "all") params.set("branchId", branchId);
  if (productId) params.set("productId", productId);
  else params.set("limit", "500");
  const qs = params.toString();

  return useQuery({
    queryKey: erpQueryKeys.inventory.movements(branchId, productId),
    queryFn: () => apiRequest<{ movements: ApiMovementRow[] }>(`/api/movements${qs ? `?${qs}` : ""}`),
    enabled: Boolean(user) && enabled,
  });
}

export interface MovementsCursorFilters {
  branchId?: string;
  productId?: string;
  movementType?: string;
  q?: string;
  limit?: number;
}

export function useMovementsCursorQuery(filters: MovementsCursorFilters = {}, enabled = true) {
  const { user } = useAuth();
  const limit = filters.limit ?? 50;

  return useInfiniteQuery({
    queryKey: [
      "inventory",
      "movements",
      "cursor",
      {
        branchId: filters.branchId ?? "all",
        productId: filters.productId ?? "all",
        movementType: filters.movementType ?? "all",
        q: filters.q?.trim() ?? "",
        limit,
      },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (pageParam) params.set("cursor", pageParam);
      if (filters.branchId && filters.branchId !== "all") params.set("branchId", filters.branchId);
      if (filters.productId) params.set("productId", filters.productId);
      if (filters.movementType && filters.movementType !== "all") {
        params.set("movementType", filters.movementType);
      }
      if (filters.q?.trim()) params.set("q", filters.q.trim());
      return apiRequest<{ movements: ApiMovementRow[]; items: ApiMovementRow[]; pageInfo: CursorPageInfo }>(
        `/api/movements?${params.toString()}`
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? (lastPage.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: Boolean(user) && enabled,
  });
}

export function useAdjustmentsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.adjustments(),
    queryFn: () => apiRequest<{ adjustments: ApiAdjustmentHeader[] }>("/api/adjustments"),
    enabled: Boolean(user) && enabled,
  });
}

export function useWriteOffsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.writeOffs(),
    queryFn: () => apiRequest<{ writeOffs: ApiWriteOffHeader[] }>("/api/write-offs"),
    enabled: Boolean(user) && enabled,
  });
}

export function useTransfersQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.transfers(),
    queryFn: () => apiRequest<{ transfers: ApiTransferHeader[] }>("/api/transfers"),
    enabled: Boolean(user) && enabled,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useInventoryMutations() {
  const queryClient = useQueryClient();

  const invalidateInventory = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.tracking.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const invalidateBranches = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.branches });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.branchesDirectory });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const createProduct = useMutation({
    mutationFn: (body: {
      sku: string;
      name: string;
      category: string;
      brand: string;
      unit?: string;
      costPrice: number;
      sellingPrice: number;
      minStockLevel?: number;
      barcode?: string | null;
      itemType?: "stock" | "non_stock" | "service" | "manufactured";
      trackingMode?: "none" | "lot" | "serial";
      requiresExpiry?: boolean;
      shelfLifeDays?: number | null;
      pickingStrategy?: "FEFO" | "FIFO" | "LIFO";
      initialStock?: Array<{ branchId: string; quantity: number; unitCost: number }>;
    }) => apiRequest<{ product: ApiProductRow }>("/api/products", { method: "POST", body }),
    onSuccess: invalidateInventory,
  });

  const updateProduct = useMutation({
    mutationFn: ({
      productId,
      body,
    }: {
      productId: string;
      body: {
        sku?: string;
        name?: string;
        category?: string;
        brand?: string;
        unit?: string;
        costPrice?: number;
        sellingPrice?: number;
        minStockLevel?: number;
        barcode?: string | null;
        itemType?: "stock" | "non_stock" | "service" | "manufactured";
        trackingMode?: "none" | "lot" | "serial";
        requiresExpiry?: boolean;
        shelfLifeDays?: number | null;
        pickingStrategy?: "FEFO" | "FIFO" | "LIFO";
      };
    }) => apiRequest<{ product: ApiProductRow }>(`/api/products/${productId}`, { method: "PUT", body }),
    onSuccess: invalidateInventory,
  });

  const deleteProduct = useMutation({
    mutationFn: (productId: string) => apiRequest<{ ok: boolean }>(`/api/products/${productId}`, { method: "DELETE" }),
    onSuccess: invalidateInventory,
  });

  const createBranch = useMutation({
    mutationFn: (body: {
      name: string;
      location: string;
      phone: string;
      branchType?: "hq_warehouse" | "warehouse" | "retail";
      code?: string;
      address?: string;
      email?: string;
      managerName?: string;
    }) => apiRequest<{ branch: ApiBranchFullRow }>("/api/branches", { method: "POST", body }),
    onSuccess: invalidateBranches,
  });

  const updateBranch = useMutation({
    mutationFn: ({
      branchId,
      body,
    }: {
      branchId: string;
      body: {
        name?: string;
        location?: string;
        phone?: string;
        branchType?: "hq_warehouse" | "warehouse" | "retail";
        address?: string;
        email?: string;
        managerName?: string;
        isActive?: boolean;
      };
    }) => apiRequest<{ branch: ApiBranchFullRow }>(`/api/branches/${branchId}`, { method: "PUT", body }),
    onSuccess: invalidateBranches,
  });

  const deleteBranch = useMutation({
    mutationFn: (branchId: string) => apiRequest<{ ok: boolean }>(`/api/branches/${branchId}`, { method: "DELETE" }),
    onSuccess: invalidateBranches,
  });

  const adjustBranchLevel = useMutation({
    mutationFn: (body: {
      productId: string;
      branchId: string;
      newQuantity: number;
      unitCost?: number;
      sellingPrice?: number;
      notes?: string;
    }) => apiRequest("/api/branch-products/adjust-level", { method: "POST", body }),
    onSuccess: invalidateInventory,
  });

  const createAdjustment = useMutation({
    mutationFn: (body: {
      branchId: string;
      reason: AdjustmentReason;
      notes?: string;
      lines: Array<{ productId: string; newQty: number; notes?: string }>;
    }) =>
      apiRequest<{ adjustment: { id: string; adjustmentNumber: string; createdAt: string } }>("/api/adjustments", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidateInventory();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.approvals.all });
    },
  });

  const createWriteOff = useMutation({
    mutationFn: (body: {
      branchId: string;
      reason: WriteOffReason;
      notes?: string;
      lines: Array<{
        productId: string;
        quantity: number;
        notes?: string;
        lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
        serialNumbers?: string[];
      }>;
    }) =>
      apiRequest<{ writeOff: { id: string; writeOffNumber: string; createdAt: string } }>("/api/write-offs", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidateInventory();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.approvals.all });
    },
  });

  const createTransfer = useMutation({
    mutationFn: (body: {
      fromBranchId: string;
      toBranchId: string;
      status?: TransferStatus;
      notes?: string;
      lines: Array<{
        productId: string;
        quantity: number;
        lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
        serialNumbers?: string[];
      }>;
    }) =>
      apiRequest<{ transfer: { id: string; transferNumber: string; createdAt: string } }>("/api/transfers", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidateInventory();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.approvals.all });
    },
  });

  const dispatchTransfer = useMutation({
    mutationFn: (transferId: string) => apiRequest(`/api/transfers/${transferId}/dispatch`, { method: "POST" }),
    onSuccess: invalidateInventory,
  });

  const receiveTransfer = useMutation({
    mutationFn: ({
      transferId,
      items,
      shortageResolution,
      notes,
    }: {
      transferId: string;
      items: Array<{ productId: string; qtyReceived: number }>;
      shortageResolution?: TransferShortageResolution;
      notes?: string;
    }) =>
      apiRequest(`/api/transfers/${transferId}/receive`, {
        method: "POST",
        body: { items, shortageResolution: shortageResolution ?? "none", notes },
      }),
    onSuccess: invalidateInventory,
  });

  const cancelTransfer = useMutation({
    mutationFn: (transferId: string) => apiRequest(`/api/transfers/${transferId}/cancel`, { method: "POST" }),
    onSuccess: invalidateInventory,
  });

  return {
    createProduct,
    updateProduct,
    deleteProduct,
    createBranch,
    updateBranch,
    deleteBranch,
    adjustBranchLevel,
    createAdjustment,
    createWriteOff,
    createTransfer,
    dispatchTransfer,
    receiveTransfer,
    cancelTransfer,
  };
}
