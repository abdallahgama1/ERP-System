import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { useBranch } from "@/contexts/BranchContext";
import { erpQueryKeys } from "./queryKeys";
import { useProductsQuery } from "./useInventoryQueries";
import { useSessionsQuery } from "./useSessionsQueries";
import type { Product, Session, SessionItem } from "@/types";

export function useSessionsScope(options: { includeProducts?: boolean } = {}) {
  const { user } = useAuth();
  const { branches: shellBranches } = useBranch();
  const queryClient = useQueryClient();

  const sessionsQuery = useSessionsQuery(true);
  const productsQuery = useProductsQuery(Boolean(options.includeProducts));

  const refreshSessions = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.sessions.all });
  }, [queryClient]);

  const refreshInventory = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
  }, [queryClient]);

  const { sessions, sessionItems } = useMemo(() => {
    const branchMap = new Map(shellBranches.map((b) => [b.id, b.name]));
    const productMap = new Map((productsQuery.data?.products ?? []).map((p) => [p.id, p]));

    const mappedSessions: Session[] = [];
    const mappedItems: SessionItem[] = [];

    for (const s of sessionsQuery.data?.sessions ?? []) {
      mappedSessions.push({
        id: s.id,
        sessionNumber: s.sessionNumber,
        createdByUserId: s.createdByUserId ?? "",
        createdByName: s.createdByName,
        branchId: s.branchId,
        branchName: branchMap.get(s.branchId),
        name: s.name,
        description: s.notes || s.name,
        status: s.status,
        adjustmentId: s.adjustmentId ?? undefined,
        completedAt: s.completedAt ?? undefined,
        createdAt: s.createdAt,
        updatedAt: s.completedAt ?? s.createdAt,
      });

      for (const item of s.items ?? []) {
        const prod = productMap.get(item.productId);
        const diff = item.countedQty - item.expectedQty;
        mappedItems.push({
          productId: item.productId,
          sessionId: s.id,
          product_name: prod?.name ?? "Product",
          product_sku: prod?.sku ?? "",
          quantity: item.countedQty,
          expectedQty: item.expectedQty,
          sellingPrice: prod?.sellingPrice ?? 0,
          costPrice: prod?.costPrice ?? 0,
          variance: item.variance,
          status: diff === 0 ? "Exact" : diff > 0 ? "Over Count" : "Under Count",
        });
      }
    }

    return { sessions: mappedSessions, sessionItems: mappedItems };
  }, [sessionsQuery.data, shellBranches, productsQuery.data]);

  const branchProducts = useMemo(
    () => productsQuery.data?.branchProducts ?? [],
    [productsQuery.data]
  );

  const getSession = useCallback(
    (sessionId: string) => sessions.find((s) => s.id === sessionId),
    [sessions]
  );

  const getSessionItems = useCallback(
    (sessionId: string) => sessionItems.filter((i) => i.sessionId === sessionId),
    [sessionItems]
  );

  const createSession = useCallback(
    async ({
      branchId,
      description,
      name,
    }: {
      branchId: string;
      description?: string;
      name?: string;
    }): Promise<{ ok: true; session: Session } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{
          session: { id: string; sessionNumber: string; createdAt: string; name: string };
        }>("/api/sessions", {
          method: "POST",
          body: {
            branchId,
            name: name?.trim() || description?.trim() || `Count ${new Date().toLocaleDateString()}`,
            notes: description?.trim() ?? "",
          },
        });
        await refreshSessions();
        const created: Session = {
          id: res.session.id,
          sessionNumber: res.session.sessionNumber,
          createdByUserId: user?.id ?? "",
          createdByName: user?.name ?? "",
          branchId,
          description: description?.trim() || res.session.name,
          status: "In Progress",
          createdAt: res.session.createdAt,
          updatedAt: res.session.createdAt,
        };
        return { ok: true, session: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create session" };
      }
    },
    [refreshSessions, user]
  );

  const updateSession = useCallback(
    async (
      sessionId: string,
      patch: { branchId?: string; description?: string; status?: "Active" | "In Progress" | "Cancelled" }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        if (patch.status === "Cancelled") {
          await apiRequest(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
        } else {
          await apiRequest(`/api/sessions/${sessionId}`, {
            method: "PATCH",
            body: {
              ...(patch.branchId ? { branchId: patch.branchId } : {}),
              ...(patch.description !== undefined ? { notes: patch.description, name: patch.description } : {}),
              ...(patch.status ? { status: patch.status === "Active" ? "In Progress" : patch.status } : {}),
            },
          });
        }
        await refreshSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update session" };
      }
    },
    [refreshSessions]
  );

  const deleteSession = useCallback(
    async (sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
        await refreshSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete session" };
      }
    },
    [refreshSessions]
  );

  const upsertSessionItemCount = useCallback(
    async (
      sessionId: string,
      product: Product,
      quantity: number,
      mode: "increment" | "set" = "increment"
    ): Promise<{ ok: true; item: SessionItem } | { ok: false; error: string }> => {
      const existing = sessionItems.find((i) => i.sessionId === sessionId && i.productId === product.productId);
      const nextCount = mode === "set" ? Math.max(0, quantity) : Math.max(0, (existing?.quantity ?? 0) + quantity);

      const sess = sessions.find((s) => s.id === sessionId);
      const expected =
        existing?.expectedQty ??
        branchProducts.find((bp) => bp.branchId === sess?.branchId && bp.productId === product.productId)?.quantity ??
        0;
      const variance = nextCount - expected;

      try {
        await apiRequest(`/api/sessions/${sessionId}/items`, {
          method: "PUT",
          body: {
            items: [
              {
                productId: product.productId,
                countedQty: nextCount,
                scannedCount: mode === "increment" ? 1 : 0,
              },
            ],
          },
        });
        await refreshSessions();
        const item: SessionItem = {
          productId: product.productId,
          sessionId,
          product_name: product.product_name,
          product_sku: product.product_sku,
          quantity: nextCount,
          expectedQty: expected,
          sellingPrice: product.sellingPrice,
          costPrice: product.costPrice,
          variance,
          status: variance === 0 ? "Exact" : variance > 0 ? "Over Count" : "Under Count",
        };
        return { ok: true, item };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to record count" };
      }
    },
    [sessionItems, sessions, branchProducts, refreshSessions]
  );

  const removeSessionItem = useCallback(
    async (sessionId: string, productId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sessions/${sessionId}/items/${productId}`, { method: "DELETE" });
        await refreshSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to remove item" };
      }
    },
    [refreshSessions]
  );

  const completeSession = useCallback(
    async (sessionId: string): Promise<{ ok: true; adjustedCount: number } | { ok: false; error: string }> => {
      const items = sessionItems.filter((i) => i.sessionId === sessionId);
      const adjustedEstimate = items.filter((i) => i.variance !== 0).length;
      try {
        await apiRequest(`/api/sessions/${sessionId}/complete`, { method: "POST" });
        await Promise.all([refreshSessions(), refreshInventory()]);
        return { ok: true, adjustedCount: adjustedEstimate };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to complete session" };
      }
    },
    [sessionItems, refreshSessions, refreshInventory]
  );

  return {
    sessions,
    sessionItems,
    isLoading: sessionsQuery.isLoading,
    getSession,
    getSessionItems,
    createSession,
    updateSession,
    deleteSession,
    upsertSessionItemCount,
    removeSessionItem,
    completeSession,
    refreshSessions,
  };
}
