import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type {
  AppRole,
  AssignCompanyMemberInput,
  CompanyDto,
  CreateCompanyInput,
  UpdateCompanyInput,
  UpdateCompanyMemberInput,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface CompanyMemberDto {
  userId: string;
  name: string;
  email: string;
  role: AppRole;
  customRoleId: string | null;
  customRoleName: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export function useCompaniesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.companies.list(),
    queryFn: () => apiRequest<{ companies: CompanyDto[] }>("/api/companies"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useCompanyMembersQuery(companyId: string | null | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.companies.members(companyId ?? "none"),
    queryFn: () => apiRequest<{ members: CompanyMemberDto[] }>(`/api/companies/${companyId}/members`),
    enabled: Boolean(user) && Boolean(companyId) && enabled,
  });
}

export function useCompanyMutations() {
  const queryClient = useQueryClient();
  const { switchCompany: authSwitchCompany, refreshUser } = useAuth();

  const invalidateCompanies = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.companies.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.companySettings });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.settings });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const createCompany = useMutation({
    mutationFn: (body: CreateCompanyInput) =>
      apiRequest<{ company: CompanyDto }>("/api/companies", { method: "POST", body }),
    onSuccess: () => {
      invalidateCompanies();
      void refreshUser();
    },
  });

  const updateCompany = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCompanyInput }) =>
      apiRequest<{ company: CompanyDto }>(`/api/companies/${id}`, { method: "PUT", body }),
    onSuccess: () => {
      invalidateCompanies();
      void refreshUser();
    },
  });

  const deleteCompany = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/companies/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateCompanies();
      void refreshUser();
    },
  });

  const assignCompanyMember = useMutation({
    mutationFn: ({ companyId, body }: { companyId: string; body: AssignCompanyMemberInput }) =>
      apiRequest<{ member: CompanyMemberDto }>(`/api/companies/${companyId}/members`, { method: "POST", body }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.companies.members(vars.companyId) });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.users });
    },
  });

  const updateCompanyMember = useMutation({
    mutationFn: ({ companyId, userId, body }: { companyId: string; userId: string; body: UpdateCompanyMemberInput }) =>
      apiRequest<{ member: CompanyMemberDto }>(`/api/companies/${companyId}/members/${userId}`, {
        method: "PUT",
        body,
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.companies.members(vars.companyId) });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.users });
    },
  });

  const removeCompanyMember = useMutation({
    mutationFn: ({ companyId, userId }: { companyId: string; userId: string }) =>
      apiRequest<{ ok: boolean }>(`/api/companies/${companyId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.companies.members(vars.companyId) });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.users });
    },
  });

  const switchCompany = useMutation({
    mutationFn: (companyId: string) => authSwitchCompany(companyId),
  });

  return {
    createCompany,
    updateCompany,
    deleteCompany,
    assignCompanyMember,
    updateCompanyMember,
    removeCompanyMember,
    switchCompany,
  };
}
