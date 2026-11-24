import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface UserPreferencesPayload {
  preferences: {
    userId?: string;
    language?: string;
    activeBranchId?: string | null;
    preferencesJson?: Record<string, unknown>;
  } | null;
}

export interface CompanySettingsTaxCodeRow {
  id: string;
  code: string;
  name: string;
  rate: string | number;
  isDefault: boolean;
  isInclusive: boolean;
  isActive: boolean;
  inputAccountId: string | null;
  outputAccountId: string | null;
}

export interface CompanySettingsPayload {
  company: {
    companyName: string;
    legalName: string | null;
    taxRegistrationNumber: string | null;
    baseCurrency: string;
    einvoicingMode: "none" | "zatca_qr" | "zatca_phase2" | "eta_egypt";
    address: string | null;
    phone: string | null;
    email: string | null;
    settingsJson?: Record<string, unknown>;
  } | null;
  taxCodes?: CompanySettingsTaxCodeRow[];
}

export interface ApiUserSummary {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "user";
  isActive: boolean;
  branchScopeMode: "all" | "selected";
  branchIds: string[];
  defaultBranchId: string | null;
  customRoleId?: string | null;
  customRoleName?: string | null;
  createdAt?: string;
}

export function usePreferencesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.preferences,
    queryFn: () => apiRequest<UserPreferencesPayload>("/api/settings/preferences"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useCompanySettingsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.companySettings,
    queryFn: () => apiRequest<CompanySettingsPayload>("/api/settings/company"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function useUsersDirectoryQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.users,
    queryFn: () => apiRequest<{ users: ApiUserSummary[] }>("/api/users"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}
