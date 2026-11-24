import { createHash } from "node:crypto";
import {
  roundCurrency,
  type BankStatementLineDto,
  type TreasuryAccountDto,
  type TreasuryTransferDto,
  type UnreconciledGlLineDto,
  type createTreasuryAccountSchema,
  type createTreasuryTransferSchema,
  type importBankStatementCsvSchema,
  type reconcileStatementLineSchema,
  type updateTreasuryAccountSchema,
} from "@erp/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  bankStatementLines,
  bankStatements,
  branches,
  chartOfAccounts,
  journalEntries,
  journalLines,
  treasuryAccounts,
  treasuryTransfers,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertCostCenterInCompany } from "./cost-centers.service.ts";
import { ensureAccountingDefaults, getGlAccountMap, postJournalEntry } from "./gl.service.ts";
import { actorCompanyId, assertBranchInCompany, type RequestActor } from "./stock-locks.ts";

export interface ParsedStatementRow {
  lineDate: Date;
  description: string;
  reference: string;
  amount: number;
  runningBalance: number | null;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseAmountCell(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[,$\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? roundCurrency(parsed, 4) : Number.NaN;
}

/**
 * Pure RFC-4180 bank statement CSV parser supporting either:
 *   - `date,description,reference,amount[,balance]`
 *   - `date,description,debit,credit[,reference,balance]` (where credit/deposit is +, debit/withdrawal is -)
 */
export function parseBankStatementCsv(csvText: string): ParsedStatementRow[] {
  const rawLines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 2) {
    throw new AppError(400, "CSV must contain a header row and at least one statement line", "INVALID_CSV");
  }

  const headerCells = splitCsvLine(rawLines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, ""));
  const dateIdx = headerCells.findIndex((h) => ["date", "linedate", "transactiondate", "valuedate", "posteddate"].includes(h));
  const descIdx = headerCells.findIndex((h) => ["description", "memo", "narration", "details", "particulars"].includes(h));
  const refIdx = headerCells.findIndex((h) => ["reference", "ref", "cheque", "checknumber", "txid"].includes(h));
  const amountIdx = headerCells.findIndex((h) => ["amount", "netamount", "signedamount"].includes(h));
  const debitIdx = headerCells.findIndex((h) => ["debit", "withdrawal", "outflow", "moneyout"].includes(h));
  const creditIdx = headerCells.findIndex((h) => ["credit", "deposit", "inflow", "moneyin"].includes(h));
  const balanceIdx = headerCells.findIndex((h) => ["balance", "runningbalance", "closingbalance"].includes(h));

  if (dateIdx === -1) {
    throw new AppError(400, "CSV header must include a 'date' column", "INVALID_CSV");
  }
  if (amountIdx === -1 && (debitIdx === -1 || creditIdx === -1)) {
    throw new AppError(
      400,
      "CSV header must include either an 'amount' column or 'debit' and 'credit' columns",
      "INVALID_CSV"
    );
  }

  const parsedRows: ParsedStatementRow[] = [];

  for (let rowNum = 1; rowNum < rawLines.length; rowNum++) {
    const cells = splitCsvLine(rawLines[rowNum]!);
    if (cells.every((c) => !c)) continue;

    const rawDate = cells[dateIdx] ?? "";
    const dateMs = Date.parse(rawDate);
    if (!Number.isFinite(dateMs)) {
      throw new AppError(400, `Invalid date '${rawDate}' on CSV row ${rowNum + 1}`, "INVALID_CSV");
    }

    let amount: number;
    if (amountIdx !== -1) {
      amount = parseAmountCell(cells[amountIdx]);
    } else {
      const debitVal = cells[debitIdx] ? parseAmountCell(cells[debitIdx]) : 0;
      const creditVal = cells[creditIdx] ? parseAmountCell(cells[creditIdx]) : 0;
      if (Number.isNaN(debitVal) || Number.isNaN(creditVal)) {
        amount = Number.NaN;
      } else {
        amount = roundCurrency(Math.abs(creditVal) - Math.abs(debitVal), 4);
      }
    }

    if (Number.isNaN(amount) || Math.abs(amount) < 0.0001) {
      throw new AppError(400, `Invalid or zero amount on CSV row ${rowNum + 1}`, "INVALID_CSV");
    }

    const rawBal = balanceIdx !== -1 ? cells[balanceIdx] : undefined;
    const balParsed = rawBal ? parseAmountCell(rawBal) : null;

    parsedRows.push({
      lineDate: new Date(dateMs),
      description: descIdx !== -1 ? (cells[descIdx] ?? "").slice(0, 300) : "",
      reference: refIdx !== -1 ? (cells[refIdx] ?? "").slice(0, 120) : "",
      amount,
      runningBalance: balParsed !== null && !Number.isNaN(balParsed) ? balParsed : null,
    });
  }

  if (parsedRows.length === 0) {
    throw new AppError(400, "No valid statement lines found in CSV", "INVALID_CSV");
  }

  return parsedRows;
}

function computeStatementLineFingerprint(row: ParsedStatementRow, occurrenceIndex: number): string {
  const dateIso = row.lineDate.toISOString().slice(0, 10);
  const payload = `${dateIso}|${toNumeric(row.amount, 4)}|${row.reference.trim().toLowerCase()}|${row.description.trim().toLowerCase()}|#${occurrenceIndex}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export async function listTreasuryAccounts(
  db: AppDatabase,
  actor: RequestActor
): Promise<TreasuryAccountDto[]> {
  const companyId = actorCompanyId(actor);
  await ensureAccountingDefaults(db, companyId);

  const accounts = await db
    .select({
      id: treasuryAccounts.id,
      code: treasuryAccounts.code,
      name: treasuryAccounts.name,
      accountType: treasuryAccounts.accountType,
      currency: treasuryAccounts.currency,
      branchId: treasuryAccounts.branchId,
      branchName: branches.name,
      glAccountId: treasuryAccounts.glAccountId,
      glAccountCode: chartOfAccounts.code,
      glAccountName: chartOfAccounts.name,
      bankName: treasuryAccounts.bankName,
      accountNumber: treasuryAccounts.accountNumber,
      iban: treasuryAccounts.iban,
      isActive: treasuryAccounts.isActive,
      createdAt: treasuryAccounts.createdAt,
      updatedAt: treasuryAccounts.updatedAt,
    })
    .from(treasuryAccounts)
    .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, treasuryAccounts.glAccountId))
    .leftJoin(branches, eq(branches.id, treasuryAccounts.branchId))
    .where(eq(treasuryAccounts.companyId, companyId))
    .orderBy(asc(treasuryAccounts.code));

  if (accounts.length === 0) return [];

  const glIds = accounts.map((a) => a.glAccountId);
  const treasuryIds = accounts.map((a) => a.id);

  const [glTotals, stmtStats] = await Promise.all([
    db
      .select({
        accountId: journalLines.accountId,
        debit: sql<string>`coalesce(sum(${journalLines.debitBase}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.creditBase}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.status, "posted"),
          inArray(journalLines.accountId, glIds)
        )
      )
      .groupBy(journalLines.accountId),
    db
      .select({
        treasuryAccountId: bankStatementLines.treasuryAccountId,
        reconciledSum: sql<string>`coalesce(sum(case when ${bankStatementLines.status} = 'reconciled' then ${bankStatementLines.amount} else 0 end), 0)`,
        unmatchedCount: sql<number>`count(*) filter (where ${bankStatementLines.status} = 'unmatched')::int`,
      })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.companyId, companyId),
          inArray(bankStatementLines.treasuryAccountId, treasuryIds)
        )
      )
      .groupBy(bankStatementLines.treasuryAccountId),
  ]);

  const bookMap = new Map<string, number>();
  for (const r of glTotals) {
    bookMap.set(r.accountId, roundCurrency(num(r.debit) - num(r.credit), 4));
  }

  const stmtMap = new Map<string, { reconciledBalance: number; unmatchedCount: number }>();
  for (const r of stmtStats) {
    stmtMap.set(r.treasuryAccountId, {
      reconciledBalance: roundCurrency(num(r.reconciledSum), 4),
      unmatchedCount: Number(r.unmatchedCount) || 0,
    });
  }

  return accounts.map((a) => {
    const st = stmtMap.get(a.id);
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      currency: a.currency,
      branchId: a.branchId ?? null,
      branchName: a.branchName ?? null,
      glAccountId: a.glAccountId,
      glAccountCode: a.glAccountCode,
      glAccountName: a.glAccountName,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      iban: a.iban,
      bookBalance: bookMap.get(a.glAccountId) ?? 0,
      reconciledBalance: st?.reconciledBalance ?? 0,
      unmatchedStatementLines: st?.unmatchedCount ?? 0,
      isActive: a.isActive,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}

export async function createTreasuryAccount(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createTreasuryAccountSchema>,
  ipAddress?: string
): Promise<TreasuryAccountDto> {
  const companyId = actorCompanyId(actor);

  const createdId = await db.transaction(async (tx) => {
    await ensureAccountingDefaults(tx, companyId);

    const [dupCode] = await tx
      .select({ id: treasuryAccounts.id })
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.companyId, companyId), eq(treasuryAccounts.code, data.code)))
      .limit(1);
    if (dupCode) {
      throw new AppError(409, `Treasury account code '${data.code}' already exists`, "DUPLICATE_CODE");
    }

    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }

    let glAccountId = data.glAccountId ?? null;
    if (glAccountId) {
      const [acct] = await tx
        .select()
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, glAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) {
        throw new AppError(404, "Selected GL account not found", "NOT_FOUND");
      }
      if (acct.accountType !== "asset") {
        throw new AppError(400, "Treasury GL sub-account must be an Asset account", "INVALID_GL_ACCOUNT_TYPE");
      }
      const [alreadyBound] = await tx
        .select({ id: treasuryAccounts.id })
        .from(treasuryAccounts)
        .where(and(eq(treasuryAccounts.companyId, companyId), eq(treasuryAccounts.glAccountId, glAccountId)))
        .limit(1);
      if (alreadyBound) {
        throw new AppError(409, "This GL account is already bound to another treasury account", "GL_ACCOUNT_ALREADY_BOUND");
      }
    } else {
      // Auto-create dedicated 1-to-1 child Asset GL account under 1000 Cash & Bank
      const [parentCash] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.companyId, companyId), eq(chartOfAccounts.code, "1000")))
        .limit(1);

      const existingSubCodes = await tx
        .select({ code: chartOfAccounts.code })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.companyId, companyId));
      const usedCodes = new Set(existingSubCodes.map((r) => r.code));
      let nextNum = 1030;
      while (usedCodes.has(String(nextNum))) {
        nextNum += 1;
      }

      const [createdGl] = await tx
        .insert(chartOfAccounts)
        .values({
          companyId,
          code: String(nextNum),
          name: `${data.name} (${data.code})`,
          accountType: "asset",
          normalBalance: "debit",
          parentId: parentCash?.id ?? null,
          description: `1-to-1 sub-ledger account for ${data.accountType} ${data.code}`,
          isSystem: false,
          isActive: true,
        })
        .returning();
      glAccountId = createdGl.id;
    }

    const [created] = await tx
      .insert(treasuryAccounts)
      .values({
        companyId,
        code: data.code,
        name: data.name,
        accountType: data.accountType,
        currency: data.currency ?? "USD",
        branchId: data.branchId ?? null,
        glAccountId,
        bankName: data.bankName ?? "",
        accountNumber: data.accountNumber ?? "",
        iban: data.iban ?? "",
        isActive: data.isActive ?? true,
      })
      .returning();

    if (data.openingBalance && data.openingBalance > 0) {
      const glMap = await getGlAccountMap(tx, companyId);
      const entryDate = data.openingBalanceDate ? new Date(data.openingBalanceDate) : new Date();
      await postJournalEntry(tx, {
        companyId,
        entryDate,
        branchId: data.branchId ?? null,
        sourceType: "treasury_opening",
        sourceId: created.id,
        referenceNumber: created.code,
        memo: `Opening balance for ${created.name} (${created.code})`,
        createdBy: actor.id,
        lines: [
          {
            accountId: glAccountId,
            branchId: data.branchId ?? null,
            debit: data.openingBalance,
            credit: 0,
            currency: created.currency,
            description: "Opening balance",
          },
          {
            accountId: glMap.opening_equity,
            branchId: data.branchId ?? null,
            debit: 0,
            credit: data.openingBalance,
            currency: created.currency,
            description: "Opening balance equity offset",
          },
        ],
      });
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: created.branchId ?? null,
      action: "treasury_account.created",
      entityType: "treasury",
      entityId: created.id,
      entityLabel: `${created.code} — ${created.name}`,
      after: {
        code: created.code,
        name: created.name,
        accountType: created.accountType,
        glAccountId: created.glAccountId,
        openingBalance: data.openingBalance ?? 0,
      },
      ipAddress,
    });

    return created.id;
  });

  const all = await listTreasuryAccounts(db, actor);
  return all.find((a) => a.id === createdId)!;
}

export async function updateTreasuryAccount(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updateTreasuryAccountSchema>,
  ipAddress?: string
): Promise<TreasuryAccountDto> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.id, id), eq(treasuryAccounts.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Treasury account not found", "NOT_FOUND");
    }

    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }

    const [updated] = await tx
      .update(treasuryAccounts)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.branchId !== undefined ? { branchId: data.branchId } : {}),
        ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
        ...(data.accountNumber !== undefined ? { accountNumber: data.accountNumber } : {}),
        ...(data.iban !== undefined ? { iban: data.iban } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(treasuryAccounts.id, id), eq(treasuryAccounts.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: updated.branchId ?? null,
      action: "treasury_account.updated",
      entityType: "treasury",
      entityId: updated.id,
      entityLabel: `${updated.code} — ${updated.name}`,
      before: { name: existing.name, bankName: existing.bankName, isActive: existing.isActive },
      after: { name: updated.name, bankName: updated.bankName, isActive: updated.isActive },
      ipAddress,
    });
  });

  const all = await listTreasuryAccounts(db, actor);
  return all.find((a) => a.id === id)!;
}

export async function listTreasuryTransfers(
  db: AppDatabase,
  actor: RequestActor
): Promise<TreasuryTransferDto[]> {
  const companyId = actorCompanyId(actor);
  const accts = await db
    .select({ id: treasuryAccounts.id, name: treasuryAccounts.name, code: treasuryAccounts.code })
    .from(treasuryAccounts)
    .where(eq(treasuryAccounts.companyId, companyId));
  const nameMap = new Map(accts.map((a) => [a.id, `${a.code} — ${a.name}`]));

  const rows = await db
    .select()
    .from(treasuryTransfers)
    .where(eq(treasuryTransfers.companyId, companyId))
    .orderBy(desc(treasuryTransfers.transferDate), desc(treasuryTransfers.createdAt))
    .limit(200);

  return rows.map((r) => ({
    id: r.id,
    transferNumber: r.transferNumber,
    transferDate: r.transferDate.toISOString(),
    fromTreasuryAccountId: r.fromTreasuryAccountId,
    fromAccountName: nameMap.get(r.fromTreasuryAccountId) ?? r.fromTreasuryAccountId,
    toTreasuryAccountId: r.toTreasuryAccountId,
    toAccountName: nameMap.get(r.toTreasuryAccountId) ?? r.toTreasuryAccountId,
    amount: num(r.amount),
    currency: r.currency,
    reference: r.reference,
    memo: r.memo,
    journalEntryId: r.journalEntryId ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createTreasuryTransfer(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createTreasuryTransferSchema>,
  ipAddress?: string
): Promise<TreasuryTransferDto> {
  const companyId = actorCompanyId(actor);

  const transferId = await db.transaction(async (tx) => {
    const [fromAcct] = await tx
      .select()
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.id, data.fromTreasuryAccountId), eq(treasuryAccounts.companyId, companyId)))
      .limit(1);
    const [toAcct] = await tx
      .select()
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.id, data.toTreasuryAccountId), eq(treasuryAccounts.companyId, companyId)))
      .limit(1);

    if (!fromAcct || !toAcct) {
      throw new AppError(404, "Source or destination treasury account not found", "NOT_FOUND");
    }
    if (!fromAcct.isActive || !toAcct.isActive) {
      throw new AppError(400, "Cannot transfer funds involving an inactive treasury account", "ACCOUNT_INACTIVE");
    }
    if (fromAcct.currency !== toAcct.currency) {
      throw new AppError(
        400,
        `Currency mismatch between ${fromAcct.currency} and ${toAcct.currency}`,
        "CURRENCY_MISMATCH"
      );
    }

    const transferNumber = await nextDocNumber(tx, "TRFT", "TRFT-", undefined, companyId);
    const transferDate = data.transferDate ? new Date(data.transferDate) : new Date();
    const memo = data.memo || `Inter-account transfer ${fromAcct.code} → ${toAcct.code}`;

    const je = await postJournalEntry(tx, {
      companyId,
      entryDate: transferDate,
      branchId: toAcct.branchId ?? fromAcct.branchId ?? null,
      sourceType: "treasury_transfer",
      referenceNumber: data.reference || transferNumber,
      memo,
      createdBy: actor.id,
      lines: [
        {
          accountId: toAcct.glAccountId,
          branchId: toAcct.branchId ?? null,
          debit: data.amount,
          credit: 0,
          currency: toAcct.currency,
          description: `Transfer in from ${fromAcct.code}`,
        },
        {
          accountId: fromAcct.glAccountId,
          branchId: fromAcct.branchId ?? null,
          debit: 0,
          credit: data.amount,
          currency: fromAcct.currency,
          description: `Transfer out to ${toAcct.code}`,
        },
      ],
    });

    const [created] = await tx
      .insert(treasuryTransfers)
      .values({
        companyId,
        transferNumber,
        transferDate,
        fromTreasuryAccountId: fromAcct.id,
        toTreasuryAccountId: toAcct.id,
        amount: toNumeric(data.amount, 4),
        currency: fromAcct.currency,
        reference: data.reference ?? "",
        memo,
        journalEntryId: je.id,
        createdBy: actor.id,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "treasury.transfer_posted",
      entityType: "treasury",
      entityId: created.id,
      entityLabel: transferNumber,
      after: {
        transferNumber,
        from: fromAcct.code,
        to: toAcct.code,
        amount: data.amount,
        journalEntryId: je.id,
      },
      ipAddress,
    });

    return created.id;
  });

  const all = await listTreasuryTransfers(db, actor);
  return all.find((t) => t.id === transferId)!;
}

export async function importBankStatementCsv(
  db: AppDatabase,
  actor: RequestActor,
  treasuryAccountId: string,
  data: z.infer<typeof importBankStatementCsvSchema>,
  ipAddress?: string
): Promise<{
  statementId: string;
  statementNumber: string;
  importedLines: number;
  skippedDuplicates: number;
}> {
  const companyId = actorCompanyId(actor);
  const parsedRows = parseBankStatementCsv(data.csvText);

  return db.transaction(async (tx) => {
    const [acct] = await tx
      .select()
      .from(treasuryAccounts)
      .where(and(eq(treasuryAccounts.id, treasuryAccountId), eq(treasuryAccounts.companyId, companyId)))
      .limit(1);
    if (!acct) {
      throw new AppError(404, "Treasury account not found", "NOT_FOUND");
    }

    const statementNumber = await nextDocNumber(tx, "BST", "BST-", undefined, companyId);
    const sortedDates = parsedRows.map((r) => r.lineDate.getTime()).sort((a, b) => a - b);
    const fromDate = new Date(sortedDates[0]!);
    const toDate = new Date(sortedDates[sortedDates.length - 1]!);

    const [statement] = await tx
      .insert(bankStatements)
      .values({
        companyId,
        treasuryAccountId: acct.id,
        statementNumber,
        fileName: data.fileName || "statement.csv",
        fromDate,
        toDate,
        lineCount: 0,
        importedBy: actor.id,
      })
      .returning();

    const occurrenceCounter = new Map<string, number>();
    let importedLines = 0;
    let skippedDuplicates = 0;

    for (const row of parsedRows) {
      const baseKey = `${row.lineDate.toISOString().slice(0, 10)}|${toNumeric(row.amount, 4)}|${row.reference.trim().toLowerCase()}|${row.description.trim().toLowerCase()}`;
      const occ = (occurrenceCounter.get(baseKey) ?? 0) + 1;
      occurrenceCounter.set(baseKey, occ);
      const fingerprint = computeStatementLineFingerprint(row, occ);

      const inserted = await tx
        .insert(bankStatementLines)
        .values({
          companyId,
          statementId: statement.id,
          treasuryAccountId: acct.id,
          lineDate: row.lineDate,
          description: row.description,
          reference: row.reference,
          amount: toNumeric(row.amount, 4),
          runningBalance: row.runningBalance !== null ? toNumeric(row.runningBalance, 4) : null,
          fingerprint,
          status: "unmatched",
        })
        .onConflictDoNothing({
          target: [bankStatementLines.treasuryAccountId, bankStatementLines.fingerprint],
        })
        .returning({ id: bankStatementLines.id });

      if (inserted.length > 0) {
        importedLines += 1;
      } else {
        skippedDuplicates += 1;
      }
    }

    await tx
      .update(bankStatements)
      .set({ lineCount: importedLines })
      .where(eq(bankStatements.id, statement.id));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: acct.branchId ?? null,
      action: "treasury.statement_imported",
      entityType: "treasury",
      entityId: statement.id,
      entityLabel: `${statementNumber} (${acct.code})`,
      details: {
        fileName: data.fileName,
        importedLines,
        skippedDuplicates,
      },
      ipAddress,
    });

    return {
      statementId: statement.id,
      statementNumber,
      importedLines,
      skippedDuplicates,
    };
  });
}

export async function getTreasuryReconciliationView(
  db: AppDatabase,
  actor: RequestActor,
  treasuryAccountId: string
): Promise<{
  account: TreasuryAccountDto;
  statementLines: BankStatementLineDto[];
  unreconciledGlLines: UnreconciledGlLineDto[];
}> {
  const companyId = actorCompanyId(actor);
  const allAccounts = await listTreasuryAccounts(db, actor);
  const account = allAccounts.find((a) => a.id === treasuryAccountId);
  if (!account) {
    throw new AppError(404, "Treasury account not found", "NOT_FOUND");
  }

  const [stmtRows, glCandidateRows] = await Promise.all([
    db
      .select({
        id: bankStatementLines.id,
        statementId: bankStatementLines.statementId,
        treasuryAccountId: bankStatementLines.treasuryAccountId,
        lineDate: bankStatementLines.lineDate,
        description: bankStatementLines.description,
        reference: bankStatementLines.reference,
        amount: bankStatementLines.amount,
        runningBalance: bankStatementLines.runningBalance,
        status: bankStatementLines.status,
        matchedJournalLineId: bankStatementLines.matchedJournalLineId,
        matchedEntryNumber: journalEntries.entryNumber,
        reconciledAt: bankStatementLines.reconciledAt,
      })
      .from(bankStatementLines)
      .leftJoin(journalLines, eq(journalLines.id, bankStatementLines.matchedJournalLineId))
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(bankStatementLines.companyId, companyId),
          eq(bankStatementLines.treasuryAccountId, treasuryAccountId)
        )
      )
      .orderBy(desc(bankStatementLines.lineDate), asc(bankStatementLines.createdAt))
      .limit(500),
    db
      .select({
        journalLineId: journalLines.id,
        entryId: journalEntries.id,
        entryNumber: journalEntries.entryNumber,
        entryDate: journalEntries.entryDate,
        memo: journalEntries.memo,
        referenceNumber: journalEntries.referenceNumber,
        description: journalLines.description,
        debitBase: journalLines.debitBase,
        creditBase: journalLines.creditBase,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .leftJoin(bankStatementLines, eq(bankStatementLines.matchedJournalLineId, journalLines.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.status, "posted"),
          eq(journalLines.accountId, account.glAccountId),
          isNull(bankStatementLines.id)
        )
      )
      .orderBy(desc(journalEntries.entryDate))
      .limit(500),
  ]);

  const unreconciledGlLines: UnreconciledGlLineDto[] = glCandidateRows.map((g) => {
    const debitBase = num(g.debitBase);
    const creditBase = num(g.creditBase);
    return {
      journalLineId: g.journalLineId,
      entryId: g.entryId,
      entryNumber: g.entryNumber,
      entryDate: g.entryDate.toISOString(),
      memo: g.memo,
      referenceNumber: g.referenceNumber ?? "",
      description: g.description,
      signedAmount: roundCurrency(debitBase - creditBase, 4),
      debitBase,
      creditBase,
    };
  });

  const FIVE_DAYS_MS = 5 * 86_400_000;
  const usedSuggestions = new Set<string>();

  const statementLines: BankStatementLineDto[] = stmtRows.map((s) => {
    const amount = num(s.amount);
    let suggestedJournalLineId: string | null = null;

    if (s.status === "unmatched") {
      const stmtMs = s.lineDate.getTime();
      const candidate = unreconciledGlLines.find(
        (g) =>
          !usedSuggestions.has(g.journalLineId) &&
          Math.abs(g.signedAmount - amount) <= 0.005 &&
          Math.abs(Date.parse(g.entryDate) - stmtMs) <= FIVE_DAYS_MS
      );
      if (candidate) {
        suggestedJournalLineId = candidate.journalLineId;
        usedSuggestions.add(candidate.journalLineId);
      }
    }

    return {
      id: s.id,
      statementId: s.statementId,
      treasuryAccountId: s.treasuryAccountId,
      lineDate: s.lineDate.toISOString(),
      description: s.description,
      reference: s.reference,
      amount,
      runningBalance: s.runningBalance !== null ? num(s.runningBalance) : null,
      status: s.status,
      matchedJournalLineId: s.matchedJournalLineId ?? null,
      matchedEntryNumber: s.matchedEntryNumber ?? null,
      suggestedJournalLineId,
      reconciledAt: s.reconciledAt ? s.reconciledAt.toISOString() : null,
    };
  });

  return {
    account,
    statementLines,
    unreconciledGlLines,
  };
}

export async function reconcileStatementLine(
  db: AppDatabase,
  actor: RequestActor,
  lineId: string,
  data: z.infer<typeof reconcileStatementLineSchema>,
  ipAddress?: string
): Promise<{ reconciled: true; matchedJournalLineId: string }> {
  const companyId = actorCompanyId(actor);

  return db.transaction(async (tx) => {
    const lockedRows = await tx.execute<{
      id: string;
      treasury_account_id: string;
      line_date: Date | string;
      description: string;
      reference: string;
      amount: string;
      status: string;
    }>(sql`
      SELECT id, treasury_account_id, line_date, description, reference, amount, status
      FROM bank_statement_lines
      WHERE id = ${lineId} AND company_id = ${companyId}
      FOR UPDATE
    `);

    const stmtLine = lockedRows[0];
    if (!stmtLine) {
      throw new AppError(404, "Bank statement line not found", "NOT_FOUND");
    }
    if (stmtLine.status === "reconciled") {
      throw new AppError(409, "Statement line is already reconciled", "ALREADY_RECONCILED");
    }

    const [acct] = await tx
      .select()
      .from(treasuryAccounts)
      .where(
        and(
          eq(treasuryAccounts.id, stmtLine.treasury_account_id),
          eq(treasuryAccounts.companyId, companyId)
        )
      )
      .limit(1);
    if (!acct) {
      throw new AppError(404, "Treasury account not found", "NOT_FOUND");
    }

    const stmtAmount = roundCurrency(num(stmtLine.amount), 4);
    let targetJournalLineId: string;

    if (data.journalLineId) {
      const [jl] = await tx
        .select({
          id: journalLines.id,
          accountId: journalLines.accountId,
          debitBase: journalLines.debitBase,
          creditBase: journalLines.creditBase,
          entryStatus: journalEntries.status,
          entryCompanyId: journalEntries.companyId,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(eq(journalLines.id, data.journalLineId))
        .limit(1);

      if (!jl || jl.entryCompanyId !== companyId || jl.entryStatus !== "posted") {
        throw new AppError(404, "Posted journal line not found", "JOURNAL_LINE_NOT_FOUND");
      }
      if (jl.accountId !== acct.glAccountId) {
        throw new AppError(
          400,
          "Journal line does not belong to this treasury account's GL sub-account",
          "GL_ACCOUNT_MISMATCH"
        );
      }

      const jlSigned = roundCurrency(num(jl.debitBase) - num(jl.creditBase), 4);
      if (Math.abs(jlSigned - stmtAmount) > 0.01) {
        throw new AppError(
          400,
          `Statement line amount (${stmtAmount}) does not match GL line signed amount (${jlSigned})`,
          "AMOUNT_MISMATCH"
        );
      }

      const [alreadyMatched] = await tx
        .select({ id: bankStatementLines.id })
        .from(bankStatementLines)
        .where(eq(bankStatementLines.matchedJournalLineId, jl.id))
        .limit(1);
      if (alreadyMatched) {
        throw new AppError(409, "Journal line is already matched to another statement line", "ALREADY_MATCHED");
      }

      targetJournalLineId = jl.id;
    } else {
      const adj = data.createAdjustment!;
      if (adj.counterpartAccountId === acct.glAccountId) {
        throw new AppError(
          400,
          "Counterpart adjustment account cannot be the treasury account itself",
          "INVALID_COUNTERPART_ACCOUNT"
        );
      }
      if (adj.costCenterId) {
        await assertCostCenterInCompany(tx, adj.costCenterId, companyId);
      }

      const absAmt = Math.abs(stmtAmount);
      const isDeposit = stmtAmount > 0;
      const lineDate = new Date(stmtLine.line_date);
      const memo = adj.memo || stmtLine.description || "Bank reconciliation adjustment";

      const je = await postJournalEntry(tx, {
        companyId,
        entryDate: lineDate,
        branchId: acct.branchId ?? null,
        sourceType: "bank_reconciliation",
        sourceId: stmtLine.id,
        referenceNumber: stmtLine.reference || acct.code,
        memo,
        createdBy: actor.id,
        lines: [
          {
            accountId: acct.glAccountId,
            branchId: acct.branchId ?? null,
            debit: isDeposit ? absAmt : 0,
            credit: isDeposit ? 0 : absAmt,
            currency: acct.currency,
            description: memo,
          },
          {
            accountId: adj.counterpartAccountId,
            branchId: acct.branchId ?? null,
            costCenterId: adj.costCenterId ?? null,
            debit: isDeposit ? 0 : absAmt,
            credit: isDeposit ? absAmt : 0,
            currency: acct.currency,
            description: memo,
          },
        ],
      });

      const [treasuryJl] = await tx
        .select({ id: journalLines.id })
        .from(journalLines)
        .where(and(eq(journalLines.entryId, je.id), eq(journalLines.accountId, acct.glAccountId)))
        .limit(1);

      if (!treasuryJl) {
        throw new AppError(500, "Failed to locate created treasury journal line", "INTERNAL_ERROR");
      }
      targetJournalLineId = treasuryJl.id;
    }

    await tx
      .update(bankStatementLines)
      .set({
        status: "reconciled",
        matchedJournalLineId: targetJournalLineId,
        reconciledBy: actor.id,
        reconciledAt: new Date(),
      })
      .where(eq(bankStatementLines.id, stmtLine.id));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: acct.branchId ?? null,
      action: "treasury.statement_line_reconciled",
      entityType: "treasury",
      entityId: stmtLine.id,
      entityLabel: `${acct.code}: ${stmtLine.description || stmtAmount}`,
      after: { status: "reconciled", matchedJournalLineId: targetJournalLineId, amount: stmtAmount },
      ipAddress,
    });

    return { reconciled: true, matchedJournalLineId: targetJournalLineId };
  });
}

export async function unreconcileStatementLine(
  db: AppDatabase,
  actor: RequestActor,
  lineId: string,
  ipAddress?: string
): Promise<{ ok: true }> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Bank statement line not found", "NOT_FOUND");
    }

    await tx
      .update(bankStatementLines)
      .set({
        status: "unmatched",
        matchedJournalLineId: null,
        reconciledBy: null,
        reconciledAt: null,
      })
      .where(eq(bankStatementLines.id, lineId));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "treasury.statement_line_unreconciled",
      entityType: "treasury",
      entityId: lineId,
      before: { status: existing.status, matchedJournalLineId: existing.matchedJournalLineId },
      after: { status: "unmatched", matchedJournalLineId: null },
      ipAddress,
    });
  });

  return { ok: true };
}

export async function setStatementLineIgnored(
  db: AppDatabase,
  actor: RequestActor,
  lineId: string,
  ignored: boolean,
  ipAddress?: string
): Promise<{ ok: true }> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Bank statement line not found", "NOT_FOUND");
    }
    if (existing.status === "reconciled") {
      throw new AppError(409, "Unreconcile the statement line before ignoring it", "ALREADY_RECONCILED");
    }

    const nextStatus = ignored ? "ignored" : "unmatched";
    await tx
      .update(bankStatementLines)
      .set({ status: nextStatus })
      .where(eq(bankStatementLines.id, lineId));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: ignored ? "treasury.statement_line_ignored" : "treasury.statement_line_restored",
      entityType: "treasury",
      entityId: lineId,
      before: { status: existing.status },
      after: { status: nextStatus },
      ipAddress,
    });
  });

  return { ok: true };
}
