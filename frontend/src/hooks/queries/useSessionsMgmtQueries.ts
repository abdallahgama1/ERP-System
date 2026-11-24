import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActiveSessionDto } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useActiveSessionsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sessionsMgmt.list(),
    queryFn: () => apiRequest<{ sessions: ActiveSessionDto[] }>("/api/auth/sessions"),
    enabled: Boolean(user) && enabled,
  });
}

export function useRevokeSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiRequest<{ ok: boolean }>(`/api/auth/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sessionsMgmt.all });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });
}

export function useRevokeOtherSessionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<{ ok: boolean; revokedCount?: number }>("/api/auth/sessions/revoke-others", { method: "POST", body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sessionsMgmt.all });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });
}
