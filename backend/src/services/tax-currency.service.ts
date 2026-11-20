import { asc, desc, eq, ne } from "drizzle-orm";
import type { z } from "zod";
import type {
  createExchangeRateSchema,
  createTaxCodeSchema,
  updateTaxCodeSchema,
  upsertCurrencySchema,
} from "@erp/shared";
import { companySettings, currencies, exchangeRates, taxCodes } from "../../drizzle/schema.ts";
import { ensureSeededDefaults } from "../auth/permissions.ts";
import { AppError, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import type { RequestActor } from "./stock-locks.ts";

export async function listTaxCodes(db: AppDatabase) {
  await ensureSeededDefaults(db);
  const rows = await db.select().from(taxCodes).orderBy(asc(taxCodes.code));
  return rows.map((r) => ({ ...r, rate: num(r.rate) }));
}

export async function createTaxCode(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createTaxCodeSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const dup = await tx.select({ id: taxCodes.id }).from(taxCodes).where(eq(taxCodes.code, data.code)).limit(1);
    if (dup.length > 0) throw new AppError(409, `Tax code '${data.code}' already exists`, "DUPLICATE_TAX_CODE");

    if (data.isDefault) {
      await tx.update(taxCodes).set({ isDefault: false });
    }

    const [row] = await tx
      .insert(taxCodes)
      .values({
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
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(taxCodes).where(eq(taxCodes.id, id)).limit(1);
    if (!current) throw new AppError(404, "Tax code not found", "NOT_FOUND");
    if (data.isDefault) {
      await tx.update(taxCodes).set({ isDefault: false }).where(ne(taxCodes.id, id));
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
      .where(eq(taxCodes.id, id))
      .returning();

    await writeAuditLog(tx, {
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
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(taxCodes).where(eq(taxCodes.id, id)).limit(1);
    if (!current) throw new AppError(404, "Tax code not found", "NOT_FOUND");
    if (current.isDefault) throw new AppError(400, "Cannot delete default tax code", "DEFAULT_TAX_CODE");

    await tx.delete(taxCodes).where(eq(taxCodes.id, id));
    await writeAuditLog(tx, {
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

export async function listCurrencies(db: AppDatabase) {
  await ensureSeededDefaults(db);
  return db.select().from(currencies).orderBy(asc(currencies.code));
}

export async function upsertCurrency(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof upsertCurrencySchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    if (data.isBase) {
      await tx.update(currencies).set({ isBase: false });
      await tx.update(companySettings).set({ baseCurrency: data.code, updatedAt: new Date() }).where(eq(companySettings.id, 1));
    }

    const [row] = await tx
      .insert(currencies)
      .values({
        code: data.code,
        name: data.name,
        symbol: data.symbol,
        decimals: data.decimals,
        isBase: data.isBase,
        isActive: data.isActive,
      })
      .onConflictDoUpdate({
        target: currencies.code,
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

export async function listExchangeRates(db: AppDatabase) {
  const rows = await db.select().from(exchangeRates).orderBy(desc(exchangeRates.effectiveAt)).limit(200);
  return rows.map((r) => ({ ...r, rate: num(r.rate), effectiveAt: r.effectiveAt.toISOString() }));
}

export async function createExchangeRate(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createExchangeRateSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(exchangeRates)
      .values({
        fromCurrency: data.fromCurrency,
        toCurrency: data.toCurrency,
        rate: toNumeric(data.rate, 6),
        effectiveAt: data.effectiveAt ? new Date(data.effectiveAt) : new Date(),
        createdBy: actor.id,
      })
      .returning();

    await writeAuditLog(tx, {
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
