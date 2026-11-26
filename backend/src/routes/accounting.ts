import type { FastifyInstance } from "fastify";
import {
  closeFiscalYearSchema,
  createAccountSchema,
  createCostCenterSchema,
  createExchangeRateSchema,
  createFiscalYearSchema,
  createJournalEntrySchema,
  createTaxCodeSchema,
  reopenFiscalYearSchema,
  runFxRevaluationSchema,
  updateAccountSchema,
  updateCostCenterSchema,
  updateGlMappingSchema,
  updateTaxCodeSchema,
  upsertCurrencySchema,
} from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requireAuth, requirePermission, requireRole } from "../middleware/auth.ts";
import {
  getAccountLedger,
  getBalanceSheet,
  getCashFlowStatement,
  getProfitAndLoss,
  getSubledgerReconciliation,
  getTrialBalance,
  getVatReturnSummary,
} from "../services/accounting-reports.service.ts";
import {
  createCostCenter,
  listCostCenters,
  updateCostCenter,
} from "../services/cost-centers.service.ts";
import {
  previewFxRevaluation,
  runFxRevaluation,
} from "../services/fx-revaluation.service.ts";
import {
  closeFiscalYear,
  createAccount,
  createFiscalYear,
  createManualJournal,
  getAccountingSetupHealth,
  listAccounts,
  listFiscalYearsWithPeriods,
  listGlMappings,
  listJournalEntries,
  reopenFiscalYear,
  reverseSingleJournalEntry,
  setFiscalPeriodLock,
  updateAccount,
  updateGlMapping,
} from "../services/gl.service.ts";
import { normalizeVoidReason } from "../services/query-helpers.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";
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
  app.get("/api/accounting/accounts", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    return { accounts: await listAccounts(getDb(), req.authUser!) };
  });

  app.post("/api/accounting/accounts", { preHandler: requirePermission("accounting", "create") }, async (req, reply) => {
    const data = parseOrThrow(createAccountSchema, req.body, "Invalid account data");
    const account = await createAccount(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { accountId: account.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ account });
  });

  app.put("/api/accounting/accounts/:id", { preHandler: requirePermission("accounting", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(updateAccountSchema, req.body, "Invalid account update");
    const account = await updateAccount(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { accountId: id }, actorCompanyId(req.authUser!));
    return { account };
  });

  // ---------------- Cost Centers ----------------
  app.get("/api/accounting/cost-centers", { preHandler: requireAuth }, async (req) => {
    const q = req.query as { activeOnly?: string };
    return {
      costCenters: await listCostCenters(getDb(), req.authUser!, {
        activeOnly: q.activeOnly === "true",
      }),
    };
  });

  app.post(
    "/api/accounting/cost-centers",
    { preHandler: requirePermission("accounting", "create") },
    async (req, reply) => {
      const data = parseOrThrow(createCostCenterSchema, req.body, "Invalid cost center");
      if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
      const costCenter = await createCostCenter(getDb(), req.authUser!, data, req.ip);
      eventBroadcaster.broadcast("accounting_updated", { costCenterId: costCenter.id }, actorCompanyId(req.authUser!));
      return reply.status(201).send({ costCenter });
    }
  );

  app.put(
    "/api/accounting/cost-centers/:id",
    { preHandler: requirePermission("accounting", "edit") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const data = parseOrThrow(updateCostCenterSchema, req.body, "Invalid cost center update");
      if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
      const costCenter = await updateCostCenter(getDb(), req.authUser!, id, data, req.ip);
      eventBroadcaster.broadcast("accounting_updated", { costCenterId: id }, actorCompanyId(req.authUser!));
      return { costCenter };
    }
  );

  // ---------------- GL Account Mappings ----------------
  app.get("/api/accounting/mappings", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    return { mappings: await listGlMappings(getDb(), req.authUser!) };
  });

  app.put("/api/accounting/mappings", { preHandler: requirePermission("accounting", "edit") }, async (req) => {
    const data = parseOrThrow(updateGlMappingSchema, req.body, "Invalid GL mapping");
    const mapping = await updateGlMapping(getDb(), req.authUser!, data.mappingKey, data.accountId, req.ip);
    eventBroadcaster.broadcast("accounting_updated", {}, actorCompanyId(req.authUser!));
    return { mapping };
  });

  app.get("/api/accounting/setup-health", { preHandler: requireRole("admin") }, async (req) => {
    return getAccountingSetupHealth(getDb(), req.authUser!);
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
    eventBroadcaster.broadcast("accounting_updated", { entryId: entry.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ entry });
  });

  app.post(
    "/api/accounting/journal-entries/:id/reverse",
    { preHandler: requirePermission("accounting", "approve") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const actor = req.authUser!;
      const companyId = actorCompanyId(actor);
      const reason = normalizeVoidReason(req.body);
      const db = getDb();
      const reversal = await db.transaction(async (tx) =>
        reverseSingleJournalEntry(tx, id, actor.id, reason, companyId)
      );
      eventBroadcaster.broadcast("accounting_updated", { entryId: reversal.id }, companyId);
      return { reversal };
    }
  );

  // ---------------- Fiscal Years & Periods ----------------
  app.get("/api/accounting/fiscal-years", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    return { fiscalYears: await listFiscalYearsWithPeriods(getDb(), req.authUser!) };
  });

  app.post("/api/accounting/fiscal-years", { preHandler: requirePermission("accounting", "create") }, async (req, reply) => {
    const data = parseOrThrow(createFiscalYearSchema, req.body, "Invalid fiscal year");
    const fiscalYear = await createFiscalYear(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { fiscalYearId: fiscalYear.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ fiscalYear });
  });

  app.post("/api/accounting/periods/:id/lock", { preHandler: requirePermission("accounting", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const period = await setFiscalPeriodLock(getDb(), req.authUser!, id, true, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { periodId: id }, actorCompanyId(req.authUser!));
    return { period };
  });

  app.post("/api/accounting/periods/:id/unlock", { preHandler: requirePermission("accounting", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const period = await setFiscalPeriodLock(getDb(), req.authUser!, id, false, req.ip);
    eventBroadcaster.broadcast("accounting_updated", { periodId: id }, actorCompanyId(req.authUser!));
    return { period };
  });

  app.post(
    "/api/accounting/fiscal-years/:id/close",
    { preHandler: requirePermission("accounting", "approve") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const data = parseOrThrow(closeFiscalYearSchema, req.body ?? {}, "Invalid fiscal year closing payload");
      const result = await closeFiscalYear(getDb(), req.authUser!, id, data, req.ip);
      eventBroadcaster.broadcast("accounting_updated", { fiscalYearId: id }, actorCompanyId(req.authUser!));
      return result;
    }
  );

  app.post(
    "/api/accounting/fiscal-years/:id/reopen",
    { preHandler: requireRole("admin") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const data = parseOrThrow(reopenFiscalYearSchema, req.body ?? {}, "Invalid fiscal year reopen payload");
      const result = await reopenFiscalYear(getDb(), req.authUser!, id, data, req.ip);
      eventBroadcaster.broadcast("accounting_updated", { fiscalYearId: id }, actorCompanyId(req.authUser!));
      return result;
    }
  );

  // ---------------- Period-End FX Revaluation ----------------
  app.get(
    "/api/accounting/fx-revaluation/preview",
    { preHandler: requirePermission("accounting", "view") },
    async (req) => {
      const q = req.query as { asOfDate?: string };
      const asOfDate = q.asOfDate || new Date().toISOString().slice(0, 10);
      return previewFxRevaluation(getDb(), req.authUser!, asOfDate);
    }
  );

  app.post(
    "/api/accounting/fx-revaluation",
    { preHandler: requirePermission("accounting", "approve") },
    async (req, reply) => {
      const data = parseOrThrow(runFxRevaluationSchema, req.body, "Invalid FX revaluation payload");
      const result = await runFxRevaluation(getDb(), req.authUser!, data, req.ip);
      eventBroadcaster.broadcast("accounting_updated", {}, actorCompanyId(req.authUser!));
      return reply.status(201).send(result);
    }
  );

  // ---------------- Financial Statements & Ledger ----------------
  app.get("/api/accounting/reports/trial-balance", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string; costCenterId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    const normalizedCc = q.costCenterId && q.costCenterId !== "all" ? q.costCenterId : undefined;
    return getTrialBalance(getDb(), req.authUser!, { ...q, costCenterId: normalizedCc });
  });

  app.get("/api/accounting/reports/profit-loss", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as {
      fromDate?: string;
      toDate?: string;
      compareFromDate?: string;
      compareToDate?: string;
      branchId?: string;
      costCenterId?: string;
    };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    const normalizedCc = q.costCenterId && q.costCenterId !== "all" ? q.costCenterId : undefined;
    return getProfitAndLoss(getDb(), req.authUser!, { ...q, costCenterId: normalizedCc });
  });

  app.get("/api/accounting/reports/balance-sheet", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { asOfDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getBalanceSheet(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/cash-flow", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getCashFlowStatement(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/vat-return", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getVatReturnSummary(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/reconciliation", { preHandler: requireRole("admin") }, async (req) => {
    const q = req.query as { asOfDate?: string; branchId?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    return getSubledgerReconciliation(getDb(), req.authUser!, q);
  });

  app.get("/api/accounting/reports/ledger/:accountId", { preHandler: requirePermission("accounting", "view") }, async (req) => {
    const accountId = (req.params as { accountId: string }).accountId;
    const q = req.query as { fromDate?: string; toDate?: string; branchId?: string; costCenterId?: string; cursor?: string; limit?: string };
    if (q.branchId) assertBranchAccess(req.authUser!, q.branchId);
    const parsedLimit = q.limit ? Number(q.limit) : undefined;
    const normalizedCc = q.costCenterId && q.costCenterId !== "all" ? q.costCenterId : undefined;
    return getAccountLedger(getDb(), req.authUser!, accountId, {
      fromDate: q.fromDate,
      toDate: q.toDate,
      branchId: q.branchId,
      costCenterId: normalizedCc,
      cursor: q.cursor,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  });

  // ---------------- Tax Codes ----------------
  app.get("/api/tax-codes", { preHandler: requireAuth }, async (req) => {
    return { taxCodes: await listTaxCodes(getDb(), req.authUser!) };
  });

  app.post("/api/tax-codes", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const data = parseOrThrow(createTaxCodeSchema, req.body, "Invalid tax code");
    const taxCode = await createTaxCode(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: taxCode.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ taxCode });
  });

  app.put("/api/tax-codes/:id", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(updateTaxCodeSchema, req.body, "Invalid tax code update");
    const taxCode = await updateTaxCode(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: id }, actorCompanyId(req.authUser!));
    return { taxCode };
  });

  app.delete("/api/tax-codes/:id", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteTaxCode(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("settings_updated", { taxCodeId: id }, actorCompanyId(req.authUser!));
    return { ok: true };
  });

  // ---------------- Currencies & FX Rates ----------------
  app.get("/api/currencies", { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const [currencyList, rates] = await Promise.all([
      listCurrencies(db, req.authUser!),
      listExchangeRates(db, req.authUser!),
    ]);
    return { currencies: currencyList, exchangeRates: rates };
  });

  app.put("/api/currencies", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const data = parseOrThrow(upsertCurrencySchema, req.body, "Invalid currency");
    const currency = await upsertCurrency(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { currency: currency.code }, actorCompanyId(req.authUser!));
    return { currency };
  });

  app.post("/api/currencies/rates", { preHandler: requirePermission("settings", "edit") }, async (req, reply) => {
    const data = parseOrThrow(createExchangeRateSchema, req.body, "Invalid FX rate");
    const rate = await createExchangeRate(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("settings_updated", { rateId: rate.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ rate });
  });
}
