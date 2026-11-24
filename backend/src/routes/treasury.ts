import {
  createTreasuryAccountSchema,
  createTreasuryTransferSchema,
  importBankStatementCsvSchema,
  reconcileStatementLineSchema,
  updateTreasuryAccountSchema,
} from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requirePermission } from "../middleware/auth.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";
import {
  createTreasuryAccount,
  createTreasuryTransfer,
  getTreasuryReconciliationView,
  importBankStatementCsv,
  listTreasuryAccounts,
  listTreasuryTransfers,
  reconcileStatementLine,
  setStatementLineIgnored,
  unreconcileStatementLine,
  updateTreasuryAccount,
} from "../services/treasury.service.ts";

export async function treasuryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/treasury/accounts", { preHandler: requirePermission("treasury", "view") }, async (req) => {
    const accounts = await listTreasuryAccounts(getDb(), req.authUser!);
    return { accounts };
  });

  app.post(
    "/api/treasury/accounts",
    { preHandler: requirePermission("treasury", "create") },
    async (req, reply) => {
      const data = parseOrThrow(createTreasuryAccountSchema, req.body, "Invalid treasury account payload");
      if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
      const account = await createTreasuryAccount(getDb(), req.authUser!, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("treasury_updated", { accountId: account.id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return reply.status(201).send({ account });
    }
  );

  app.put(
    "/api/treasury/accounts/:id",
    { preHandler: requirePermission("treasury", "edit") },
    async (req) => {
      const { id } = req.params as { id: string };
      const data = parseOrThrow(updateTreasuryAccountSchema, req.body, "Invalid treasury account update");
      if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
      const account = await updateTreasuryAccount(getDb(), req.authUser!, id, data, req.ip);
      eventBroadcaster.broadcast("treasury_updated", { accountId: id }, actorCompanyId(req.authUser!));
      return { account };
    }
  );

  app.get("/api/treasury/transfers", { preHandler: requirePermission("treasury", "view") }, async (req) => {
    const transfers = await listTreasuryTransfers(getDb(), req.authUser!);
    return { transfers };
  });

  app.post(
    "/api/treasury/transfers",
    { preHandler: requirePermission("treasury", "create") },
    async (req, reply) => {
      const data = parseOrThrow(createTreasuryTransferSchema, req.body, "Invalid treasury transfer payload");
      const transfer = await createTreasuryTransfer(getDb(), req.authUser!, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("treasury_updated", { transferId: transfer.id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return reply.status(201).send({ transfer });
    }
  );

  app.get(
    "/api/treasury/accounts/:id/reconciliation",
    { preHandler: requirePermission("treasury", "view") },
    async (req) => {
      const { id } = req.params as { id: string };
      return getTreasuryReconciliationView(getDb(), req.authUser!, id);
    }
  );

  app.post(
    "/api/treasury/accounts/:id/statements/import-csv",
    { preHandler: requirePermission("treasury", "create") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = parseOrThrow(importBankStatementCsvSchema, req.body, "Invalid bank statement CSV payload");
      const result = await importBankStatementCsv(getDb(), req.authUser!, id, data, req.ip);
      eventBroadcaster.broadcast("treasury_updated", { accountId: id }, actorCompanyId(req.authUser!));
      return reply.status(201).send(result);
    }
  );

  app.post(
    "/api/treasury/statement-lines/:lineId/reconcile",
    { preHandler: requirePermission("treasury", "edit") },
    async (req) => {
      const { lineId } = req.params as { lineId: string };
      const data = parseOrThrow(reconcileStatementLineSchema, req.body, "Invalid reconciliation payload");
      const result = await reconcileStatementLine(getDb(), req.authUser!, lineId, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("treasury_updated", { lineId }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return result;
    }
  );

  app.post(
    "/api/treasury/statement-lines/:lineId/unreconcile",
    { preHandler: requirePermission("treasury", "edit") },
    async (req) => {
      const { lineId } = req.params as { lineId: string };
      const result = await unreconcileStatementLine(getDb(), req.authUser!, lineId, req.ip);
      eventBroadcaster.broadcast("treasury_updated", { lineId }, actorCompanyId(req.authUser!));
      return result;
    }
  );

  app.post(
    "/api/treasury/statement-lines/:lineId/ignore",
    { preHandler: requirePermission("treasury", "edit") },
    async (req) => {
      const { lineId } = req.params as { lineId: string };
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as { ignored?: boolean };
      const result = await setStatementLineIgnored(
        getDb(),
        req.authUser!,
        lineId,
        body.ignored !== false,
        req.ip
      );
      eventBroadcaster.broadcast("treasury_updated", { lineId }, actorCompanyId(req.authUser!));
      return result;
    }
  );
}
