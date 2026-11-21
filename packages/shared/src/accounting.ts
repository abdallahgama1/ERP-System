import { z } from "zod";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountTypeShared = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["debit", "credit"] as const;
export type NormalBalanceShared = (typeof NORMAL_BALANCES)[number];

export const FISCAL_PERIOD_STATUSES = ["open", "locked"] as const;
export type FiscalPeriodStatusShared = (typeof FISCAL_PERIOD_STATUSES)[number];

export const JOURNAL_ENTRY_STATUSES = ["posted", "reversed"] as const;
export type JournalEntryStatusShared = (typeof JOURNAL_ENTRY_STATUSES)[number];

export const GL_MAPPING_KEYS = [
  "default_cash_bank",
  "pos_cash_drawer",
  "card_clearing",
  "accounts_receivable",
  "inventory_asset",
  "in_transit_inventory",
  "wip_inventory",
  "input_vat",
  "accounts_payable",
  "grni",
  "retainer_liability",
  "output_vat",
  "opening_equity",
  "sales_revenue",
  "cogs",
  "inventory_adjustment",
  "write_off_expense",
  "cash_over_short",
  "rounding_variance",
] as const;
export type GlMappingKey = (typeof GL_MAPPING_KEYS)[number];

export const createAccountSchema = z.object({
  code: z.string().trim().min(1, "Account code is required").max(32),
  name: z.string().trim().min(1, "Account name is required").max(160),
  accountType: z.enum(ACCOUNT_TYPES),
  normalBalance: z.enum(NORMAL_BALANCES).optional(),
  parentId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(300).optional().default(""),
  isActive: z.boolean().optional().default(true),
});

export const updateAccountSchema = createAccountSchema.partial();

export const updateGlMappingSchema = z.object({
  mappingKey: z.enum(GL_MAPPING_KEYS),
  accountId: z.string().uuid(),
});

export const journalLineInputSchema = z.object({
  accountId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  debit: z.number().min(0).default(0),
  credit: z.number().min(0).default(0),
  currency: z.string().trim().min(3).max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  description: z.string().trim().max(250).optional().default(""),
});

export const createJournalEntrySchema = z
  .object({
    entryDate: z.string().optional(),
    branchId: z.string().uuid().nullable().optional(),
    referenceNumber: z.string().trim().max(80).optional().default(""),
    memo: z.string().trim().min(1, "Memo is required").max(500),
    lines: z.array(journalLineInputSchema).min(2, "At least two journal lines are required"),
  })
  .refine(
    (data) => {
      const totalDr = data.lines.reduce((s, l) => s + l.debit * (l.fxRate ?? 1), 0);
      const totalCr = data.lines.reduce((s, l) => s + l.credit * (l.fxRate ?? 1), 0);
      return totalDr > 0 && Math.abs(totalDr - totalCr) <= 0.005;
    },
    { message: "Total debits must equal total credits and be positive" }
  );

export const createFiscalYearSchema = z.object({
  name: z.string().trim().min(2).max(60),
  startDate: z.string(),
  endDate: z.string(),
});

export const createTaxCodeSchema = z.object({
  code: z.string().trim().min(1, "Tax code is required").max(40),
  name: z.string().trim().min(1, "Tax name is required").max(120),
  rate: z.number().min(0).max(100),
  isDefault: z.boolean().optional().default(false),
  isInclusive: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  inputAccountId: z.string().uuid().nullable().optional(),
  outputAccountId: z.string().uuid().nullable().optional(),
});

export const updateTaxCodeSchema = createTaxCodeSchema.partial();

export const upsertCurrencySchema = z.object({
  code: z.string().trim().toUpperCase().min(3).max(10),
  name: z.string().trim().min(1).max(80),
  symbol: z.string().trim().min(1).max(10),
  decimals: z.number().int().min(0).max(4).optional().default(2),
  isBase: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});

export const createExchangeRateSchema = z.object({
  fromCurrency: z.string().trim().toUpperCase().min(3).max(10),
  toCurrency: z.string().trim().toUpperCase().min(3).max(10),
  rate: z.number().positive(),
  effectiveAt: z.string().optional(),
});
