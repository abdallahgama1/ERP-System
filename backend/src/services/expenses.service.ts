import {
  buildOffsetPageInfo,
  resolveSearchTerm,
  roundCurrency,
  type ExpenseClaimDto,
  type ExpenseClaimLineDto,
  type OffsetPageInfo,
  type createExpenseClaimSchema,
  type expenseClaimsListQuerySchema,
  type payExpenseClaimSchema,
  type reviewExpenseClaimSchema,
} from "@erp/shared";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  branches,
  chartOfAccounts,
  companies,
  costCenters,
  expenseClaimLines,
  expenseClaims,
  taxCodes,
  treasuryAccounts,
  userRoles,
  users,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertCostCenterInCompany } from "./cost-centers.service.ts";
import { ensureAccountingDefaults, getGlAccountMap, postJournalEntry, type JournalLineSpec } from "./gl.service.ts";
import { actorCompanyId, assertBranchInCompany, type RequestActor } from "./stock-locks.ts";

async function hydrateExpenseClaims(
  dbOrTx: DbOrTx,
  companyId: string,
  claimRows: Array<typeof expenseClaims.$inferSelect>
): Promise<ExpenseClaimDto[]> {
  if (claimRows.length === 0) return [];

  const claimIds = claimRows.map((c) => c.id);

  const [branchRows, treasuryRows, lineRows] = await Promise.all([
    dbOrTx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.companyId, companyId)),
    dbOrTx
      .select({ id: treasuryAccounts.id, name: treasuryAccounts.name, code: treasuryAccounts.code })
      .from(treasuryAccounts)
      .where(eq(treasuryAccounts.companyId, companyId)),
    dbOrTx
      .select({
        id: expenseClaimLines.id,
        claimId: expenseClaimLines.claimId,
        expenseAccountId: expenseClaimLines.expenseAccountId,
        expenseAccountCode: chartOfAccounts.code,
        expenseAccountName: chartOfAccounts.name,
        costCenterId: expenseClaimLines.costCenterId,
        costCenterCode: costCenters.code,
        costCenterName: costCenters.name,
        description: expenseClaimLines.description,
        netAmount: expenseClaimLines.netAmount,
        taxCodeId: expenseClaimLines.taxCodeId,
        taxRate: expenseClaimLines.taxRate,
        taxAmount: expenseClaimLines.taxAmount,
        lineTotal: expenseClaimLines.lineTotal,
      })
      .from(expenseClaimLines)
      .innerJoin(chartOfAccounts, eq(chartOfAccounts.id, expenseClaimLines.expenseAccountId))
      .leftJoin(costCenters, eq(costCenters.id, expenseClaimLines.costCenterId))
      .where(inArray(expenseClaimLines.claimId, claimIds))
      .orderBy(asc(expenseClaimLines.id)),
  ]);

  const branchNameMap = new Map(branchRows.map((b) => [b.id, b.name]));
  const treasuryNameMap = new Map(treasuryRows.map((t) => [t.id, `${t.code} — ${t.name}`]));

  const linesByClaim = new Map<string, ExpenseClaimLineDto[]>();
  for (const l of lineRows) {
    const arr = linesByClaim.get(l.claimId) ?? [];
    arr.push({
      id: l.id,
      expenseAccountId: l.expenseAccountId,
      expenseAccountCode: l.expenseAccountCode,
      expenseAccountName: l.expenseAccountName,
      costCenterId: l.costCenterId ?? null,
      costCenterCode: l.costCenterCode ?? null,
      costCenterName: l.costCenterName ?? null,
      description: l.description,
      netAmount: num(l.netAmount),
      taxCodeId: l.taxCodeId ?? null,
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
    });
    linesByClaim.set(l.claimId, arr);
  }

  return claimRows.map((c) => ({
    id: c.id,
    claimNumber: c.claimNumber,
    claimDate: c.claimDate.toISOString(),
    branchId: c.branchId ?? null,
    branchName: c.branchId ? (branchNameMap.get(c.branchId) ?? null) : null,
    submittedBy: c.submittedBy ?? null,
    submittedByName: c.submittedByName,
    payeeName: c.payeeName,
    paymentMode: c.paymentMode,
    treasuryAccountId: c.treasuryAccountId ?? null,
    treasuryAccountName: c.treasuryAccountId ? (treasuryNameMap.get(c.treasuryAccountId) ?? null) : null,
    status: c.status,
    subtotal: num(c.subtotal),
    taxTotal: num(c.taxTotal),
    totalAmount: num(c.totalAmount),
    currency: c.currency,
    reference: c.reference,
    notes: c.notes,
    reviewedBy: c.reviewedBy ?? null,
    reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
    reviewComment: c.reviewComment,
    accrualJournalEntryId: c.accrualJournalEntryId ?? null,
    paymentJournalEntryId: c.paymentJournalEntryId ?? null,
    paidAt: c.paidAt ? c.paidAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    lines: linesByClaim.get(c.id) ?? [],
  }));
}

export async function listExpenseClaims(
  db: AppDatabase,
  actor: RequestActor,
  query: z.infer<typeof expenseClaimsListQuerySchema>
): Promise<{ items: ExpenseClaimDto[]; pageInfo: OffsetPageInfo }> {
  const companyId = actorCompanyId(actor);
  const conds: SQL[] = [eq(expenseClaims.companyId, companyId)];

  if (query.status) {
    conds.push(eq(expenseClaims.status, query.status));
  }
  if (query.paymentMode) {
    conds.push(eq(expenseClaims.paymentMode, query.paymentMode));
  }
  if (query.branchId) {
    conds.push(eq(expenseClaims.branchId, query.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length > 0) {
      conds.push(or(inArray(expenseClaims.branchId, actor.branchIds), eq(expenseClaims.submittedBy, actor.id))!);
    } else {
      conds.push(eq(expenseClaims.submittedBy, actor.id));
    }
  }
  if (query.fromDate) {
    conds.push(gte(expenseClaims.claimDate, new Date(query.fromDate)));
  }
  if (query.toDate) {
    conds.push(lte(expenseClaims.claimDate, new Date(query.toDate)));
  }

  const search = resolveSearchTerm(query);
  if (search) {
    const pattern = `%${search}%`;
    conds.push(
      or(
        ilike(expenseClaims.claimNumber, pattern),
        ilike(expenseClaims.payeeName, pattern),
        ilike(expenseClaims.submittedByName, pattern),
        ilike(expenseClaims.reference, pattern),
        ilike(expenseClaims.notes, pattern)
      )!
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(expenseClaims)
    .where(and(...conds));

  const offset = (query.page - 1) * query.pageSize;
  const rows = await db
    .select()
    .from(expenseClaims)
    .where(and(...conds))
    .orderBy(desc(expenseClaims.claimDate), desc(expenseClaims.createdAt))
    .limit(query.pageSize)
    .offset(offset);

  const items = await hydrateExpenseClaims(db, companyId, rows);
  return {
    items,
    pageInfo: buildOffsetPageInfo(query.page, query.pageSize, count),
  };
}

export async function getExpenseClaimById(
  db: AppDatabase,
  actor: RequestActor,
  id: string
): Promise<ExpenseClaimDto> {
  const companyId = actorCompanyId(actor);
  const [row] = await db
    .select()
    .from(expenseClaims)
    .where(and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new AppError(404, "Expense claim not found", "NOT_FOUND");
  }
  const [hydrated] = await hydrateExpenseClaims(db, companyId, [row]);
  return hydrated!;
}

export async function createExpenseClaim(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createExpenseClaimSchema>,
  ipAddress?: string
): Promise<ExpenseClaimDto> {
  const companyId = actorCompanyId(actor);

  const claimId = await db.transaction(async (tx) => {
    await ensureAccountingDefaults(tx, companyId);

    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }

    const [comp] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const currency = comp?.baseCurrency ?? "USD";

    if (data.treasuryAccountId) {
      const [ta] = await tx
        .select({ id: treasuryAccounts.id, isActive: treasuryAccounts.isActive })
        .from(treasuryAccounts)
        .where(
          and(
            eq(treasuryAccounts.id, data.treasuryAccountId),
            eq(treasuryAccounts.companyId, companyId)
          )
        )
        .limit(1);
      if (!ta || !ta.isActive) {
        throw new AppError(404, "Selected treasury account not found or inactive", "TREASURY_ACCOUNT_NOT_FOUND");
      }
    }

    // Validate expense accounts, tax codes, and cost centers
    let subtotal = 0;
    let taxTotal = 0;
    const preparedLines: Array<{
      expenseAccountId: string;
      costCenterId: string | null;
      description: string;
      netAmount: number;
      taxCodeId: string | null;
      taxRate: number;
      taxAmount: number;
      lineTotal: number;
    }> = [];

    for (const line of data.lines) {
      const [acct] = await tx
        .select({ id: chartOfAccounts.id, accountType: chartOfAccounts.accountType })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, line.expenseAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) {
        throw new AppError(404, "Expense GL account not found", "ACCOUNT_NOT_FOUND");
      }
      if (acct.accountType !== "expense" && acct.accountType !== "asset") {
        throw new AppError(400, "Expense line account must be an Expense or Asset account", "INVALID_EXPENSE_ACCOUNT");
      }

      if (line.costCenterId) {
        await assertCostCenterInCompany(tx, line.costCenterId, companyId);
      }

      let effectiveTaxRate = line.taxRate ?? 0;
      if (line.taxCodeId) {
        const [tc] = await tx
          .select({ rate: taxCodes.rate })
          .from(taxCodes)
          .where(and(eq(taxCodes.id, line.taxCodeId), eq(taxCodes.companyId, companyId)))
          .limit(1);
        if (!tc) {
          throw new AppError(404, "Tax code not found", "TAX_CODE_NOT_FOUND");
        }
        effectiveTaxRate = num(tc.rate);
      }

      const netAmount = roundCurrency(line.netAmount, 4);
      const taxAmount = roundCurrency((netAmount * effectiveTaxRate) / 100, 4);
      const lineTotal = roundCurrency(netAmount + taxAmount, 4);
      subtotal = roundCurrency(subtotal + netAmount, 4);
      taxTotal = roundCurrency(taxTotal + taxAmount, 4);

      preparedLines.push({
        expenseAccountId: line.expenseAccountId,
        costCenterId: line.costCenterId ?? null,
        description: line.description,
        netAmount,
        taxCodeId: line.taxCodeId ?? null,
        taxRate: effectiveTaxRate,
        taxAmount,
        lineTotal,
      });
    }

    const totalAmount = roundCurrency(subtotal + taxTotal, 4);
    const claimNumber = await nextDocNumber(tx, "EXP", "EXP-", undefined, companyId);
    const claimDate = data.claimDate ? new Date(data.claimDate) : new Date();
    const initialStatus = data.submitNow !== false ? "pending_approval" : "draft";

    const [created] = await tx
      .insert(expenseClaims)
      .values({
        companyId,
        claimNumber,
        claimDate,
        branchId: data.branchId ?? null,
        submittedBy: actor.id,
        submittedByName: actor.name,
        payeeName: data.payeeName || actor.name,
        paymentMode: data.paymentMode,
        treasuryAccountId: data.treasuryAccountId ?? null,
        status: initialStatus,
        subtotal: toNumeric(subtotal, 4),
        taxTotal: toNumeric(taxTotal, 4),
        totalAmount: toNumeric(totalAmount, 4),
        currency,
        reference: data.reference ?? "",
        notes: data.notes ?? "",
      })
      .returning();

    await tx.insert(expenseClaimLines).values(
      preparedLines.map((l) => ({
        claimId: created.id,
        expenseAccountId: l.expenseAccountId,
        costCenterId: l.costCenterId,
        description: l.description,
        netAmount: toNumeric(l.netAmount, 4),
        taxCodeId: l.taxCodeId,
        taxRate: toNumeric(l.taxRate, 4),
        taxAmount: toNumeric(l.taxAmount, 4),
        lineTotal: toNumeric(l.lineTotal, 4),
      }))
    );

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: created.branchId ?? null,
      action: "expense_claim.created",
      entityType: "expenses",
      entityId: created.id,
      entityLabel: claimNumber,
      after: {
        claimNumber,
        status: initialStatus,
        paymentMode: created.paymentMode,
        totalAmount,
      },
      ipAddress,
    });

    return created.id;
  });

  return getExpenseClaimById(db, actor, claimId);
}

export async function submitExpenseClaim(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
): Promise<ExpenseClaimDto> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(expenseClaims)
      .where(and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)))
      .limit(1);
    if (!existing) {
      throw new AppError(404, "Expense claim not found", "NOT_FOUND");
    }
    if (existing.status !== "draft") {
      throw new AppError(400, "Only draft expense claims can be submitted", "INVALID_STATUS");
    }

    await tx
      .update(expenseClaims)
      .set({ status: "pending_approval", updatedAt: new Date() })
      .where(eq(expenseClaims.id, id));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: existing.branchId ?? null,
      action: "expense_claim.submitted",
      entityType: "expenses",
      entityId: id,
      entityLabel: existing.claimNumber,
      before: { status: "draft" },
      after: { status: "pending_approval" },
      ipAddress,
    });
  });

  return getExpenseClaimById(db, actor, id);
}

export async function reviewExpenseClaim(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof reviewExpenseClaimSchema>,
  ipAddress?: string
): Promise<ExpenseClaimDto> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM expense_claims WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE
    `);
    if (!locked[0]) {
      throw new AppError(404, "Expense claim not found", "NOT_FOUND");
    }

    const [claim] = await tx
      .select()
      .from(expenseClaims)
      .where(and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)))
      .limit(1);
    if (!claim) {
      throw new AppError(404, "Expense claim not found", "NOT_FOUND");
    }
    if (claim.status !== "pending_approval") {
      throw new AppError(400, "Only pending expense claims can be reviewed", "INVALID_STATUS");
    }

    // Maker-checker guard (allowing single-admin bootstrap when only 1 active admin/manager exists)
    if (claim.submittedBy && claim.submittedBy === actor.id) {
      const [{ approverCount }] = await tx
        .select({ approverCount: sql<number>`count(*)::int` })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .where(and(eq(users.isActive, true), inArray(userRoles.role, ["admin", "manager"])));
      if (approverCount > 1) {
        throw new AppError(
          403,
          "Maker-checker policy: you cannot approve your own expense claim when another approver exists",
          "SELF_APPROVAL_FORBIDDEN"
        );
      }
    }

    const now = new Date();
    if (data.decision === "rejected") {
      await tx
        .update(expenseClaims)
        .set({
          status: "rejected",
          reviewedBy: actor.id,
          reviewedAt: now,
          reviewComment: data.comment ?? "",
          updatedAt: now,
        })
        .where(eq(expenseClaims.id, id));

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        branchId: claim.branchId ?? null,
        action: "expense_claim.rejected",
        entityType: "expenses",
        entityId: id,
        entityLabel: claim.claimNumber,
        before: { status: claim.status },
        after: { status: "rejected", reviewComment: data.comment ?? "" },
        ipAddress,
      });
      return;
    }

    // Approved: build GL debit lines (Expense + Input VAT)
    await ensureAccountingDefaults(tx, companyId);
    const glMap = await getGlAccountMap(tx, companyId);
    const lines = await tx
      .select()
      .from(expenseClaimLines)
      .where(eq(expenseClaimLines.claimId, claim.id))
      .orderBy(asc(expenseClaimLines.id));

    const jeLines: JournalLineSpec[] = [];
    for (const l of lines) {
      jeLines.push({
        accountId: l.expenseAccountId,
        branchId: claim.branchId ?? null,
        costCenterId: l.costCenterId ?? null,
        debit: num(l.netAmount),
        credit: 0,
        currency: claim.currency,
        description: l.description,
      });
    }

    const taxTotal = num(claim.taxTotal);
    if (taxTotal > 0) {
      jeLines.push({
        accountId: glMap.input_vat,
        branchId: claim.branchId ?? null,
        debit: taxTotal,
        credit: 0,
        currency: claim.currency,
        description: `Input VAT on ${claim.claimNumber}`,
      });
    }

    const totalAmount = num(claim.totalAmount);

    if (claim.paymentMode === "direct_treasury" && claim.treasuryAccountId) {
      const [ta] = await tx
        .select()
        .from(treasuryAccounts)
        .where(
          and(
            eq(treasuryAccounts.id, claim.treasuryAccountId),
            eq(treasuryAccounts.companyId, companyId)
          )
        )
        .limit(1);
      if (!ta || !ta.isActive) {
        throw new AppError(400, "Treasury account for direct expense is missing or inactive", "TREASURY_ACCOUNT_NOT_FOUND");
      }

      jeLines.push({
        accountId: ta.glAccountId,
        branchId: claim.branchId ?? ta.branchId ?? null,
        debit: 0,
        credit: totalAmount,
        currency: claim.currency,
        description: `Direct payment via ${ta.code}`,
      });

      const je = await postJournalEntry(tx, {
        companyId,
        entryDate: claim.claimDate,
        branchId: claim.branchId ?? null,
        sourceType: "expense_claim",
        sourceId: claim.id,
        referenceNumber: claim.reference || claim.claimNumber,
        memo: `Operating expense ${claim.claimNumber} (${claim.payeeName || claim.submittedByName})`,
        createdBy: actor.id,
        lines: jeLines,
        allowRoundingPlug: true,
      });

      await tx
        .update(expenseClaims)
        .set({
          status: "paid",
          reviewedBy: actor.id,
          reviewedAt: now,
          reviewComment: data.comment ?? "",
          accrualJournalEntryId: je.id,
          paymentJournalEntryId: je.id,
          paidAt: now,
          updatedAt: now,
        })
        .where(eq(expenseClaims.id, id));
    } else {
      // Employee reimbursement or deferred treasury payment -> post accrual against 2400 Employee Reimbursements Payable
      jeLines.push({
        accountId: glMap.employee_reimbursements,
        branchId: claim.branchId ?? null,
        debit: 0,
        credit: totalAmount,
        currency: claim.currency,
        description: `Expense payable (${claim.payeeName || claim.submittedByName})`,
      });

      const je = await postJournalEntry(tx, {
        companyId,
        entryDate: claim.claimDate,
        branchId: claim.branchId ?? null,
        sourceType: "expense_claim_accrual",
        sourceId: claim.id,
        referenceNumber: claim.reference || claim.claimNumber,
        memo: `Expense claim accrual ${claim.claimNumber} (${claim.payeeName || claim.submittedByName})`,
        createdBy: actor.id,
        lines: jeLines,
        allowRoundingPlug: true,
      });

      await tx
        .update(expenseClaims)
        .set({
          status: "approved",
          reviewedBy: actor.id,
          reviewedAt: now,
          reviewComment: data.comment ?? "",
          accrualJournalEntryId: je.id,
          updatedAt: now,
        })
        .where(eq(expenseClaims.id, id));
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: claim.branchId ?? null,
      action: "expense_claim.approved",
      entityType: "expenses",
      entityId: id,
      entityLabel: claim.claimNumber,
      before: { status: claim.status },
      after: {
        status: claim.paymentMode === "direct_treasury" && claim.treasuryAccountId ? "paid" : "approved",
        totalAmount,
      },
      ipAddress,
    });
  });

  return getExpenseClaimById(db, actor, id);
}

export async function payExpenseClaim(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof payExpenseClaimSchema>,
  ipAddress?: string
): Promise<ExpenseClaimDto> {
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM expense_claims WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE
    `);
    if (!locked[0]) {
      throw new AppError(404, "Expense claim not found", "NOT_FOUND");
    }

    const [claim] = await tx
      .select()
      .from(expenseClaims)
      .where(and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)))
      .limit(1);
    if (!claim) {
      throw new AppError(404, "Expense claim not found", "NOT_FOUND");
    }
    if (claim.status !== "approved") {
      throw new AppError(400, "Only approved unpaid expense claims can be settled", "INVALID_STATUS");
    }

    const [ta] = await tx
      .select()
      .from(treasuryAccounts)
      .where(
        and(eq(treasuryAccounts.id, data.treasuryAccountId), eq(treasuryAccounts.companyId, companyId))
      )
      .limit(1);
    if (!ta || !ta.isActive) {
      throw new AppError(404, "Treasury account not found or inactive", "TREASURY_ACCOUNT_NOT_FOUND");
    }

    const glMap = await getGlAccountMap(tx, companyId);
    const totalAmount = num(claim.totalAmount);
    const payDate = data.paymentDate ? new Date(data.paymentDate) : new Date();

    const je = await postJournalEntry(tx, {
      companyId,
      entryDate: payDate,
      branchId: claim.branchId ?? ta.branchId ?? null,
      sourceType: "expense_claim_payment",
      sourceId: claim.id,
      referenceNumber: data.reference || claim.claimNumber,
      memo: `Settlement of expense claim ${claim.claimNumber} via ${ta.code}`,
      createdBy: actor.id,
      lines: [
        {
          accountId: glMap.employee_reimbursements,
          branchId: claim.branchId ?? null,
          debit: totalAmount,
          credit: 0,
          currency: claim.currency,
          description: `Settle ${claim.claimNumber}`,
        },
        {
          accountId: ta.glAccountId,
          branchId: ta.branchId ?? claim.branchId ?? null,
          debit: 0,
          credit: totalAmount,
          currency: claim.currency,
          description: `Paid via ${ta.code}`,
        },
      ],
    });

    await tx
      .update(expenseClaims)
      .set({
        status: "paid",
        treasuryAccountId: ta.id,
        paymentJournalEntryId: je.id,
        paidAt: payDate,
        updatedAt: new Date(),
      })
      .where(eq(expenseClaims.id, id));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: claim.branchId ?? null,
      action: "expense_claim.paid",
      entityType: "expenses",
      entityId: id,
      entityLabel: claim.claimNumber,
      before: { status: "approved" },
      after: { status: "paid", treasuryAccountId: ta.id, paymentJournalEntryId: je.id },
      ipAddress,
    });
  });

  return getExpenseClaimById(db, actor, id);
}
