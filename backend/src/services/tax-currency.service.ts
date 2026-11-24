import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import type {
  createExchangeRateSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  upsertCurrencySchema,
} from "@erp/shared";
import {
  DEFAULT_COMPANY_ID,
  chartOfAccounts,
  companies,
  companySettings,
  currencies,
  exchangeRates,
  taxCodes,
} from "../../drizzle/schema.ts";
import { ensureSeededDefaults } from "../auth/permissions.ts";
import { AppError, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

function resolveCompanyId(actorOrCompanyId?: RequestActor | string): string {
  if (typeof actorOrCompanyId === "string") {
    return actorOrCompanyId || DEFAULT_COMPANY_ID;
  }
  return actorCompanyId(actorOrCompanyId);
}

export async function listTaxCodes(db: AppDatabase, actorOrCompanyId?: RequestActor | string) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  if (companyId === DEFAULT_COMPANY_ID) {
    await ensureSeededDefaults(db);
  }
  const rows = await db
    .select()
    .from(taxCodes)
    .where(eq(taxCodes.companyId, companyId))
    .orderBy(asc(taxCodes.code));
  return rows.map((r) => ({ ...r, rate: num(r.rate) }));
}

export async function createTaxCode(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createTaxCodeSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const dup = await tx
      .select({ id: taxCodes.id })
      .from(taxCodes)
      .where(and(eq(taxCodes.companyId, companyId), eq(taxCodes.code, data.code)))
      .limit(1);
    if (dup.length > 0) throw new AppError(409, `Tax code '${data.code}' already exists`, "DUPLICATE_TAX_CODE");

    if (data.inputAccountId) {
      const [acct] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, data.inputAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) throw new AppError(404, "Input tax account not found", "NOT_FOUND");
    }
    if (data.outputAccountId) {
      const [acct] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, data.outputAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) throw new AppError(404, "Output tax account not found", "NOT_FOUND");
    }

    if (data.isDefault) {
      await tx.update(taxCodes).set({ isDefault: false }).where(eq(taxCodes.companyId, companyId));
    }

    const [row] = await tx
      .insert(taxCodes)
      .values({
        companyId,
        code: data.code,
        name: data.name,
        rate: toNumeric(data.rate, 4),
        isDefault: data.isDefault,
        isInclusive: data.isInclusive,
        isActive: data.isActive,
        inputAccountId: data.inputAccountId ?? null,
        outputAccountId: data.outputAccountId ?? null,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "tax_code.created",
      entityType: "settings",
      entityId: row.id,
      entityLabel: `${row.code} (${data.rate}%)`,
      ipAddress,
    });
    return { ...row, rate: num(row.rate) };
  });
}

export async function updateTaxCode(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updateTaxCodeSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(taxCodes)
      .where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Tax code not found", "NOT_FOUND");

    if (data.code !== undefined && data.code !== current.code) {
      const dup = await tx
        .select({ id: taxCodes.id })
        .from(taxCodes)
        .where(and(eq(taxCodes.companyId, companyId), eq(taxCodes.code, data.code), ne(taxCodes.id, id)))
        .limit(1);
      if (dup.length > 0) throw new AppError(409, `Tax code '${data.code}' already exists`, "DUPLICATE_TAX_CODE");
    }

    if (data.inputAccountId) {
      const [acct] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, data.inputAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) throw new AppError(404, "Input tax account not found", "NOT_FOUND");
    }
    if (data.outputAccountId) {
      const [acct] = await tx
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.id, data.outputAccountId), eq(chartOfAccounts.companyId, companyId)))
        .limit(1);
      if (!acct) throw new AppError(404, "Output tax account not found", "NOT_FOUND");
    }

    if (data.isDefault) {
      await tx
        .update(taxCodes)
        .set({ isDefault: false })
        .where(and(eq(taxCodes.companyId, companyId), ne(taxCodes.id, id)));
    }

    const [row] = await tx
      .update(taxCodes)
      .set({
        ...(data.code !== undefined ? { code: data.code } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.rate !== undefined ? { rate: toNumeric(data.rate, 4) } : {}),
        ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
        ...(data.isInclusive !== undefined ? { isInclusive: data.isInclusive } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.inputAccountId !== undefined ? { inputAccountId: data.inputAccountId } : {}),
        ...(data.outputAccountId !== undefined ? { outputAccountId: data.outputAccountId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "tax_code.updated",
      entityType: "settings",
      entityId: id,
      entityLabel: row.code,
      ipAddress,
    });
    return { ...row, rate: num(row.rate) };
  });
}

export async function deleteTaxCode(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  const companyId = actorCompanyId(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(taxCodes)
      .where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Tax code not found", "NOT_FOUND");
    if (current.isDefault) throw new AppError(400, "Cannot delete default tax code", "DEFAULT_TAX_CODE");

    await tx.delete(taxCodes).where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)));
    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "tax_code.deleted",
      entityType: "settings",
      entityId: id,
      entityLabel: current.code,
      ipAddress,
    });
  });
}

export async function listCurrencies(db: AppDatabase, actorOrCompanyId?: RequestActor | string) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  if (companyId === DEFAULT_COMPANY_ID) {
    await ensureSeededDefaults(db);
  }
  return db
    .select()
    .from(currencies)
    .where(eq(currencies.companyId, companyId))
    .orderBy(asc(currencies.code));
}

export async function upsertCurrency(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof upsertCurrencySchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    if (data.isBase) {
      await tx.update(currencies).set({ isBase: false }).where(eq(currencies.companyId, companyId));
      await tx
        .update(companies)
        .set({ baseCurrency: data.code, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
      if (companyId === DEFAULT_COMPANY_ID) {
        await tx
          .update(companySettings)
          .set({ baseCurrency: data.code, updatedAt: new Date() })
          .where(eq(companySettings.id, 1));
      }
    }

    const [row] = await tx
      .insert(currencies)
      .values({
        companyId,
        code: data.code,
        name: data.name,
        symbol: data.symbol,
        decimals: data.decimals,
        isBase: data.isBase,
        isActive: data.isActive,
      })
      .onConflictDoUpdate({
        target: [currencies.companyId, currencies.code],
        set: {
          name: data.name,
          symbol: data.symbol,
          decimals: data.decimals,
          isBase: data.isBase,
          isActive: data.isActive,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "currency.upserted",
      entityType: "settings",
      entityId: row.code,
      entityLabel: `${row.code} (${row.symbol})`,
      ipAddress,
    });
    return row;
  });
}

export async function listExchangeRates(db: AppDatabase, actorOrCompanyId?: RequestActor | string) {
  const companyId = resolveCompanyId(actorOrCompanyId);
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(eq(exchangeRates.companyId, companyId))
    .orderBy(desc(exchangeRates.effectiveAt))
    .limit(200);
  return rows.map((r) => ({ ...r, rate: num(r.rate), effectiveAt: r.effectiveAt.toISOString() }));
}

export async function createExchangeRate(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createExchangeRateSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(exchangeRates)
      .values({
        companyId,
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        rate: toNumeric(data.rate, 6),
        effectiveAt: data.effectiveAt ? new Date(data.effectiveAt) : new Date(),
        createdBy: actor.id,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "exchange_rate.created",
      entityType: "settings",
      entityId: row.id,
      entityLabel: `${data.fromCurrency}/${data.toCurrency} = ${data.rate}`,
      ipAddress,
    });
    return { ...row, rate: num(row.rate), effectiveAt: row.effectiveAt.toISOString() };
  });
}
