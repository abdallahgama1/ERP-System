import {
  createExpenseClaimSchema,
  expenseClaimsListQuerySchema,
  payExpenseClaimSchema,
  reviewExpenseClaimSchema,
} from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requirePermission } from "../middleware/auth.ts";
import {
  createExpenseClaim,
  getExpenseClaimById,
  listExpenseClaims,
  payExpenseClaim,
  reviewExpenseClaim,
  submitExpenseClaim,
} from "../services/expenses.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function expensesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/expenses", { preHandler: requirePermission("expenses", "view") }, async (req) => {
    const query = parseOrThrow(expenseClaimsListQuerySchema, req.query ?? {}, "Invalid expenses query");
    if (query.branchId) assertBranchAccess(req.authUser!, query.branchId);
    const { items, pageInfo } = await listExpenseClaims(getDb(), req.authUser!, query);
    return { claims: items, items, pageInfo };
  });

  app.get("/api/expenses/:id", { preHandler: requirePermission("expenses", "view") }, async (req) => {
    const { id } = req.params as { id: string };
    const claim = await getExpenseClaimById(getDb(), req.authUser!, id);
    if (claim.branchId) assertBranchAccess(req.authUser!, claim.branchId);
    return { claim };
  });

  app.post("/api/expenses", { preHandler: requirePermission("expenses", "create") }, async (req, reply) => {
    const data = parseOrThrow(createExpenseClaimSchema, req.body, "Invalid expense claim payload");
    if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
    const claim = await createExpenseClaim(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("expenses_updated", { claimId: claim.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ claim });
  });

  app.post(
    "/api/expenses/:id/submit",
    { preHandler: requirePermission("expenses", "create") },
    async (req) => {
      const { id } = req.params as { id: string };
      const claim = await submitExpenseClaim(getDb(), req.authUser!, id, req.ip);
      eventBroadcaster.broadcast("expenses_updated", { claimId: id }, actorCompanyId(req.authUser!));
      return { claim };
    }
  );

  app.post(
    "/api/expenses/:id/review",
    { preHandler: requirePermission("expenses", "approve") },
    async (req) => {
      const { id } = req.params as { id: string };
      const data = parseOrThrow(reviewExpenseClaimSchema, req.body, "Invalid review decision");
      const claim = await reviewExpenseClaim(getDb(), req.authUser!, id, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("expenses_updated", { claimId: id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      eventBroadcaster.broadcast("treasury_updated", {}, companyId);
      return { claim };
    }
  );

  app.post(
    "/api/expenses/:id/pay",
    { preHandler: requirePermission("expenses", "approve") },
    async (req) => {
      const { id } = req.params as { id: string };
      const data = parseOrThrow(payExpenseClaimSchema, req.body, "Invalid expense payment payload");
      const claim = await payExpenseClaim(getDb(), req.authUser!, id, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("expenses_updated", { claimId: id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      eventBroadcaster.broadcast("treasury_updated", {}, companyId);
      return { claim };
    }
  );
}
