import { useInfiniteQuery } from "@tanstack/react-query";
import type { CursorPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type { AuditEntry, AuditModule } from "@/types";

export interface AuditLogCursorFilters {
  module?: AuditModule | "all";
  q?: string;
  branchId?: string;
  limit?: number;
}

interface AuditLogPageResponse {
  entries: AuditEntry[];
  items: AuditEntry[];
  pageInfo: CursorPageInfo;
}

export function useAuditLogsCursorQuery(filters: AuditLogCursorFilters = {}) {
  const { user } = useAuth();
  const limit = filters.limit ?? 50;

  return useInfiniteQuery({
    queryKey: [
      ...erpQueryKeys.auditLogs,
      {
        module: filters.module ?? "all",
        q: filters.q?.trim() ?? "",
        branchId: filters.branchId ?? "all",
        limit,
      },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (pageParam) params.set("cursor", pageParam);
      if (filters.module && filters.module !== "all") params.set("module", filters.module);
      if (filters.branchId && filters.branchId !== "all") params.set("branchId", filters.branchId);
      if (filters.q?.trim()) params.set("q", filters.q.trim());
      return apiRequest<AuditLogPageResponse>(`/api/audit-logs?${params.toString()}`);
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? (lastPage.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: Boolean(user),
  });
}
