import { z } from "zod";
import { offsetPageQuerySchema, optionalSearchQuery } from "./pagination.ts";

// ============================================================================
// Wave 2A: Cost Centers, Treasury & Bank Reconciliation, Operating Expenses
// ============================================================================

export const TREASURY_ACCOUNT_TYPES = ["bank", "cashbox"] as const;
export type TreasuryAccountType = (typeof TREASURY_ACCOUNT_TYPES)[number];

export const BANK_STATEMENT_LINE_STATUSES = ["unmatched", "reconciled", "ignored"] as const;
export type BankStatementLineStatus = (typeof BANK_STATEMENT_LINE_STATUSES)[number];

export const EXPENSE_CLAIM_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "paid",
  "rejected",
] as const;
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];

export const EXPENSE_PAYMENT_MODES = ["direct_treasury", "employee_reimbursement"] as const;
export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];

// ---------------- Cost Centers ----------------

export const createCostCenterSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Cost center code is required")
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Cost center code may only contain letters, numbers, hyphens, and underscores")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, "Cost center name is required").max(160),
  branchId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(300).optional().default(""),
  isActive: z.boolean().optional().default(true),
});

export const updateCostCenterSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((v) => v.toUpperCase())
    .optional(),
  name: z.string().trim().min(1).max(160).optional(),
  branchId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(300).optional(),
  isActive: z.boolean().optional(),
});

export interface CostCenterDto {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  branchName: string | null;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------- Treasury Accounts, Transfers & Bank Reconciliation ----------------

export const createTreasuryAccountSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Treasury account code is required")
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Code may only contain letters, numbers, hyphens, and underscores")
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1, "Treasury account name is required").max(160),
  accountType: z.enum(TREASURY_ACCOUNT_TYPES),
  currency: z.string().trim().toUpperCase().min(3).max(10).optional().default("USD"),
  branchId: z.string().uuid().nullable().optional(),
  glAccountId: z.string().uuid().nullable().optional(),
  bankName: z.string().trim().max(160).optional().default(""),
  accountNumber: z.string().trim().max(80).optional().default(""),
  iban: z.string().trim().max(64).optional().default(""),
  openingBalance: z.number().min(0).optional().default(0),
  openingBalanceDate: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateTreasuryAccountSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  branchId: z.string().uuid().nullable().optional(),
  bankName: z.string().trim().max(160).optional(),
  accountNumber: z.string().trim().max(80).optional(),
  iban: z.string().trim().max(64).optional(),
  isActive: z.boolean().optional(),
});

export const createTreasuryTransferSchema = z
  .object({
    fromTreasuryAccountId: z.string().uuid(),
    toTreasuryAccountId: z.string().uuid(),
    amount: z.number().positive("Transfer amount must be positive"),
    transferDate: z.string().optional(),
    reference: z.string().trim().max(80).optional().default(""),
    memo: z.string().trim().max(400).optional().default(""),
  })
  .refine((d) => d.fromTreasuryAccountId !== d.toTreasuryAccountId, {
    message: "Source and destination treasury accounts must be different",
    path: ["toTreasuryAccountId"],
  });

export const importBankStatementCsvSchema = z.object({
  fileName: z.string().trim().max(200).optional().default("statement.csv"),
  csvText: z.string().min(1, "CSV content is required").max(2_000_000),
});

export const reconcileStatementLineSchema = z
  .object({
    journalLineId: z.string().uuid().optional(),
    createAdjustment: z
      .object({
        counterpartAccountId: z.string().uuid(),
        costCenterId: z.string().uuid().nullable().optional(),
        memo: z.string().trim().min(1).max(300).optional(),
      })
      .optional(),
  })
  .refine((d) => Boolean(d.journalLineId) !== Boolean(d.createAdjustment), {
    message: "Provide either journalLineId or createAdjustment (not both)",
  });

export interface TreasuryAccountDto {
  id: string;
  code: string;
  name: string;
  accountType: TreasuryAccountType;
  currency: string;
  branchId: string | null;
  branchName: string | null;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
  bankName: string;
  accountNumber: string;
  iban: string;
  bookBalance: number;
  reconciledBalance: number;
  unmatchedStatementLines: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TreasuryTransferDto {
  id: string;
  transferNumber: string;
  transferDate: string;
  fromTreasuryAccountId: string;
  fromAccountName: string;
  toTreasuryAccountId: string;
  toAccountName: string;
  amount: number;
  currency: string;
  reference: string;
  memo: string;
  journalEntryId: string | null;
  createdAt: string;
}

export interface BankStatementLineDto {
  id: string;
  statementId: string;
  treasuryAccountId: string;
  lineDate: string;
  description: string;
  reference: string;
  amount: number;
  runningBalance: number | null;
  status: BankStatementLineStatus;
  matchedJournalLineId: string | null;
  matchedEntryNumber: string | null;
  suggestedJournalLineId: string | null;
  reconciledAt: string | null;
}

export interface UnreconciledGlLineDto {
  journalLineId: string;
  entryId: string;
  entryNumber: string;
  entryDate: string;
  memo: string;
  referenceNumber: string;
  description: string;
  signedAmount: number;
  debitBase: number;
  creditBase: number;
}

// ---------------- Operating Expenses & Petty Cash Claims ----------------

export const expenseClaimLineSchema = z.object({
  expenseAccountId: z.string().uuid(),
  costCenterId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1, "Line description is required").max(250),
  netAmount: z.number().positive("Line amount must be positive"),
  taxCodeId: z.string().uuid().nullable().optional(),
  taxRate: z.number().min(0).max(100).optional().default(0),
});

export const createExpenseClaimSchema = z.object({
  claimDate: z.string().optional(),
  branchId: z.string().uuid().nullable().optional(),
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES).default("direct_treasury"),
  treasuryAccountId: z.string().uuid().nullable().optional(),
  payeeName: z.string().trim().max(160).optional().default(""),
  reference: z.string().trim().max(80).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
  submitNow: z.boolean().optional().default(true),
  lines: z.array(expenseClaimLineSchema).min(1, "At least one expense line is required"),
});

export const reviewExpenseClaimSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(500).optional().default(""),
});

export const payExpenseClaimSchema = z.object({
  treasuryAccountId: z.string().uuid(),
  paymentDate: z.string().optional(),
  reference: z.string().trim().max(80).optional().default(""),
});

export const expenseClaimsListQuerySchema = offsetPageQuerySchema.extend({
  status: z
    .union([z.enum(EXPENSE_CLAIM_STATUSES), z.literal(""), z.literal("all")])
    .transform((v) => (v === "" || v === "all" ? undefined : v))
    .optional(),
  paymentMode: z
    .union([z.enum(EXPENSE_PAYMENT_MODES), z.literal(""), z.literal("all")])
    .transform((v) => (v === "" || v === "all" ? undefined : v))
    .optional(),
  branchId: z
    .string()
    .trim()
    .transform((v) => (v === "" || v === "all" ? undefined : v))
    .pipe(z.string().uuid().optional())
    .optional(),
  fromDate: optionalSearchQuery,
  toDate: optionalSearchQuery,
});

export interface ExpenseClaimLineDto {
  id: string;
  expenseAccountId: string;
  expenseAccountCode: string;
  expenseAccountName: string;
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string | null;
  description: string;
  netAmount: number;
  taxCodeId: string | null;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
}

export interface ExpenseClaimDto {
  id: string;
  claimNumber: string;
  claimDate: string;
  branchId: string | null;
  branchName: string | null;
  submittedBy: string | null;
  submittedByName: string;
  payeeName: string;
  paymentMode: ExpensePaymentMode;
  treasuryAccountId: string | null;
  treasuryAccountName: string | null;
  status: ExpenseClaimStatus;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  currency: string;
  reference: string;
  notes: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string;
  accrualJournalEntryId: string | null;
  paymentJournalEntryId: string | null;
  paidAt: string | null;
  createdAt: string;
  lines: ExpenseClaimLineDto[];
}

// ============================================================================
// Wave 2B: Cash Flow, VAT Return, Year-End Close, FX Revaluation & Fixed Assets
// ============================================================================

export const FIXED_ASSET_DEPRECIATION_METHODS = ["straight_line", "declining_balance"] as const;
export type FixedAssetDepreciationMethod = (typeof FIXED_ASSET_DEPRECIATION_METHODS)[number];

export const FIXED_ASSET_STATUSES = ["active", "fully_depreciated", "disposed"] as const;
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number];

export interface CashFlowLineDto {
  code: string;
  label: string;
  amount: number;
}

export interface CashFlowStatementDto {
  fromDate: string | null;
  toDate: string | null;
  openingCash: number;
  closingCash: number;
  netCashChange: number;
  operating: {
    netIncome: number;
    nonCashAdjustments: CashFlowLineDto[];
    workingCapitalChanges: CashFlowLineDto[];
    total: number;
  };
  investing: {
    items: CashFlowLineDto[];
    total: number;
  };
  financing: {
    items: CashFlowLineDto[];
    total: number;
  };
  isReconciled: boolean;
}

export interface VatReturnRateBucketDto {
  taxRate: number;
  taxableAmount: number;
  vatAmount: number;
  documentCount: number;
}

export interface VatReturnReportDto {
  fromDate: string | null;
  toDate: string | null;
  outputSales: VatReturnRateBucketDto[];
  inputPurchasesAndExpenses: VatReturnRateBucketDto[];
  totalOutputTaxable: number;
  totalOutputVat: number;
  totalInputTaxable: number;
  totalInputVat: number;
  netVatPayable: number;
  glOutputVatBalance: number;
  glInputVatBalance: number;
  glNetVatPayable: number;
}

export const closeFiscalYearSchema = z.object({
  memo: z.string().trim().max(300).optional().default(""),
});

export const reopenFiscalYearSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "A reason of at least 5 characters is required to reopen a closed fiscal year")
    .max(500),
});

export interface YearEndCloseResultDto {
  fiscalYearId: string;
  fiscalYearName: string;
  status: "closed";
  journalEntryId: string | null;
  entryNumber: string | null;
  totalRevenueClosed: number;
  totalExpensesClosed: number;
  netIncomeTransferred: number;
  periodsClosed: number;
}

export interface YearEndReopenResultDto {
  fiscalYearId: string;
  fiscalYearName: string;
  status: "open";
  reversedClosingEntryId: string | null;
  reversalEntryId: string | null;
  reversalEntryNumber: string | null;
  periodsReopened: number;
}

export type ReconciliationControlKey =
  | "accounts_receivable"
  | "accounts_payable"
  | "inventory_asset"
  | "output_vat"
  | "input_vat"
  | "fixed_assets_cost"
  | "accumulated_depreciation"
  | "treasury";

export interface SubledgerReconciliationItemDto {
  key: ReconciliationControlKey;
  label: string;
  glAccountCode: string;
  glAccountName: string;
  subledgerBalance: number;
  glBalance: number;
  variance: number;
  isReconciled: boolean;
  details?: string;
}

export interface TreasuryReconciliationItemDto {
  treasuryAccountId: string;
  code: string;
  name: string;
  glAccountCode: string;
  glAccountName: string;
  glBalance: number;
  reconciledStatementBalance: number;
  unreconciledGlDelta: number;
  isValidAssetAccount: boolean;
}

export interface SubledgerReconciliationReportDto {
  asOfDate: string | null;
  items: SubledgerReconciliationItemDto[];
  treasuryAccounts: TreasuryReconciliationItemDto[];
  allReconciled: boolean;
}

export interface AccountingMappingIssueDto {
  mappingKey: string;
  expectedCode: string;
  expectedName: string;
  expectedAccountType: "asset" | "liability" | "equity" | "revenue" | "expense";
  status: "missing" | "type_mismatch" | "inactive";
  boundAccountId: string | null;
  boundAccountCode: string | null;
  boundAccountName: string | null;
  boundAccountType: string | null;
  collidingAccountCode: string | null;
  collidingAccountName: string | null;
  collidingAccountType: string | null;
  instructions: string;
}

export interface AccountingSetupHealthDto {
  healthy: boolean;
  totalMappings: number;
  validMappings: number;
  issues: AccountingMappingIssueDto[];
}

// ---------------- Period-End FX Revaluation ----------------

export const fxRevaluationRateOverrideSchema = z.object({
  currency: z.string().trim().toUpperCase().min(3).max(10),
  closingRate: z.number().positive("Closing FX rate must be positive"),
});

export const runFxRevaluationSchema = z.object({
  asOfDate: z.string().min(1, "Valuation date is required"),
  autoReverse: z.boolean().optional().default(true),
  memo: z.string().trim().max(300).optional().default(""),
  rates: z.array(fxRevaluationRateOverrideSchema).optional().default([]),
});

export interface FxExposureLineDto {
  entityType: "sales_invoice" | "vendor_bill" | "treasury_account";
  entityId: string;
  documentNumber: string;
  currency: string;
  foreignBalance: number;
  bookedRate: number;
  closingRate: number;
  bookedBaseAmount: number;
  revaluedBaseAmount: number;
  unrealizedGainLoss: number;
  glAccountId: string;
}

export interface FxRevaluationPreviewDto {
  asOfDate: string;
  baseCurrency: string;
  lines: FxExposureLineDto[];
  totalUnrealizedGainLoss: number;
}

export interface FxRevaluationResultDto extends FxRevaluationPreviewDto {
  journalEntryId: string | null;
  entryNumber: string | null;
  reversalJournalEntryId: string | null;
  reversalEntryNumber: string | null;
}

// ---------------- Fixed Assets & Automated Depreciation ----------------

export const createFixedAssetSchema = z
  .object({
    name: z.string().trim().min(1, "Asset name is required").max(160),
    category: z.string().trim().min(1).max(80).optional().default("Equipment"),
    serialNumber: z.string().trim().max(100).optional().default(""),
    branchId: z.string().uuid().nullable().optional(),
    costCenterId: z.string().uuid().nullable().optional(),
    acquisitionDate: z.string().min(1, "Acquisition date is required"),
    inServiceDate: z.string().optional(),
    acquisitionCost: z.number().positive("Acquisition cost must be positive"),
    salvageValue: z.number().min(0, "Salvage value cannot be negative").optional().default(0),
    usefulLifeMonths: z.number().int().min(1, "Useful life must be at least 1 month").max(1200),
    depreciationMethod: z.enum(FIXED_ASSET_DEPRECIATION_METHODS).optional().default("straight_line"),
    decliningRatePct: z.number().min(100).max(500).optional().default(200),
    assetAccountId: z.string().uuid().nullable().optional(),
    accumDepAccountId: z.string().uuid().nullable().optional(),
    depExpenseAccountId: z.string().uuid().nullable().optional(),
    fundingAccountId: z.string().uuid().nullable().optional(),
    postAcquisitionEntry: z.boolean().optional().default(true),
    notes: z.string().trim().max(500).optional().default(""),
  })
  .refine((d) => d.salvageValue < d.acquisitionCost, {
    message: "Salvage value must be strictly less than acquisition cost",
    path: ["salvageValue"],
  });

export const runDepreciationSchema = z.object({
  periodKey: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "periodKey must be formatted as YYYY-MM"),
  postingDate: z.string().optional(),
});

export const disposeFixedAssetSchema = z.object({
  disposalDate: z.string().min(1, "Disposal date is required"),
  proceedsAmount: z.number().min(0).optional().default(0),
  depositAccountId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(400).optional().default(""),
});

export interface FixedAssetDepreciationEntryDto {
  id: string;
  assetId: string;
  periodKey: string;
  depreciationDate: string;
  depreciationAmount: number;
  accumulatedAfter: number;
  netBookValueAfter: number;
  journalEntryId: string | null;
  createdAt: string;
}

export interface FixedAssetDto {
  id: string;
  assetCode: string;
  name: string;
  category: string;
  serialNumber: string;
  branchId: string | null;
  branchName: string | null;
  costCenterId: string | null;
  costCenterCode: string | null;
  acquisitionDate: string;
  inServiceDate: string;
  acquisitionCost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  depreciationMethod: FixedAssetDepreciationMethod;
  decliningRatePct: number;
  accumulatedDepreciation: number;
  netBookValue: number;
  status: FixedAssetStatus;
  assetAccountId: string;
  accumDepAccountId: string;
  depExpenseAccountId: string;
  acquisitionJournalEntryId: string | null;
  disposedAt: string | null;
  disposalProceeds: number | null;
  disposalJournalEntryId: string | null;
  notes: string;
  createdAt: string;
}

export interface DepreciationRunResultDto {
  periodKey: string;
  processedAssets: number;
  skippedAlreadyPosted: number;
  totalDepreciationPosted: number;
  entries: FixedAssetDepreciationEntryDto[];
}
