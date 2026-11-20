import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "./AuthContext";
import { useInventory } from "./InventoryContext";

export type TaxonomyKind = "brands" | "categories" | "units";

export interface TaxonomyItem {
  id: string;
  name: string;
  code?: string;
  description?: string;
}

type BackendKind = "brand" | "category" | "unit";
const toBackendKind: Record<TaxonomyKind, BackendKind> = {
  brands: "brand",
  categories: "category",
  units: "unit",
};

type TaxonomyState = Record<TaxonomyKind, TaxonomyItem[]>;

const emptyState: TaxonomyState = { brands: [], categories: [], units: [] };

interface TaxonomyContextType {
  brands: TaxonomyItem[];
  categories: TaxonomyItem[];
  units: TaxonomyItem[];
  list: (kind: TaxonomyKind) => TaxonomyItem[];
  usageCount: (kind: TaxonomyKind, name: string) => number;
  addItem: (kind: TaxonomyKind, item: Omit<TaxonomyItem, "id">) => string | null;
  updateItem: (kind: TaxonomyKind, id: string, item: Omit<TaxonomyItem, "id">) => string | null;
  removeItem: (kind: TaxonomyKind, id: string) => string | null;
  ensureItem: (kind: TaxonomyKind, name: string) => void;
}

const TaxonomyContext = createContext<TaxonomyContextType | undefined>(undefined);

export function TaxonomyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { products } = useInventory();
  const [state, setState] = useState<TaxonomyState>(emptyState);

  const loadTaxonomy = useCallback(async () => {
    if (!user) {
      setState(emptyState);
      return;
    }
    try {
      const res = await apiRequest<{
        items: Array<{ id: string; kind: string; name: string; symbol?: string; description?: string }>;
      }>("/api/taxonomy");
      const next: TaxonomyState = { brands: [], categories: [], units: [] };
      for (const row of res.items ?? []) {
        const mapped: TaxonomyItem = {
          id: row.id,
          name: row.name,
          code: row.symbol || undefined,
          description: row.description || undefined,
        };
        if (row.kind === "brand") next.brands.push(mapped);
        else if (row.kind === "category") next.categories.push(mapped);
        else if (row.kind === "unit") next.units.push(mapped);
      }
      setState(next);
    } catch {
      // keep existing state on transient failure
    }
  }, [user]);

  useEffect(() => {
    void loadTaxonomy();
  }, [loadTaxonomy]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ type?: string }>).detail;
      if (detail?.type === "taxonomy_updated") {
        void loadTaxonomy();
      }
    };
    window.addEventListener("erp:server-event", handler);
    return () => window.removeEventListener("erp:server-event", handler);
  }, [loadTaxonomy]);

  const usageCount = useCallback(
    (kind: TaxonomyKind, name: string) => {
      const n = name.trim().toLowerCase();
      if (kind === "brands") return products.filter((p) => p.brand.trim().toLowerCase() === n).length;
      if (kind === "categories") return products.filter((p) => p.category.trim().toLowerCase() === n).length;
      return 0;
    },
    [products]
  );

  const addItem = useCallback<TaxonomyContextType["addItem"]>(
    (kind, item) => {
      const name = item.name.trim();
      if (!name) return "empty";
      if (state[kind].some((i) => i.name.trim().toLowerCase() === name.toLowerCase())) {
        return "duplicate";
      }
      const tempId = `tmp-${Date.now()}`;
      setState((prev) => ({
        ...prev,
        [kind]: [...prev[kind], { ...item, name, id: tempId }],
      }));
      void apiRequest<{ item: { id: string } }>("/api/taxonomy", {
        method: "POST",
        body: {
          kind: toBackendKind[kind],
          name,
          symbol: item.code ?? "",
          description: item.description ?? "",
        },
      })
        .then(() => loadTaxonomy())
        .catch(() => loadTaxonomy());
      return null;
    },
    [state, loadTaxonomy]
  );

  const updateItem = useCallback<TaxonomyContextType["updateItem"]>(
    (kind, id, item) => {
      const name = item.name.trim();
      if (!name) return "empty";
      if (state[kind].some((i) => i.id !== id && i.name.trim().toLowerCase() === name.toLowerCase())) {
        return "duplicate";
      }
      setState((prev) => ({
        ...prev,
        [kind]: prev[kind].map((i) => (i.id === id ? { ...i, ...item, name } : i)),
      }));
      void apiRequest(`/api/taxonomy/${id}`, {
        method: "PUT",
        body: {
          name,
          symbol: item.code ?? "",
          description: item.description ?? "",
        },
      })
        .then(() => loadTaxonomy())
        .catch(() => loadTaxonomy());
      return null;
    },
    [state, loadTaxonomy]
  );

  const removeItem = useCallback<TaxonomyContextType["removeItem"]>(
    (kind, id) => {
      const item = state[kind].find((i) => i.id === id);
      if (!item) return "missing";
      if (usageCount(kind, item.name) > 0) return "in_use";
      setState((prev) => ({
        ...prev,
        [kind]: prev[kind].filter((i) => i.id !== id),
      }));
      void apiRequest(`/api/taxonomy/${id}`, { method: "DELETE" })
        .then(() => loadTaxonomy())
        .catch(() => loadTaxonomy());
      return null;
    },
    [state, usageCount, loadTaxonomy]
  );

  const ensureItem = useCallback<TaxonomyContextType["ensureItem"]>(
    (kind, name) => {
      const value = name.trim();
      if (!value) return;
      if (state[kind].some((i) => i.name.trim().toLowerCase() === value.toLowerCase())) return;
      void addItem(kind, { name: value });
    },
    [state, addItem]
  );

  const value = useMemo<TaxonomyContextType>(
    () => ({
      brands: state.brands,
      categories: state.categories,
      units: state.units,
      list: (kind: TaxonomyKind) => state[kind],
      usageCount,
      addItem,
      updateItem,
      removeItem,
      ensureItem,
    }),
    [state, usageCount, addItem, updateItem, removeItem, ensureItem]
  );

  return <TaxonomyContext.Provider value={value}>{children}</TaxonomyContext.Provider>;
}

export function useTaxonomy() {
  const ctx = useContext(TaxonomyContext);
  if (!ctx) throw new Error("useTaxonomy must be used within a TaxonomyProvider");
  return ctx;
}
