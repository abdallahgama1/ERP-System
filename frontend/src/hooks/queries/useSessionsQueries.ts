import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import type { Branch, Product, Session, SessionItem } from "@/types";
import { erpQueryKeys } from "./queryKeys";

export interface ApiSessionItem {
  id: string;
  productId: string;
  expectedQty: number;
  countedQty: number;
  variance: number;
  scannedCount: number;
  notes: string;
}

export interface ApiSession {
  id: string;
  sessionNumber: string;
  branchId: string;
  name: string;
  status: "In Progress" | "Completed" | "Cancelled";
  notes: string;
  adjustmentId: string | null;
  createdByUserId: string | null;
  createdByName: string;
  completedAt: string | null;
  createdAt: string;
  items: ApiSessionItem[];
}

export function mapApiSession(
  s: ApiSession,
  branchMap?: Map<string, Branch>,
  productMap?: Map<string, Product>
): { session: Session; items: SessionItem[] } {
  const session: Session = {
    id: s.id,
    sessionNumber: s.sessionNumber,
    createdByUserId: s.createdByUserId ?? "",
    createdByName: s.createdByName,
    branchId: s.branchId,
    branchName: branchMap?.get(s.branchId)?.branch_name,
    name: s.name,
    description: s.notes || s.name,
    status: s.status,
    adjustmentId: s.adjustmentId ?? undefined,
    completedAt: s.completedAt ?? undefined,
    createdAt: s.createdAt,
    updatedAt: s.completedAt ?? s.createdAt,
  };

  const items: SessionItem[] = (s.items ?? []).map((item) => {
    const prod = productMap?.get(item.productId);
    const diff = item.countedQty - item.expectedQty;
    return {
      productId: item.productId,
      sessionId: s.id,
      product_name: prod?.product_name ?? "Product",
      product_sku: prod?.product_sku ?? "",
      quantity: item.countedQty,
      expectedQty: item.expectedQty,
      sellingPrice: prod?.sellingPrice ?? 0,
      costPrice: prod?.costPrice ?? 0,
      variance: item.variance,
      status: diff === 0 ? "Exact" : diff > 0 ? "Over Count" : "Under Count",
    };
  });

  return { session, items };
}

export function useSessionsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sessions.list(),
    queryFn: () => apiRequest<{ sessions: ApiSession[] }>("/api/sessions"),
    enabled: Boolean(user) && enabled,
  });
}

export function useSessionDetailQuery(sessionId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sessions.list(),
    queryFn: () => apiRequest<{ sessions: ApiSession[] }>("/api/sessions"),
    select: (res) => res.sessions.find((s) => s.id === sessionId) ?? null,
    enabled: Boolean(user) && Boolean(sessionId),
  });
}

export function useSessionsMutations() {
  const queryClient = useQueryClient();

  const invalidateSessions = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sessions.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const createSession = useMutation({
    mutationFn: (body: { branchId: string; name: string; notes?: string; productIds?: string[] }) =>
      apiRequest<{ session: ApiSession }>("/api/sessions", { method: "POST", body }),
    onSuccess: invalidateSessions,
  });

  const updateSession = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { branchId?: string; name?: string; notes?: string; status?: "In Progress" | "Cancelled" };
    }) => apiRequest<{ session: ApiSession }>(`/api/sessions/${id}`, { method: "PATCH", body }),
    onSuccess: invalidateSessions,
  });

  const cancelSession = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sessions/${id}/cancel`, { method: "POST" }),
    onSuccess: invalidateSessions,
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sessions/${id}`, { method: "DELETE" }),
    onSuccess: invalidateSessions,
  });

  const upsertSessionItems = useMutation({
    mutationFn: ({
      id,
      items,
    }: {
      id: string;
      items: Array<{ productId: string; countedQty: number; scannedCount?: number; notes?: string }>;
    }) => apiRequest(`/api/sessions/${id}/items`, { method: "PUT", body: { items } }),
    onSuccess: invalidateSessions,
  });

  const removeSessionItem = useMutation({
    mutationFn: ({ id, productId }: { id: string; productId: string }) =>
      apiRequest(`/api/sessions/${id}/items/${productId}`, { method: "DELETE" }),
    onSuccess: invalidateSessions,
  });

  const completeSession = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sessions/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      invalidateSessions();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  return {
    createSession,
    updateSession,
    cancelSession,
    deleteSession,
    upsertSessionItems,
    removeSessionItem,
    completeSession,
  };
}
