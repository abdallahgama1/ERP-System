import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExpenseClaimDto,
  OffsetPageInfo,
  createExpenseClaimSchema,
  payExpenseClaimSchema,
  reviewExpenseClaimSchema,
} from "@erp/shared";
import type { z } from "zod";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface ExpensesFilterParams {
  page?: number;
  pageSize?: number;
  status?: string;
  paymentMode?: string;
  branchId?: string;
  q?: string;
}

export function useExpenseClaimsQuery(params: ExpensesFilterParams = {}) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.expenses.list(params as Record<string, unknown>),
    enabled: Boolean(user) && can("expenses", "view"),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (params.page) qs.set("page", String(params.page));
      if (params.pageSize) qs.set("pageSize", String(params.pageSize));
      if (params.status && params.status !== "all") qs.set("status", params.status);
      if (params.paymentMode && params.paymentMode !== "all") qs.set("paymentMode", params.paymentMode);
      if (params.branchId && params.branchId !== "all") qs.set("branchId", params.branchId);
      if (params.q?.trim()) qs.set("q", params.q.trim());
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiRequest<{ claims: ExpenseClaimDto[]; items: ExpenseClaimDto[]; pageInfo: OffsetPageInfo }>(
        `/api/expenses${suffix}`
      );
    },
  });
}

export function useExpenseMutations() {
  const qc = useQueryClient();
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: erpQueryKeys.expenses.all });
    void qc.invalidateQueries({ queryKey: erpQueryKeys.treasury.all });
    void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const createClaim = useMutation({
    mutationFn: (payload: z.input<typeof createExpenseClaimSchema>) =>
      apiRequest<{ claim: ExpenseClaimDto }>("/api/expenses", { method: "POST", body: payload }),
    onSuccess: invalidateAll,
  });

  const submitClaim = useMutation({
    mutationFn: (id: string) =>
      apiRequest<{ claim: ExpenseClaimDto }>(`/api/expenses/${id}/submit`, { method: "POST", body: {} }),
    onSuccess: invalidateAll,
  });

  const reviewClaim = useMutation({
    mutationFn: ({ id, data }: { id: string; data: z.input<typeof reviewExpenseClaimSchema> }) =>
      apiRequest<{ claim: ExpenseClaimDto }>(`/api/expenses/${id}/review`, { method: "POST", body: data }),
    onSuccess: invalidateAll,
  });

  const payClaim = useMutation({
    mutationFn: ({ id, data }: { id: string; data: z.input<typeof payExpenseClaimSchema> }) =>
      apiRequest<{ claim: ExpenseClaimDto }>(`/api/expenses/${id}/pay`, { method: "POST", body: data }),
    onSuccess: invalidateAll,
  });

  return {
    createClaim,
    submitClaim,
    reviewClaim,
    payClaim,
  };
}
