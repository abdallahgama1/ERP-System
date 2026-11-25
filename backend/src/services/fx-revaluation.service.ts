import {
  roundCurrency,
  type FxExposureLineDto,
  type FxRevaluationPreviewDto,
  type FxRevaluationResultDto,
  type runFxRevaluationSchema,
} from "@erp/shared";
import { and, desc, eq, lte, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  companies,
  exchangeRates,
  journalEntries,
  journalLines,
  salesInvoices,
  treasuryAccounts,
  vendorBills,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { ensureAccountingDefaults, getGlAccountMap, postJournalEntry, type JournalLineSpec } from "./gl.service.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

async function resolveCompanyBaseCurrency(tx: DbOrTx, companyId: string): Promise<string> {
  const [comp] = await tx
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return (comp?.baseCurrency || "USD").toUpperCase();
}

async function resolveClosingRatesMap(
  tx: DbOrTx,
  companyId: string,
  baseCurrency: string,
  asOf: Date,
  overrides: Array<{ currency: string; closingRate: number }>
): Promise<Map<string, number>> {
  const rateMap = new Map<string, number>();

  const storedRates = await tx
    .select()
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        eq(exchangeRates.toCurrency, baseCurrency),
        lte(exchangeRates.effectiveAt, asOf)
      )
    )
    .orderBy(desc(exchangeRates.effectiveAt));

  for (const r of storedRates) {
    const code = r.fromCurrency.toUpperCase();
    if (!rateMap.has(code)) {
      rateMap.set(code, num(r.rate));
    }
  }

  for (const ov of overrides) {
    rateMap.set(ov.currency.toUpperCase(), ov.closingRate);
  }

  return rateMap;
}

async function computeFxExposures(
  tx: DbOrTx,
  companyId: string,
  asOfDateStr: string,
  overrides: Array<{ currency: string; closingRate: number }>
): Promise<FxRevaluationPreviewDto> {
  await ensureAccountingDefaults(tx, companyId);
  const baseCurrency = await resolveCompanyBaseCurrency(tx, companyId);
  const asOf = new Date(asOfDateStr);
  if (Number.isNaN(asOf.getTime())) {
    throw new AppError(400, "Invalid valuation date", "INVALID_DATE");
  }
  const asOfEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), 23, 59, 59, 999));

  const glMap = await getGlAccountMap(tx, companyId);
  const closingRates = await resolveClosingRatesMap(tx, companyId, baseCurrency, asOfEnd, overrides);
  const lines: FxExposureLineDto[] = [];

  // 1. Open foreign-currency AR invoices
  const openInvoices = await tx
    .select()
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.companyId, companyId),
        ne(salesInvoices.currency, baseCurrency),
        ne(salesInvoices.status, "Cancelled"),
        ne(salesInvoices.status, "Paid"),
        lte(salesInvoices.invoiceDate, asOfEnd)
      )
    );

  for (const inv of openInvoices) {
    const settled =
      num(inv.paidAmount) + num(inv.creditAppliedAmount) + num(inv.retainerAppliedAmount);
    const foreignBalance = roundCurrency(num(inv.totalAmount) - settled, 4);
    if (foreignBalance <= 0.0001) continue;

    const ccy = inv.currency.toUpperCase();
    const bookedRate = num(inv.fxRate);
    const closingRate = closingRates.get(ccy) ?? bookedRate;
    const bookedBaseAmount = roundCurrency(foreignBalance * bookedRate, 4);
    const revaluedBaseAmount = roundCurrency(foreignBalance * closingRate, 4);
    const unrealizedGainLoss = roundCurrency(revaluedBaseAmount - bookedBaseAmount, 4);

    if (Math.abs(unrealizedGainLoss) >= 0.01) {
      lines.push({
        entityType: "sales_invoice",
        entityId: inv.id,
        documentNumber: inv.invoiceNumber,
        currency: ccy,
        foreignBalance,
        bookedRate,
        closingRate,
        bookedBaseAmount,
        revaluedBaseAmount,
        unrealizedGainLoss,
        glAccountId: glMap.accounts_receivable,
      });
    }
  }

  // 2. Open foreign-currency AP vendor bills
  const openBills = await tx
    .select()
    .from(vendorBills)
    .where(
      and(
        eq(vendorBills.companyId, companyId),
        ne(vendorBills.currency, baseCurrency),
        ne(vendorBills.status, "Cancelled"),
        ne(vendorBills.status, "Paid"),
        lte(vendorBills.billDate, asOfEnd)
      )
    );

  for (const bill of openBills) {
    const foreignBalance = roundCurrency(num(bill.totalAmount) - num(bill.paidAmount), 4);
    if (foreignBalance <= 0.0001) continue;

    const ccy = bill.currency.toUpperCase();
    const bookedRate = num(bill.fxRate);
    const closingRate = closingRates.get(ccy) ?? bookedRate;
    const bookedBaseAmount = roundCurrency(foreignBalance * bookedRate, 4);
    const revaluedBaseAmount = roundCurrency(foreignBalance * closingRate, 4);
    // Liability increase (closingRate > bookedRate) is an unrealized FX LOSS (negative)
    const unrealizedGainLoss = roundCurrency(bookedBaseAmount - revaluedBaseAmount, 4);

    if (Math.abs(unrealizedGainLoss) >= 0.01) {
      lines.push({
        entityType: "vendor_bill",
        entityId: bill.id,
        documentNumber: bill.billNumber,
        currency: ccy,
        foreignBalance,
        bookedRate,
        closingRate,
        bookedBaseAmount,
        revaluedBaseAmount,
        unrealizedGainLoss,
        glAccountId: glMap.accounts_payable,
      });
    }
  }

  // 3. Foreign-currency Treasury Accounts
  const fxTreasury = await tx
    .select()
    .from(treasuryAccounts)
    .where(
      and(
        eq(treasuryAccounts.companyId, companyId),
        eq(treasuryAccounts.isActive, true),
        ne(treasuryAccounts.currency, baseCurrency)
      )
    );

  for (const ta of fxTreasury) {
    const ccy = ta.currency.toUpperCase();
    const closingRate = closingRates.get(ccy);
    if (!closingRate) continue;

    const [balRow] = await tx
      .select({
        txNet: sql<string>`coalesce(sum(${journalLines.debitTx} - ${journalLines.creditTx}), 0)`,
        baseNet: sql<string>`coalesce(sum(${journalLines.debitBase} - ${journalLines.creditBase}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.status, "posted"),
          eq(journalLines.accountId, ta.glAccountId),
          lte(journalEntries.entryDate, asOfEnd)
        )
      );

    const foreignBalance = roundCurrency(num(balRow?.txNet ?? 0), 4);
    const bookedBaseAmount = roundCurrency(num(balRow?.baseNet ?? 0), 4);
    if (Math.abs(foreignBalance) <= 0.0001) continue;

    const bookedRate = roundCurrency(bookedBaseAmount / foreignBalance, 6);
    const revaluedBaseAmount = roundCurrency(foreignBalance * closingRate, 4);
    const unrealizedGainLoss = roundCurrency(revaluedBaseAmount - bookedBaseAmount, 4);

    if (Math.abs(unrealizedGainLoss) >= 0.01) {
      lines.push({
        entityType: "treasury_account",
        entityId: ta.id,
        documentNumber: ta.code,
        currency: ccy,
        foreignBalance,
        bookedRate,
        closingRate,
        bookedBaseAmount,
        revaluedBaseAmount,
        unrealizedGainLoss,
        glAccountId: ta.glAccountId,
      });
    }
  }

  const totalUnrealizedGainLoss = roundCurrency(
    lines.reduce((s, l) => s + l.unrealizedGainLoss, 0),
    4
  );

  return {
    asOfDate: asOfEnd.toISOString().slice(0, 10),
    baseCurrency,
    lines,
    totalUnrealizedGainLoss,
  };
}

export async function previewFxRevaluation(
  db: AppDatabase,
  actor: RequestActor,
  asOfDate: string,
  rates: Array<{ currency: string; closingRate: number }> = []
): Promise<FxRevaluationPreviewDto> {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => computeFxExposures(tx, companyId, asOfDate, rates));
}

export async function runFxRevaluation(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof runFxRevaluationSchema>,
  ipAddress?: string
): Promise<FxRevaluationResultDto> {
  const companyId = actorCompanyId(actor);

  return db.transaction(async (tx) => {
    const preview = await computeFxExposures(tx, companyId, data.asOfDate, data.rates ?? []);
    if (preview.lines.length === 0) {
      return {
        ...preview,
        journalEntryId: null,
        entryNumber: null,
        reversalJournalEntryId: null,
        reversalEntryNumber: null,
      };
    }

    const glMap = await getGlAccountMap(tx, companyId);
    const unrealizedAcctId = glMap.unrealized_fx;
    if (!unrealizedAcctId) {
      throw new AppError(500, "Missing GL mapping for unrealized_fx", "MISSING_GL_MAPPING");
    }

    // Group balance-sheet adjustments by glAccountId
    const deltaByAccount = new Map<string, number>();
    for (const item of preview.lines) {
      // Positive unrealizedGainLoss increases Asset (Dr) or decreases Liability (Dr)!
      // Wait: verify AP!
      // For AR / Treasury Asset: gain (+100) => Dr Asset 100 / Cr Unrealized FX 100.
      // For AP Liability: gain (+100, closingRate < bookedRate) => Liability decreases => Dr AP 100 / Cr Unrealized FX 100!
      // Loss (-100) => Cr Asset or Cr AP 100 / Dr Unrealized FX 100!
      // Both Asset and Liability have the EXACT SAME debit/credit sign as unrealizedGainLoss!
      deltaByAccount.set(
        item.glAccountId,
        roundCurrency((deltaByAccount.get(item.glAccountId) ?? 0) + item.unrealizedGainLoss, 4)
      );
    }

    const jeLines: JournalLineSpec[] = [];
    let netPnlImpact = 0;

    for (const [accountId, delta] of deltaByAccount.entries()) {
      if (Math.abs(delta) < 0.01) continue;
      netPnlImpact = roundCurrency(netPnlImpact + delta, 4);
      jeLines.push({
        accountId,
        debit: delta > 0 ? delta : 0,
        credit: delta < 0 ? Math.abs(delta) : 0,
        currency: preview.baseCurrency,
        fxRate: 1,
        description: `Period-end FX revaluation as of ${preview.asOfDate}`,
      });
    }

    if (jeLines.length === 0 || Math.abs(netPnlImpact) < 0.01) {
      return {
        ...preview,
        journalEntryId: null,
        entryNumber: null,
        reversalJournalEntryId: null,
        reversalEntryNumber: null,
      };
    }

    jeLines.push({
      accountId: unrealizedAcctId,
      debit: netPnlImpact < 0 ? Math.abs(netPnlImpact) : 0,
      credit: netPnlImpact > 0 ? netPnlImpact : 0,
      currency: preview.baseCurrency,
      fxRate: 1,
      description: `Unrealized FX ${netPnlImpact > 0 ? "gain" : "loss"} (${preview.asOfDate})`,
    });

    const valuationDate = new Date(`${preview.asOfDate}T23:59:00.000Z`);
    const memo = data.memo || `Period-end FX revaluation (${preview.asOfDate})`;

    const revalJe = await postJournalEntry(tx, {
      companyId,
      entryDate: valuationDate,
      sourceType: "fx_revaluation",
      referenceNumber: `FXREV-${preview.asOfDate}`,
      memo,
      createdBy: actor.id,
      lines: jeLines,
    });

    let reversalJeId: string | null = null;
    let reversalJeNumber: string | null = null;

    if (data.autoReverse !== false) {
      const nextDay = new Date(
        Date.UTC(
          valuationDate.getUTCFullYear(),
          valuationDate.getUTCMonth(),
          valuationDate.getUTCDate() + 1,
          0,
          5,
          0
        )
      );
      const revJe = await postJournalEntry(tx, {
        companyId,
        entryDate: nextDay,
        sourceType: "fx_revaluation_reversal",
        sourceId: revalJe.id,
        referenceNumber: revalJe.entryNumber,
        memo: `Auto-reversal of ${revalJe.entryNumber} (${preview.asOfDate})`,
        createdBy: actor.id,
        lines: jeLines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
          currency: preview.baseCurrency,
          fxRate: 1,
          description: `Auto-reversal: ${l.description ?? ""}`,
        })),
      });
      reversalJeId = revJe.id;
      reversalJeNumber = revJe.entryNumber;
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "accounting.fx_revaluation_posted",
      entityType: "accounting",
      entityId: revalJe.id,
      entityLabel: revalJe.entryNumber,
      after: {
        asOfDate: preview.asOfDate,
        totalUnrealizedGainLoss: preview.totalUnrealizedGainLoss,
        reversalEntryNumber: reversalJeNumber,
      },
      ipAddress,
    });

    return {
      ...preview,
      journalEntryId: revalJe.id,
      entryNumber: revalJe.entryNumber,
      reversalJournalEntryId: reversalJeId,
      reversalEntryNumber: reversalJeNumber,
    };
  });
}
