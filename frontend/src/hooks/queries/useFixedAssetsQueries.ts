import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DepreciationRunResultDto,
  FixedAssetDepreciationEntryDto,
  FixedAssetDto,
  createFixedAssetSchema,
  disposeFixedAssetSchema,
  runDepreciationSchema,
} from "@erp/shared";
import type { z } from "zod";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useFixedAssetsQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.fixedAssets.list(),
    enabled: Boolean(user) && enabled && can("fixed_assets", "view"),
    queryFn: async () => {
      const res = await apiRequest<{ assets: FixedAssetDto[] }>("/api/fixed-assets");
      return res.assets;
    },
  });
}

export function useFixedAssetScheduleQuery(assetId: string | null, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.fixedAssets.schedule(assetId ?? "none"),
    enabled: Boolean(user) && Boolean(assetId) && enabled && can("fixed_assets", "view"),
    queryFn: async () =>
      apiRequest<{ asset: FixedAssetDto; entries: FixedAssetDepreciationEntryDto[] }>(
        `/api/fixed-assets/${assetId}/schedule`
      ),
  });
}

export function useFixedAssetMutations() {
  const qc = useQueryClient();
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: erpQueryKeys.fixedAssets.all });
    void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const createAsset = useMutation({
    mutationFn: (payload: z.input<typeof createFixedAssetSchema>) =>
      apiRequest<{ asset: FixedAssetDto }>("/api/fixed-assets", { method: "POST", body: payload }),
    onSuccess: invalidateAll,
  });

  const runDepreciation = useMutation({
    mutationFn: (payload: z.input<typeof runDepreciationSchema>) =>
      apiRequest<DepreciationRunResultDto>("/api/fixed-assets/depreciate", {
        method: "POST",
        body: payload,
      }),
    onSuccess: invalidateAll,
  });

  const disposeAsset = useMutation({
    mutationFn: ({ id, data }: { id: string; data: z.input<typeof disposeFixedAssetSchema> }) =>
      apiRequest<{ asset: FixedAssetDto }>(`/api/fixed-assets/${id}/dispose`, {
        method: "POST",
        body: data,
      }),
    onSuccess: invalidateAll,
  });

  return { createAsset, runDepreciation, disposeAsset };
}
