import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type {
  MfaDisableInput,
  MfaEnrollResponseDto,
  MfaRegenerateRecoveryCodesInput,
  MfaStatusDto,
  MfaVerifyEnrollInput,
  MfaVerifyLoginInput,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import type { User } from "@/types";
import { erpQueryKeys } from "./queryKeys";

type MfaStatusApiResponse = MfaStatusDto | { mfa: MfaStatusDto };

export function normalizeMfaStatus(res: MfaStatusApiResponse): MfaStatusDto {
  return "mfa" in res ? res.mfa : res;
}

export function useMfaStatusQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.mfa.status(),
    queryFn: async () => {
      const res = await apiRequest<MfaStatusApiResponse>("/api/auth/mfa/status");
      return normalizeMfaStatus(res);
    },
    enabled: Boolean(user) && enabled,
  });
}

export function useMfaMutations() {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();

  const invalidateMfa = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.mfa.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const enrollMfa = useMutation({
    mutationFn: () => apiRequest<MfaEnrollResponseDto>("/api/auth/mfa/enroll", { method: "POST", body: {} }),
  });

  const verifyEnrollMfa = useMutation({
    mutationFn: (body: MfaVerifyEnrollInput) =>
      apiRequest<{ ok?: boolean; enabled?: boolean }>("/api/auth/mfa/verify", { method: "POST", body }),
    onSuccess: () => {
      invalidateMfa();
      void refreshUser();
    },
  });

  const verifyLoginMfa = useMutation({
    mutationFn: (body: MfaVerifyLoginInput) =>
      apiRequest<{ user: User }>("/api/auth/mfa/verify-login", { method: "POST", body }),
  });

  const disableMfa = useMutation({
    mutationFn: (body: MfaDisableInput) =>
      apiRequest<{ ok: boolean }>("/api/auth/mfa/disable", { method: "POST", body }),
    onSuccess: () => {
      invalidateMfa();
      void refreshUser();
    },
  });

  const regenerateRecoveryCodes = useMutation({
    mutationFn: (body: MfaRegenerateRecoveryCodesInput) =>
      apiRequest<{ recoveryCodes: string[] }>("/api/auth/mfa/recovery-codes", { method: "POST", body }),
    onSuccess: invalidateMfa,
  });

  return {
    enrollMfa,
    verifyEnrollMfa,
    verifyLoginMfa,
    disableMfa,
    regenerateRecoveryCodes,
  };
}
