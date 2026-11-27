import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  normalizeArabicDigits,
  parseCsvText,
  parseIsoDateString,
  parseLocalizedBoolean,
  parseLocalizedNumber,
  roundCurrency,
  validateEtaTaxId,
  validateVendorTaxId,
  type AccountTypeShared,
  type AccountingMappingIssueDto,
  type AccountingSetupHealthDto,
  type CsvImportResultDto,
  type CsvParseError,
  type GlMappingKey,
  type ImportRowPreviewDto,
  type NormalBalanceShared,
  type OpeningBalancesImportResultDto,
  type OpeningCutoverStatusDto,
  type ReverseOpeningBalancesResultDto,
  type StandardImportKind,
  type csvImportRequestSchema,
  type openingBalancesImportSchema,
  type reverseOpeningBalancesSchema,
} from "@erp/shared";
import { and, eq, gte, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  branchProducts,
  branches,
  chartOfAccounts,
  companies,
  customers,
  fixedAssetDepreciationEntries,
  fixedAssets,
  glAccountMappings,
  journalEntries,
  journalLines,
  paymentMadeAllocations,
  products,
  receivedPaymentAllocations,
  salesInvoiceLines,
  salesInvoices,
  stockMovements,
  taxonomyItems,
  treasuryAccounts,
  vendorBillLines,
  vendorBills,
  vendors,
  fiscalPeriods,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { getSubledgerReconciliation } from "./accounting-reports.service.ts";
import {
  DEFAULT_COA,
  ensureAccountingDefaults,
  getAccountingSetupHealth,
  getGlAccountMap,
  postJournalEntry,
} from "./gl.service.ts";
import { actorCompanyId, applyBranchStockMovement, type RequestActor } from "./stock-locks.ts";

const VALID_ACCOUNT_TYPES = new Set<AccountTypeShared>([
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

const VALID_NORMAL_BALANCES = new Set<NormalBalanceShared>(["debit", "credit"]);
const VALID_ITEM_TYPES = new Set(["stock", "non_stock", "service", "manufactured"]);
const VALID_ETA_CODE_TYPES = new Set(["EGS", "GS1"]);
const VALID_DEP_METHODS = new Set(["straight_line", "declining_balance"]);

function defaultNormalBalance(accountType: AccountTypeShared): NormalBalanceShared {
  return accountType === "asset" || accountType === "expense" ? "debit" : "credit";
}

function safeParseCsv(rawCsv: string, label: string) {
  try {
    return parseCsvText(rawCsv, { maxBytes: CSV_MAX_BYTES, maxRows: CSV_MAX_ROWS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : `Invalid ${label} CSV`;
    if (msg.startsWith("CSV_FILE_TOO_LARGE")) {
      throw new AppError(400, msg, "CSV_FILE_TOO_LARGE");
    }
    if (msg.startsWith("CSV_ROW_LIMIT_EXCEEDED")) {
      throw new AppError(400, msg, "CSV_ROW_LIMIT_EXCEEDED");
    }
    throw new AppError(400, msg, "CSV_PARSE_ERROR");
  }
}

async function getCompanyBaseCurrency(db: DbOrTx, companyId: string): Promise<string> {
  const [comp] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return (comp?.baseCurrency || "EGP").toUpperCase();
}

async function loadOpeningGuardState(db: DbOrTx, companyId: string) {
  const [activeOpeningJe] = await db
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.sourceType, "opening_balance"),
        eq(journalEntries.status, "posted"),
        isNull(journalEntries.reversedEntryId)
      )
    )
    .limit(1);

  const [nonOpeningJe] = await db
    .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber, sourceType: journalEntries.sourceType })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.status, "posted"),
        notInArray(journalEntries.sourceType, ["opening_balance", "opening_balance_reversal"])
      )
    )
    .limit(1);

  return {
    activeOpeningJe: activeOpeningJe ?? null,
    hasNonOpeningJournals: Boolean(nonOpeningJe),
    firstNonOpeningJe: nonOpeningJe ?? null,
  };
}

export async function getOpeningCutoverStatus(
  db: AppDatabase,
  actor: RequestActor
): Promise<OpeningCutoverStatusDto> {
  const companyId = actorCompanyId(actor);
  const [guard, arCount, apCount, faCount, trCount, stockCount] = await Promise.all([
    loadOpeningGuardState(db, companyId),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(salesInvoices)
      .where(and(eq(salesInvoices.companyId, companyId), eq(salesInvoices.source, "opening_balance"))),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(vendorBills)
      .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.source, "opening_balance"))),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.companyId, companyId), eq(fixedAssets.source, "opening_balance"))),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.companyId, companyId), eq(treasuryAccounts.source, "opening_balance"))),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.movementType, "opening_balance"),
          eq(stockMovements.referenceType, "opening_balance")
        )
      ),
  ]);

  let blockedReason: string | null = null;
  if (guard.activeOpeningJe) {
    blockedReason = `Opening balances were already posted (${guard.activeOpeningJe.entryNumber}). Reverse the existing opening import first if you need to reload.`;
  } else if (guard.hasNonOpeningJournals) {
    blockedReason = `Non-opening journal entries already exist (e.g. ${guard.firstNonOpeningJe?.entryNumber}). Opening cutover import is only allowed before live operational postings.`;
  }

  return {
    hasOpeningJournal: Boolean(guard.activeOpeningJe),
    openingJournalEntryId: guard.activeOpeningJe?.id ?? null,
    openingJournalEntryNumber: guard.activeOpeningJe?.entryNumber ?? null,
    cutoverDate: guard.activeOpeningJe ? guard.activeOpeningJe.entryDate.toISOString().slice(0, 10) : null,
    hasNonOpeningJournals: guard.hasNonOpeningJournals,
    canImportOpening: !guard.activeOpeningJe && !guard.hasNonOpeningJournals,
    canReverseOpening: Boolean(guard.activeOpeningJe) && !guard.hasNonOpeningJournals,
    blockedReason,
    counts: {
      openingArInvoices: arCount[0]?.cnt ?? 0,
      openingApBills: apCount[0]?.cnt ?? 0,
      openingFixedAssets: faCount[0]?.cnt ?? 0,
      openingTreasuryAccounts: trCount[0]?.cnt ?? 0,
      openingStockMovements: stockCount[0]?.cnt ?? 0,
    },
  };
}

/**
 * Projects AccountingSetupHealthDto in memory for a Chart of Accounts CSV dry-run
 * so the admin sees exact mapping health / collisions BEFORE committing.
 */
function projectSetupHealth(
  existingCoa: Array<{
    id: string;
    code: string;
    name: string;
    accountType: AccountTypeShared;
    isActive: boolean;
  }>,
  existingMappings: Array<{ mappingKey: string; accountId: string }>,
  incomingRows: Array<{
    code: string;
    name: string;
    accountType: AccountTypeShared;
    isActive: boolean;
  }>
): AccountingSetupHealthDto {
  const coaByCode = new Map(existingCoa.map((a) => [a.code, { ...a }]));
  const coaById = new Map(existingCoa.map((a) => [a.id, { ...a }]));

  for (const row of incomingRows) {
    const existing = coaByCode.get(row.code);
    if (existing) {
      const updated = { ...existing, name: row.name, isActive: row.isActive };
      coaByCode.set(row.code, updated);
      coaById.set(existing.id, updated);
    } else {
      const syntheticId = `pending:${row.code}`;
      const created = {
        id: syntheticId,
        code: row.code,
        name: row.name,
        accountType: row.accountType,
        isActive: row.isActive,
      };
      coaByCode.set(row.code, created);
      coaById.set(syntheticId, created);
    }
  }

  const mappingByKey = new Map(existingMappings.map((m) => [m.mappingKey, m.accountId]));
  const requiredDefs = DEFAULT_COA.filter(
    (d): d is (typeof DEFAULT_COA)[number] & { mappingKey: GlMappingKey } => Boolean(d.mappingKey)
  );

  // Simulate safe auto-binding (only if code AND accountType match)
  for (const def of requiredDefs) {
    if (mappingByKey.has(def.mappingKey)) continue;
    const candidate = coaByCode.get(def.code);
    if (candidate && candidate.accountType === def.accountType) {
      mappingByKey.set(def.mappingKey, candidate.id);
    }
  }

  const issues: AccountingMappingIssueDto[] = [];
  for (const def of requiredDefs) {
    const boundAccountId = mappingByKey.get(def.mappingKey) ?? null;
    const boundAcct = boundAccountId ? (coaById.get(boundAccountId) ?? null) : null;
    const collidingAcct = coaByCode.get(def.code) ?? null;

    if (!boundAcct) {
      const hasTypeCollision = Boolean(collidingAcct && collidingAcct.accountType !== def.accountType);
      issues.push({
        mappingKey: def.mappingKey,
        expectedCode: def.code,
        expectedName: def.name,
        expectedAccountType: def.accountType,
        status: "missing",
        boundAccountId: null,
        boundAccountCode: null,
        boundAccountName: null,
        boundAccountType: null,
        collidingAccountCode: hasTypeCollision ? collidingAcct!.code : null,
        collidingAccountName: hasTypeCollision ? collidingAcct!.name : null,
        collidingAccountType: hasTypeCollision ? collidingAcct!.accountType : null,
        instructions: hasTypeCollision
          ? `Account code '${def.code}' is used by '${collidingAcct!.name}' (type '${collidingAcct!.accountType}'), so '${def.mappingKey}' (requires '${def.accountType}') will not be auto-bound. Remap '${def.mappingKey}' in Setup Health.`
          : `GL mapping '${def.mappingKey}' is missing. Add an active '${def.accountType}' account and bind via Setup Health.`,
      });
      continue;
    }

    if (boundAcct.accountType !== def.accountType) {
      issues.push({
        mappingKey: def.mappingKey,
        expectedCode: def.code,
        expectedName: def.name,
        expectedAccountType: def.accountType,
        status: "type_mismatch",
        boundAccountId: boundAcct.id,
        boundAccountCode: boundAcct.code,
        boundAccountName: boundAcct.name,
        boundAccountType: boundAcct.accountType,
        collidingAccountCode: collidingAcct?.code ?? null,
        collidingAccountName: collidingAcct?.name ?? null,
        collidingAccountType: collidingAcct?.accountType ?? null,
        instructions: `GL mapping '${def.mappingKey}' points to '${boundAcct.code} ${boundAcct.name}' (${boundAcct.accountType}) instead of '${def.accountType}'.`,
      });
      continue;
    }

    if (!boundAcct.isActive) {
      issues.push({
        mappingKey: def.mappingKey,
        expectedCode: def.code,
        expectedName: def.name,
        expectedAccountType: def.accountType,
        status: "inactive",
        boundAccountId: boundAcct.id,
        boundAccountCode: boundAcct.code,
        boundAccountName: boundAcct.name,
        boundAccountType: boundAcct.accountType,
        collidingAccountCode: null,
        collidingAccountName: null,
        collidingAccountType: null,
        instructions: `GL mapping '${def.mappingKey}' points to inactive account '${boundAcct.code} ${boundAcct.name}'.`,
      });
    }
  }

  return {
    healthy: issues.length === 0,
    totalMappings: requiredDefs.length,
    validMappings: requiredDefs.length - issues.length,
    issues,
  };
}

export async function importStandardDataset(
  db: AppDatabase,
  actor: RequestActor,
  kind: StandardImportKind,
  input: z.infer<typeof csvImportRequestSchema>,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  const companyId = actorCompanyId(actor);
  const dryRun = input.dryRun ?? true;
  const parsed = safeParseCsv(input.csv, kind);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return {
      kind,
      dryRun,
      valid: false,
      totalRows: 0,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      errors: [{ row: 1, column: "csv", message: "CSV contains no data rows" }],
      warnings: [],
      preview: [],
    };
  }

  switch (kind) {
    case "chart_of_accounts":
      return importChartOfAccounts(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "customers":
      return importCustomers(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "vendors":
      return importVendors(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "products":
      return importProducts(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "opening_stock":
      return importOpeningStock(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "opening_fixed_assets":
      return importOpeningFixedAssets(db, actor, companyId, parsed.rows, dryRun, ipAddress);
    case "opening_treasury":
      return importOpeningTreasury(db, actor, companyId, parsed.rows, dryRun, ipAddress);
  }
}

async function importChartOfAccounts(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  await ensureAccountingDefaults(db, companyId);
  const [existingCoa, existingMappings] = await Promise.all([
    db.select().from(chartOfAccounts).where(eq(chartOfAccounts.companyId, companyId)),
    db.select().from(glAccountMappings).where(eq(glAccountMappings.companyId, companyId)),
  ]);

  const existingByCode = new Map(existingCoa.map((a) => [a.code, a]));
  const reservedByCode = new Map(
    DEFAULT_COA.filter((d) => Boolean(d.mappingKey)).map((d) => [d.code, d])
  );

  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];
  const seenCodes = new Set<string>();

  interface ValidCoaRow {
    rowNumber: number;
    code: string;
    name: string;
    accountType: AccountTypeShared;
    normalBalance: NormalBalanceShared;
    description: string;
    isActive: boolean;
    exists: boolean;
  }
  const validRows: ValidCoaRow[] = [];

  for (const r of rows) {
    const code = normalizeArabicDigits(r.values.code || r.values.account_code || "").trim();
    const name = (r.values.name || r.values.account_name || "").trim();
    const rawType = (r.values.account_type || r.values.type || "").trim().toLowerCase();
    const rawNormal = (r.values.normal_balance || "").trim().toLowerCase();
    const description = (r.values.description || "").trim();
    const parsedActive = parseLocalizedBoolean(r.values.is_active, true);

    let rowHasError = false;
    if (!code) {
      errors.push({ row: r.rowNumber, column: "code", message: "Account code is required" });
      rowHasError = true;
    } else if (seenCodes.has(code)) {
      errors.push({ row: r.rowNumber, column: "code", message: `Duplicate account code '${code}' in CSV`, value: code });
      rowHasError = true;
    } else {
      seenCodes.add(code);
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Account name is required" });
      rowHasError = true;
    }

    if (!VALID_ACCOUNT_TYPES.has(rawType as AccountTypeShared)) {
      errors.push({
        row: r.rowNumber,
        column: "account_type",
        message: "account_type must be one of: asset, liability, equity, revenue, expense",
        value: rawType,
      });
      rowHasError = true;
    }

    const accountType = rawType as AccountTypeShared;
    let normalBalance = VALID_ACCOUNT_TYPES.has(accountType)
      ? defaultNormalBalance(accountType)
      : ("debit" as NormalBalanceShared);
    if (rawNormal) {
      if (!VALID_NORMAL_BALANCES.has(rawNormal as NormalBalanceShared)) {
        errors.push({
          row: r.rowNumber,
          column: "normal_balance",
          message: "normal_balance must be 'debit' or 'credit'",
          value: rawNormal,
        });
        rowHasError = true;
      } else {
        normalBalance = rawNormal as NormalBalanceShared;
      }
    }

    if (parsedActive === null) {
      errors.push({
        row: r.rowNumber,
        column: "is_active",
        message: "is_active must be true/false (or 1/0, yes/no)",
        value: r.values.is_active,
      });
      rowHasError = true;
    }

    const existing = code ? existingByCode.get(code) : undefined;
    if (existing && VALID_ACCOUNT_TYPES.has(accountType) && existing.accountType !== accountType) {
      errors.push({
        row: r.rowNumber,
        column: "account_type",
        message: `Account '${code}' already exists with type '${existing.accountType}' and cannot be reclassified to '${accountType}' via CSV import`,
        value: accountType,
      });
      rowHasError = true;
    }

    // Mapping guard check against system control account codes
    const reserved = code ? reservedByCode.get(code) : undefined;
    if (!rowHasError && reserved && reserved.accountType !== accountType) {
      warnings.push({
        row: r.rowNumber,
        column: "account_type",
        message: `Code '${code}' is reserved for default mapping '${reserved.mappingKey}' (expects '${reserved.accountType}'), but CSV defines '${accountType}'. It will NOT be silently auto-bound; check Setup Health and remap '${reserved.mappingKey}' to a valid '${reserved.accountType}' account.`,
        value: `${code}:${accountType}`,
      });
    }

    if (!rowHasError) {
      validRows.push({
        rowNumber: r.rowNumber,
        code,
        name,
        accountType,
        normalBalance,
        description,
        isActive: parsedActive ?? true,
        exists: Boolean(existing),
      });
      preview.push({
        row: r.rowNumber,
        action: existing ? "update" : "create",
        summary: `${code} — ${name} (${accountType}/${normalBalance})`,
      });
    }
  }

  const createdCount = validRows.filter((v) => !v.exists).length;
  const updatedCount = validRows.filter((v) => v.exists).length;

  const projectedHealth = projectSetupHealth(
    existingCoa.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType as AccountTypeShared,
      isActive: a.isActive,
    })),
    existingMappings,
    validRows
  );

  if (dryRun || errors.length > 0) {
    return {
      kind: "chart_of_accounts",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
      setupHealth: projectedHealth,
    };
  }

  await db.transaction(async (tx) => {
    for (const v of validRows) {
      const existing = existingByCode.get(v.code);
      if (existing) {
        await tx
          .update(chartOfAccounts)
          .set({
            name: v.name,
            description: v.description || existing.description,
            isActive: v.isActive,
          })
          .where(eq(chartOfAccounts.id, existing.id));
      } else {
        await tx.insert(chartOfAccounts).values({
          companyId,
          code: v.code,
          name: v.name,
          accountType: v.accountType,
          normalBalance: v.normalBalance,
          description: v.description,
          isSystem: false,
          isActive: v.isActive,
        });
      }
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.chart_of_accounts",
      entityType: "accounting",
      entityId: companyId,
      entityLabel: `COA CSV Import (${createdCount} created, ${updatedCount} updated)`,
      details: { totalRows: rows.length, createdCount, updatedCount, warningsCount: warnings.length },
      ipAddress,
    });
  });

  const liveHealth = await getAccountingSetupHealth(db, actor);

  return {
    kind: "chart_of_accounts",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount,
    updatedCount,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
    setupHealth: liveHealth,
  };
}

async function importCustomers(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  const [baseCurrency, existing] = await Promise.all([
    getCompanyBaseCurrency(db, companyId),
    db.select().from(customers).where(eq(customers.companyId, companyId)),
  ]);
  const existingByCode = new Map(existing.map((c) => [c.code.toLowerCase(), c]));
  const seenCodes = new Set<string>();
  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  interface ValidCustomerRow {
    rowNumber: number;
    code: string;
    name: string;
    etaReceiverType: "B" | "P" | "F";
    taxNumber: string;
    email: string;
    phone: string;
    company: string;
    billingAddress: string;
    shippingAddress: string;
    currency: string;
    paymentTermsDays: number;
    creditLimit: number | null;
    notes: string;
    exists: boolean;
  }
  const validRows: ValidCustomerRow[] = [];

  for (const r of rows) {
    const code = normalizeArabicDigits(r.values.code || r.values.customer_code || "").trim();
    const name = (r.values.name || r.values.display_name || "").trim();
    const rawRecType = (r.values.eta_receiver_type || r.values.receiver_type || "B").trim().toUpperCase();
    const rawTax = r.values.tax_number || r.values.tax_registration_number || r.values.national_id || "";
    const email = (r.values.email || "").trim();
    const phone = normalizeArabicDigits(r.values.phone || "").trim();
    const companyName = (r.values.company || r.values.company_name || "").trim();
    const billingAddress = (r.values.billing_address || r.values.address || "").trim();
    const shippingAddress = (r.values.shipping_address || billingAddress).trim();
    const currency = (r.values.currency || baseCurrency).trim().toUpperCase();
    const rawTerms = r.values.payment_terms_days;
    const rawCreditLimit = r.values.credit_limit;
    const notes = (r.values.notes || "").trim();

    let rowHasError = false;
    if (!code) {
      errors.push({ row: r.rowNumber, column: "code", message: "Customer code is required for deterministic cutover matching" });
      rowHasError = true;
    } else if (seenCodes.has(code.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "code", message: `Duplicate customer code '${code}' in CSV`, value: code });
      rowHasError = true;
    } else {
      seenCodes.add(code.toLowerCase());
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Customer name is required" });
      rowHasError = true;
    }

    if (!["B", "P", "F"].includes(rawRecType)) {
      errors.push({
        row: r.rowNumber,
        column: "eta_receiver_type",
        message: "eta_receiver_type must be 'B' (Business), 'P' (Person), or 'F' (Foreigner)",
        value: rawRecType,
      });
      rowHasError = true;
    }

    const etaReceiverType = (["B", "P", "F"].includes(rawRecType) ? rawRecType : "B") as "B" | "P" | "F";
    const taxCheck = validateEtaTaxId(etaReceiverType, rawTax);
    if (!taxCheck.ok) {
      errors.push({
        row: r.rowNumber,
        column: "tax_number",
        message: taxCheck.message,
        value: rawTax,
      });
      rowHasError = true;
    }

    let paymentTermsDays = 30;
    if (rawTerms && rawTerms.trim() !== "") {
      const parsedTerms = parseLocalizedNumber(rawTerms);
      if (parsedTerms === null || parsedTerms < 0 || !Number.isInteger(parsedTerms)) {
        errors.push({
          row: r.rowNumber,
          column: "payment_terms_days",
          message: "payment_terms_days must be a non-negative integer",
          value: rawTerms,
        });
        rowHasError = true;
      } else {
        paymentTermsDays = parsedTerms;
      }
    }

    let creditLimit: number | null = null;
    if (rawCreditLimit && rawCreditLimit.trim() !== "") {
      const parsedLimit = parseLocalizedNumber(rawCreditLimit);
      if (parsedLimit === null || parsedLimit < 0) {
        errors.push({
          row: r.rowNumber,
          column: "credit_limit",
          message: "credit_limit must be a non-negative number",
          value: rawCreditLimit,
        });
        rowHasError = true;
      } else {
        creditLimit = roundCurrency(parsedLimit, 4);
      }
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push({ row: r.rowNumber, column: "currency", message: "currency must be a 3-letter ISO code (e.g. EGP, USD)", value: currency });
      rowHasError = true;
    }

    if (!rowHasError) {
      const existingRow = existingByCode.get(code.toLowerCase());
      validRows.push({
        rowNumber: r.rowNumber,
        code,
        name,
        etaReceiverType,
        taxNumber: taxCheck.ok ? taxCheck.normalized : "",
        email,
        phone,
        company: companyName,
        billingAddress,
        shippingAddress,
        currency,
        paymentTermsDays,
        creditLimit,
        notes,
        exists: Boolean(existingRow),
      });
      preview.push({
        row: r.rowNumber,
        action: existingRow ? "update" : "create",
        summary: `${code} — ${name} (ETA: ${etaReceiverType}${taxCheck.ok && taxCheck.normalized ? ` / ${taxCheck.normalized}` : ""})`,
      });
    }
  }

  const createdCount = validRows.filter((v) => !v.exists).length;
  const updatedCount = validRows.filter((v) => v.exists).length;

  if (dryRun || errors.length > 0) {
    return {
      kind: "customers",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    for (const v of validRows) {
      const existingRow = existingByCode.get(v.code.toLowerCase());
      if (existingRow) {
        await tx
          .update(customers)
          .set({
            name: v.name,
            etaReceiverType: v.etaReceiverType,
            taxNumber: v.taxNumber,
            email: v.email,
            phone: v.phone,
            company: v.company,
            billingAddress: v.billingAddress,
            shippingAddress: v.shippingAddress,
            currency: v.currency,
            paymentTermsDays: v.paymentTermsDays,
            creditLimit: v.creditLimit !== null ? toNumeric(v.creditLimit) : null,
            notes: v.notes,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, existingRow.id));
      } else {
        await tx.insert(customers).values({
          companyId,
          code: v.code,
          name: v.name,
          etaReceiverType: v.etaReceiverType,
          taxNumber: v.taxNumber,
          email: v.email,
          phone: v.phone,
          company: v.company,
          billingAddress: v.billingAddress,
          shippingAddress: v.shippingAddress,
          currency: v.currency,
          paymentTermsDays: v.paymentTermsDays,
          creditLimit: v.creditLimit !== null ? toNumeric(v.creditLimit) : null,
          notes: v.notes,
        });
      }
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.customers",
      entityType: "sales",
      entityId: companyId,
      entityLabel: `Customers CSV Import (${createdCount} created, ${updatedCount} updated)`,
      details: { totalRows: rows.length, createdCount, updatedCount },
      ipAddress,
    });
  });

  return {
    kind: "customers",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount,
    updatedCount,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

async function importVendors(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  const [baseCurrency, existing] = await Promise.all([
    getCompanyBaseCurrency(db, companyId),
    db.select().from(vendors).where(eq(vendors.companyId, companyId)),
  ]);
  const existingByCode = new Map(existing.map((v) => [v.code.toLowerCase(), v]));
  const seenCodes = new Set<string>();
  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  interface ValidVendorRow {
    rowNumber: number;
    code: string;
    name: string;
    taxNumber: string;
    email: string;
    phone: string;
    company: string;
    address: string;
    currency: string;
    paymentTermsDays: number;
    notes: string;
    exists: boolean;
  }
  const validRows: ValidVendorRow[] = [];

  for (const r of rows) {
    const code = normalizeArabicDigits(r.values.code || r.values.vendor_code || "").trim();
    const name = (r.values.name || r.values.display_name || "").trim();
    const rawTax = r.values.tax_number || r.values.tax_registration_number || r.values.national_id || "";
    const email = (r.values.email || "").trim();
    const phone = normalizeArabicDigits(r.values.phone || "").trim();
    const companyName = (r.values.company || r.values.company_name || "").trim();
    const address = (r.values.address || "").trim();
    const currency = (r.values.currency || baseCurrency).trim().toUpperCase();
    const rawTerms = r.values.payment_terms_days;
    const notes = (r.values.notes || "").trim();

    let rowHasError = false;
    if (!code) {
      errors.push({ row: r.rowNumber, column: "code", message: "Vendor code is required for deterministic cutover matching" });
      rowHasError = true;
    } else if (seenCodes.has(code.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "code", message: `Duplicate vendor code '${code}' in CSV`, value: code });
      rowHasError = true;
    } else {
      seenCodes.add(code.toLowerCase());
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Vendor name is required" });
      rowHasError = true;
    }

    const taxCheck = validateVendorTaxId(rawTax);
    if (!taxCheck.ok) {
      errors.push({ row: r.rowNumber, column: "tax_number", message: taxCheck.message, value: rawTax });
      rowHasError = true;
    }

    let paymentTermsDays = 30;
    if (rawTerms && rawTerms.trim() !== "") {
      const parsedTerms = parseLocalizedNumber(rawTerms);
      if (parsedTerms === null || parsedTerms < 0 || !Number.isInteger(parsedTerms)) {
        errors.push({
          row: r.rowNumber,
          column: "payment_terms_days",
          message: "payment_terms_days must be a non-negative integer",
          value: rawTerms,
        });
        rowHasError = true;
      } else {
        paymentTermsDays = parsedTerms;
      }
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push({ row: r.rowNumber, column: "currency", message: "currency must be a 3-letter ISO code", value: currency });
      rowHasError = true;
    }

    if (!rowHasError) {
      const existingRow = existingByCode.get(code.toLowerCase());
      validRows.push({
        rowNumber: r.rowNumber,
        code,
        name,
        taxNumber: taxCheck.ok ? taxCheck.normalized : "",
        email,
        phone,
        company: companyName,
        address,
        currency,
        paymentTermsDays,
        notes,
        exists: Boolean(existingRow),
      });
      preview.push({
        row: r.rowNumber,
        action: existingRow ? "update" : "create",
        summary: `${code} — ${name}${taxCheck.ok && taxCheck.normalized ? ` (${taxCheck.normalized})` : ""}`,
      });
    }
  }

  const createdCount = validRows.filter((v) => !v.exists).length;
  const updatedCount = validRows.filter((v) => v.exists).length;

  if (dryRun || errors.length > 0) {
    return {
      kind: "vendors",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    for (const v of validRows) {
      const existingRow = existingByCode.get(v.code.toLowerCase());
      if (existingRow) {
        await tx
          .update(vendors)
          .set({
            name: v.name,
            taxNumber: v.taxNumber,
            email: v.email,
            phone: v.phone,
            company: v.company,
            address: v.address,
            currency: v.currency,
            paymentTermsDays: v.paymentTermsDays,
            notes: v.notes,
            updatedAt: new Date(),
          })
          .where(eq(vendors.id, existingRow.id));
      } else {
        await tx.insert(vendors).values({
          companyId,
          code: v.code,
          name: v.name,
          taxNumber: v.taxNumber,
          email: v.email,
          phone: v.phone,
          company: v.company,
          address: v.address,
          currency: v.currency,
          paymentTermsDays: v.paymentTermsDays,
          notes: v.notes,
        });
      }
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.vendors",
      entityType: "purchases",
      entityId: companyId,
      entityLabel: `Vendors CSV Import (${createdCount} created, ${updatedCount} updated)`,
      details: { totalRows: rows.length, createdCount, updatedCount },
      ipAddress,
    });
  });

  return {
    kind: "vendors",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount,
    updatedCount,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

async function importProducts(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  const existing = await db.select().from(products).where(eq(products.companyId, companyId));
  const existingBySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p]));
  const seenSkus = new Set<string>();
  const seenBarcodes = new Set<string>();
  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  interface ValidProductRow {
    rowNumber: number;
    sku: string;
    name: string;
    nameAr: string;
    barcode: string | null;
    category: string;
    brand: string;
    unit: string;
    costPrice: number;
    sellingPrice: number;
    minStockLevel: number;
    itemType: "stock" | "non_stock" | "service" | "manufactured";
    etaCodeType: "EGS" | "GS1";
    etaItemCode: string;
    etaUnitType: string;
    exists: boolean;
  }
  const validRows: ValidProductRow[] = [];

  for (const r of rows) {
    const sku = normalizeArabicDigits(r.values.sku || r.values.product_sku || "").trim();
    const name = (r.values.name || r.values.product_name || "").trim();
    const nameAr = (r.values.name_ar || "").trim();
    const barcode = normalizeArabicDigits(r.values.barcode || "").trim() || null;
    const category = (r.values.category || "").trim();
    const brand = (r.values.brand || "").trim();
    const unit = (r.values.unit || r.values.uom || "pcs").trim();
    const rawCost = r.values.cost_price ?? r.values.cost;
    const rawSelling = r.values.selling_price ?? r.values.price;
    const rawMinStock = r.values.min_stock_level ?? "0";
    const itemType = (r.values.item_type || "stock").trim().toLowerCase();
    const etaCodeType = (r.values.eta_code_type || "EGS").trim().toUpperCase();
    const etaItemCode = normalizeArabicDigits(r.values.eta_item_code || "").trim();
    const etaUnitType = (r.values.eta_unit_type || "EA").trim().toUpperCase();

    let rowHasError = false;
    if (!sku) {
      errors.push({ row: r.rowNumber, column: "sku", message: "Product SKU is required" });
      rowHasError = true;
    } else if (seenSkus.has(sku.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "sku", message: `Duplicate SKU '${sku}' in CSV`, value: sku });
      rowHasError = true;
    } else {
      seenSkus.add(sku.toLowerCase());
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Product name is required" });
      rowHasError = true;
    }

    if (barcode) {
      if (seenBarcodes.has(barcode)) {
        errors.push({ row: r.rowNumber, column: "barcode", message: `Duplicate barcode '${barcode}' in CSV`, value: barcode });
        rowHasError = true;
      } else {
        seenBarcodes.add(barcode);
      }
    }

    const costPrice = parseLocalizedNumber(rawCost ?? "0");
    if (costPrice === null || costPrice < 0) {
      errors.push({ row: r.rowNumber, column: "cost_price", message: "cost_price must be a non-negative number", value: rawCost });
      rowHasError = true;
    }

    const sellingPrice = parseLocalizedNumber(rawSelling ?? "0");
    if (sellingPrice === null || sellingPrice < 0) {
      errors.push({ row: r.rowNumber, column: "selling_price", message: "selling_price must be a non-negative number", value: rawSelling });
      rowHasError = true;
    }

    const minStockLevel = parseLocalizedNumber(rawMinStock || "0");
    if (minStockLevel === null || minStockLevel < 0) {
      errors.push({ row: r.rowNumber, column: "min_stock_level", message: "min_stock_level must be a non-negative number", value: rawMinStock });
      rowHasError = true;
    }

    if (!VALID_ITEM_TYPES.has(itemType)) {
      errors.push({ row: r.rowNumber, column: "item_type", message: "item_type must be stock, non_stock, service, or manufactured", value: itemType });
      rowHasError = true;
    }

    if (!VALID_ETA_CODE_TYPES.has(etaCodeType)) {
      errors.push({ row: r.rowNumber, column: "eta_code_type", message: "eta_code_type must be 'EGS' or 'GS1'", value: etaCodeType });
      rowHasError = true;
    }

    if (!rowHasError) {
      const existingRow = existingBySku.get(sku.toLowerCase());
      validRows.push({
        rowNumber: r.rowNumber,
        sku,
        name,
        nameAr,
        barcode,
        category,
        brand,
        unit,
        costPrice: roundCurrency(costPrice!, 4),
        sellingPrice: roundCurrency(sellingPrice!, 4),
        minStockLevel: roundCurrency(minStockLevel!, 4),
        itemType: itemType as ValidProductRow["itemType"],
        etaCodeType: etaCodeType as "EGS" | "GS1",
        etaItemCode,
        etaUnitType,
        exists: Boolean(existingRow),
      });
      preview.push({
        row: r.rowNumber,
        action: existingRow ? "update" : "create",
        summary: `${sku} — ${name}${barcode ? ` [Barcode: ${barcode}]` : ""} (${unit})`,
      });
    }
  }

  const createdCount = validRows.filter((v) => !v.exists).length;
  const updatedCount = validRows.filter((v) => v.exists).length;

  if (dryRun || errors.length > 0) {
    return {
      kind: "products",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount,
      updatedCount,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    // Auto-seed referenced brands, categories, and units in taxonomy_items idempotently
    const brandsToEnsure = new Set(validRows.map((v) => v.brand).filter(Boolean));
    const catsToEnsure = new Set(validRows.map((v) => v.category).filter(Boolean));
    const unitsToEnsure = new Set(validRows.map((v) => v.unit).filter(Boolean));

    for (const b of brandsToEnsure) {
      await tx.insert(taxonomyItems).values({ companyId, kind: "brand", name: b }).onConflictDoNothing();
    }
    for (const c of catsToEnsure) {
      await tx.insert(taxonomyItems).values({ companyId, kind: "category", name: c }).onConflictDoNothing();
    }
    for (const u of unitsToEnsure) {
      await tx.insert(taxonomyItems).values({ companyId, kind: "unit", name: u }).onConflictDoNothing();
    }

    for (const v of validRows) {
      const existingRow = existingBySku.get(v.sku.toLowerCase());
      if (existingRow) {
        await tx
          .update(products)
          .set({
            name: v.name,
            nameAr: v.nameAr || existingRow.nameAr,
            barcode: v.barcode ?? existingRow.barcode,
            category: v.category,
            brand: v.brand,
            unit: v.unit,
            costPrice: toNumeric(v.costPrice),
            sellingPrice: toNumeric(v.sellingPrice),
            minStockLevel: toNumeric(v.minStockLevel),
            itemType: v.itemType,
            etaCodeType: v.etaCodeType,
            etaItemCode: v.etaItemCode,
            etaUnitType: v.etaUnitType,
            updatedAt: new Date(),
          })
          .where(eq(products.id, existingRow.id));
      } else {
        await tx.insert(products).values({
          companyId,
          sku: v.sku,
          name: v.name,
          nameAr: v.nameAr,
          barcode: v.barcode,
          category: v.category,
          brand: v.brand,
          unit: v.unit,
          costPrice: toNumeric(v.costPrice),
          sellingPrice: toNumeric(v.sellingPrice),
          minStockLevel: toNumeric(v.minStockLevel),
          itemType: v.itemType,
          etaCodeType: v.etaCodeType,
          etaItemCode: v.etaItemCode,
          etaUnitType: v.etaUnitType,
        });
      }
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.products",
      entityType: "inventory",
      entityId: companyId,
      entityLabel: `Products CSV Import (${createdCount} created, ${updatedCount} updated)`,
      details: { totalRows: rows.length, createdCount, updatedCount },
      ipAddress,
    });
  });

  return {
    kind: "products",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount,
    updatedCount,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

async function importOpeningStock(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  const [guard, prodRows, branchRows, existingOpeningMoves] = await Promise.all([
    loadOpeningGuardState(db, companyId),
    db.select().from(products).where(eq(products.companyId, companyId)),
    db.select().from(branches).where(eq(branches.companyId, companyId)),
    db
      .select({ branchId: stockMovements.branchId, productId: stockMovements.productId })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.movementType, "opening_balance"),
          eq(stockMovements.referenceType, "opening_balance")
        )
      ),
  ]);

  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  if (guard.activeOpeningJe) {
    errors.push({
      row: 1,
      column: "opening_stock",
      message: `Opening balances (${guard.activeOpeningJe.entryNumber}) are already posted. Reverse the opening cutover before importing opening stock again.`,
    });
  } else if (guard.hasNonOpeningJournals) {
    errors.push({
      row: 1,
      column: "opening_stock",
      message: "Non-opening journal entries already exist. Opening stock import is restricted to pre-go-live cutover.",
    });
  }

  const prodBySku = new Map(prodRows.map((p) => [p.sku.toLowerCase(), p]));
  const branchByCode = new Map(branchRows.map((b) => [b.code.toLowerCase(), b]));
  const branchByName = new Map(branchRows.map((b) => [b.name.toLowerCase(), b]));
  const existingKeys = new Set(existingOpeningMoves.map((m) => `${m.branchId}:${m.productId}`));
  const seenKeys = new Set<string>();

  interface ValidStockRow {
    rowNumber: number;
    productId: string;
    sku: string;
    branchId: string;
    branchCode: string;
    quantity: number;
    unitCost: number;
  }
  const validRows: ValidStockRow[] = [];

  for (const r of rows) {
    const sku = normalizeArabicDigits(r.values.sku || r.values.product_sku || "").trim();
    const branchKey = (r.values.branch_code || r.values.branch_name || r.values.branch || "").trim();
    const rawQty = r.values.quantity ?? r.values.qty;
    const rawCost = r.values.unit_cost ?? r.values.cost_price ?? r.values.avg_cost;

    let rowHasError = false;
    const prod = sku ? prodBySku.get(sku.toLowerCase()) : undefined;
    if (!sku) {
      errors.push({ row: r.rowNumber, column: "sku", message: "SKU is required" });
      rowHasError = true;
    } else if (!prod) {
      errors.push({ row: r.rowNumber, column: "sku", message: `Unknown product SKU '${sku}'. Import Products first.`, value: sku });
      rowHasError = true;
    }

    const branch = branchKey
      ? (branchByCode.get(branchKey.toLowerCase()) ?? branchByName.get(branchKey.toLowerCase()))
      : undefined;
    if (!branchKey) {
      errors.push({ row: r.rowNumber, column: "branch_code", message: "branch_code (or branch_name) is required" });
      rowHasError = true;
    } else if (!branch) {
      errors.push({ row: r.rowNumber, column: "branch_code", message: `Unknown branch '${branchKey}'`, value: branchKey });
      rowHasError = true;
    }

    const qty = parseLocalizedNumber(rawQty);
    if (qty === null || qty <= 0) {
      errors.push({ row: r.rowNumber, column: "quantity", message: "quantity must be a positive number", value: rawQty });
      rowHasError = true;
    }

    const unitCost =
      rawCost !== undefined && rawCost.trim() !== ""
        ? parseLocalizedNumber(rawCost)
        : prod
          ? num(prod.costPrice)
          : null;
    if (unitCost === null || unitCost < 0) {
      errors.push({ row: r.rowNumber, column: "unit_cost", message: "unit_cost must be a non-negative number", value: rawCost });
      rowHasError = true;
    }

    if (!rowHasError && prod && branch) {
      const pairKey = `${branch.id}:${prod.id}`;
      if (seenKeys.has(pairKey)) {
        errors.push({
          row: r.rowNumber,
          column: "sku",
          message: `Duplicate (sku='${sku}', branch='${branch.code}') row in CSV`,
          value: `${sku}@${branch.code}`,
        });
        rowHasError = true;
      } else if (existingKeys.has(pairKey)) {
        errors.push({
          row: r.rowNumber,
          column: "sku",
          message: `Opening stock was already imported for SKU '${sku}' in branch '${branch.code}'`,
          value: `${sku}@${branch.code}`,
        });
        rowHasError = true;
      } else {
        seenKeys.add(pairKey);
      }
    }

    if (!rowHasError && prod && branch && qty !== null && unitCost !== null) {
      validRows.push({
        rowNumber: r.rowNumber,
        productId: prod.id,
        sku: prod.sku,
        branchId: branch.id,
        branchCode: branch.code,
        quantity: roundCurrency(qty, 4),
        unitCost: roundCurrency(unitCost, 4),
      });
      preview.push({
        row: r.rowNumber,
        action: "create",
        summary: `${prod.sku} @ ${branch.code}: qty ${qty} × ${unitCost.toFixed(2)} = ${roundCurrency(qty * unitCost, 2).toFixed(2)}`,
      });
    }
  }

  if (dryRun || errors.length > 0) {
    return {
      kind: "opening_stock",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount: validRows.length,
      updatedCount: 0,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    let totalValuation = 0;
    for (const v of validRows) {
      await applyBranchStockMovement(tx, {
        companyId,
        branchId: v.branchId,
        productId: v.productId,
        movementType: "opening_balance",
        qtyDelta: v.quantity,
        unitCostForWmac: v.unitCost,
        fallbackCost: v.unitCost,
        recomputeAvgCost: true,
        movementUnitCost: v.unitCost,
        referenceType: "opening_balance",
        referenceId: companyId,
        referenceNumber: "OPENING-STOCK",
        notes: "Cutover opening stock import",
        actorId: actor.id,
      });
      totalValuation = roundCurrency(totalValuation + v.quantity * v.unitCost, 4);
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.opening_stock",
      entityType: "inventory",
      entityId: companyId,
      entityLabel: `Opening Stock CSV Import (${validRows.length} rows, valuation ${totalValuation.toFixed(2)})`,
      details: { totalRows: validRows.length, totalValuation },
      ipAddress,
    });
  });

  return {
    kind: "opening_stock",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount: validRows.length,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

async function importOpeningFixedAssets(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  await ensureAccountingDefaults(db, companyId);
  const [guard, glMap, coaRows, branchRows, existingAssets] = await Promise.all([
    loadOpeningGuardState(db, companyId),
    getGlAccountMap(db, companyId),
    db.select().from(chartOfAccounts).where(eq(chartOfAccounts.companyId, companyId)),
    db.select().from(branches).where(eq(branches.companyId, companyId)),
    db.select({ assetCode: fixedAssets.assetCode }).from(fixedAssets).where(eq(fixedAssets.companyId, companyId)),
  ]);

  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  if (guard.activeOpeningJe) {
    errors.push({
      row: 1,
      column: "opening_fixed_assets",
      message: `Opening balances (${guard.activeOpeningJe.entryNumber}) are already posted. Reverse the opening cutover before importing opening fixed assets.`,
    });
  } else if (guard.hasNonOpeningJournals) {
    errors.push({
      row: 1,
      column: "opening_fixed_assets",
      message: "Non-opening journal entries already exist. Opening fixed assets import is restricted to pre-go-live cutover.",
    });
  }

  const coaByCode = new Map(coaRows.map((a) => [a.code, a]));
  const branchByCode = new Map(branchRows.map((b) => [b.code.toLowerCase(), b]));
  const branchByName = new Map(branchRows.map((b) => [b.name.toLowerCase(), b]));
  const existingCodes = new Set(existingAssets.map((a) => a.assetCode.toLowerCase()));
  const seenCodes = new Set<string>();

  interface ValidAssetRow {
    rowNumber: number;
    assetCode: string;
    name: string;
    category: string;
    serialNumber: string;
    branchId: string | null;
    acquisitionDate: string;
    inServiceDate: string;
    acquisitionCost: number;
    accumulatedDepreciation: number;
    salvageValue: number;
    usefulLifeMonths: number;
    depreciationMethod: "straight_line" | "declining_balance";
    assetAccountId: string;
    accumDepAccountId: string;
    depExpenseAccountId: string;
    notes: string;
  }
  const validRows: ValidAssetRow[] = [];

  for (const r of rows) {
    const assetCode = normalizeArabicDigits(r.values.asset_code || r.values.code || "").trim();
    const name = (r.values.name || "").trim();
    const category = (r.values.category || "Equipment").trim();
    const serialNumber = (r.values.serial_number || "").trim();
    const branchKey = (r.values.branch_code || r.values.branch_name || "").trim();
    const acqDate = parseIsoDateString(r.values.acquisition_date || r.values.in_service_date);
    const inSvcDate = parseIsoDateString(r.values.in_service_date || r.values.acquisition_date);
    const acqCost = parseLocalizedNumber(r.values.acquisition_cost ?? r.values.cost);
    const accumDep = parseLocalizedNumber(r.values.accumulated_depreciation || "0");
    const salvage = parseLocalizedNumber(r.values.salvage_value || "0");
    const lifeMonths = parseLocalizedNumber(r.values.useful_life_months || "60");
    const depMethod = (r.values.depreciation_method || "straight_line").trim().toLowerCase();
    const assetAcctCode = normalizeArabicDigits(r.values.asset_account_code || "").trim();
    const accumAcctCode = normalizeArabicDigits(r.values.accum_dep_account_code || "").trim();
    const depExpAcctCode = normalizeArabicDigits(r.values.dep_expense_account_code || "").trim();
    const notes = (r.values.notes || "").trim();

    let rowHasError = false;
    if (!assetCode) {
      errors.push({ row: r.rowNumber, column: "asset_code", message: "asset_code is required" });
      rowHasError = true;
    } else if (seenCodes.has(assetCode.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "asset_code", message: `Duplicate asset_code '${assetCode}' in CSV`, value: assetCode });
      rowHasError = true;
    } else if (existingCodes.has(assetCode.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "asset_code", message: `Fixed asset '${assetCode}' already exists`, value: assetCode });
      rowHasError = true;
    } else {
      seenCodes.add(assetCode.toLowerCase());
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Asset name is required" });
      rowHasError = true;
    }

    if (!acqDate) {
      errors.push({ row: r.rowNumber, column: "acquisition_date", message: "Valid acquisition_date (YYYY-MM-DD) is required", value: r.values.acquisition_date });
      rowHasError = true;
    }
    if (!inSvcDate) {
      errors.push({ row: r.rowNumber, column: "in_service_date", message: "Valid in_service_date (YYYY-MM-DD) is required", value: r.values.in_service_date });
      rowHasError = true;
    }

    if (acqCost === null || acqCost <= 0) {
      errors.push({ row: r.rowNumber, column: "acquisition_cost", message: "acquisition_cost must be a positive number", value: r.values.acquisition_cost });
      rowHasError = true;
    }
    if (accumDep === null || accumDep < 0) {
      errors.push({ row: r.rowNumber, column: "accumulated_depreciation", message: "accumulated_depreciation must be >= 0", value: r.values.accumulated_depreciation });
      rowHasError = true;
    }
    if (salvage === null || salvage < 0) {
      errors.push({ row: r.rowNumber, column: "salvage_value", message: "salvage_value must be >= 0", value: r.values.salvage_value });
      rowHasError = true;
    }
    if (acqCost !== null && salvage !== null && salvage >= acqCost) {
      errors.push({ row: r.rowNumber, column: "salvage_value", message: "salvage_value must be strictly less than acquisition_cost" });
      rowHasError = true;
    }
    if (acqCost !== null && accumDep !== null && salvage !== null && accumDep > acqCost - salvage + 0.001) {
      errors.push({
        row: r.rowNumber,
        column: "accumulated_depreciation",
        message: "accumulated_depreciation cannot exceed depreciable base (acquisition_cost - salvage_value)",
      });
      rowHasError = true;
    }
    if (lifeMonths === null || lifeMonths < 1 || !Number.isInteger(lifeMonths)) {
      errors.push({ row: r.rowNumber, column: "useful_life_months", message: "useful_life_months must be a positive integer", value: r.values.useful_life_months });
      rowHasError = true;
    }
    if (!VALID_DEP_METHODS.has(depMethod)) {
      errors.push({ row: r.rowNumber, column: "depreciation_method", message: "depreciation_method must be 'straight_line' or 'declining_balance'", value: depMethod });
      rowHasError = true;
    }

    let branchId: string | null = null;
    if (branchKey) {
      const b = branchByCode.get(branchKey.toLowerCase()) ?? branchByName.get(branchKey.toLowerCase());
      if (!b) {
        errors.push({ row: r.rowNumber, column: "branch_code", message: `Unknown branch '${branchKey}'`, value: branchKey });
        rowHasError = true;
      } else {
        branchId = b.id;
      }
    }

    const assetAcctId = assetAcctCode ? coaByCode.get(assetAcctCode)?.id : glMap.fixed_assets_cost;
    const accumAcctId = accumAcctCode ? coaByCode.get(accumAcctCode)?.id : glMap.accumulated_depreciation;
    const depExpAcctId = depExpAcctCode ? coaByCode.get(depExpAcctCode)?.id : glMap.depreciation_expense;

    if (!assetAcctId) {
      errors.push({ row: r.rowNumber, column: "asset_account_code", message: `Fixed asset GL account '${assetAcctCode || "1500"}' not found` });
      rowHasError = true;
    }
    if (!accumAcctId) {
      errors.push({ row: r.rowNumber, column: "accum_dep_account_code", message: `Accumulated depreciation GL account '${accumAcctCode || "1510"}' not found` });
      rowHasError = true;
    }
    if (!depExpAcctId) {
      errors.push({ row: r.rowNumber, column: "dep_expense_account_code", message: `Depreciation expense GL account '${depExpAcctCode || "5700"}' not found` });
      rowHasError = true;
    }

    if (!rowHasError && acqDate && inSvcDate && acqCost !== null && accumDep !== null && salvage !== null && lifeMonths !== null) {
      validRows.push({
        rowNumber: r.rowNumber,
        assetCode,
        name,
        category,
        serialNumber,
        branchId,
        acquisitionDate: acqDate,
        inServiceDate: inSvcDate,
        acquisitionCost: roundCurrency(acqCost, 4),
        accumulatedDepreciation: roundCurrency(accumDep, 4),
        salvageValue: roundCurrency(salvage, 4),
        usefulLifeMonths: lifeMonths,
        depreciationMethod: depMethod as "straight_line" | "declining_balance",
        assetAccountId: assetAcctId!,
        accumDepAccountId: accumAcctId!,
        depExpenseAccountId: depExpAcctId!,
        notes,
      });
      const nbv = roundCurrency(acqCost - accumDep, 2);
      preview.push({
        row: r.rowNumber,
        action: "create",
        summary: `${assetCode} — ${name} (Cost ${acqCost.toFixed(2)}, Accum Dep ${accumDep.toFixed(2)}, NBV ${nbv.toFixed(2)})`,
      });
    }
  }

  if (dryRun || errors.length > 0) {
    return {
      kind: "opening_fixed_assets",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount: validRows.length,
      updatedCount: 0,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    for (const v of validRows) {
      const nbv = roundCurrency(v.acquisitionCost - v.accumulatedDepreciation, 4);
      const status = nbv <= v.salvageValue + 0.001 ? "fully_depreciated" : "active";
      await tx.insert(fixedAssets).values({
        companyId,
        assetCode: v.assetCode,
        name: v.name,
        category: v.category,
        serialNumber: v.serialNumber,
        branchId: v.branchId,
        acquisitionDate: new Date(`${v.acquisitionDate}T00:00:00.000Z`),
        inServiceDate: new Date(`${v.inServiceDate}T00:00:00.000Z`),
        acquisitionCost: toNumeric(v.acquisitionCost),
        salvageValue: toNumeric(v.salvageValue),
        usefulLifeMonths: v.usefulLifeMonths,
        depreciationMethod: v.depreciationMethod,
        accumulatedDepreciation: toNumeric(v.accumulatedDepreciation),
        netBookValue: toNumeric(nbv),
        status,
        assetAccountId: v.assetAccountId,
        accumDepAccountId: v.accumDepAccountId,
        depExpenseAccountId: v.depExpenseAccountId,
        acquisitionJournalEntryId: null,
        source: "opening_balance",
        notes: v.notes,
        createdBy: actor.id,
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.opening_fixed_assets",
      entityType: "accounting",
      entityId: companyId,
      entityLabel: `Opening Fixed Assets CSV Import (${validRows.length} assets)`,
      details: {
        count: validRows.length,
        totalCost: roundCurrency(validRows.reduce((s, r) => s + r.acquisitionCost, 0), 4),
        totalAccumDep: roundCurrency(validRows.reduce((s, r) => s + r.accumulatedDepreciation, 0), 4),
      },
      ipAddress,
    });
  });

  return {
    kind: "opening_fixed_assets",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount: validRows.length,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

async function importOpeningTreasury(
  db: AppDatabase,
  actor: RequestActor,
  companyId: string,
  rows: Array<{ rowNumber: number; values: Record<string, string> }>,
  dryRun: boolean,
  ipAddress?: string
): Promise<CsvImportResultDto> {
  await ensureAccountingDefaults(db, companyId);
  const [guard, baseCurrency, coaRows, branchRows, existingTreasury] = await Promise.all([
    loadOpeningGuardState(db, companyId),
    getCompanyBaseCurrency(db, companyId),
    db.select().from(chartOfAccounts).where(eq(chartOfAccounts.companyId, companyId)),
    db.select().from(branches).where(eq(branches.companyId, companyId)),
    db.select().from(treasuryAccounts).where(eq(treasuryAccounts.companyId, companyId)),
  ]);

  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];
  const preview: ImportRowPreviewDto[] = [];

  if (guard.activeOpeningJe) {
    errors.push({
      row: 1,
      column: "opening_treasury",
      message: `Opening balances (${guard.activeOpeningJe.entryNumber}) are already posted. Reverse the opening cutover before importing opening treasury accounts.`,
    });
  } else if (guard.hasNonOpeningJournals) {
    errors.push({
      row: 1,
      column: "opening_treasury",
      message: "Non-opening journal entries already exist. Opening treasury import is restricted to pre-go-live cutover.",
    });
  }

  const coaByCode = new Map(coaRows.map((a) => [a.code, a]));
  const branchByCode = new Map(branchRows.map((b) => [b.code.toLowerCase(), b]));
  const branchByName = new Map(branchRows.map((b) => [b.name.toLowerCase(), b]));
  const existingCodes = new Set(existingTreasury.map((t) => t.code.toLowerCase()));
  const usedGlIds = new Set(existingTreasury.map((t) => t.glAccountId));
  const seenCodes = new Set<string>();
  const seenGlIds = new Set<string>();

  interface ValidTreasuryRow {
    rowNumber: number;
    code: string;
    name: string;
    accountType: "bank" | "cashbox";
    currency: string;
    glAccountId: string;
    glAccountCode: string;
    openingBalance: number;
    bankName: string;
    accountNumber: string;
    iban: string;
    branchId: string | null;
  }
  const validRows: ValidTreasuryRow[] = [];

  for (const r of rows) {
    const code = normalizeArabicDigits(r.values.code || "").trim();
    const name = (r.values.name || "").trim();
    const rawType = (r.values.account_type || "bank").trim().toLowerCase();
    const normalizedType = rawType === "cash" ? "cashbox" : rawType;
    const currency = (r.values.currency || baseCurrency).trim().toUpperCase();
    const glCode = normalizeArabicDigits(r.values.gl_account_code || "").trim();
    const openBal = parseLocalizedNumber(r.values.opening_balance || "0");
    const bankName = (r.values.bank_name || "").trim();
    const accountNumber = normalizeArabicDigits(r.values.account_number || "").trim();
    const iban = (r.values.iban || "").trim().toUpperCase();
    const branchKey = (r.values.branch_code || r.values.branch_name || "").trim();

    let rowHasError = false;
    if (!code) {
      errors.push({ row: r.rowNumber, column: "code", message: "Treasury account code is required" });
      rowHasError = true;
    } else if (seenCodes.has(code.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "code", message: `Duplicate treasury code '${code}' in CSV`, value: code });
      rowHasError = true;
    } else if (existingCodes.has(code.toLowerCase())) {
      errors.push({ row: r.rowNumber, column: "code", message: `Treasury account '${code}' already exists`, value: code });
      rowHasError = true;
    } else {
      seenCodes.add(code.toLowerCase());
    }

    if (!name) {
      errors.push({ row: r.rowNumber, column: "name", message: "Treasury account name is required" });
      rowHasError = true;
    }

    if (normalizedType !== "bank" && normalizedType !== "cashbox") {
      errors.push({ row: r.rowNumber, column: "account_type", message: "account_type must be 'bank' or 'cashbox'", value: rawType });
      rowHasError = true;
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      errors.push({ row: r.rowNumber, column: "currency", message: "currency must be a 3-letter ISO code", value: currency });
      rowHasError = true;
    }

    const glAcct = glCode ? coaByCode.get(glCode) : undefined;
    if (!glCode) {
      errors.push({ row: r.rowNumber, column: "gl_account_code", message: "gl_account_code is required and must match an active asset GL account" });
      rowHasError = true;
    } else if (!glAcct) {
      errors.push({ row: r.rowNumber, column: "gl_account_code", message: `GL account '${glCode}' not found in Chart of Accounts. Import Chart of Accounts first.`, value: glCode });
      rowHasError = true;
    } else if (glAcct.accountType !== "asset" || !glAcct.isActive) {
      errors.push({ row: r.rowNumber, column: "gl_account_code", message: `GL account '${glCode} ${glAcct.name}' must be an active 'asset' account (found '${glAcct.accountType}', active=${glAcct.isActive})`, value: glCode });
      rowHasError = true;
    } else if (usedGlIds.has(glAcct.id) || seenGlIds.has(glAcct.id)) {
      errors.push({ row: r.rowNumber, column: "gl_account_code", message: `GL account '${glCode}' is already linked to another treasury account (must be 1-to-1)`, value: glCode });
      rowHasError = true;
    } else {
      seenGlIds.add(glAcct.id);
    }

    if (openBal === null || openBal < 0) {
      errors.push({ row: r.rowNumber, column: "opening_balance", message: "opening_balance must be a non-negative number", value: r.values.opening_balance });
      rowHasError = true;
    }

    let branchId: string | null = null;
    if (branchKey) {
      const b = branchByCode.get(branchKey.toLowerCase()) ?? branchByName.get(branchKey.toLowerCase());
      if (!b) {
        errors.push({ row: r.rowNumber, column: "branch_code", message: `Unknown branch '${branchKey}'`, value: branchKey });
        rowHasError = true;
      } else {
        branchId = b.id;
      }
    }

    if (!rowHasError && glAcct && openBal !== null) {
      validRows.push({
        rowNumber: r.rowNumber,
        code,
        name,
        accountType: normalizedType as "bank" | "cashbox",
        currency,
        glAccountId: glAcct.id,
        glAccountCode: glAcct.code,
        openingBalance: roundCurrency(openBal, 4),
        bankName,
        accountNumber,
        iban,
        branchId,
      });
      preview.push({
        row: r.rowNumber,
        action: "create",
        summary: `${code} — ${name} (${normalizedType}, GL ${glAcct.code}, Opening ${openBal.toFixed(2)} ${currency})`,
      });
    }
  }

  if (dryRun || errors.length > 0) {
    return {
      kind: "opening_treasury",
      dryRun,
      valid: errors.length === 0,
      totalRows: rows.length,
      createdCount: validRows.length,
      updatedCount: 0,
      skippedCount: 0,
      errors,
      warnings,
      preview: preview.slice(0, 50),
    };
  }

  await db.transaction(async (tx) => {
    for (const v of validRows) {
      await tx.insert(treasuryAccounts).values({
        companyId,
        code: v.code,
        name: v.name,
        accountType: v.accountType,
        currency: v.currency,
        branchId: v.branchId,
        glAccountId: v.glAccountId,
        bankName: v.bankName,
        accountNumber: v.accountNumber,
        iban: v.iban,
        source: "opening_balance",
        isActive: true,
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "import.opening_treasury",
      entityType: "treasury",
      entityId: companyId,
      entityLabel: `Opening Treasury Accounts CSV Import (${validRows.length} accounts)`,
      details: {
        count: validRows.length,
        accounts: validRows.map((v) => ({ code: v.code, glAccountCode: v.glAccountCode, openingBalance: v.openingBalance })),
      },
      ipAddress,
    });
  });

  return {
    kind: "opening_treasury",
    dryRun: false,
    valid: true,
    totalRows: rows.length,
    createdCount: validRows.length,
    updatedCount: 0,
    skippedCount: 0,
    errors: [],
    warnings,
    preview: preview.slice(0, 50),
  };
}

/**
 * Unified Opening Balances Cutover Import:
 * - Allowed only once per company and only while zero non-opening journals exist
 * - Validates cutoverDate falls in an open fiscal period
 * - Enforces Balance-Sheet-only by default (rejects Revenue/Expense unless allowPnlAccounts=true)
 * - Cross-checks TB control accounts against Open AR, Open AP, Opening Stock, Fixed Assets, Treasury, and VAT
 * - Posts ONE balanced opening journal entry + flagged opening AR/AP documents atomically
 */
export async function importOpeningBalances(
  db: AppDatabase,
  actor: RequestActor,
  input: z.infer<typeof openingBalancesImportSchema>,
  ipAddress?: string
): Promise<OpeningBalancesImportResultDto> {
  const companyId = actorCompanyId(actor);
  const dryRun = input.dryRun ?? true;
  const allowPnlAccounts = input.allowPnlAccounts ?? false;

  await ensureAccountingDefaults(db, companyId);

  const [
    guard,
    baseCurrency,
    glMap,
    coaRows,
    custRows,
    vendRows,
    branchRows,
    bpRows,
    faRows,
    treasuryRows,
    existingInvNums,
    existingBillNums,
    openPeriods,
  ] = await Promise.all([
    loadOpeningGuardState(db, companyId),
    getCompanyBaseCurrency(db, companyId),
    getGlAccountMap(db, companyId),
    db.select().from(chartOfAccounts).where(eq(chartOfAccounts.companyId, companyId)),
    db.select().from(customers).where(eq(customers.companyId, companyId)),
    db.select().from(vendors).where(eq(vendors.companyId, companyId)),
    db.select().from(branches).where(eq(branches.companyId, companyId)),
    db.select({ qtyOnHand: branchProducts.qtyOnHand, avgCost: branchProducts.avgCost }).from(branchProducts).where(eq(branchProducts.companyId, companyId)),
    db
      .select({ acquisitionCost: fixedAssets.acquisitionCost, accumulatedDepreciation: fixedAssets.accumulatedDepreciation })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.companyId, companyId), ne(fixedAssets.status, "disposed"))),
    db.select().from(treasuryAccounts).where(eq(treasuryAccounts.companyId, companyId)),
    db.select({ invoiceNumber: salesInvoices.invoiceNumber }).from(salesInvoices).where(eq(salesInvoices.companyId, companyId)),
    db.select({ billNumber: vendorBills.billNumber }).from(vendorBills).where(eq(vendorBills.companyId, companyId)),
    db
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.companyId, companyId),
          lte(fiscalPeriods.startDate, new Date(`${input.cutoverDate}T12:00:00.000Z`)),
          gte(fiscalPeriods.endDate, new Date(`${input.cutoverDate}T12:00:00.000Z`))
        )
      ),
  ]);

  const errors: CsvParseError[] = [];
  const warnings: CsvParseError[] = [];

  if (guard.activeOpeningJe) {
    errors.push({
      row: 1,
      column: "opening_balances",
      message: `Opening balances have already been posted (${guard.activeOpeningJe.entryNumber}). Reverse the existing opening cutover first if you need to reload.`,
    });
  }
  if (guard.hasNonOpeningJournals) {
    errors.push({
      row: 1,
      column: "opening_balances",
      message: `Cannot import opening balances because non-opening journal entries already exist (e.g. ${guard.firstNonOpeningJe?.entryNumber}).`,
    });
  }

  // Verify cutoverDate falls in an open fiscal period
  const cutoverPeriod = openPeriods[0];
  if (!cutoverPeriod) {
    errors.push({
      row: 1,
      column: "cutoverDate",
      message: `Cutover date '${input.cutoverDate}' does not fall within any configured fiscal period. Create the fiscal year first.`,
      value: input.cutoverDate,
    });
  } else if (cutoverPeriod.status !== "open") {
    errors.push({
      row: 1,
      column: "cutoverDate",
      message: `Fiscal period '${cutoverPeriod.name}' covering cutover date '${input.cutoverDate}' is '${cutoverPeriod.status}' (must be 'open').`,
      value: input.cutoverDate,
    });
  }

  const coaByCode = new Map(coaRows.map((a) => [a.code, a]));
  const coaById = new Map(coaRows.map((a) => [a.id, a]));
  const custByCode = new Map(custRows.map((c) => [c.code.toLowerCase(), c]));
  const vendByCode = new Map(vendRows.map((v) => [v.code.toLowerCase(), v]));
  const branchByCode = new Map(branchRows.map((b) => [b.code.toLowerCase(), b]));
  const branchByName = new Map(branchRows.map((b) => [b.name.toLowerCase(), b]));
  const defaultBranch = branchRows.find((b) => b.isDefault) ?? branchRows[0];

  // Parse Opening Trial Balance CSV
  const tbParsed = safeParseCsv(input.trialBalanceCsv, "opening_trial_balance");
  if (tbParsed.rows.length === 0) {
    errors.push({ row: 1, column: "trialBalanceCsv", message: "Opening trial balance CSV contains no data rows" });
  }

  interface TbLine {
    rowNumber: number;
    accountId: string;
    accountCode: string;
    accountType: AccountTypeShared;
    debit: number;
    credit: number;
    description: string;
  }
  const tbLines: TbLine[] = [];
  const tbNetByAcctId = new Map<string, number>(); // debit - credit

  for (const r of tbParsed.rows) {
    const acctCode = normalizeArabicDigits(r.values.account_code || r.values.code || "").trim();
    const debit = parseLocalizedNumber(r.values.debit || "0");
    const credit = parseLocalizedNumber(r.values.credit || "0");
    const desc = (r.values.description || r.values.memo || "Opening balance").trim();

    let rowHasError = false;
    const acct = acctCode ? coaByCode.get(acctCode) : undefined;
    if (!acctCode) {
      errors.push({ row: r.rowNumber, column: "account_code", message: "account_code is required" });
      rowHasError = true;
    } else if (!acct) {
      errors.push({ row: r.rowNumber, column: "account_code", message: `Unknown account_code '${acctCode}'. Import Chart of Accounts first.`, value: acctCode });
      rowHasError = true;
    } else if (!acct.isActive) {
      errors.push({ row: r.rowNumber, column: "account_code", message: `Account '${acctCode} ${acct.name}' is inactive`, value: acctCode });
      rowHasError = true;
    } else if (!allowPnlAccounts && (acct.accountType === "revenue" || acct.accountType === "expense")) {
      errors.push({
        row: r.rowNumber,
        column: "account_code",
        message: `Account '${acctCode} ${acct.name}' is a ${acct.accountType} (P&L) account. Balance-sheet cutover rejects P&L accounts by default (carry prior earnings in Retained Earnings 3100). Enable allowPnlAccounts only if approved by your accountant.`,
        value: acctCode,
      });
      rowHasError = true;
    }

    if (debit === null || debit < 0) {
      errors.push({ row: r.rowNumber, column: "debit", message: "debit must be a non-negative number", value: r.values.debit });
      rowHasError = true;
    }
    if (credit === null || credit < 0) {
      errors.push({ row: r.rowNumber, column: "credit", message: "credit must be a non-negative number", value: r.values.credit });
      rowHasError = true;
    }
    if (debit !== null && credit !== null) {
      if (debit > 0 && credit > 0) {
        errors.push({ row: r.rowNumber, column: "debit", message: "A trial balance line cannot have both debit > 0 and credit > 0" });
        rowHasError = true;
      } else if (debit === 0 && credit === 0) {
        continue; // ignore zero lines
      }
    }

    if (!rowHasError && acct && debit !== null && credit !== null) {
      const d = roundCurrency(debit, 4);
      const c = roundCurrency(credit, 4);
      tbLines.push({
        rowNumber: r.rowNumber,
        accountId: acct.id,
        accountCode: acct.code,
        accountType: acct.accountType as AccountTypeShared,
        debit: d,
        credit: c,
        description: desc,
      });
      tbNetByAcctId.set(acct.id, roundCurrency((tbNetByAcctId.get(acct.id) ?? 0) + d - c, 4));
    }
  }

  const totalDebits = roundCurrency(tbLines.reduce((s, l) => s + l.debit, 0), 4);
  const totalCredits = roundCurrency(tbLines.reduce((s, l) => s + l.credit, 0), 4);
  const isBalanced = Math.abs(totalDebits - totalCredits) <= 0.01 && tbLines.length >= 2;
  if (tbLines.length < 2) {
    errors.push({ row: 1, column: "trialBalanceCsv", message: "Opening trial balance must contain at least 2 non-zero lines" });
  } else if (!isBalanced) {
    errors.push({
      row: 1,
      column: "trialBalanceCsv",
      message: `Opening trial balance is out of balance: debits (${totalDebits.toFixed(2)}) != credits (${totalCredits.toFixed(2)}), difference = ${roundCurrency(totalDebits - totalCredits, 2).toFixed(2)}`,
    });
  }

  // Parse Open AR CSV
  interface ValidOpenArRow {
    rowNumber: number;
    invoiceNumber: string;
    customerId: string;
    branchId: string;
    invoiceDate: string;
    dueDate: string;
    openAmount: number;
    currency: string;
    fxRate: number;
    baseAmount: number;
    notes: string;
  }
  const openArRows: ValidOpenArRow[] = [];
  if (input.openArCsv && input.openArCsv.trim().length > 0) {
    const arParsed = safeParseCsv(input.openArCsv, "opening_ar");
    const existingInvSet = new Set(existingInvNums.map((i) => i.invoiceNumber.toLowerCase()));
    const seenInvNums = new Set<string>();

    for (const r of arParsed.rows) {
      const invNum = normalizeArabicDigits(r.values.invoice_number || r.values.document_number || "").trim();
      const custCode = normalizeArabicDigits(r.values.customer_code || "").trim();
      const branchKey = (r.values.branch_code || r.values.branch_name || "").trim();
      const invDate = parseIsoDateString(r.values.invoice_date || input.cutoverDate);
      const dueDate = parseIsoDateString(r.values.due_date || invDate || input.cutoverDate);
      const openAmt = parseLocalizedNumber(r.values.open_amount ?? r.values.amount ?? r.values.balance);
      const currency = (r.values.currency || baseCurrency).trim().toUpperCase();
      const fxRate = parseLocalizedNumber(r.values.fx_rate || "1");
      const notes = (r.values.notes || "Opening AR balance").trim();

      let rowHasError = false;
      if (!invNum) {
        errors.push({ row: r.rowNumber, column: "open_ar.invoice_number", message: "invoice_number is required" });
        rowHasError = true;
      } else if (seenInvNums.has(invNum.toLowerCase())) {
        errors.push({ row: r.rowNumber, column: "open_ar.invoice_number", message: `Duplicate open AR invoice_number '${invNum}'`, value: invNum });
        rowHasError = true;
      } else if (existingInvSet.has(invNum.toLowerCase())) {
        errors.push({ row: r.rowNumber, column: "open_ar.invoice_number", message: `Sales invoice '${invNum}' already exists`, value: invNum });
        rowHasError = true;
      } else {
        seenInvNums.add(invNum.toLowerCase());
      }

      const cust = custCode ? custByCode.get(custCode.toLowerCase()) : undefined;
      if (!custCode) {
        errors.push({ row: r.rowNumber, column: "open_ar.customer_code", message: "customer_code is required" });
        rowHasError = true;
      } else if (!cust) {
        errors.push({ row: r.rowNumber, column: "open_ar.customer_code", message: `Unknown customer_code '${custCode}'. Import Customers first.`, value: custCode });
        rowHasError = true;
      }

      const branch = branchKey
        ? (branchByCode.get(branchKey.toLowerCase()) ?? branchByName.get(branchKey.toLowerCase()))
        : defaultBranch;
      if (!branch) {
        errors.push({ row: r.rowNumber, column: "open_ar.branch_code", message: `Unknown branch '${branchKey}'`, value: branchKey });
        rowHasError = true;
      }

      if (!invDate) {
        errors.push({ row: r.rowNumber, column: "open_ar.invoice_date", message: "Valid invoice_date (YYYY-MM-DD) is required", value: r.values.invoice_date });
        rowHasError = true;
      }
      if (!dueDate) {
        errors.push({ row: r.rowNumber, column: "open_ar.due_date", message: "Valid due_date (YYYY-MM-DD) is required", value: r.values.due_date });
        rowHasError = true;
      }
      if (openAmt === null || openAmt <= 0) {
        errors.push({ row: r.rowNumber, column: "open_ar.open_amount", message: "open_amount must be a positive number", value: r.values.open_amount });
        rowHasError = true;
      }
      if (fxRate === null || fxRate <= 0) {
        errors.push({ row: r.rowNumber, column: "open_ar.fx_rate", message: "fx_rate must be a positive number", value: r.values.fx_rate });
        rowHasError = true;
      }

      if (!rowHasError && cust && branch && invDate && dueDate && openAmt !== null && fxRate !== null) {
        openArRows.push({
          rowNumber: r.rowNumber,
          invoiceNumber: invNum,
          customerId: cust.id,
          branchId: branch.id,
          invoiceDate: invDate,
          dueDate,
          openAmount: roundCurrency(openAmt, 4),
          currency,
          fxRate,
          baseAmount: roundCurrency(openAmt * fxRate, 4),
          notes,
        });
      }
    }
  }

  // Parse Open AP CSV
  interface ValidOpenApRow {
    rowNumber: number;
    billNumber: string;
    vendorId: string;
    branchId: string;
    billDate: string;
    dueDate: string;
    openAmount: number;
    currency: string;
    fxRate: number;
    baseAmount: number;
    notes: string;
  }
  const openApRows: ValidOpenApRow[] = [];
  if (input.openApCsv && input.openApCsv.trim().length > 0) {
    const apParsed = safeParseCsv(input.openApCsv, "opening_ap");
    const existingBillSet = new Set(existingBillNums.map((b) => b.billNumber.toLowerCase()));
    const seenBillNums = new Set<string>();

    for (const r of apParsed.rows) {
      const billNum = normalizeArabicDigits(r.values.bill_number || r.values.document_number || "").trim();
      const vendCode = normalizeArabicDigits(r.values.vendor_code || "").trim();
      const branchKey = (r.values.branch_code || r.values.branch_name || "").trim();
      const billDate = parseIsoDateString(r.values.bill_date || input.cutoverDate);
      const dueDate = parseIsoDateString(r.values.due_date || billDate || input.cutoverDate);
      const openAmt = parseLocalizedNumber(r.values.open_amount ?? r.values.amount ?? r.values.balance);
      const currency = (r.values.currency || baseCurrency).trim().toUpperCase();
      const fxRate = parseLocalizedNumber(r.values.fx_rate || "1");
      const notes = (r.values.notes || "Opening AP balance").trim();

      let rowHasError = false;
      if (!billNum) {
        errors.push({ row: r.rowNumber, column: "open_ap.bill_number", message: "bill_number is required" });
        rowHasError = true;
      } else if (seenBillNums.has(billNum.toLowerCase())) {
        errors.push({ row: r.rowNumber, column: "open_ap.bill_number", message: `Duplicate open AP bill_number '${billNum}'`, value: billNum });
        rowHasError = true;
      } else if (existingBillSet.has(billNum.toLowerCase())) {
        errors.push({ row: r.rowNumber, column: "open_ap.bill_number", message: `Vendor bill '${billNum}' already exists`, value: billNum });
        rowHasError = true;
      } else {
        seenBillNums.add(billNum.toLowerCase());
      }

      const vend = vendCode ? vendByCode.get(vendCode.toLowerCase()) : undefined;
      if (!vendCode) {
        errors.push({ row: r.rowNumber, column: "open_ap.vendor_code", message: "vendor_code is required" });
        rowHasError = true;
      } else if (!vend) {
        errors.push({ row: r.rowNumber, column: "open_ap.vendor_code", message: `Unknown vendor_code '${vendCode}'. Import Vendors first.`, value: vendCode });
        rowHasError = true;
      }

      const branch = branchKey
        ? (branchByCode.get(branchKey.toLowerCase()) ?? branchByName.get(branchKey.toLowerCase()))
        : defaultBranch;
      if (!branch) {
        errors.push({ row: r.rowNumber, column: "open_ap.branch_code", message: `Unknown branch '${branchKey}'`, value: branchKey });
        rowHasError = true;
      }

      if (!billDate) {
        errors.push({ row: r.rowNumber, column: "open_ap.bill_date", message: "Valid bill_date (YYYY-MM-DD) is required", value: r.values.bill_date });
        rowHasError = true;
      }
      if (!dueDate) {
        errors.push({ row: r.rowNumber, column: "open_ap.due_date", message: "Valid due_date (YYYY-MM-DD) is required", value: r.values.due_date });
        rowHasError = true;
      }
      if (openAmt === null || openAmt <= 0) {
        errors.push({ row: r.rowNumber, column: "open_ap.open_amount", message: "open_amount must be a positive number", value: r.values.open_amount });
        rowHasError = true;
      }
      if (fxRate === null || fxRate <= 0) {
        errors.push({ row: r.rowNumber, column: "open_ap.fx_rate", message: "fx_rate must be a positive number", value: r.values.fx_rate });
        rowHasError = true;
      }

      if (!rowHasError && vend && branch && billDate && dueDate && openAmt !== null && fxRate !== null) {
        openApRows.push({
          rowNumber: r.rowNumber,
          billNumber: billNum,
          vendorId: vend.id,
          branchId: branch.id,
          billDate,
          dueDate,
          openAmount: roundCurrency(openAmt, 4),
          currency,
          fxRate,
          baseAmount: roundCurrency(openAmt * fxRate, 4),
          notes,
        });
      }
    }
  }

  // Control account cross-checks against all 8 subledgers
  const tbArBalance = roundCurrency(tbNetByAcctId.get(glMap.accounts_receivable) ?? 0, 4);
  const tbApBalance = roundCurrency(-(tbNetByAcctId.get(glMap.accounts_payable) ?? 0), 4);
  const tbInvBalance = roundCurrency(tbNetByAcctId.get(glMap.inventory_asset) ?? 0, 4);
  const tbFaCostBalance = roundCurrency(tbNetByAcctId.get(glMap.fixed_assets_cost) ?? 0, 4);
  const tbFaAccumBalance = roundCurrency(-(tbNetByAcctId.get(glMap.accumulated_depreciation) ?? 0), 4);
  const openingOutputVatCarryover = roundCurrency(-(tbNetByAcctId.get(glMap.output_vat) ?? 0), 4);
  const openingInputVatCarryover = roundCurrency(tbNetByAcctId.get(glMap.input_vat) ?? 0, 4);

  const openArTotal = roundCurrency(openArRows.reduce((s, r) => s + r.baseAmount, 0), 4);
  const openApTotal = roundCurrency(openApRows.reduce((s, r) => s + r.baseAmount, 0), 4);
  const openingStockValuation = roundCurrency(
    bpRows.reduce((s, bp) => s + num(bp.qtyOnHand) * num(bp.avgCost), 0),
    4
  );
  const openingFixedAssetsCost = roundCurrency(
    faRows.reduce((s, a) => s + num(a.acquisitionCost), 0),
    4
  );
  const openingFixedAssetsAccumDep = roundCurrency(
    faRows.reduce((s, a) => s + num(a.accumulatedDepreciation), 0),
    4
  );

  let openingTreasuryTotal = 0;
  for (const ta of treasuryRows) {
    const coa = coaById.get(ta.glAccountId);
    if (!coa || coa.accountType !== "asset" || !coa.isActive) {
      errors.push({
        row: 1,
        column: "opening_treasury",
        message: `Treasury account '${ta.code}' is linked to an invalid or inactive GL account`,
      });
    }
    openingTreasuryTotal = roundCurrency(openingTreasuryTotal + (tbNetByAcctId.get(ta.glAccountId) ?? 0), 4);
  }

  if (Math.abs(openArTotal - tbArBalance) > 0.02) {
    errors.push({
      row: 1,
      column: "open_ar",
      message: `Open AR documents total (${openArTotal.toFixed(2)}) does not match Accounts Receivable control balance in Trial Balance (${tbArBalance.toFixed(2)})`,
    });
  }
  if (Math.abs(openApTotal - tbApBalance) > 0.02) {
    errors.push({
      row: 1,
      column: "open_ap",
      message: `Open AP documents total (${openApTotal.toFixed(2)}) does not match Accounts Payable control balance in Trial Balance (${tbApBalance.toFixed(2)})`,
    });
  }
  if (Math.abs(openingStockValuation - tbInvBalance) > 0.02) {
    errors.push({
      row: 1,
      column: "opening_stock",
      message: `Imported opening stock valuation (${openingStockValuation.toFixed(2)}) does not match Inventory control balance in Trial Balance (${tbInvBalance.toFixed(2)})`,
    });
  }
  if (Math.abs(openingFixedAssetsCost - tbFaCostBalance) > 0.02) {
    errors.push({
      row: 1,
      column: "opening_fixed_assets",
      message: `Fixed Assets register cost (${openingFixedAssetsCost.toFixed(2)}) does not match Fixed Assets Cost control balance in Trial Balance (${tbFaCostBalance.toFixed(2)})`,
    });
  }
  if (Math.abs(openingFixedAssetsAccumDep - tbFaAccumBalance) > 0.02) {
    errors.push({
      row: 1,
      column: "opening_fixed_assets",
      message: `Fixed Assets accumulated depreciation (${openingFixedAssetsAccumDep.toFixed(2)}) does not match Accumulated Depreciation control balance in Trial Balance (${tbFaAccumBalance.toFixed(2)})`,
    });
  }

  if (openingOutputVatCarryover !== 0 || openingInputVatCarryover !== 0) {
    warnings.push({
      row: 1,
      column: "vat_carryover",
      message: `Opening VAT balances carried forward from legacy books (Output VAT 2300: ${openingOutputVatCarryover.toFixed(2)}, Input VAT 1300: ${openingInputVatCarryover.toFixed(2)}). These are tracked as opening carryover and excluded from current-period VAT return sales/purchase buckets.`,
    });
  }

  if (dryRun || errors.length > 0) {
    return {
      dryRun,
      valid: errors.length === 0,
      cutoverDate: input.cutoverDate,
      allowPnlAccounts,
      trialBalanceRows: tbLines.length,
      totalDebits,
      totalCredits,
      isBalanced,
      openArCount: openArRows.length,
      openArTotal,
      openApCount: openApRows.length,
      openApTotal,
      openingStockValuation,
      openingFixedAssetsCost,
      openingFixedAssetsAccumDep,
      openingTreasuryTotal,
      openingOutputVatCarryover,
      openingInputVatCarryover,
      journalEntryId: null,
      journalEntryNumber: null,
      errors,
      warnings,
    };
  }

  const entryDate = new Date(`${input.cutoverDate}T12:00:00.000Z`);

  const committed = await db.transaction(async (tx) => {
    // Re-check single-use opening guard inside transaction
    const txGuard = await loadOpeningGuardState(tx, companyId);
    if (txGuard.activeOpeningJe) {
      throw new AppError(409, "Opening balances have already been posted for this company", "OPENING_BALANCES_ALREADY_POSTED");
    }
    if (txGuard.hasNonOpeningJournals) {
      throw new AppError(409, "Cannot import opening balances because non-opening journal entries exist", "NON_OPENING_JOURNALS_EXIST");
    }

    // 1. Insert flagged Open AR documents (source='opening_balance', NEVER enqueued to ETA/ZATCA)
    for (const ar of openArRows) {
      const [inserted] = await tx
        .insert(salesInvoices)
        .values({
          companyId,
          invoiceNumber: ar.invoiceNumber,
          customerId: ar.customerId,
          branchId: ar.branchId,
          status: "Sent",
          source: "opening_balance",
          invoiceDate: new Date(`${ar.invoiceDate}T00:00:00.000Z`),
          dueDate: new Date(`${ar.dueDate}T00:00:00.000Z`),
          currency: ar.currency,
          fxRate: toNumeric(ar.fxRate),
          subtotal: toNumeric(ar.openAmount),
          taxTotal: toNumeric(0),
          totalAmount: toNumeric(ar.openAmount),
          paidAmount: toNumeric(0),
          creditAppliedAmount: toNumeric(0),
          retainerAppliedAmount: toNumeric(0),
          eInvoiceStatus: "not_applicable",
          etaReceiptStatus: "not_applicable",
          notes: ar.notes,
          createdBy: actor.id,
        })
        .returning({ id: salesInvoices.id });

      await tx.insert(salesInvoiceLines).values({
        invoiceId: inserted.id,
        productId: null,
        description: ar.notes || `Opening AR Balance (${ar.invoiceNumber})`,
        quantity: toNumeric(1),
        unitPrice: toNumeric(ar.openAmount),
        discount: toNumeric(0),
        taxRate: toNumeric(0),
        taxAmount: toNumeric(0),
        lineTotal: toNumeric(ar.openAmount),
      });
    }

    // 2. Insert flagged Open AP documents (source='opening_balance')
    for (const ap of openApRows) {
      const [inserted] = await tx
        .insert(vendorBills)
        .values({
          companyId,
          billNumber: ap.billNumber,
          vendorId: ap.vendorId,
          branchId: ap.branchId,
          status: "Open",
          source: "opening_balance",
          billDate: new Date(`${ap.billDate}T00:00:00.000Z`),
          dueDate: new Date(`${ap.dueDate}T00:00:00.000Z`),
          currency: ap.currency,
          fxRate: toNumeric(ap.fxRate),
          subtotal: toNumeric(ap.openAmount),
          taxTotal: toNumeric(0),
          totalAmount: toNumeric(ap.openAmount),
          paidAmount: toNumeric(0),
          notes: ap.notes,
          createdBy: actor.id,
        })
        .returning({ id: vendorBills.id });

      await tx.insert(vendorBillLines).values({
        billId: inserted.id,
        productId: null,
        description: ap.notes || `Opening AP Balance (${ap.billNumber})`,
        quantity: toNumeric(1),
        unitCost: toNumeric(ap.openAmount),
        taxRate: toNumeric(0),
        taxAmount: toNumeric(0),
        lineTotal: toNumeric(ap.openAmount),
      });
    }

    // 3. Post ONE single balanced opening journal entry dated at cutoverDate
    const je = await postJournalEntry(tx, {
      companyId,
      entryDate,
      branchId: defaultBranch?.id ?? null,
      sourceType: "opening_balance",
      sourceId: companyId,
      referenceNumber: `OPEN-${input.cutoverDate}`,
      memo: input.memo || `Opening Balances Cutover (${input.cutoverDate})`,
      createdBy: actor.id,
      lines: tbLines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        currency: baseCurrency,
        fxRate: 1,
        description: l.description,
      })),
    });

    // 4. Write audit log inside the tamper-evident hash chain
    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "opening_balances.imported",
      entityType: "accounting",
      entityId: je.id,
      entityLabel: je.entryNumber,
      after: {
        cutoverDate: input.cutoverDate,
        allowPnlAccounts,
        totalDebits,
        totalCredits,
        openArCount: openArRows.length,
        openArTotal,
        openApCount: openApRows.length,
        openApTotal,
        openingStockValuation,
        openingFixedAssetsCost,
        openingFixedAssetsAccumDep,
        openingTreasuryTotal,
        openingOutputVatCarryover,
        openingInputVatCarryover,
      },
      ipAddress,
    });

    return je;
  });

  const reconciliation = await getSubledgerReconciliation(db, actor);

  return {
    dryRun: false,
    valid: true,
    cutoverDate: input.cutoverDate,
    allowPnlAccounts,
    trialBalanceRows: tbLines.length,
    totalDebits,
    totalCredits,
    isBalanced: true,
    openArCount: openArRows.length,
    openArTotal,
    openApCount: openApRows.length,
    openApTotal,
    openingStockValuation,
    openingFixedAssetsCost,
    openingFixedAssetsAccumDep,
    openingTreasuryTotal,
    openingOutputVatCarryover,
    openingInputVatCarryover,
    journalEntryId: committed.id,
    journalEntryNumber: committed.entryNumber,
    errors: [],
    warnings,
    reconciliation,
  };
}

/**
 * Controlled Admin Reversal of Opening Balances Cutover:
 * - Only allowed while no non-opening JEs or payments/depreciation exist against opening artifacts
 * - Posts mirror reversing JE (keeping original status='posted' with reversedEntryId linked so net = 0)
 * - Removes flagged opening AR/AP documents, opening fixed assets, opening treasury accounts, and opening stock
 * - Writes opening_balances.reversed to the tamper-evident audit hash chain
 */
export async function reverseOpeningBalances(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof reverseOpeningBalancesSchema>,
  ipAddress?: string
): Promise<ReverseOpeningBalancesResultDto> {
  const companyId = actorCompanyId(actor);

  return db.transaction(async (tx) => {
    const guard = await loadOpeningGuardState(tx, companyId);
    if (!guard.activeOpeningJe) {
      throw new AppError(404, "No active opening balance journal entry found to reverse", "NOT_FOUND");
    }
    if (guard.hasNonOpeningJournals) {
      throw new AppError(
        409,
        `Cannot reverse opening balances because non-opening journal entries already exist (e.g. ${guard.firstNonOpeningJe?.entryNumber}).`,
        "NON_OPENING_JOURNALS_EXIST"
      );
    }

    // Ensure no payments or depreciation were recorded against opening artifacts
    const openingArIds = (
      await tx
        .select({ id: salesInvoices.id })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.companyId, companyId), eq(salesInvoices.source, "opening_balance")))
    ).map((r) => r.id);

    if (openingArIds.length > 0) {
      const [arAlloc] = await tx
        .select({ id: receivedPaymentAllocations.id })
        .from(receivedPaymentAllocations)
        .where(inArray(receivedPaymentAllocations.invoiceId, openingArIds))
        .limit(1);
      if (arAlloc) {
        throw new AppError(409, "Cannot reverse opening balances because payments have been applied to opening AR invoices", "OPENING_DOCS_REFERENCED");
      }
    }

    const openingApIds = (
      await tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.source, "opening_balance")))
    ).map((r) => r.id);

    if (openingApIds.length > 0) {
      const [apAlloc] = await tx
        .select({ id: paymentMadeAllocations.id })
        .from(paymentMadeAllocations)
        .where(inArray(paymentMadeAllocations.billId, openingApIds))
        .limit(1);
      if (apAlloc) {
        throw new AppError(409, "Cannot reverse opening balances because payments have been applied to opening AP bills", "OPENING_DOCS_REFERENCED");
      }
    }

    const openingFaIds = (
      await tx
        .select({ id: fixedAssets.id })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.companyId, companyId), eq(fixedAssets.source, "opening_balance")))
    ).map((r) => r.id);

    if (openingFaIds.length > 0) {
      const [dep] = await tx
        .select({ id: fixedAssetDepreciationEntries.id })
        .from(fixedAssetDepreciationEntries)
        .where(inArray(fixedAssetDepreciationEntries.assetId, openingFaIds))
        .limit(1);
      if (dep) {
        throw new AppError(409, "Cannot reverse opening balances because depreciation has been posted on opening fixed assets", "OPENING_DOCS_REFERENCED");
      }
    }

    // 1. Post mirror reversal JE dated at openingJe.entryDate (keeping original status='posted' so net = 0)
    const [openingJeFull] = await tx
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, guard.activeOpeningJe.id))
      .limit(1);
    const origLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, guard.activeOpeningJe.id));

    const revJe = await postJournalEntry(tx, {
      companyId,
      entryDate: openingJeFull.entryDate,
      branchId: openingJeFull.branchId,
      sourceType: "opening_balance_reversal",
      sourceId: openingJeFull.id,
      referenceNumber: openingJeFull.entryNumber,
      memo: `Reversal of Opening Cutover ${openingJeFull.entryNumber}: ${data.reason}`,
      createdBy: actor.id,
      lines: origLines.map((l) => ({
        accountId: l.accountId,
        branchId: l.branchId,
        debit: num(l.creditTx),
        credit: num(l.debitTx),
        currency: l.currency,
        fxRate: num(l.fxRate),
        costCenterId: l.costCenterId,
        description: l.description ? `Reversal: ${l.description}` : "Opening balance reversal",
      })),
    });

    await tx
      .update(journalEntries)
      .set({ reversedEntryId: revJe.id })
      .where(eq(journalEntries.id, openingJeFull.id));

    // 2. Remove flagged opening AR, AP, Fixed Assets, and Treasury records
    const deletedAr = await tx
      .delete(salesInvoices)
      .where(and(eq(salesInvoices.companyId, companyId), eq(salesInvoices.source, "opening_balance")))
      .returning({ id: salesInvoices.id });

    const deletedAp = await tx
      .delete(vendorBills)
      .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.source, "opening_balance")))
      .returning({ id: vendorBills.id });

    const deletedFa = await tx
      .delete(fixedAssets)
      .where(and(eq(fixedAssets.companyId, companyId), eq(fixedAssets.source, "opening_balance")))
      .returning({ id: fixedAssets.id });

    const deletedTreasury = await tx
      .delete(treasuryAccounts)
      .where(and(eq(treasuryAccounts.companyId, companyId), eq(treasuryAccounts.source, "opening_balance")))
      .returning({ id: treasuryAccounts.id });

    // 3. Reverse & remove opening stock movements and update branch_products
    const openingMoves = await tx
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.movementType, "opening_balance"),
          eq(stockMovements.referenceType, "opening_balance")
        )
      );

    for (const mv of openingMoves) {
      const [bp] = await tx
        .select()
        .from(branchProducts)
        .where(and(eq(branchProducts.branchId, mv.branchId), eq(branchProducts.productId, mv.productId)))
        .limit(1);
      if (bp) {
        const nextQty = Math.max(0, roundCurrency(num(bp.qtyOnHand) - num(mv.qtyDelta), 4));
        await tx
          .update(branchProducts)
          .set({
            qtyOnHand: toNumeric(nextQty),
            avgCost: nextQty <= 0 ? toNumeric(0) : bp.avgCost,
            updatedAt: new Date(),
          })
          .where(eq(branchProducts.id, bp.id));
      }
    }

    const deletedStockMoves = await tx
      .delete(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, companyId),
          eq(stockMovements.movementType, "opening_balance"),
          eq(stockMovements.referenceType, "opening_balance")
        )
      )
      .returning({ id: stockMovements.id });

    // 4. Write audit log inside the hash chain
    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "opening_balances.reversed",
      entityType: "accounting",
      entityId: openingJeFull.id,
      entityLabel: `${openingJeFull.entryNumber} -> ${revJe.entryNumber}`,
      details: {
        reason: data.reason,
        removedArInvoices: deletedAr.length,
        removedApBills: deletedAp.length,
        removedFixedAssets: deletedFa.length,
        removedTreasuryAccounts: deletedTreasury.length,
        removedOpeningStockMovements: deletedStockMoves.length,
      },
      ipAddress,
    });

    return {
      reversedJournalEntryId: openingJeFull.id,
      reversalEntryId: revJe.id,
      reversalEntryNumber: revJe.entryNumber,
      removedArInvoices: deletedAr.length,
      removedApBills: deletedAp.length,
      removedFixedAssets: deletedFa.length,
      removedTreasuryAccounts: deletedTreasury.length,
      removedOpeningStockMovements: deletedStockMoves.length,
    };
  });
}

// Keep nextDocNumber referenced if needed in future extensions
export const _importHelpersRef = nextDocNumber;
