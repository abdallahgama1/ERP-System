import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import type { Product } from "@/types";
import { erpQueryKeys } from "./queryKeys";

export type TaxonomyKind = "brands" | "categories" | "units";
export type BackendTaxonomyKind = "brand" | "category" | "unit";

export interface TaxonomyItem {
  id: string;
  name: string;
  code?: string;
  description?: string;
  color?: string;
}

export interface ApiTaxonomyRow {
  id: string;
  kind: BackendTaxonomyKind;
  name: string;
  symbol?: string;
  description?: string;
  color?: string;
}

export interface GroupedTaxonomy {
  brands: TaxonomyItem[];
  categories: TaxonomyItem[];
  units: TaxonomyItem[];
  items: ApiTaxonomyRow[];
}

const toBackendKind: Record<TaxonomyKind, BackendTaxonomyKind> = {
  brands: "brand",
  categories: "category",
  units: "unit",
};

export function groupTaxonomyItems(rows: ApiTaxonomyRow[]): GroupedTaxonomy {
  const grouped: GroupedTaxonomy = { brands: [], categories: [], units: [], items: rows };
  for (const row of rows) {
    const mapped: TaxonomyItem = {
      id: row.id,
      name: row.name,
      code: row.symbol || undefined,
      description: row.description || undefined,
      color: row.color || undefined,
    };
    if (row.kind === "brand") grouped.brands.push(mapped);
    else if (row.kind === "category") grouped.categories.push(mapped);
    else if (row.kind === "unit") grouped.units.push(mapped);
  }
  return grouped;
}

export function computeTaxonomyUsageCount(
  kind: TaxonomyKind,
  name: string,
  products: Product[],
  symbol?: string
): number {
  const n = name.trim().toLowerCase();
  const s = symbol?.trim().toLowerCase();
  if (kind === "brands") {
    return products.filter((p) => p.brand.trim().toLowerCase() === n).length;
  }
  if (kind === "categories") {
    return products.filter((p) => p.category.trim().toLowerCase() === n).length;
  }
  return products.filter((p) => {
    const u = (p.unit ?? "").trim().toLowerCase();
    return u === n || (Boolean(s) && u === s);
  }).length;
}

export function useTaxonomyQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.taxonomy,
    queryFn: () => apiRequest<{ items: ApiTaxonomyRow[] }>("/api/taxonomy"),
    select: (res) => groupTaxonomyItems(res.items ?? []),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useTaxonomyMutations() {
  const queryClient = useQueryClient();

  const createTaxonomyItem = useMutation({
    mutationFn: ({
      kind,
      name,
      code,
      description,
      color,
    }: {
      kind: TaxonomyKind;
      name: string;
      code?: string;
      description?: string;
      color?: string;
    }) =>
      apiRequest<{ item: ApiTaxonomyRow }>("/api/taxonomy", {
        method: "POST",
        body: {
          kind: toBackendKind[kind],
          name: name.trim(),
          symbol: code?.trim() ?? "",
          description: description?.trim() ?? "",
          ...(color ? { color } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.taxonomy });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });

  const updateTaxonomyItem = useMutation({
    mutationFn: ({
      id,
      name,
      code,
      description,
      color,
    }: {
      id: string;
      name: string;
      code?: string;
      description?: string;
      color?: string;
    }) =>
      apiRequest<{ item: ApiTaxonomyRow }>(`/api/taxonomy/${id}`, {
        method: "PUT",
        body: {
          name: name.trim(),
          symbol: code?.trim() ?? "",
          description: description?.trim() ?? "",
          ...(color ? { color } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.taxonomy });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.products() });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });

  const deleteTaxonomyItem = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/taxonomy/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.taxonomy });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });

  const ensureTaxonomyItem = async (kind: TaxonomyKind, name: string, existing?: TaxonomyItem[]) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const cached = queryClient.getQueryData<{ items: ApiTaxonomyRow[] }>(erpQueryKeys.taxonomy);
    const list =
      existing ?? (cached ? groupTaxonomyItems(cached.items ?? [])[kind] : []);
    if (list.some((item) => item.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      return;
    }
    await createTaxonomyItem.mutateAsync({ kind, name: trimmed });
  };

  return {
    createTaxonomyItem,
    updateTaxonomyItem,
    deleteTaxonomyItem,
    ensureTaxonomyItem,
  };
}
