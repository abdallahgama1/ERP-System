import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { GlobalSearchResponseDto } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useGlobalSearchQuery(q: string, limit = 20, enabled = true) {
  const { user } = useAuth();
  const trimmed = q.trim();

  return useQuery({
    queryKey: erpQueryKeys.search.query(trimmed, limit),
    queryFn: () =>
      apiRequest<GlobalSearchResponseDto>(
        `/api/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`
      ),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    enabled: Boolean(user) && enabled && trimmed.length >= 1,
  });
}
