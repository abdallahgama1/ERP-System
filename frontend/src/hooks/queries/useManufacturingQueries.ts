import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface BomComponentRow {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string;
  unitCost: number;
  quantity: number;
  scrapPercent: number;
  notes: string;
}

export interface BomRow {
  id: string;
  bomNumber: string;
  productId: string;
  productName: string;
  productSku: string;
  name: string;
  outputQty: number;
  isActive: boolean;
  notes: string;
  createdAt: string;
  components: BomComponentRow[];
}

export interface WorkOrderMaterialRow {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string;
  trackingMode: "none" | "lot" | "serial";
  requiredQty: number;
  issuedQty: number;
  unitCostSnapshot: number;
}

export interface WorkOrderRow {
  id: string;
  woNumber: string;
  bomId: string;
  bomNumber: string;
  bomName: string;
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  productSku: string;
  productTrackingMode: "none" | "lot" | "serial";
  plannedQty: number;
  completedQty: number;
  status: "Draft" | "Released" | "In Progress" | "Completed" | "Cancelled";
  wipValueIssued: number;
  wipValueAbsorbed: number;
  wipBalance: number;
  notes: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  materials: WorkOrderMaterialRow[];
}

export function useBomsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.manufacturing.boms(),
    queryFn: () => apiRequest<{ boms: BomRow[] }>("/api/manufacturing/boms"),
    enabled: Boolean(user),
  });
}

export function useWorkOrdersQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.manufacturing.workOrders(),
    queryFn: () => apiRequest<{ workOrders: WorkOrderRow[] }>("/api/manufacturing/work-orders"),
    enabled: Boolean(user),
  });
}

export function useCreateBomMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      productId: string;
      name: string;
      outputQty: number;
      isActive?: boolean;
      notes?: string;
      components: Array<{ componentProductId: string; quantity: number; scrapPercent?: number; notes?: string }>;
    }) => apiRequest("/api/manufacturing/boms", { method: "POST", body: payload }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: erpQueryKeys.manufacturing.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    },
  });
}

export function useCreateWorkOrderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      bomId: string;
      branchId: string;
      plannedQty: number;
      status?: "Draft" | "Released";
      notes?: string;
    }) => apiRequest("/api/manufacturing/work-orders", { method: "POST", body: payload }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: erpQueryKeys.manufacturing.all });
    },
  });
}

export function useIssueWorkOrderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; notes?: string }) =>
      apiRequest(`/api/manufacturing/work-orders/${payload.id}/issue`, {
        method: "POST",
        body: { notes: payload.notes ?? "" },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: erpQueryKeys.manufacturing.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.tracking.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });
}

export function useCompleteWorkOrderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      id: string;
      qtyCompleted: number;
      notes?: string;
      lotNumber?: string;
      expiryDate?: string | null;
      serialNumbers?: string[];
    }) =>
      apiRequest(`/api/manufacturing/work-orders/${payload.id}/complete`, {
        method: "POST",
        body: {
          qtyCompleted: payload.qtyCompleted,
          notes: payload.notes ?? "",
          ...(payload.lotNumber ? { lotNumber: payload.lotNumber } : {}),
          ...(payload.expiryDate ? { expiryDate: payload.expiryDate } : {}),
          ...(payload.serialNumbers && payload.serialNumbers.length > 0
            ? { serialNumbers: payload.serialNumbers }
            : {}),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: erpQueryKeys.manufacturing.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.tracking.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });
}

export function useCancelWorkOrderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; reason?: string }) =>
      apiRequest(`/api/manufacturing/work-orders/${payload.id}/cancel`, {
        method: "POST",
        body: { reason: payload.reason ?? "Cancelled" },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: erpQueryKeys.manufacturing.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
      void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });
}
