import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type {
  AdjustmentReason,
  StockMovementType,
  TransferShortageResolution,
  TransferStatus,
  WriteOffReason,
} from "@/types";

export interface ApiBranchRow {
  id: string;
  code: string;
  name: string;
  branchType: "hq_warehouse" | "warehouse" | "retail";
  location: string;
  phone: string;
  isDefault: boolean;
  isActive: boolean;
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

export function useBranchesDirectoryQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.branchesDirectory,
    queryFn: () => apiRequest<{ branches: ApiBranchRow[] }>("/api/branches?scope=directory"),
    enabled: Boolean(user),
  });
}

export function useProductsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.products(),
    queryFn: () =>
      apiRequest<{ products: ApiProductRow[]; branchProducts: ApiBranchProductRow[] }>("/api/products"),
    enabled: Boolean(user),
  });
}

export function useMovementsQuery(branchId?: string, productId?: string) {
  const { user } = useAuth();
  const params = new URLSearchParams();
  if (branchId && branchId !== "all") params.set("branchId", branchId);
  if (productId) params.set("productId", productId);
  else params.set("limit", "500");
  const qs = params.toString();

  return useQuery({
    queryKey: erpQueryKeys.inventory.movements(branchId, productId),
    queryFn: () => apiRequest<{ movements: ApiMovementRow[] }>(`/api/movements${qs ? `?${qs}` : ""}`),
    enabled: Boolean(user),
  });
}

export function useAdjustmentsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.adjustments(),
    queryFn: () => apiRequest<{ adjustments: ApiAdjustmentHeader[] }>("/api/adjustments"),
    enabled: Boolean(user),
  });
}

export function useWriteOffsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.writeOffs(),
    queryFn: () => apiRequest<{ writeOffs: ApiWriteOffHeader[] }>("/api/write-offs"),
    enabled: Boolean(user),
  });
}

export function useTransfersQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.inventory.transfers(),
    queryFn: () => apiRequest<{ transfers: ApiTransferHeader[] }>("/api/transfers"),
    enabled: Boolean(user),
  });
}
