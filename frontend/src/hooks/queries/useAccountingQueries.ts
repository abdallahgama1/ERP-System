import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccountTypeShared,
  CostCenterDto,
  FiscalPeriodStatusShared,
  GlMappingKey,
  JournalEntryStatusShared,
  NormalBalanceShared,
  OffsetPageInfo,
  createCostCenterSchema,
  updateCostCenterSchema,
} from "@erp/shared";
import type { z } from "zod";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface ChartAccountDto {
  id: string;
  code: string;
  name: string;
  accountType: AccountTypeShared;
  normalBalance: NormalBalanceShared;
  parentId: string | null;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
}

export interface GlMappingDto {
  mappingKey: GlMappingKey;
  accountId: string;
}

export interface JournalLineDto {
  id: string;
  entryId: string;
  accountId: string;
  branchId: string | null;
  costCenterId?: string | null;
  debitBase: number;
  creditBase: number;
  currency: string;
  fxRate: number;
  debitTx: number;
  creditTx: number;
  description: string | null;
}

export interface JournalEntryDto {
  id: string;
  entryNumber: string;
  entryDate: string;
  branchId: string | null;
  fiscalPeriodId: string | null;
  sourceType: string;
  sourceId: string | null;
  referenceNumber: string | null;
  memo: string;
  status: JournalEntryStatusShared;
  reversedEntryId: string | null;
  createdBy: string | null;
  createdAt: string;
  lines: JournalLineDto[];
}

export interface FiscalPeriodDto {
  id: string;
  fiscalYearId: string;
  periodNumber: number;
  name: string;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatusShared;
  lockedBy: string | null;
  lockedAt: string | null;
}

export interface FiscalYearDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  periods: FiscalPeriodDto[];
}

export interface TrialBalanceRowDto {
  accountId: string;
  code: string;
  name: string;
  accountType: AccountTypeShared;
  normalBalance: NormalBalanceShared;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalanceResponse {
  rows: TrialBalanceRowDto[];
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
}

export interface StatementAccountRowDto extends TrialBalanceRowDto {
  balance: number;
}

export interface ProfitLossResponse {
  revenueAccounts: StatementAccountRowDto[];
  expenseAccounts: StatementAccountRowDto[];
  totalRevenue: number;
  cogsTotal: number;
  grossProfit: number;
  operatingExpenses: number;
  netIncome: number;
}

export interface BalanceSheetResponse {
  assets: StatementAccountRowDto[];
  liabilities: StatementAccountRowDto[];
  equity: StatementAccountRowDto[];
  totalAssets: number;
  totalLiabilities: number;
  currentYearEarnings: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  isBalanced: boolean;
}

export interface AccountLedgerRowDto {
  lineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  sourceType: string;
  referenceNumber: string | null;
  memo: string;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
}

export interface TaxCodeDto {
  id: string;
  code: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isInclusive: boolean;
  isActive: boolean;
  inputAccountId: string | null;
  outputAccountId: string | null;
}

export interface CurrencyDto {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  isBase: boolean;
  isActive: boolean;
}

export interface ExchangeRateDto {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  effectiveAt: string;
}

export interface ReportFilterParams {
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  branchId?: string;
  costCenterId?: string;
}

function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v !== "all") search.set(k, v);
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

export function useAccountsQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.accounting.accounts(),
    queryFn: () => apiRequest<{ accounts: ChartAccountDto[] }>("/api/accounting/accounts"),
    select: (data) => data.accounts,
    enabled:
      Boolean(user) &&
      enabled &&
      (can("accounting", "view") ||
        can("settings", "view") ||
        can("treasury", "view") ||
        can("expenses", "view")),
  });
}

export function useCostCentersQuery(activeOnly = false, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...erpQueryKeys.accounting.costCenters(), { activeOnly }],
    queryFn: () =>
      apiRequest<{ costCenters: CostCenterDto[] }>(
        `/api/accounting/cost-centers${activeOnly ? "?activeOnly=true" : ""}`
      ),
    select: (data) => data.costCenters,
    enabled: Boolean(user) && enabled,
  });
}

export function useCostCenterMutations() {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });

  const createCostCenter = useMutation({
    mutationFn: (payload: z.input<typeof createCostCenterSchema>) =>
      apiRequest<{ costCenter: CostCenterDto }>("/api/accounting/cost-centers", {
        method: "POST",
        body: payload,
      }),
    onSuccess: invalidate,
  });

  const updateCostCenter = useMutation({
    mutationFn: ({ id, data }: { id: string; data: z.input<typeof updateCostCenterSchema> }) =>
      apiRequest<{ costCenter: CostCenterDto }>(`/api/accounting/cost-centers/${id}`, {
        method: "PUT",
        body: data,
      }),
    onSuccess: invalidate,
  });

  return { createCostCenter, updateCostCenter };
}

export function useGlMappingsQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.accounting.mappings(),
    queryFn: () => apiRequest<{ mappings: GlMappingDto[] }>("/api/accounting/mappings"),
    select: (data) => data.mappings,
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useJournalEntriesQuery(filters?: ReportFilterParams, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters?.toDate ? { toDate: filters.toDate } : {}),
  };
  return useQuery({
    queryKey: [...erpQueryKeys.accounting.journals(), params],
    queryFn: () =>
      apiRequest<{ entries: JournalEntryDto[] }>(
        `/api/accounting/journal-entries${toQueryString(params)}`
      ),
    select: (data) => data.entries,
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export interface JournalEntriesPageParams extends ReportFilterParams {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export function useJournalEntriesPageQuery(filters?: JournalEntriesPageParams, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? 50;
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters?.toDate ? { toDate: filters.toDate } : {}),
    ...(filters?.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters?.status && filters.status !== "all" ? { status: filters.status } : {}),
    page: String(page),
    pageSize: String(pageSize),
  };
  return useQuery({
    queryKey: [...erpQueryKeys.accounting.journals(), "page", params],
    queryFn: () =>
      apiRequest<{ entries: JournalEntryDto[]; items: JournalEntryDto[]; pageInfo: OffsetPageInfo }>(
        `/api/accounting/journal-entries${toQueryString(params)}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useFiscalYearsQuery(enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  return useQuery({
    queryKey: erpQueryKeys.accounting.fiscalYears(),
    queryFn: () => apiRequest<{ fiscalYears: FiscalYearDto[] }>("/api/accounting/fiscal-years"),
    select: (data) => data.fiscalYears,
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useTrialBalanceQuery(filters?: ReportFilterParams, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.costCenterId && filters.costCenterId !== "all"
      ? { costCenterId: filters.costCenterId }
      : {}),
    ...(filters?.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters?.toDate ? { toDate: filters.toDate } : {}),
  };
  return useQuery({
    queryKey: erpQueryKeys.accounting.statement("trial-balance", params),
    queryFn: () =>
      apiRequest<TrialBalanceResponse>(
        `/api/accounting/reports/trial-balance${toQueryString(params)}`
      ),
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useProfitLossQuery(filters?: ReportFilterParams, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.costCenterId && filters.costCenterId !== "all"
      ? { costCenterId: filters.costCenterId }
      : {}),
    ...(filters?.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters?.toDate ? { toDate: filters.toDate } : {}),
  };
  return useQuery({
    queryKey: erpQueryKeys.accounting.statement("profit-loss", params),
    queryFn: () =>
      apiRequest<ProfitLossResponse>(
        `/api/accounting/reports/profit-loss${toQueryString(params)}`
      ),
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useBalanceSheetQuery(filters?: ReportFilterParams, enabled = true) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.asOfDate ? { asOfDate: filters.asOfDate } : {}),
  };
  return useQuery({
    queryKey: erpQueryKeys.accounting.statement("balance-sheet", params),
    queryFn: () =>
      apiRequest<BalanceSheetResponse>(
        `/api/accounting/reports/balance-sheet${toQueryString(params)}`
      ),
    enabled: Boolean(user) && enabled && can("accounting", "view"),
  });
}

export function useAccountLedgerQuery(
  accountId: string | null,
  filters?: ReportFilterParams
) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const params = {
    ...(filters?.branchId && filters.branchId !== "all" ? { branchId: filters.branchId } : {}),
    ...(filters?.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters?.toDate ? { toDate: filters.toDate } : {}),
  };
  return useQuery({
    queryKey: erpQueryKeys.accounting.statement(`ledger:${accountId ?? "none"}`, params),
    queryFn: () =>
      apiRequest<{ entries: AccountLedgerRowDto[] }>(
        `/api/accounting/reports/ledger/${accountId}${toQueryString(params)}`
      ),
    select: (data) => data.entries,
    enabled: Boolean(user) && Boolean(accountId) && can("accounting", "view"),
  });
}

export function useTaxCodesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.accounting.taxCodes(),
    queryFn: () => apiRequest<{ taxCodes: TaxCodeDto[] }>("/api/tax-codes"),
    select: (data) => data.taxCodes,
    enabled: Boolean(user) && enabled,
  });
}

export function useCurrenciesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.accounting.currencies(),
    queryFn: () =>
      apiRequest<{ currencies: CurrencyDto[]; exchangeRates: ExchangeRateDto[] }>("/api/currencies"),
    enabled: Boolean(user) && enabled,
  });
}

export function useAccountingMutations() {
  const queryClient = useQueryClient();
  const { reloadCompanySettings } = useSettings();

  const invalidateAccounting = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const invalidateSettingsAndAccounting = () => {
    invalidateAccounting();
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.settings });
    void reloadCompanySettings();
  };

  const createAccount = useMutation({
    mutationFn: (body: {
      code: string;
      name: string;
      accountType: AccountTypeShared;
      normalBalance?: NormalBalanceShared;
      description?: string;
      isActive?: boolean;
    }) => apiRequest<{ account: ChartAccountDto }>("/api/accounting/accounts", { method: "POST", body }),
    onSuccess: invalidateAccounting,
  });

  const updateAccount = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { name?: string; description?: string; isActive?: boolean };
    }) => apiRequest<{ account: ChartAccountDto }>(`/api/accounting/accounts/${id}`, { method: "PUT", body }),
    onSuccess: invalidateAccounting,
  });

  const updateMapping = useMutation({
    mutationFn: (body: { mappingKey: GlMappingKey; accountId: string }) =>
      apiRequest<{ mapping: GlMappingDto }>("/api/accounting/mappings", { method: "PUT", body }),
    onSuccess: invalidateAccounting,
  });

  const createJournalEntry = useMutation({
    mutationFn: (body: {
      entryDate?: string;
      branchId?: string | null;
      referenceNumber?: string;
      memo: string;
      lines: Array<{
        accountId: string;
        branchId?: string | null;
        costCenterId?: string | null;
        debit: number;
        credit: number;
        currency?: string;
        fxRate?: number;
        description?: string;
      }>;
    }) => apiRequest<{ entry: JournalEntryDto }>("/api/accounting/journal-entries", { method: "POST", body }),
    onSuccess: invalidateAccounting,
  });

  const reverseJournalEntry = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiRequest<{ reversal: JournalEntryDto }>(`/api/accounting/journal-entries/${id}/reverse`, {
        method: "POST",
        body: { reason },
      }),
    onSuccess: invalidateAccounting,
  });

  const createFiscalYear = useMutation({
    mutationFn: (body: { name: string; startDate: string; endDate: string }) =>
      apiRequest<{ fiscalYear: FiscalYearDto }>("/api/accounting/fiscal-years", { method: "POST", body }),
    onSuccess: invalidateAccounting,
  });

  const togglePeriodLock = useMutation({
    mutationFn: ({ id, lock }: { id: string; lock: boolean }) =>
      apiRequest(`/api/accounting/periods/${id}/${lock ? "lock" : "unlock"}`, { method: "POST" }),
    onSuccess: invalidateAccounting,
  });

  const createTaxCode = useMutation({
    mutationFn: (body: {
      code: string;
      name: string;
      rate: number;
      isDefault?: boolean;
      isInclusive?: boolean;
      isActive?: boolean;
      inputAccountId?: string | null;
      outputAccountId?: string | null;
    }) => apiRequest<{ taxCode: TaxCodeDto }>("/api/tax-codes", { method: "POST", body }),
    onSuccess: invalidateSettingsAndAccounting,
  });

  const updateTaxCode = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: Partial<{
        code: string;
        name: string;
        rate: number;
        isDefault: boolean;
        isInclusive: boolean;
        isActive: boolean;
        inputAccountId: string | null;
        outputAccountId: string | null;
      }>;
    }) => apiRequest<{ taxCode: TaxCodeDto }>(`/api/tax-codes/${id}`, { method: "PUT", body }),
    onSuccess: invalidateSettingsAndAccounting,
  });

  const deleteTaxCode = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/tax-codes/${id}`, { method: "DELETE" }),
    onSuccess: invalidateSettingsAndAccounting,
  });

  const upsertCurrency = useMutation({
    mutationFn: (body: {
      code: string;
      name: string;
      symbol: string;
      decimals?: number;
      isBase?: boolean;
      isActive?: boolean;
    }) => apiRequest<{ currency: CurrencyDto }>("/api/currencies", { method: "PUT", body }),
    onSuccess: invalidateSettingsAndAccounting,
  });

  const createExchangeRate = useMutation({
    mutationFn: (body: { fromCurrency: string; toCurrency: string; rate: number; effectiveAt?: string }) =>
      apiRequest<{ exchangeRate: ExchangeRateDto }>("/api/currencies/rates", { method: "POST", body }),
    onSuccess: invalidateAccounting,
  });

  return {
    createAccount,
    updateAccount,
    updateMapping,
    createJournalEntry,
    reverseJournalEntry,
    createFiscalYear,
    togglePeriodLock,
    createTaxCode,
    updateTaxCode,
    deleteTaxCode,
    upsertCurrency,
    createExchangeRate,
  };
}
