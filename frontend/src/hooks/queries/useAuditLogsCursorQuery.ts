import { useCallback } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditDiffEntryDto, CursorPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type { AuditEntry, AuditModule } from "@/types";

export interface AuditLogCursorFilters {
  module?: AuditModule | string | "all";
  q?: string;
  branchId?: string;
  userId?: string;
  action?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export type AuditLogItem = AuditEntry & Partial<Omit<AuditDiffEntryDto, keyof AuditEntry>>;

export interface AuditLogPageResponse {
  entries: AuditLogItem[];
  items: AuditLogItem[];
  pageInfo: CursorPageInfo;
}

export function useAuditLogsCursorQuery(filters: AuditLogCursorFilters = {}, enabled = true) {
  const { user } = useAuth();
  const limit = filters.limit ?? 50;

  return useInfiniteQuery({
    queryKey: [
      ...erpQueryKeys.auditLogs,
      {
        module: filters.module ?? "all",
        q: filters.q?.trim() ?? "",
        branchId: filters.branchId ?? "all",
        userId: filters.userId ?? "",
        action: filters.action ?? "",
        fromDate: filters.fromDate ?? "",
        toDate: filters.toDate ?? "",
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
      if (filters.userId) params.set("userId", filters.userId);
      if (filters.action) params.set("action", filters.action);
      if (filters.fromDate) params.set("fromDate", filters.fromDate);
      if (filters.toDate) params.set("toDate", filters.toDate);
      if (filters.q?.trim()) params.set("q", filters.q.trim());
      return apiRequest<AuditLogPageResponse>(`/api/audit-logs?${params.toString()}`);
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? (lastPage.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: Boolean(user) && enabled,
  });
}

export function useRecentAuditLogsQuery(limit = 8, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const canView = can("audit", "view") || can("reports", "view");

  return useQuery({
    queryKey: [...erpQueryKeys.auditLogs, "recent", limit],
    queryFn: () => apiRequest<AuditLogPageResponse>(`/api/audit-logs?limit=${limit}`),
    enabled: Boolean(user) && enabled && canView,
    staleTime: 30_000,
  });
}

export function useRecordAuditLogMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      module: AuditModule | string;
      action: string;
      entity?: string;
      entityId?: string | number;
      branchId?: string | null;
      meta?: Record<string, unknown>;
    }) => apiRequest<{ ok: boolean }>("/api/audit-logs", { method: "POST", body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });
}

export function useAuditRecorder() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const record = useCallback(
    (
      module: AuditModule,
      action: string,
      opts?: {
        entity?: string;
        entityId?: string | number;
        user?: string;
        branchId?: string;
        meta?: Record<string, unknown>;
      }
    ) => {
      if (!user) return;
      void apiRequest("/api/audit-logs", {
        method: "POST",
        body: {
          module,
          action,
          entity: opts?.entity,
          entityId: opts?.entityId !== undefined ? String(opts.entityId) : undefined,
          branchId: opts?.branchId ?? null,
          meta: opts?.meta ?? {},
        },
      })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
        })
        .catch(() => {
          // non-blocking client audit write
        });
    },
    [queryClient, user]
  );

  return { record };
}
