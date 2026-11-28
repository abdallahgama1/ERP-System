import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type { CreateSavedViewInput, SavedViewDto, UpdateSavedViewInput } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useSavedViewsQuery(resource?: string, enabled = true) {
  const { user } = useAuth();
  const qs = resource ? `?resource=${encodeURIComponent(resource)}` : "";

  return useQuery({
    queryKey: erpQueryKeys.savedViews.byResource(resource),
    queryFn: () => apiRequest<{ views: SavedViewDto[] }>(`/api/saved-views${qs}`),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useSavedViewMutations() {
  const queryClient = useQueryClient();

  const invalidateViews = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.savedViews.all });
  };

  const createSavedView = useMutation({
    mutationFn: (body: CreateSavedViewInput) =>
      apiRequest<{ view: SavedViewDto }>("/api/saved-views", { method: "POST", body }),
    onSuccess: invalidateViews,
  });

  const updateSavedView = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSavedViewInput }) =>
      apiRequest<{ view: SavedViewDto }>(`/api/saved-views/${id}`, { method: "PUT", body }),
    onSuccess: invalidateViews,
  });

  const deleteSavedView = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/saved-views/${id}`, { method: "DELETE" }),
    onSuccess: invalidateViews,
  });

  return {
    createSavedView,
    updateSavedView,
    deleteSavedView,
  };
}
