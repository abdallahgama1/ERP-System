import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "./AuthContext";
import { useInventory } from "./InventoryContext";
import type { Product, Session, SessionItem } from "@/types";

interface BackendSessionItem {
  id: string;
  productId: string;
  expectedQty: number;
  countedQty: number;
  variance: number;
  scannedCount: number;
  notes: string;
}

interface BackendSession {
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
  items: BackendSessionItem[];
}

interface SessionsContextType {
  sessions: Session[];
  sessionItems: SessionItem[];
  isLoading: boolean;
  getSession: (sessionId: string) => Session | undefined;
  getSessionItems: (sessionId: string) => SessionItem[];
  createSession: (input: {
    branchId: string;
    description?: string;
    name?: string;
  }) => Promise<{ ok: true; session: Session } | { ok: false; error: string }>;
  updateSession: (
    sessionId: string,
    patch: { branchId?: string; description?: string; status?: "Active" | "In Progress" | "Cancelled" }
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  upsertSessionItemCount: (
    sessionId: string,
    product: Product,
    quantity: number,
    mode?: "increment" | "set"
  ) => Promise<{ ok: true; item: SessionItem } | { ok: false; error: string }>;
  removeSessionItem: (sessionId: string, productId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  completeSession: (sessionId: string) => Promise<{ ok: true; adjustedCount: number } | { ok: false; error: string }>;
  refreshSessions: () => Promise<void>;
}

const SessionsContext = createContext<SessionsContextType | undefined>(undefined);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { branches, products, branchProducts, refreshInventory } = useInventory();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionItems, setSessionItems] = useState<SessionItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!user) {
      setSessions([]);
      setSessionItems([]);
      return;
    }

    setIsLoading(true);
    try {
      const res = await apiRequest<{ sessions: BackendSession[] }>("/api/sessions");
      const branchMap = new Map(branches.map((b) => [b.branchId, b.branch_name]));
      const productMap = new Map(products.map((p) => [p.productId, p]));

      const mappedSessions: Session[] = [];
      const mappedItems: SessionItem[] = [];

      for (const s of res.sessions ?? []) {
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
            product_name: prod?.product_name ?? "Product",
            product_sku: prod?.product_sku ?? "",
            quantity: item.countedQty,
            expectedQty: item.expectedQty,
            sellingPrice: prod?.sellingPrice ?? 0,
            costPrice: prod?.costPrice ?? 0,
            variance: item.variance,
            status: diff === 0 ? "Exact" : diff > 0 ? "Over Count" : "Under Count",
          });
        }
      }

      setSessions(mappedSessions);
      setSessionItems(mappedItems);
    } catch {
      // retain existing state on transient error
    } finally {
      setIsLoading(false);
    }
  }, [user, branches, products]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const onServerEvent = (ev: Event) => {
      const type = (ev as CustomEvent<{ type?: string }>).detail?.type;
      if (type === "sessions_updated") {
        void loadSessions();
      }
    };
    window.addEventListener("erp:server-event", onServerEvent);
    return () => window.removeEventListener("erp:server-event", onServerEvent);
  }, [loadSessions]);

  const getSession = useCallback(
    (sessionId: string) => sessions.find((s) => s.id === sessionId),
    [sessions]
  );

  const getSessionItems = useCallback(
    (sessionId: string) => sessionItems.filter((i) => i.sessionId === sessionId),
    [sessionItems]
  );

  const createSession = useCallback<SessionsContextType["createSession"]>(
    async ({ branchId, description, name }) => {
      try {
        const res = await apiRequest<{ session: { id: string; sessionNumber: string; createdAt: string; name: string } }>(
          "/api/sessions",
          {
            method: "POST",
            body: {
              branchId,
              name: name?.trim() || description?.trim() || `Count ${new Date().toLocaleDateString()}`,
              notes: description?.trim() ?? "",
            },
          }
        );
        await loadSessions();
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
    [loadSessions, user]
  );

  const updateSession = useCallback<SessionsContextType["updateSession"]>(
    async (sessionId, patch) => {
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
        await loadSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update session" };
      }
    },
    [loadSessions]
  );

  const deleteSession = useCallback<SessionsContextType["deleteSession"]>(
    async (sessionId) => {
      try {
        await apiRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
        await loadSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete session" };
      }
    },
    [loadSessions]
  );

  const upsertSessionItemCount = useCallback<SessionsContextType["upsertSessionItemCount"]>(
    async (sessionId, product, quantity, mode = "increment") => {
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
        await loadSessions();
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
    [sessionItems, sessions, branchProducts, loadSessions]
  );

  const removeSessionItem = useCallback<SessionsContextType["removeSessionItem"]>(
    async (sessionId, productId) => {
      try {
        await apiRequest(`/api/sessions/${sessionId}/items/${productId}`, { method: "DELETE" });
        await loadSessions();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to remove item" };
      }
    },
    [loadSessions]
  );

  const completeSession = useCallback<SessionsContextType["completeSession"]>(
    async (sessionId) => {
      const items = sessionItems.filter((i) => i.sessionId === sessionId);
      const adjustedEstimate = items.filter((i) => i.variance !== 0).length;
      try {
        await apiRequest(`/api/sessions/${sessionId}/complete`, { method: "POST" });
        await Promise.all([loadSessions(), refreshInventory()]);
        return { ok: true, adjustedCount: adjustedEstimate };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to complete session" };
      }
    },
    [sessionItems, loadSessions, refreshInventory]
  );

  const value = useMemo<SessionsContextType>(
    () => ({
      sessions,
      sessionItems,
      isLoading,
      getSession,
      getSessionItems,
      createSession,
      updateSession,
      deleteSession,
      upsertSessionItemCount,
      removeSessionItem,
      completeSession,
      refreshSessions: loadSessions,
    }),
    [
      sessions,
      sessionItems,
      isLoading,
      getSession,
      getSessionItems,
      createSession,
      updateSession,
      deleteSession,
      upsertSessionItemCount,
      removeSessionItem,
      completeSession,
      loadSessions,
    ]
  );

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessions() {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within a SessionsProvider");
  return ctx;
}
