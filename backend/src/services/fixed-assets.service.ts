import {
  roundCurrency,
  type DepreciationRunResultDto,
  type FixedAssetDepreciationEntryDto,
  type FixedAssetDto,
  type createFixedAssetSchema,
  type disposeFixedAssetSchema,
  type runDepreciationSchema,
} from "@erp/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
  branches,
  companies,
  costCenters,
  fixedAssetDepreciationEntries,
  fixedAssets,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertCostCenterInCompany } from "./cost-centers.service.ts";
import { ensureAccountingDefaults, getGlAccountMap, postJournalEntry, type JournalLineSpec } from "./gl.service.ts";
import { actorCompanyId, assertBranchInCompany, type RequestActor } from "./stock-locks.ts";

/**
 * Pure monthly depreciation calculator supporting Straight-Line and Declining-Balance.
 */
export function computeMonthlyDepreciationAmount(params: {
  acquisitionCost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  depreciationMethod: "straight_line" | "declining_balance";
  decliningRatePct: number;
  accumulatedDepreciation: number;
  elapsedMonths: number;
}): number {
  const depreciableBase = roundCurrency(params.acquisitionCost - params.salvageValue, 4);
  const remainingDepreciable = roundCurrency(depreciableBase - params.accumulatedDepreciation, 4);
  if (remainingDepreciable <= 0.0001) return 0;

  const remainingMonths = Math.max(1, params.usefulLifeMonths - params.elapsedMonths);

  let rawMonthly: number;
  if (params.depreciationMethod === "declining_balance") {
    const currentNbv = roundCurrency(params.acquisitionCost - params.accumulatedDepreciation, 4);
    const annualYears = params.usefulLifeMonths / 12;
    const monthlyFactor = (params.decliningRatePct / 100) / Math.max(1 / 12, annualYears) / 12;
    const decliningAmt = roundCurrency(currentNbv * monthlyFactor, 4);
    const straightLineRemaining = roundCurrency(remainingDepreciable / remainingMonths, 4);
    // Switch to straight-line over remaining life once straight-line exceeds declining balance
    rawMonthly = Math.max(decliningAmt, straightLineRemaining);
  } else {
    if (remainingMonths <= 1) {
      rawMonthly = remainingDepreciable;
    } else {
      rawMonthly = roundCurrency(depreciableBase / params.usefulLifeMonths, 4);
    }
  }

  return roundCurrency(Math.min(rawMonthly, remainingDepreciable), 4);
}

async function hydrateFixedAssets(
  dbOrTx: DbOrTx,
  companyId: string,
  rows: Array<typeof fixedAssets.$inferSelect>
): Promise<FixedAssetDto[]> {
  if (rows.length === 0) return [];

  const [branchRows, ccRows] = await Promise.all([
    dbOrTx.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.companyId, companyId)),
    dbOrTx.select({ id: costCenters.id, code: costCenters.code }).from(costCenters).where(eq(costCenters.companyId, companyId)),
  ]);

  const branchMap = new Map(branchRows.map((b) => [b.id, b.name]));
  const ccMap = new Map(ccRows.map((c) => [c.id, c.code]));

  return rows.map((r) => ({
    id: r.id,
    assetCode: r.assetCode,
    name: r.name,
    category: r.category,
    serialNumber: r.serialNumber,
    branchId: r.branchId ?? null,
    branchName: r.branchId ? (branchMap.get(r.branchId) ?? null) : null,
    costCenterId: r.costCenterId ?? null,
    costCenterCode: r.costCenterId ? (ccMap.get(r.costCenterId) ?? null) : null,
    acquisitionDate: r.acquisitionDate.toISOString(),
    inServiceDate: r.inServiceDate.toISOString(),
    acquisitionCost: num(r.acquisitionCost),
    salvageValue: num(r.salvageValue),
    usefulLifeMonths: r.usefulLifeMonths,
    depreciationMethod: r.depreciationMethod,
    decliningRatePct: num(r.decliningRatePct),
    accumulatedDepreciation: num(r.accumulatedDepreciation),
    netBookValue: num(r.netBookValue),
    status: r.status,
    assetAccountId: r.assetAccountId,
    accumDepAccountId: r.accumDepAccountId,
    depExpenseAccountId: r.depExpenseAccountId,
    acquisitionJournalEntryId: r.acquisitionJournalEntryId ?? null,
    disposedAt: r.disposedAt ? r.disposedAt.toISOString() : null,
    disposalProceeds: r.disposalProceeds !== null ? num(r.disposalProceeds) : null,
    disposalJournalEntryId: r.disposalJournalEntryId ?? null,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listFixedAssets(
  db: AppDatabase,
  actor: RequestActor
): Promise<FixedAssetDto[]> {
  const companyId = actorCompanyId(actor);
  const rows = await db
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.companyId, companyId))
    .orderBy(desc(fixedAssets.acquisitionDate), asc(fixedAssets.assetCode));

  const visible =
    actor.role !== "admin" && actor.branchScopeMode === "selected"
      ? rows.filter((r) => !r.branchId || actor.branchIds.includes(r.branchId))
      : rows;

  return hydrateFixedAssets(db, companyId, visible);
}

export async function getFixedAssetSchedule(
  db: AppDatabase,
  actor: RequestActor,
  assetId: string
): Promise<{ asset: FixedAssetDto; entries: FixedAssetDepreciationEntryDto[] }> {
  const companyId = actorCompanyId(actor);
  const [row] = await db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.companyId, companyId)))
    .limit(1);
  if (!row) {
    throw new AppError(404, "Fixed asset not found", "NOT_FOUND");
  }

  const [hydrated] = await hydrateFixedAssets(db, companyId, [row]);
  const depRows = await db
    .select()
    .from(fixedAssetDepreciationEntries)
    .where(eq(fixedAssetDepreciationEntries.assetId, assetId))
    .orderBy(asc(fixedAssetDepreciationEntries.periodKey));

  return {
    asset: hydrated!,
    entries: depRows.map((e) => ({
      id: e.id,
      assetId: e.assetId,
      periodKey: e.periodKey,
      depreciationDate: e.depreciationDate.toISOString(),
      depreciationAmount: num(e.depreciationAmount),
      accumulatedAfter: num(e.accumulatedAfter),
      netBookValueAfter: num(e.netBookValueAfter),
      journalEntryId: e.journalEntryId ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export async function createFixedAsset(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createFixedAssetSchema>,
  ipAddress?: string
): Promise<FixedAssetDto> {
  const companyId = actorCompanyId(actor);

  return db.transaction(async (tx) => {
    await ensureAccountingDefaults(tx, companyId);
    if (data.branchId) {
      await assertBranchInCompany(tx, data.branchId, companyId);
    }
    if (data.costCenterId) {
      await assertCostCenterInCompany(tx, data.costCenterId, companyId);
    }

    const [comp] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const currency = comp?.baseCurrency || "USD";

    const glMap = await getGlAccountMap(tx, companyId);
    const assetAccountId = data.assetAccountId || glMap.fixed_assets_cost;
    const accumDepAccountId = data.accumDepAccountId || glMap.accumulated_depreciation;
    const depExpenseAccountId = data.depExpenseAccountId || glMap.depreciation_expense;
    const fundingAccountId = data.fundingAccountId || glMap.default_cash_bank;

    const acqDate = new Date(data.acquisitionDate);
    const inServiceDate = data.inServiceDate ? new Date(data.inServiceDate) : acqDate;
    if (Number.isNaN(acqDate.getTime()) || Number.isNaN(inServiceDate.getTime())) {
      throw new AppError(400, "Invalid acquisition or in-service date", "INVALID_DATE");
    }

    const assetCode = await nextDocNumber(tx, "FA", "FA-", undefined, companyId);
    const cost = roundCurrency(data.acquisitionCost, 4);
    const salvage = roundCurrency(data.salvageValue ?? 0, 4);

    let acquisitionJeId: string | null = null;
    if (data.postAcquisitionEntry !== false) {
      const acqJe = await postJournalEntry(tx, {
        companyId,
        entryDate: acqDate,
        branchId: data.branchId ?? null,
        sourceType: "fixed_asset_acquisition",
        referenceNumber: assetCode,
        memo: `Fixed asset acquisition ${assetCode} — ${data.name}`,
        createdBy: actor.id,
        lines: [
          {
            accountId: assetAccountId,
            branchId: data.branchId ?? null,
            costCenterId: data.costCenterId ?? null,
            debit: cost,
            credit: 0,
            currency,
            description: `${assetCode} — ${data.name}`,
          },
          {
            accountId: fundingAccountId,
            branchId: data.branchId ?? null,
            debit: 0,
            credit: cost,
            currency,
            description: `Capital expenditure ${assetCode}`,
          },
        ],
      });
      acquisitionJeId = acqJe.id;
    }

    const [created] = await tx
      .insert(fixedAssets)
      .values({
        companyId,
        assetCode,
        name: data.name,
        category: data.category ?? "Equipment",
        serialNumber: data.serialNumber ?? "",
        branchId: data.branchId ?? null,
        costCenterId: data.costCenterId ?? null,
        acquisitionDate: acqDate,
        inServiceDate,
        acquisitionCost: toNumeric(cost, 4),
        salvageValue: toNumeric(salvage, 4),
        usefulLifeMonths: data.usefulLifeMonths,
        depreciationMethod: data.depreciationMethod ?? "straight_line",
        decliningRatePct: toNumeric(data.decliningRatePct ?? 200, 4),
        accumulatedDepreciation: "0.0000",
        netBookValue: toNumeric(cost, 4),
        status: "active",
        assetAccountId,
        accumDepAccountId,
        depExpenseAccountId,
        acquisitionJournalEntryId: acquisitionJeId,
        notes: data.notes ?? "",
        createdBy: actor.id,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId ?? null,
      action: "fixed_asset.created",
      entityType: "fixed_assets",
      entityId: created.id,
      entityLabel: `${assetCode} — ${data.name}`,
      after: { assetCode, name: data.name, acquisitionCost: cost, salvageValue: salvage },
      ipAddress,
    });

    const [dto] = await hydrateFixedAssets(tx, companyId, [created]);
    return dto!;
  });
}

export async function runMonthlyDepreciation(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof runDepreciationSchema>,
  ipAddress?: string
): Promise<DepreciationRunResultDto> {
  const companyId = actorCompanyId(actor);
  const [yearStr, monthStr] = data.periodKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const periodEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const postingDate = data.postingDate ? new Date(data.postingDate) : periodEnd;

  return db.transaction(async (tx) => {
    await ensureAccountingDefaults(tx, companyId);
    const [comp] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const currency = comp?.baseCurrency || "USD";

    const activeAssets = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.companyId, companyId), eq(fixedAssets.status, "active")))
      .orderBy(asc(fixedAssets.assetCode));

    if (activeAssets.length === 0) {
      return {
        periodKey: data.periodKey,
        processedAssets: 0,
        skippedAlreadyPosted: 0,
        totalDepreciationPosted: 0,
        entries: [],
      };
    }

    const existingDep = await tx
      .select({ assetId: fixedAssetDepreciationEntries.assetId, periodKey: fixedAssetDepreciationEntries.periodKey })
      .from(fixedAssetDepreciationEntries)
      .where(inArray(fixedAssetDepreciationEntries.assetId, activeAssets.map((a) => a.id)));

    const postedPeriodsByAsset = new Map<string, Set<string>>();
    for (const row of existingDep) {
      const set = postedPeriodsByAsset.get(row.assetId) ?? new Set<string>();
      set.add(row.periodKey);
      postedPeriodsByAsset.set(row.assetId, set);
    }

    let skippedAlreadyPosted = 0;
    let totalDepreciationPosted = 0;
    const createdEntries: FixedAssetDepreciationEntryDto[] = [];

    for (const asset of activeAssets) {
      if (asset.inServiceDate > periodEnd) {
        continue;
      }

      const postedSet = postedPeriodsByAsset.get(asset.id) ?? new Set<string>();
      if (postedSet.has(data.periodKey)) {
        skippedAlreadyPosted += 1;
        continue;
      }

      const cost = num(asset.acquisitionCost);
      const salvage = num(asset.salvageValue);
      const accumBefore = num(asset.accumulatedDepreciation);
      const depAmount = computeMonthlyDepreciationAmount({
        acquisitionCost: cost,
        salvageValue: salvage,
        usefulLifeMonths: asset.usefulLifeMonths,
        depreciationMethod: asset.depreciationMethod,
        decliningRatePct: num(asset.decliningRatePct),
        accumulatedDepreciation: accumBefore,
        elapsedMonths: postedSet.size,
      });

      if (depAmount <= 0.0001) {
        await tx
          .update(fixedAssets)
          .set({ status: "fully_depreciated", updatedAt: new Date() })
          .where(eq(fixedAssets.id, asset.id));
        continue;
      }

      const je = await postJournalEntry(tx, {
        companyId,
        entryDate: postingDate,
        branchId: asset.branchId ?? null,
        sourceType: "fixed_asset_depreciation",
        sourceId: asset.id,
        referenceNumber: `${asset.assetCode}-${data.periodKey}`,
        memo: `Monthly depreciation ${data.periodKey} — ${asset.assetCode} (${asset.name})`,
        createdBy: actor.id,
        lines: [
          {
            accountId: asset.depExpenseAccountId,
            branchId: asset.branchId ?? null,
            costCenterId: asset.costCenterId ?? null,
            debit: depAmount,
            credit: 0,
            currency,
            description: `Depreciation ${data.periodKey}: ${asset.assetCode}`,
          },
          {
            accountId: asset.accumDepAccountId,
            branchId: asset.branchId ?? null,
            debit: 0,
            credit: depAmount,
            currency,
            description: `Accumulated depreciation ${data.periodKey}: ${asset.assetCode}`,
          },
        ],
      });

      const accumAfter = roundCurrency(accumBefore + depAmount, 4);
      const nbvAfter = roundCurrency(cost - accumAfter, 4);
      const nextStatus = nbvAfter <= salvage + 0.0001 ? "fully_depreciated" : "active";

      const [depEntry] = await tx
        .insert(fixedAssetDepreciationEntries)
        .values({
          companyId,
          assetId: asset.id,
          periodKey: data.periodKey,
          depreciationDate: postingDate,
          depreciationAmount: toNumeric(depAmount, 4),
          accumulatedAfter: toNumeric(accumAfter, 4),
          netBookValueAfter: toNumeric(nbvAfter, 4),
          journalEntryId: je.id,
          createdBy: actor.id,
        })
        .returning();

      await tx
        .update(fixedAssets)
        .set({
          accumulatedDepreciation: toNumeric(accumAfter, 4),
          netBookValue: toNumeric(nbvAfter, 4),
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssets.id, asset.id));

      totalDepreciationPosted = roundCurrency(totalDepreciationPosted + depAmount, 4);
      createdEntries.push({
        id: depEntry.id,
        assetId: asset.id,
        periodKey: data.periodKey,
        depreciationDate: postingDate.toISOString(),
        depreciationAmount: depAmount,
        accumulatedAfter: accumAfter,
        netBookValueAfter: nbvAfter,
        journalEntryId: je.id,
        createdAt: depEntry.createdAt.toISOString(),
      });
    }

    if (createdEntries.length > 0) {
      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "fixed_asset.depreciation_run",
        entityType: "fixed_assets",
        entityId: data.periodKey,
        entityLabel: `Depreciation ${data.periodKey}`,
        after: {
          periodKey: data.periodKey,
          processedAssets: createdEntries.length,
          totalDepreciationPosted,
        },
        ipAddress,
      });
    }

    return {
      periodKey: data.periodKey,
      processedAssets: createdEntries.length,
      skippedAlreadyPosted,
      totalDepreciationPosted,
      entries: createdEntries,
    };
  });
}

export async function disposeFixedAsset(
  db: AppDatabase,
  actor: RequestActor,
  assetId: string,
  data: z.infer<typeof disposeFixedAssetSchema>,
  ipAddress?: string
): Promise<FixedAssetDto> {
  const companyId = actorCompanyId(actor);

  return db.transaction(async (tx) => {
    await ensureAccountingDefaults(tx, companyId);
    const [asset] = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.companyId, companyId)))
      .limit(1);
    if (!asset) {
      throw new AppError(404, "Fixed asset not found", "NOT_FOUND");
    }
    if (asset.status === "disposed") {
      throw new AppError(409, "Fixed asset is already disposed", "ALREADY_DISPOSED");
    }

    const disposalDate = new Date(data.disposalDate);
    if (Number.isNaN(disposalDate.getTime())) {
      throw new AppError(400, "Invalid disposal date", "INVALID_DATE");
    }

    const [comp] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const currency = comp?.baseCurrency || "USD";
    const glMap = await getGlAccountMap(tx, companyId);

    const cost = roundCurrency(num(asset.acquisitionCost), 4);
    const accum = roundCurrency(num(asset.accumulatedDepreciation), 4);
    const nbv = roundCurrency(cost - accum, 4);
    const proceeds = roundCurrency(data.proceedsAmount ?? 0, 4);
    const gainOrLoss = roundCurrency(proceeds - nbv, 4); // +gain, -loss

    const depositAccountId = data.depositAccountId || glMap.default_cash_bank;
    const gainLossAccountId = glMap.asset_disposal_gain_loss;

    const lines: JournalLineSpec[] = [];
    if (proceeds > 0.0001) {
      lines.push({
        accountId: depositAccountId,
        branchId: asset.branchId ?? null,
        debit: proceeds,
        credit: 0,
        currency,
        description: `Disposal proceeds: ${asset.assetCode}`,
      });
    }
    if (accum > 0.0001) {
      lines.push({
        accountId: asset.accumDepAccountId,
        branchId: asset.branchId ?? null,
        debit: accum,
        credit: 0,
        currency,
        description: `Derecognize accumulated depreciation: ${asset.assetCode}`,
      });
    }
    lines.push({
      accountId: asset.assetAccountId,
      branchId: asset.branchId ?? null,
      debit: 0,
      credit: cost,
      currency,
      description: `Derecognize original asset cost: ${asset.assetCode}`,
    });

    if (Math.abs(gainOrLoss) > 0.0001) {
      lines.push({
        accountId: gainLossAccountId,
        branchId: asset.branchId ?? null,
        costCenterId: asset.costCenterId ?? null,
        debit: gainOrLoss < 0 ? Math.abs(gainOrLoss) : 0,
        credit: gainOrLoss > 0 ? gainOrLoss : 0,
        currency,
        description: `${gainOrLoss > 0 ? "Gain" : "Loss"} on disposal: ${asset.assetCode}`,
      });
    }

    const je = await postJournalEntry(tx, {
      companyId,
      entryDate: disposalDate,
      branchId: asset.branchId ?? null,
      sourceType: "fixed_asset_disposal",
      sourceId: asset.id,
      referenceNumber: asset.assetCode,
      memo: `Asset disposal ${asset.assetCode} — ${asset.name}`,
      createdBy: actor.id,
      lines,
    });

    const [updated] = await tx
      .update(fixedAssets)
      .set({
        status: "disposed",
        netBookValue: "0.0000",
        disposedAt: disposalDate,
        disposalProceeds: toNumeric(proceeds, 4),
        disposalJournalEntryId: je.id,
        notes: data.notes ? `${asset.notes ? `${asset.notes}\n` : ""}${data.notes}` : asset.notes,
        updatedAt: new Date(),
      })
      .where(eq(fixedAssets.id, asset.id))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: asset.branchId ?? null,
      action: "fixed_asset.disposed",
      entityType: "fixed_assets",
      entityId: asset.id,
      entityLabel: `${asset.assetCode} — ${asset.name}`,
      after: { status: "disposed", proceeds, gainOrLoss, journalEntryId: je.id },
      ipAddress,
    });

    const [dto] = await hydrateFixedAssets(tx, companyId, [updated]);
    return dto!;
  });
}
