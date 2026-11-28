import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type {
  CreateCustomRoleInput,
  CustomRoleDto,
  UpdateCustomRoleInput,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function useCustomRolesQuery(enabled = true) {
  const { user, activeCompanyId } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.customRoles.list(activeCompanyId),
    queryFn: () => apiRequest<{ roles: CustomRoleDto[] }>("/api/custom-roles"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useCustomRoleMutations() {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();

  const invalidateRoles = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.customRoles.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.permissions });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.users });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const createCustomRole = useMutation({
    mutationFn: (body: CreateCustomRoleInput) =>
      apiRequest<{ role: CustomRoleDto }>("/api/custom-roles", { method: "POST", body }),
    onSuccess: invalidateRoles,
  });

  const updateCustomRole = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCustomRoleInput }) =>
      apiRequest<{ role: CustomRoleDto }>(`/api/custom-roles/${id}`, { method: "PUT", body }),
    onSuccess: () => {
      invalidateRoles();
      void refreshUser();
    },
  });

  const deleteCustomRole = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/custom-roles/${id}`, { method: "DELETE" }),
    onSuccess: invalidateRoles,
  });

  const assignUserCustomRole = useMutation({
    mutationFn: ({
      userId,
      customRoleId,
      companyId,
    }: {
      userId: string;
      customRoleId: string;
      companyId?: string;
    }) =>
      apiRequest<{ ok: boolean }>(`/api/users/${userId}/custom-role`, {
        method: "PUT",
        body: { customRoleId, ...(companyId ? { companyId } : {}) },
      }),
    onSuccess: () => {
      invalidateRoles();
      void refreshUser();
    },
  });

  return {
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignUserCustomRole,
  };
}
