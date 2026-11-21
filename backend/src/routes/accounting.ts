import type { FastifyInstance } from "fastify";
import {
  createAccountSchema,
  createExchangeRateSchema,
  createFiscalYearSchema,
  createJournalEntrySchema,
  createTaxCodeSchema,
  updateAccountSchema,
  updateGlMappingSchema,
  updateTaxCodeSchema,
  upsertCurrencySchema,
} from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  getAccountLedger,
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from "../services/accounting-reports.service.ts";
import {
  createAccount,
  createFiscalYear,
  createManualJournal,
  listAccounts,
  listFiscalYearsWithPeriods,
  listGlMappings,
  listJournalEntries,
  reverseSingleJournalEntry,
  setFiscalPeriodLock,
  updateAccount,
  updateGlMapping,
} from "../services/gl.service.ts";
import { normalizeVoidReason } from "../services/query-helpers.ts";
import { parseOrThrow } from "../services/stock-locks.ts";
import {
  createExchangeRate,
  createTaxCode,
  deleteTaxCode,
  listCurrencies,
  listExchangeRates,
  listTaxCodes,
  updateTaxCode,
  upsertCurrency,
} from "../services/tax-currency.service.ts";

export async function accountingRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Chart of Accounts ----------------
  app.get("/api/accounting/accounts", { preHandler: requirePermission("accounting", "view") }, async () => {
    return { accounts: await listAccounts(getDb()) };
  });

  app.post("/api/accounting/accounts", { preHandler: requirePermission("accounting", "create") }, async (req, reply) => {
    const data = parseOrThrow(createAccountSchema, req.body, "Invalid account data");
    const account = await createAccount(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { accountId: account.id });
    return reply.status(201).send({ account });
  });

  app.put("/api/accounting/accounts/:id", { preHandler: requirePermission("accounting", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(updateAccountSchema, req.body, "Invalid account update");
    const account = await updateAccount(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { accountId: id });
    return { account };
  });

  // ---------------- GL Account Mappings ----------------
  app.get("/api/accounting/mappings", { preHandler: requirePermission("accounting", "view") }, async () => {
    return { mappings: await listGlMappings(getDb()) };
  });

  app.put("/api/accounting/mappings", { preHandler: requirePermission("accounting", "edit") }, async (req) => {
    const data = parseOrThrow(updateGlMappingSchema, req.body, "Invalid GL mapping");
    const mapping = await updateGlMapping(getDb(), req.authUser!, data.mappingKey, data.accountId, req.ip);
    eventBroadcaster.broadcast("accounting_updated");
    return { mapping };
  });

  // ---------------- Journal Entries ----------------
  app.get("/api/accounting/journal-entries", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const query = req.query as {
      branchId?: string;
      fromDate?: string;
      toDate?: string;
      search?: string;
      q?: string;
      status?: string;
      page?: string;
      pageSize?: string;
    };
    if (query.branchId) assertBranchAccess(req.authUser!, query.branchId);
    const { items, pageInfo } = await listJournalEntries(getDb(), req.authUser!, query);
    return { entries: items, items, pageInfo };
  });

  app.post("/api/accounting/journal-entries", { preHandler: requirePermission("accounting", "create") }, async (req, reply) => {
    const data = parseOrThrow(createJournalEntrySchema, req.body, "Invalid journal entry");
    if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
    const entry = await createManualJournal(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { entryId: entry.id });
    return reply.status(201).send({ entry });
  });

  app.post(
    "/api/accounting/journal-entries/:id/reverse",
    { preHandler: requirePermission("accounting", "approve") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const actor = req.authUser!;
      const reason = normalizeVoidReason(req.body);
      const db = getDb();
      const reversal = await db.transaction(async (tx) => reverseSingleJournalEntry(tx, id, actor.id, reason));
      eventBroadcaster.broadcast("accounting_updated", { entryId: reversal.id });
      return { reversal };
    }
  );

  // ---------------- Fiscal Years & Periods ----------------
  app.get("/api/accounting/fiscal-years", { preHandler: requirePermission("accounting", "view") }, async () => {
    return { fiscalYears: await listFiscalYearsWithPeriods(getDb()) };
  });

  app.post("/api/accounting/fiscal-years", { preHandler: requirePermission("accounting", "create") }, async (req, reply) => {
    const data = parseOrThrow(createFiscalYearSchema, req.body, "Invalid fiscal year");
    const fiscalYear = await createFiscalYear(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { fiscalYearId: fiscalYear.id });
    return reply.status(201).send({ fiscalYear });
  });

  app.post("/api/accounting/periods/:id/lock", { preHandler: requirePermission("accounting", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const period = await setFiscalPeriodLock(getDb(), req.authUser!, id, true, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { periodId: id });
    return { period };
  });

  app.post("/api/accounting/periods/:id/unlock", { preHandler: requirePermission("accounting", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const period = await setFiscalPeriodLock(getDb(), req.authUser!, id, false, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { periodId: id });
    return { period };
  });

  // ---------------- Financial Statements & Ledger ----------------
  app.get("/api/accounting/reports/trial-balance", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getTrialBalance(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/profit-loss", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getProfitAndLoss(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/balance-sheet", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { asOfDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getBalanceSheet(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/ledger/:accountId", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const accountId = (req.params as { accountId: string }).accountId;
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string; cursor?: string; limit?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    const parsedLimit = q.limit ? Number(q.limit) : undefined;
    return getAccountLedger(getDb(), req.authUser!, accountId, {
      fromDate: q.fromDate,
      toDate: q.toDate,
      branchId: q.branchId,
      cursor: q.cursor,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  });

  // ---------------- Tax Codes ----------------
  app.get("/api/tax-codes", { preHandler: requireAuth }, async () => {
    return { taxCodes: await listTaxCodes(getDb()) };
  });

  app.post("/api/tax-codes", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const data = parseOrThrow(createTaxCodeSchema, req.body, "Invalid tax code");
    const taxCode = await createTaxCode(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: taxCode.id });
    return reply.status(201).send({ taxCode });
  });

  app.put("/api/tax-codes/:id", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(updateTaxCodeSchema, req.body, "Invalid tax code update");
    const taxCode = await updateTaxCode(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: id });
    return { taxCode };
  });

  app.delete("/api/tax-codes/:id", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteTaxCode(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: id });
    return { ok: true };
  });

  // ---------------- Currencies & FX Rates ----------------
  app.get("/api/currencies", { preHandler: requireAuth }, async () => {
    const db = getDb();
    const [currencyList, rates] = await Promise.all([listCurrencies(db), listExchangeRates(db)]);
    return { currencies: currencyList, exchangeRates: rates };
  });

  app.put("/api/currencies", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const data = parseOrThrow(upsertCurrencySchema, req.body, "Invalid currency");
    const currency = await upsertCurrency(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { currency: currency.code });
    return { currency };
  });

  app.post("/api/currencies/rates", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const data = parseOrThrow(createExchangeRateSchema, req.body, "Invalid FX rate");
    const rate = await createExchangeRate(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { rateId: rate.id });
    return reply.status(201).send({ rate });
  });
}
