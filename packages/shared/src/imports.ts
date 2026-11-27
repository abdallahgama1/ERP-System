import { z } from "zod";
import type { CsvParseError } from "./csv.ts";
import type { AccountingSetupHealthDto, SubledgerReconciliationReportDto } from "./finance.ts";

export const IMPORT_DATASET_KINDS = [
  "chart_of_accounts",
  "customers",
  "vendors",
  "products",
  "opening_stock",
  "opening_fixed_assets",
  "opening_treasury",
  "opening_trial_balance",
  "opening_ar",
  "opening_ap",
] as const;

export type ImportDatasetKind = (typeof IMPORT_DATASET_KINDS)[number];

export const STANDARD_IMPORT_KINDS = [
  "chart_of_accounts",
  "customers",
  "vendors",
  "products",
  "opening_stock",
  "opening_fixed_assets",
  "opening_treasury",
] as const;

export type StandardImportKind = (typeof STANDARD_IMPORT_KINDS)[number];

export const csvImportRequestSchema = z.object({
  csv: z.string().min(1, "CSV content is required"),
  dryRun: z.boolean().optional().default(true),
  updateExisting: z.boolean().optional().default(false),
});

export const openingBalancesImportSchema = z.object({
  cutoverDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "cutoverDate must be formatted as YYYY-MM-DD"),
  allowPnlAccounts: z.boolean().optional().default(false),
  trialBalanceCsv: z.string().min(1, "Opening trial balance CSV is required"),
  openArCsv: z.string().optional().default(""),
  openApCsv: z.string().optional().default(""),
  memo: z.string().trim().max(300).optional().default(""),
  dryRun: z.boolean().optional().default(true),
});

export const reverseOpeningBalancesSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, "A reason of at least 5 characters is required to reverse opening balances")
    .max(500),
});

export interface ImportRowPreviewDto {
  row: number;
  action: "create" | "update" | "skip";
  summary: string;
}

export interface CsvImportResultDto {
  kind: StandardImportKind;
  dryRun: boolean;
  updateExisting?: boolean;
  valid: boolean;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errors: CsvParseError[];
  warnings: CsvParseError[];
  preview: ImportRowPreviewDto[];
  setupHealth?: AccountingSetupHealthDto;
}

export interface OpeningReversalBlockerDto {
  category:
    | "opening_ar"
    | "opening_ap"
    | "opening_stock"
    | "opening_fixed_asset"
    | "opening_treasury"
    | "non_opening_journal";
  reference: string;
  reason: string;
}

export interface CutoverReadinessCheckDto {
  passed: boolean;
  summary: string;
}

export interface CutoverReadinessDto {
  ready: boolean;
  status: "PASS" | "FAIL";
  checkedAt: string;
  checks: {
    reconciliation: CutoverReadinessCheckDto & {
      totalControls: number;
      passedControls: number;
      failingKeys: string[];
    };
    setupHealth: CutoverReadinessCheckDto & {
      totalMappings: number;
      validMappings: number;
      issueCount: number;
    };
    auditChain: CutoverReadinessCheckDto & {
      totalChainedRows: number;
      firstBrokenId: string | null;
    };
  };
  reconciliation: SubledgerReconciliationReportDto;
  setupHealth: AccountingSetupHealthDto;
}

export interface OpeningBalancesImportResultDto {
  dryRun: boolean;
  valid: boolean;
  cutoverDate: string;
  allowPnlAccounts: boolean;
  trialBalanceRows: number;
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  openArCount: number;
  openArTotal: number;
  openApCount: number;
  openApTotal: number;
  openingStockValuation: number;
  openingFixedAssetsCost: number;
  openingFixedAssetsAccumDep: number;
  openingTreasuryTotal: number;
  openingOutputVatCarryover: number;
  openingInputVatCarryover: number;
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  errors: CsvParseError[];
  warnings: CsvParseError[];
  reconciliation?: SubledgerReconciliationReportDto;
}

export interface ReverseOpeningBalancesResultDto {
  reversedJournalEntryId: string;
  reversalEntryId: string;
  reversalEntryNumber: string;
  removedArInvoices: number;
  removedApBills: number;
  removedFixedAssets: number;
  removedTreasuryAccounts: number;
  removedOpeningStockMovements: number;
}

export interface OpeningCutoverStatusDto {
  hasOpeningJournal: boolean;
  openingJournalEntryId: string | null;
  openingJournalEntryNumber: string | null;
  cutoverDate: string | null;
  hasNonOpeningJournals: boolean;
  canImportOpening: boolean;
  canReverseOpening: boolean;
  blockedReason: string | null;
  counts: {
    openingArInvoices: number;
    openingApBills: number;
    openingFixedAssets: number;
    openingTreasuryAccounts: number;
    openingStockMovements: number;
  };
}

export interface CsvTemplateDefinition {
  kind: ImportDatasetKind;
  fileName: string;
  headers: string[];
  exampleRows: string[][];
}

export const CSV_TEMPLATES: Record<ImportDatasetKind, CsvTemplateDefinition> = {
  chart_of_accounts: {
    kind: "chart_of_accounts",
    fileName: "01-chart-of-accounts-template.csv",
    headers: ["code", "name", "account_type", "normal_balance", "description", "is_active"],
    exampleRows: [
      ["1030", "Main Operating Bank - CIB EGP", "asset", "debit", "Primary corporate EGP operating bank account", "true"],
      ["1031", "HQ Petty Cashbox", "asset", "debit", "Headquarters cashbox", "true"],
      ["3100", "Retained Earnings", "equity", "credit", "Accumulated prior-year earnings", "true"],
    ],
  },
  customers: {
    kind: "customers",
    fileName: "02-customers-template.csv",
    headers: [
      "code",
      "name",
      "eta_receiver_type",
      "tax_number",
      "email",
      "phone",
      "company",
      "billing_address",
      "currency",
      "payment_terms_days",
      "credit_limit",
    ],
    exampleRows: [
      ["CUST-101", "Nile Delta Distributors", "B", "200300400", "ap@niledelta.example", "+20224001100", "Nile Delta SAE", "15 Tahrir St, Cairo", "EGP", "30", "250000"],
      ["CUST-102", "Ahmed Mansour", "P", "29001011234567", "ahmed@example.com", "+201001112233", "", "Nasr City, Cairo", "EGP", "0", ""],
    ],
  },
  vendors: {
    kind: "vendors",
    fileName: "03-vendors-template.csv",
    headers: [
      "code",
      "name",
      "tax_number",
      "email",
      "phone",
      "company",
      "address",
      "currency",
      "payment_terms_days",
    ],
    exampleRows: [
      ["VEND-101", "Alexandria Industrial Supplies", "400500600", "ar@alexsupplies.example", "+2034800990", "Alex Industrial SAE", "Borg El Arab, Alexandria", "EGP", "45"],
    ],
  },
  products: {
    kind: "products",
    fileName: "04-products-template.csv",
    headers: [
      "sku",
      "name",
      "name_ar",
      "barcode",
      "category",
      "brand",
      "unit",
      "cost_price",
      "selling_price",
      "min_stock_level",
      "item_type",
      "eta_code_type",
      "eta_item_code",
      "eta_unit_type",
    ],
    exampleRows: [
      ["SKU-1001", "Industrial Valve 2-Inch", "صمام صناعي 2 بوصة", "6221000001001", "Valves", "ApexFlow", "pcs", "150.00", "260.00", "10", "stock", "GS1", "6221000001001", "EA"],
    ],
  },
  opening_stock: {
    kind: "opening_stock",
    fileName: "05-opening-stock-template.csv",
    headers: ["sku", "branch_code", "quantity", "unit_cost"],
    exampleRows: [
      ["SKU-1001", "HQ-01", "100", "150.00"],
    ],
  },
  opening_fixed_assets: {
    kind: "opening_fixed_assets",
    fileName: "06-opening-fixed-assets-template.csv",
    headers: [
      "asset_code",
      "name",
      "category",
      "acquisition_date",
      "in_service_date",
      "acquisition_cost",
      "accumulated_depreciation",
      "salvage_value",
      "useful_life_months",
      "depreciation_method",
      "branch_code",
      "asset_account_code",
      "accum_dep_account_code",
      "dep_expense_account_code",
      "serial_number",
    ],
    exampleRows: [
      ["FA-OPEN-01", "Delivery Van - Cairo", "Vehicles", "2024-01-15", "2024-01-15", "240000.00", "60000.00", "20000.00", "60", "straight_line", "HQ-01", "1500", "1510", "5700", "VIN-SYN-0001"],
    ],
  },
  opening_treasury: {
    kind: "opening_treasury",
    fileName: "07-opening-treasury-template.csv",
    headers: [
      "code",
      "name",
      "account_type",
      "currency",
      "gl_account_code",
      "opening_balance",
      "bank_name",
      "account_number",
      "iban",
      "branch_code",
    ],
    exampleRows: [
      ["BNK-CIB-EGP", "CIB Main Operating EGP", "bank", "EGP", "1030", "150000.00", "CIB Egypt", "1000200030", "EG380010000100000001000200030", "HQ-01"],
      ["CSH-HQ", "HQ Petty Cashbox", "cashbox", "EGP", "1031", "15000.00", "", "", "", "HQ-01"],
    ],
  },
  opening_trial_balance: {
    kind: "opening_trial_balance",
    fileName: "08-opening-trial-balance-template.csv",
    headers: ["account_code", "debit", "credit", "description"],
    exampleRows: [
      ["1030", "150000.00", "0", "Opening CIB Main Operating EGP"],
      ["1031", "15000.00", "0", "Opening HQ Petty Cashbox"],
      ["1100", "45000.00", "0", "Opening Accounts Receivable"],
      ["1200", "15000.00", "0", "Opening Inventory Valuation"],
      ["1300", "2800.00", "0", "Opening Input VAT Carryover"],
      ["1500", "240000.00", "0", "Opening Fixed Assets Cost"],
      ["1510", "0", "60000.00", "Opening Accumulated Depreciation"],
      ["2000", "0", "30000.00", "Opening Accounts Payable"],
      ["2300", "0", "4200.00", "Opening Output VAT Carryover"],
      ["3100", "0", "373600.00", "Opening Retained Earnings & Prior Equity"],
    ],
  },
  opening_ar: {
    kind: "opening_ar",
    fileName: "09-opening-ar-template.csv",
    headers: ["invoice_number", "customer_code", "branch_code", "invoice_date", "due_date", "open_amount", "currency", "fx_rate", "notes"],
    exampleRows: [
      ["OPEN-INV-001", "CUST-101", "HQ-01", "2025-12-15", "2026-01-14", "45000.00", "EGP", "1", "Legacy invoice #2025-881 carried forward"],
    ],
  },
  opening_ap: {
    kind: "opening_ap",
    fileName: "10-opening-ap-template.csv",
    headers: ["bill_number", "vendor_code", "branch_code", "bill_date", "due_date", "open_amount", "currency", "fx_rate", "notes"],
    exampleRows: [
      ["OPEN-BILL-001", "VEND-101", "HQ-01", "2025-12-20", "2026-02-03", "30000.00", "EGP", "1", "Legacy vendor bill #VB-772 carried forward"],
    ],
  },
};

export function renderCsvTemplate(kind: ImportDatasetKind): string {
  const def = CSV_TEMPLATES[kind];
  const escapeCell = (v: string) => {
    if (v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\r")) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const lines = [
    def.headers.map(escapeCell).join(","),
    ...def.exampleRows.map((row) => row.map(escapeCell).join(",")),
  ];
  // Include UTF-8 BOM so Microsoft Excel opens Arabic cells without mojibake
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
