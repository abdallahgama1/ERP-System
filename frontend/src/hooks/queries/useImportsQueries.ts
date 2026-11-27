import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CsvImportResultDto,
  ImportDatasetKind,
  OpeningBalancesImportResultDto,
  OpeningCutoverStatusDto,
  ReverseOpeningBalancesResultDto,
  StandardImportKind,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export const importQueryKeys = {
  openingStatus: () => ["imports", "opening-status"] as const,
};

export function useOpeningCutoverStatusQuery(enabled = true) {
  const { user } = useAuth();
  const { role } = usePermissions();
  return useQuery({
    queryKey: importQueryKeys.openingStatus(),
    queryFn: () => apiRequest<OpeningCutoverStatusDto>("/api/imports/opening-balances/status"),
    enabled: Boolean(user) && enabled && role === "admin",
  });
}

export function useImportMutations() {
  const queryClient = useQueryClient();

  const invalidateAllOperational = () => {
    void queryClient.invalidateQueries({ queryKey: importQueryKeys.openingStatus() });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sales.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.purchases.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.fixedAssets.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.treasury.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.taxonomy });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const runStandardImport = useMutation({
    mutationFn: ({ kind, csv, dryRun }: { kind: StandardImportKind; csv: string; dryRun: boolean }) =>
      apiRequest<CsvImportResultDto>(`/api/imports/${kind}`, {
        method: "POST",
        body: { csv, dryRun },
      }),
    onSuccess: (res) => {
      if (!res.dryRun && res.valid) {
        invalidateAllOperational();
      }
    },
  });

  const runOpeningBalancesImport = useMutation({
    mutationFn: (payload: {
      cutoverDate: string;
      allowPnlAccounts?: boolean;
      trialBalanceCsv: string;
      openArCsv?: string;
      openApCsv?: string;
      memo?: string;
      dryRun: boolean;
    }) =>
      apiRequest<OpeningBalancesImportResultDto>("/api/imports/opening-balances", {
        method: "POST",
        body: payload,
      }),
    onSuccess: (res) => {
      if (!res.dryRun && res.valid) {
        invalidateAllOperational();
      }
    },
  });

  const reverseOpeningBalances = useMutation({
    mutationFn: (payload: { reason: string }) =>
      apiRequest<ReverseOpeningBalancesResultDto>("/api/imports/opening-balances/reverse", {
        method: "POST",
        body: payload,
      }),
    onSuccess: invalidateAllOperational,
  });

  return {
    runStandardImport,
    runOpeningBalancesImport,
    reverseOpeningBalances,
  };
}

export async function downloadImportTemplate(kind: ImportDatasetKind, fileName: string): Promise<void> {
  const res = await fetch(`/api/imports/templates/${kind}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to download template (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
