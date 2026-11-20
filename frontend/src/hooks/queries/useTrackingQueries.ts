import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface LotBalanceRow {
  id: string;
  lotId: string;
  lotNumber: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  productSku: string;
  manufactureDate: string | null;
  expiryDate: string | null;
  expiryStatus: "valid" | "expiring_soon" | "expired" | "no_expiry";
  unitCost: number;
  qtyOnHand: number;
  qtyReserved: number;
  createdAt: string;
}

export interface SerialNumberRow {
  id: string;
  serialNumber: string;
  productId: string;
  productName: string;
  productSku: string;
  branchId: string | null;
  branchName: string;
  status: "in_stock" | "reserved" | "in_transit" | "sold" | "returned" | "written_off" | "consumed";
  unitCost: number;
  receivedFromType: string | null;
  receivedFromId: string | null;
  soldInvoiceId: string | null;
  workOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerialTraceResponse {
  serial: {
    id: string;
    serialNumber: string;
    productId: string;
    productName: string;
    productSku: string;
    branchId: string | null;
    status: string;
    unitCost: number;
    createdAt: string;
  };
  history: Array<{
    allocationId: string;
    movementId: string;
    movementType: string;
    branchId: string;
    branchName: string | null;
    qtyDelta: number;
    unitCost: number;
    referenceType: string | null;
    referenceNumber: string | null;
    notes: string;
    createdAt: string;
  }>;
}

export function useLotsQuery(branchId?: string, productId?: string, includeZero = false) {
  const { user } = useAuth();
  const params = new URLSearchParams();
  if (branchId && branchId !== "all") params.set("branchId", branchId);
  if (productId) params.set("productId", productId);
  if (includeZero) params.set("includeZero", "true");
  const qs = params.toString();

  return useQuery({
    queryKey: erpQueryKeys.tracking.lots(branchId, productId),
    queryFn: () => apiRequest<{ lots: LotBalanceRow[] }>(`/api/tracking/lots${qs ? `?${qs}` : ""}`),
    enabled: Boolean(user),
  });
}

export function useSerialsQuery(branchId?: string, status?: string, search?: string) {
  const { user } = useAuth();
  const params = new URLSearchParams();
  if (branchId && branchId !== "all") params.set("branchId", branchId);
  if (status && status !== "all") params.set("status", status);
  if (search?.trim()) params.set("search", search.trim());
  const qs = params.toString();

  return useQuery({
    queryKey: erpQueryKeys.tracking.serials(branchId, status, search),
    queryFn: () => apiRequest<{ serials: SerialNumberRow[] }>(`/api/tracking/serials${qs ? `?${qs}` : ""}`),
    enabled: Boolean(user),
  });
}

export function useSerialTraceQuery(serialId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.tracking.serialTrace(serialId ?? ""),
    queryFn: () => apiRequest<SerialTraceResponse>(`/api/tracking/serials/${serialId}/trace`),
    enabled: Boolean(user) && Boolean(serialId),
  });
}
