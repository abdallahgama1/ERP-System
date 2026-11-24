import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BankStatementLineDto,
  TreasuryAccountDto,
  TreasuryTransferDto,
  UnreconciledGlLineDto,
  createTreasuryAccountSchema,
  createTreasuryTransferSchema,
  importBankStatementCsvSchema,
  reconcileStatementLineSchema,
  updateTreasuryAccountSchema,
} from "@erp/shared";
import type { z } from "zod";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface TreasuryReconciliationViewDto {
  account: TreasuryAccountDto;
  statementLines: BankStatementLineDto[];
  unreconciledGlLines: UnreconciledGlLineDto[];
}

export function useTreasuryAccountsQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.treasury.accounts(),
    enabled: Boolean(user) && enabled && (can("treasury", "view") || can("expenses", "view")),
    queryFn: async () => {
      const res = await apiRequest<{ accounts: TreasuryAccountDto[] }>("/api/treasury/accounts");
      return res.accounts;
    },
  });
}

export function useTreasuryTransfersQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.treasury.transfers(),
    enabled: Boolean(user) && enabled && can("treasury", "view"),
    queryFn: async () => {
      const res = await apiRequest<{ transfers: TreasuryTransferDto[] }>("/api/treasury/transfers");
      return res.transfers;
    },
  });
}

export function useTreasuryReconciliationQuery(treasuryAccountId: string | null, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.treasury.reconciliation(treasuryAccountId ?? "none"),
    enabled: Boolean(user) && Boolean(treasuryAccountId) && enabled && can("treasury", "view"),
    queryFn: async () =>
      apiRequest<TreasuryReconciliationViewDto>(`/api/treasury/accounts/${treasuryAccountId}/reconciliation`),
  });
}

export function useTreasuryMutations() {
  const qc = useQueryClient();
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: erpQueryKeys.treasury.all });
    void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const createAccount = useMutation({
    mutationFn: (payload: z.input<typeof createTreasuryAccountSchema>) =>
      apiRequest<{ account: TreasuryAccountDto }>("/api/treasury/accounts", { method: "POST", body: payload }),
    onSuccess: invalidateAll,
  });

  const updateAccount = useMutation({
    mutationFn: ({ id, data }: { id: string; data: z.input<typeof updateTreasuryAccountSchema> }) =>
      apiRequest<{ account: TreasuryAccountDto }>(`/api/treasury/accounts/${id}`, { method: "PUT", body: data }),
    onSuccess: invalidateAll,
  });

  const createTransfer = useMutation({
    mutationFn: (payload: z.input<typeof createTreasuryTransferSchema>) =>
      apiRequest<{ transfer: TreasuryTransferDto }>("/api/treasury/transfers", { method: "POST", body: payload }),
    onSuccess: invalidateAll,
  });

  const importCsv = useMutation({
    mutationFn: ({
      accountId,
      data,
    }: {
      accountId: string;
      data: z.input<typeof importBankStatementCsvSchema>;
    }) =>
      apiRequest<{
        statementId: string;
        statementNumber: string;
        importedLines: number;
        skippedDuplicates: number;
      }>(`/api/treasury/accounts/${accountId}/statements/import-csv`, { method: "POST", body: data }),
    onSuccess: invalidateAll,
  });

  const reconcileLine = useMutation({
    mutationFn: ({
      lineId,
      data,
    }: {
      lineId: string;
      data: z.input<typeof reconcileStatementLineSchema>;
    }) =>
      apiRequest<{ reconciled: true; matchedJournalLineId: string }>(
        `/api/treasury/statement-lines/${lineId}/reconcile`,
        { method: "POST", body: data }
      ),
    onSuccess: invalidateAll,
  });

  const unreconcileLine = useMutation({
    mutationFn: (lineId: string) =>
      apiRequest<{ ok: true }>(`/api/treasury/statement-lines/${lineId}/unreconcile`, { method: "POST", body: {} }),
    onSuccess: invalidateAll,
  });

  const ignoreLine = useMutation({
    mutationFn: ({ lineId, ignored }: { lineId: string; ignored: boolean }) =>
      apiRequest<{ ok: true }>(`/api/treasury/statement-lines/${lineId}/ignore`, {
        method: "POST",
        body: { ignored },
      }),
    onSuccess: invalidateAll,
  });

  return {
    createAccount,
    updateAccount,
    createTransfer,
    importCsv,
    reconcileLine,
    unreconcileLine,
    ignoreLine,
  };
}
