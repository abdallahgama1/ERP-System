import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type { AppRole, ApprovalEntityType } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface ApprovalRuleDto {
  id: string;
  entityType: ApprovalEntityType;
  minAmount: number;
  requiredRole: AppRole;
  isActive: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestDto {
  id: string;
  entityType: ApprovalEntityType;
  entityId: string;
  entityNumber: string;
  branchId: string | null;
  amount: number;
  status: "pending" | "approved" | "rejected";
  requestedBy: string | null;
  requestedByName: string;
  reviewedBy: string | null;
  reviewedByName: string;
  decisionComment: string;
  selfApprovedSingleAdmin: boolean;
  requestedAt: string;
  reviewedAt: string | null;
}

export function useApprovalRulesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.approvals.rules(),
    queryFn: () => apiRequest<{ rules: ApprovalRuleDto[] }>("/api/approvals/rules"),
    select: (data) => data.rules,
    enabled: Boolean(user) && enabled,
  });
}

export function useApprovalRequestsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.approvals.requests(),
    queryFn: () => apiRequest<{ requests: ApprovalRequestDto[] }>("/api/approvals/requests"),
    select: (data) => data.requests,
    enabled: Boolean(user) && enabled,
  });
}

export function useApprovalMutations() {
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.approvals.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.purchases.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.notifications });
  };

  const upsertRule = useMutation({
    mutationFn: (body: {
      entityType: ApprovalEntityType;
      minAmount: number;
      requiredRole: AppRole;
      isActive: boolean;
      description?: string;
    }) => apiRequest<{ rule: ApprovalRuleDto }>("/api/approvals/rules", { method: "PUT", body }),
    onSuccess: invalidateAll,
  });

  const decideRequest = useMutation({
    mutationFn: ({
      id,
      decision,
      comment,
    }: {
      id: string;
      decision: "approved" | "rejected";
      comment?: string;
    }) =>
      apiRequest<{ request: ApprovalRequestDto }>(`/api/approvals/requests/${id}/decision`, {
        method: "POST",
        body: { decision, comment: comment ?? "" },
      }),
    onSuccess: invalidateAll,
  });

  return { upsertRule, decideRequest };
}
