import { approvalDecisionSchema, upsertApprovalRuleSchema } from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import {
  listApprovalRequests,
  listApprovalRules,
  reviewApprovalRequest,
  upsertApprovalRule,
} from "../services/approvals.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/approvals/rules", { preHandler: requireAuth }, async (req) => {
    const rules = await listApprovalRules(getDb(), req.authUser!);
    return { rules };
  });

  app.put("/api/approvals/rules", { preHandler: requireRole("admin") }, async (req) => {
    const data = parseOrThrow(upsertApprovalRuleSchema, req.body);
    const rule = await upsertApprovalRule(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("approvals_updated", { entity: "approval_rule", id: rule.id }, actorCompanyId(req.authUser!));
    return { rule };
  });

  app.get("/api/approvals/requests", { preHandler: requireAuth }, async (req) => {
    const requests = await listApprovalRequests(getDb(), req.authUser!);
    return { requests };
  });

  app.post("/api/approvals/requests/:id/decision", { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(approvalDecisionSchema, req.body);
    const request = await reviewApprovalRequest(
      getDb(),
      req.authUser!,
      id,
      data.decision,
      data.comment,
      req.ip
    );
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("approvals_updated", { entity: "approval_request", id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { source: "approval" }, companyId);
    eventBroadcaster.broadcast("purchases_updated", { source: "approval" }, companyId);
    eventBroadcaster.broadcast("accounting_updated", { source: "approval" }, companyId);
    eventBroadcaster.broadcast("notifications_updated", { source: "approval" }, companyId);
    return { request };
  });
}
