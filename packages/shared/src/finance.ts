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
