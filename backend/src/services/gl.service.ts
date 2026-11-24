import { buildOffsetPageInfo, roundCurrency, type AccountTypeShared, type GlMappingKey, type NormalBalanceShared, type OffsetPageInfo, type createAccountSchema, type createFiscalYearSchema, type createJournalEntrySchema } from "@erp/shared";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  DEFAULT_COMPANY_ID,
  chartOfAccounts,
  currencies,
  fiscalPeriods,
  fiscalYears,
  glAccountMappings,
  journalEntries,
  journalLines,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { groupByKey } from "./query-helpers.ts";
import { actorCompanyId, assertBranchInCompany, type RequestActor } from "./stock-locks.ts";

interface DefaultAccountDef {
  code: string;
  name: string;
  accountType: AccountTypeShared;
  normalBalance: NormalBalanceShared;
  mappingKey?: GlMappingKey;
}

export const DEFAULT_COA: DefaultAccountDef[] = [
  { code: "1000", name: "Cash & Bank", accountType: "asset", normalBalance: "debit", mappingKey: "default_cash_bank" },
  { code: "1010", name: "POS Cash Drawer", accountType: "asset", normalBalance: "debit", mappingKey: "pos_cash_drawer" },
  { code: "1020", name: "Card & Mobile Wallet Clearing", accountType: "asset", normalBalance: "debit", mappingKey: "card_clearing" },
  { code: "1100", name: "Accounts Receivable", accountType: "asset", normalBalance: "debit", mappingKey: "accounts_receivable" },
  { code: "1200", name: "Inventory Asset", accountType: "asset", normalBalance: "debit", mappingKey: "inventory_asset" },
  { code: "1210", name: "In-Transit Inventory", accountType: "asset", normalBalance: "debit", mappingKey: "in_transit_inventory" },
  { code: "1220", name: "Work in Progress (WIP) Inventory", accountType: "asset", normalBalance: "debit", mappingKey: "wip_inventory" },
  { code: "1300", name: "Input VAT Recoverable", accountType: "asset", normalBalance: "debit", mappingKey: "input_vat" },
  { code: "2000", name: "Accounts Payable", accountType: "liability", normalBalance: "credit", mappingKey: "accounts_payable" },
  { code: "2100", name: "Goods Received Not Invoiced (GRNI)", accountType: "liability", normalBalance: "credit", mappingKey: "grni" },
  { code: "2200", name: "Customer Retainers & Advances", accountType: "liability", normalBalance: "credit", mappingKey: "retainer_liability" },
  { code: "2300", name: "Output VAT Payable", accountType: "liability", normalBalance: "credit", mappingKey: "output_vat" },
  { code: "3000", name: "Opening Balance Equity", accountType: "equity", normalBalance: "credit", mappingKey: "opening_equity" },
  { code: "4000", name: "Sales Revenue", accountType: "revenue", normalBalance: "credit", mappingKey: "sales_revenue" },
  { code: "5000", name: "Cost of Goods Sold", accountType: "expense", normalBalance: "debit", mappingKey: "cogs" },
  { code: "5100", name: "Inventory Adjustment & Shrinkage", accountType: "expense", normalBalance: "debit", mappingKey: "inventory_adjustment" },
  { code: "5200", name: "Inventory Write-Off Expense", accountType: "expense", normalBalance: "debit", mappingKey: "write_off_expense" },
  { code: "5400", name: "Cash Over & Short", accountType: "expense", normalBalance: "debit", mappingKey: "cash_over_short" },
  { code: "5900", name: "Purchase Price & Rounding Variance", accountType: "expense", normalBalance: "debit", mappingKey: "rounding_variance" },
];

export function defaultNormalBalance(accountType: AccountTypeShared): NormalBalanceShared {
  return accountType === "asset" || accountType === "expense" ? "debit" : "credit";
}

/**
 * Seeds default Chart of Accounts, GL account mappings, base currency,
 * and open fiscal calendar periods idempotently inside any DB transaction.
 */
export async function ensureAccountingDefaults(
  tx: DbOrTx,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<void> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;

  for (const def of DEFAULT_COA) {
    await tx
      .insert(chartOfAccounts)
      .values({
        companyId: effectiveCompanyId,
        code: def.code,
        name: def.name,
        accountType: def.accountType,
        normalBalance: def.normalBalance,
        isSystem: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  const coaRows = await tx
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, effectiveCompanyId));
  const byCode = new Map(coaRows.map((a) => [a.code, a.id]));

  for (const def of DEFAULT_COA) {
    if (!def.mappingKey) continue;
    const accountId = byCode.get(def.code);
    if (!accountId) continue;
    await tx
      .insert(glAccountMappings)
      .values({ companyId: effectiveCompanyId, mappingKey: def.mappingKey, accountId })
      .onConflictDoNothing();
  }

  const existingCurrency = await tx
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.companyId, effectiveCompanyId))
    .limit(1);
  if (existingCurrency.length === 0) {
    await tx
      .insert(currencies)
      .values({
        companyId: effectiveCompanyId,
        code: "USD",
        name: "US Dollar",
        symbol: "$",
        decimals: 2,
        isBase: true,
        isActive: true,
      })
      .onConflictDoNothing();
  }

  const nowYear = new Date().getUTCFullYear();
  for (const year of [nowYear, nowYear + 1]) {
    await seedCalendarFiscalYear(tx, year, effectiveCompanyId);
  }
}

async function seedCalendarFiscalYear(
  tx: DbOrTx,
  year: number,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<void> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;
  const existing = await tx
    .select({ id: fiscalYears.id })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.companyId, effectiveCompanyId), eq(fiscalYears.name, `FY ${year}`)))
    .limit(1);
  if (existing.length > 0) return;

  const [fy] = await tx
    .insert(fiscalYears)
    .values({
      companyId: effectiveCompanyId,
      name: `FY ${year}`,
      startDate: new Date(Date.UTC(year, 0, 1, 0, 0, 0)),
      endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
      status: "open",
    })
    .onConflictDoNothing()
    .returning();

  if (!fy) return;

  const periods: Array<typeof fiscalPeriods.$inferInsert> = [];
  for (let m = 0; m < 12; m++) {
    const startDate = new Date(Date.UTC(year, m, 1, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, m + 1, 0, 23, 59, 59, 999));
    periods.push({
      companyId: effectiveCompanyId,
      fiscalYearId: fy.id,
      periodNumber: m + 1,
      name: `${year}-${String(m + 1).padStart(2, "0")}`,
      startDate,
      endDate,
      status: "open",
    });
  }
  await tx.insert(fiscalPeriods).values(periods).onConflictDoNothing();
}

export interface JournalLineSpec {
  accountId: string;
  branchId?: string | null;
  debit: number;
  credit: number;
  currency?: string;
  fxRate?: number;
  description?: string;
}

export interface BalancedJournalValidation {
  normalizedLines: Array<{
    accountId: string;
    branchId: string | null;
    debitBase: number;
    creditBase: number;
    currency: string;
    fxRate: number;
    debitTx: number;
    creditTx: number;
    description: string;
  }>;
  totalDebit: number;
  totalCredit: number;
  pennyDiffPlugged: number;
}

/**
 * Pure validation ensuring debits equal credits in base currency, plugging <= 0.05 FX/rounding diffs
 * when a roundingVarianceAccountId is provided.
 */
export function validateAndNormalizeJournalLines(
  lines: JournalLineSpec[],
  roundingVarianceAccountId?: string
): BalancedJournalValidation {
  if (lines.length < 2) {
    throw new AppError(400, "Journal entry requires at least two lines", "UNBALANCED_JOURNAL");
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const normalizedLines = lines.map((l) => {
    const fxRate = l.fxRate && l.fxRate > 0 ? l.fxRate : 1;
    const debitTx = roundCurrency(l.debit, 4);
    const creditTx = roundCurrency(l.credit, 4);
    const debitBase = roundCurrency(debitTx * fxRate, 4);
    const creditBase = roundCurrency(creditTx * fxRate, 4);
    totalDebit = roundCurrency(totalDebit + debitBase, 4);
    totalCredit = roundCurrency(totalCredit + creditBase, 4);
    return {
      accountId: l.accountId,
      branchId: l.branchId ?? null,
      debitBase,
      creditBase,
      currency: l.currency ?? "USD",
      fxRate,
      debitTx,
      creditTx,
      description: l.description ?? "",
    };
  });

  if (totalDebit <= 0 || totalCredit <= 0) {
    throw new AppError(400, "Journal entry totals must be positive", "UNBALANCED_JOURNAL");
  }

  const diff = roundCurrency(totalDebit - totalCredit, 4);
  let pennyDiffPlugged = 0;
  if (Math.abs(diff) > 0.0001) {
    if (roundingVarianceAccountId && Math.abs(diff) <= 0.05) {
      pennyDiffPlugged = Math.abs(diff);
      if (diff > 0) {
        normalizedLines.push({
          accountId: roundingVarianceAccountId,
          branchId: normalizedLines[0]?.branchId ?? null,
          debitBase: 0,
          creditBase: diff,
          currency: "USD",
          fxRate: 1,
          debitTx: 0,
          creditTx: diff,
          description: "FX / rounding variance plug",
        });
        totalCredit = roundCurrency(totalCredit + diff, 4);
      } else {
        const absDiff = Math.abs(diff);
        normalizedLines.push({
          accountId: roundingVarianceAccountId,
          branchId: normalizedLines[0]?.branchId ?? null,
          debitBase: absDiff,
          creditBase: 0,
          currency: "USD",
          fxRate: 1,
          debitTx: absDiff,
          creditTx: 0,
          description: "FX / rounding variance plug",
        });
        totalDebit = roundCurrency(totalDebit + absDiff, 4);
      }
    } else {
      throw new AppError(
        400,
        `Unbalanced journal entry: debits (${totalDebit}) do not equal credits (${totalCredit})`,
        "UNBALANCED_JOURNAL"
      );
    }
  }

  return { normalizedLines, totalDebit, totalCredit, pennyDiffPlugged };
}

export async function assertPeriodOpen(
  tx: DbOrTx,
  entryDate: Date,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<string | null> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;
  const periods = await tx
    .select({
      id: fiscalPeriods.id,
      name: fiscalPeriods.name,
      status: fiscalPeriods.status,
      fiscalYearId: fiscalPeriods.fiscalYearId,
    })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.companyId, effectiveCompanyId),
        lte(fiscalPeriods.startDate, entryDate),
        gte(fiscalPeriods.endDate, entryDate)
      )
    )
    .limit(1);

  const period = periods[0];
  if (!period) return null;

  if (period.status === "locked") {
    throw new AppError(400, `Fiscal period '${period.name}' is locked`, "FISCAL_PERIOD_LOCKED");
  }

  const [fy] = await tx
    .select({ name: fiscalYears.name, status: fiscalYears.status })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.id, period.fiscalYearId), eq(fiscalYears.companyId, effectiveCompanyId)))
    .limit(1);
  if (fy && fy.status === "closed") {
    throw new AppError(400, `Fiscal year '${fy.name}' is closed`, "FISCAL_YEAR_CLOSED");
  }

  return period.id;
}

export async function getGlAccountMap(
  tx: DbOrTx,
  companyId: string = DEFAULT_COMPANY_ID
): Promise<Record<GlMappingKey, string>> {
  const effectiveCompanyId = companyId || DEFAULT_COMPANY_ID;
  let rows = await tx
    .select()
    .from(glAccountMappings)
    .where(eq(glAccountMappings.companyId, effectiveCompanyId));
  if (rows.length === 0) {
    await ensureAccountingDefaults(tx, effectiveCompanyId);
    rows = await tx
      .select()
      .from(glAccountMappings)
      .where(eq(glAccountMappings.companyId, effectiveCompanyId));
  }
  const map = {} as Record<GlMappingKey, string>;
  for (const r of rows) {
    map[r.mappingKey as GlMappingKey] = r.accountId;
  }
  return map;
}

export interface PostJournalEntryInput {
  companyId?: string;
  entryDate?: Date;
  branchId?: string | null;
  sourceType: string;
  sourceId?: string | null;
  referenceNumber?: string;
  memo: string;
  createdBy?: string | null;
  lines: JournalLineSpec[];
  allowRoundingPlug?: boolean;
}

export async function postJournalEntry(tx: DbOrTx, input: PostJournalEntryInput) {
  const effectiveCompanyId = input.companyId || DEFAULT_COMPANY_ID;
  const entryDate = input.entryDate ?? new Date();
  const glMap = await getGlAccountMap(tx, effectiveCompanyId);
  const fiscalPeriodId = await assertPeriodOpen(tx, entryDate, effectiveCompanyId);
  const { normalizedLines } = validateAndNormalizeJournalLines(
    input.lines,
    input.allowRoundingPlug ? glMap.rounding_variance : undefined
  );

  // Verify every account belongs to effectiveCompanyId
  const distinctAccountIds = Array.from(new Set(normalizedLines.map((l) => l.accountId)));
  const companyAccounts = await tx
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.companyId, effectiveCompanyId),
        inArray(chartOfAccounts.id, distinctAccountIds)
      )
    );
  if (companyAccounts.length !== distinctAccountIds.length) {
    throw new AppError(404, "One or more journal accounts were not found in the active company", "NOT_FOUND");
  }

  if (input.branchId) {
    await assertBranchInCompany(tx, input.branchId, effectiveCompanyId);
  }
  const lineBranchIds = Array.from(
    new Set(
      normalizedLines
        .map((l) => l.branchId)
        .filter((b): b is string => Boolean(b) && b !== input.branchId)
    )
  );
  for (const bId of lineBranchIds) {
    await assertBranchInCompany(tx, bId, effectiveCompanyId);
  }

  const entryNumber = await nextDocNumber(tx, "JE", "JE-", undefined, effectiveCompanyId);
  const [je] = await tx
    .insert(journalEntries)
    .values({
      companyId: effectiveCompanyId,
      entryNumber,
      entryDate,
      branchId: input.branchId ?? null,
      fiscalPeriodId,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      referenceNumber: input.referenceNumber ?? "",
      memo: input.memo,
      status: "posted",
      createdBy: input.createdBy ?? null,
    })
    .returning();

  await tx.insert(journalLines).values(
    normalizedLines.map((l) => ({
      entryId: je.id,
      accountId: l.accountId,
      branchId: l.branchId ?? input.branchId ?? null,
      debitBase: toNumeric(l.debitBase, 4),
      creditBase: toNumeric(l.creditBase, 4),
      currency: l.currency,
      fxRate: toNumeric(l.fxRate, 6),
      debitTx: toNumeric(l.debitTx, 4),
      creditTx: toNumeric(l.creditTx, 4),
      description: l.description,
    }))
  );

  return je;
}

export interface MappedLineSpec {
  mappingKey: GlMappingKey;
  accountId?: string;
  branchId?: string | null;
  debit?: number;
  credit?: number;
  currency?: string;
  fxRate?: number;
  description?: string;
}

/**
 * Resolves GL mapping keys cleanly and skips posting if all amounts evaluate to 0.
 */
export async function postMappedJournal(
  tx: DbOrTx,
  input: Omit<PostJournalEntryInput, "lines"> & { lines: MappedLineSpec[] }
) {
  const effectiveCompanyId = input.companyId || DEFAULT_COMPANY_ID;
  const glMap = await getGlAccountMap(tx, effectiveCompanyId);
  const activeLines: JournalLineSpec[] = [];
  for (const l of input.lines) {
    const debit = roundCurrency(l.debit ?? 0, 4);
    const credit = roundCurrency(l.credit ?? 0, 4);
    if (debit <= 0 && credit <= 0) continue;
    const accountId = l.accountId ?? glMap[l.mappingKey];
    if (!accountId) {
      throw new AppError(500, `Missing GL account mapping for '${l.mappingKey}'`, "MISSING_GL_MAPPING");
    }
    activeLines.push({
      accountId,
      branchId: l.branchId ?? input.branchId,
      debit,
      credit,
      currency: l.currency,
      fxRate: l.fxRate,
      description: l.description,
    });
  }

  if (activeLines.length < 2) return null;
  return postJournalEntry(tx, {
    ...input,
    companyId: effectiveCompanyId,
    allowRoundingPlug: true,
    lines: activeLines,
  });
}

export async function reverseJournalEntriesForSource(
  tx: DbOrTx,
  sourceType: string,
  sourceId: string,
  actorId: string,
  reason: string,
  companyId?: string
) {
  const conds: SQL[] = [
    eq(journalEntries.sourceType, sourceType),
    eq(journalEntries.sourceId, sourceId),
    eq(journalEntries.status, "posted"),
  ];
  if (companyId) {
    conds.push(eq(journalEntries.companyId, companyId));
  }

  const existing = await tx
    .select()
    .from(journalEntries)
    .where(and(...conds));

  const reversals = [];
  for (const je of existing) {
    reversals.push(await reverseSingleJournalEntry(tx, je.id, actorId, reason, companyId ?? je.companyId));
  }
  return reversals;
}

export async function reverseSingleJournalEntry(
  tx: DbOrTx,
  entryId: string,
  actorId: string,
  reason: string,
  companyId?: string
) {
  const whereCond = companyId
    ? and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, companyId))
    : eq(journalEntries.id, entryId);
  const [je] = await tx.select().from(journalEntries).where(whereCond).limit(1);
  if (!je) throw new AppError(404, "Journal entry not found", "NOT_FOUND");
  if (je.status === "reversed") {
    throw new AppError(400, "Journal entry has already been reversed", "ALREADY_REVERSED");
  }

  const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId));
  const rev = await postJournalEntry(tx, {
    companyId: je.companyId,
    entryDate: new Date(),
    branchId: je.branchId,
    sourceType: "reversal",
    sourceId: je.id,
    referenceNumber: je.entryNumber,
    memo: `Reversal of ${je.entryNumber}: ${reason}`,
    createdBy: actorId,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      branchId: l.branchId,
      debit: num(l.creditTx),
      credit: num(l.debitTx),
      currency: l.currency,
      fxRate: num(l.fxRate),
      description: l.description ? `Reversal: ${l.description}` : `Reversal of ${je.entryNumber}`,
    })),
  });

  await tx
    .update(journalEntries)
    .set({ status: "reversed", reversedEntryId: rev.id })
    .where(eq(journalEntries.id, je.id));

  return rev;
}

// ---------------- CRUD & Admin Queries ----------------

function resolveCompanyId(actorOrCompanyId?: RequestActor | string): string {
  if (typeof actorOrCompanyId === "string") {
    return actorOrCompanyId || DEFAULT_COMPANY_ID;
  }
  return actorCompanyId(actorOrCompanyId);
}

export async function listAccounts(db: AppDatabase, actorOrCompanyId?: RequestActor | string) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  await ensureAccountingDefaults(db, companyId);
  return db
    .select()
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.companyId, companyId))
    .orderBy(asc(chartOfAccounts.code));
}

export async function createAccount(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createAccountSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const dup = await tx
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, data.code)))
      .limit(1);
    if (dup.length > 0) throw new AppError(409, `Account code '${data.code}' already exists`, "DUPLICATE_ACCOUNT_CODE");

    if (data.parentId) {
      const [parent] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, data.parentId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!parent) throw new AppError(404, "Parent account not found", "NOT_FOUND");
    }

    const [row] = await tx
      .insert(chartOfAccounts)
      .values({
        companyId,
        code: data.code,
        name: data.name,
        accountType: data.accountType,
        normalBalance: data.normalBalance ?? defaultNormalBalance(data.accountType),
        parentId: data.parentId ?? null,
        description: data.description,
        isSystem: false,
        isActive: data.isActive,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "account.created",
      entityType: "accounting",
      entityId: row.id,
      entityLabel: `${row.code} ${row.name}`,
      ipAddress,
    });
    return row;
  });
}

export async function updateAccount(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: Partial<z.infer<typeof createAccountSchema>>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Account not found", "NOT_FOUND");
    const [row] = await tx
      .update(chartOfAccounts)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(chartOfAccounts.id, id), eq(chartOfAccounts.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "account.updated",
      entityType: "accounting",
      entityId: id,
      entityLabel: `${row.code} ${row.name}`,
      ipAddress,
    });
    return row;
  });
}

export async function listGlMappings(db: AppDatabase, actorOrCompanyId?: RequestActor | string) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  await ensureAccountingDefaults(db, companyId);
  return db
    .select()
    .from(glAccountMappings)
    .where(eq(glAccountMappings.companyId, companyId))
    .orderBy(asc(glAccountMappings.mappingKey));
}

export async function updateGlMapping(
  db: AppDatabase,
  actor: RequestActor,
  mappingKey: GlMappingKey,
  accountId: string,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [acct] = await tx
      .select()
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.id, accountId), eq(chartOfAccounts.companyId, companyId)))
      .limit(1);
    if (!acct) throw new AppError(404, "Referenced account not found", "NOT_FOUND");

    await tx
      .insert(glAccountMappings)
      .values({ companyId, mappingKey, accountId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [glAccountMappings.companyId, glAccountMappings.mappingKey],
        set: { accountId, updatedAt: new Date() },
      });

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "gl_mapping.updated",
      entityType: "accounting",
      entityId: mappingKey,
      entityLabel: `${mappingKey} -> ${acct.code} ${acct.name}`,
      ipAddress,
    });
    return { mappingKey, accountId };
  });
}

export async function listJournalEntries(
  db: AppDatabase,
  actor: RequestActor,
  filters: {
    branchId?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
    q?: string;
    status?: string;
    page?: string;
    pageSize?: string;
  }
) {
  const companyId = actorCompanyId(actor);
  const page = Math.max(1, Number.parseInt(filters.page ?? "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(filters.pageSize ?? "50", 10) || 50));

  const conditions: SQL[] = [eq(journalEntries.companyId, companyId)];
  if (filters.branchId) {
    conditions.push(eq(journalEntries.branchId, filters.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length === 0) {
      return { items: [], pageInfo: buildOffsetPageInfo(page, pageSize, 0) satisfies OffsetPageInfo };
    }
    conditions.push(inArray(journalEntries.branchId, actor.branchIds));
  }
  if (filters.fromDate) conditions.push(gte(journalEntries.entryDate, new Date(filters.fromDate)));
  if (filters.toDate) conditions.push(lte(journalEntries.entryDate, new Date(filters.toDate)));
  if (filters.status && filters.status !== "all") {
    conditions.push(eq(journalEntries.status, filters.status as "posted" | "reversed"));
  }
  const term = (filters.search ?? filters.q)?.trim();
  if (term) {
    const pattern = `%${term}%`;
    conditions.push(
      or(
        ilike(journalEntries.entryNumber, pattern),
        ilike(journalEntries.memo, pattern),
        ilike(journalEntries.referenceNumber, pattern)
      )!
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(whereClause);

  const headers = await db
    .select()
    .from(journalEntries)
    .where(whereClause)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.createdAt), desc(journalEntries.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const pageInfo = buildOffsetPageInfo(page, pageSize, total);
  if (headers.length === 0) return { items: [], pageInfo };

  const lines = await db
    .select()
    .from(journalLines)
    .where(inArray(journalLines.entryId, headers.map((h) => h.id)));
  const linesMap = groupByKey(lines, (l) => l.entryId);

  const items = headers.map((je) => ({
    ...je,
    entryDate: je.entryDate.toISOString(),
    createdAt: je.createdAt.toISOString(),
    lines: (linesMap.get(je.id) ?? []).map((l) => ({
      ...l,
      debitBase: num(l.debitBase),
      creditBase: num(l.creditBase),
      fxRate: num(l.fxRate),
      debitTx: num(l.debitTx),
      creditTx: num(l.creditTx),
    })),
  }));

  return { items, pageInfo };
}

export async function createManualJournal(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createJournalEntrySchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const je = await postJournalEntry(tx, {
      companyId,
      entryDate: data.entryDate ? new Date(data.entryDate) : new Date(),
      branchId: data.branchId ?? null,
      sourceType: "manual",
      referenceNumber: data.referenceNumber,
      memo: data.memo,
      createdBy: actor.id,
      lines: data.lines,
    });

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: je.branchId,
      action: "journal_entry.created",
      entityType: "accounting",
      entityId: je.id,
      entityLabel: je.entryNumber,
      ipAddress,
    });
    return je;
  });
}

export async function listFiscalYearsWithPeriods(
  db: AppDatabase,
  actorOrCompanyId?: RequestActor | string
) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  await ensureAccountingDefaults(db, companyId);
  const years = await db
    .select()
    .from(fiscalYears)
    .where(eq(fiscalYears.companyId, companyId))
    .orderBy(desc(fiscalYears.startDate));
  const periods = await db
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.companyId, companyId))
    .orderBy(asc(fiscalPeriods.periodNumber));
  const pMap = groupByKey(periods, (p) => p.fiscalYearId);

  return years.map((y) => ({
    ...y,
    startDate: y.startDate.toISOString(),
    endDate: y.endDate.toISOString(),
    periods: (pMap.get(y.id) ?? []).map((p) => ({
      ...p,
      startDate: p.startDate.toISOString(),
      endDate: p.endDate.toISOString(),
      lockedAt: p.lockedAt?.toISOString() ?? null,
    })),
  }));
}

export async function createFiscalYear(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createFiscalYearSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  const start = new Date(data.startDate);
  const end = new Date(data.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new AppError(400, "Invalid fiscal year date range", "INVALID_DATES");
  }

  return db.transaction(async (tx) => {
    const dup = await tx
      .select({ id: fiscalYears.id })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.name, data.name)))
      .limit(1);
    if (dup.length > 0) {
      throw new AppError(409, `Fiscal year '${data.name}' already exists`, "DUPLICATE_FISCAL_YEAR");
    }

    const [fy] = await tx
      .insert(fiscalYears)
      .values({ companyId, name: data.name, startDate: start, endDate: end, status: "open" })
      .returning();

    const periods: Array<typeof fiscalPeriods.$inferInsert> = [];
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    let idx = 1;
    while (cursor <= end && idx <= 24) {
      const pStart = idx === 1 ? start : new Date(cursor);
      const nextMonthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59, 999));
      const pEnd = nextMonthEnd > end ? end : nextMonthEnd;
      periods.push({
        companyId,
        fiscalYearId: fy.id,
        periodNumber: idx,
        name: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
        startDate: pStart,
        endDate: pEnd,
        status: "open",
      });
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      idx++;
    }

    if (periods.length > 0) {
      await tx.insert(fiscalPeriods).values(periods);
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "fiscal_year.created",
      entityType: "accounting",
      entityId: fy.id,
      entityLabel: fy.name,
      ipAddress,
    });
    return fy;
  });
}

export async function setFiscalPeriodLock(
  db: AppDatabase,
  actor: RequestActor,
  periodId: string,
  locked: boolean,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Fiscal period not found", "NOT_FOUND");

    const [updated] = await tx
      .update(fiscalPeriods)
      .set({
        status: locked ? "locked" : "open",
        lockedBy: locked ? actor.id : null,
        lockedAt: locked ? new Date() : null,
      })
      .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: locked ? "fiscal_period.locked" : "fiscal_period.unlocked",
      entityType: "accounting",
      entityId: periodId,
      entityLabel: current.name,
      ipAddress,
    });
    return updated;
  });
}

export const sumJournalBalanceSql = sql;
