import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useSessionsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sessions.list(),
    queryFn: () => apiRequest<{ sessions: unknown[] }>("/api/sessions"),
    enabled: Boolean(user),
  });
}
