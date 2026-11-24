import { einvoiceQueueQuerySchema, einvoiceRetrySchema } from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireRole } from "../middleware/auth.ts";
import {
  getEinvoiceQueueSummary,
  getEinvoiceSubmissionDetail,
  listEinvoiceSubmissions,
  processPendingEtaSubmissions,
  retryEinvoiceSubmissions,
} from "../services/einvoicing.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function einvoicingRoutes(app: FastifyInstance): Promise<void> {
  const requireAdminOrManager = requireRole("admin", "manager");

  app.get(
    "/api/einvoicing/submissions",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const query = parseOrThrow(
        einvoiceQueueQuerySchema,
        req.query ?? {},
        "Invalid E-Invoice queue query parameters"
      );
      return listEinvoiceSubmissions(req.authUser!, query, getDb());
    }
  );

  app.get(
    "/api/einvoicing/submissions/summary",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const query = req.query as { branchId?: string; provider?: "eta_egypt" | "zatca_phase2" };
      const summary = await getEinvoiceQueueSummary(req.authUser!, {
        branchId: query.branchId,
        provider: query.provider,
        db: getDb(),
      });
      return { summary, ...summary };
    }
  );

  app.get(
    "/api/einvoicing/submissions/:id",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const { id } = req.params as { id: string };
      const submission = await getEinvoiceSubmissionDetail(req.authUser!, id, getDb());
      return { submission, ...submission };
    }
  );

  app.post(
    "/api/einvoicing/submissions/:id/retry",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const parsed = parseOrThrow(
        einvoiceRetrySchema,
        { ...body, submissionId: id },
        "Invalid E-Invoice retry payload"
      );
      const result = await retryEinvoiceSubmissions(req.authUser!, parsed, getDb());
      eventBroadcaster.broadcast("einvoicing_updated", { submissionId: id }, actorCompanyId(req.authUser!));
      return result;
    }
  );

  app.post(
    "/api/einvoicing/submissions/retry",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const parsed = parseOrThrow(
        einvoiceRetrySchema,
        req.body && typeof req.body === "object" ? req.body : {},
        "Invalid E-Invoice retry payload"
      );
      const result = await retryEinvoiceSubmissions(req.authUser!, parsed, getDb());
      eventBroadcaster.broadcast("einvoicing_updated", { queued: result.queued }, actorCompanyId(req.authUser!));
      return result;
    }
  );

  app.post(
    "/api/einvoicing/submissions/process-now",
    { preHandler: requireAdminOrManager },
    async (req) => {
      const companyId = actorCompanyId(req.authUser!);
      const result = await processPendingEtaSubmissions({ limit: 25, companyId, db: getDb() });
      if (result.processed > 0) {
        eventBroadcaster.broadcast("einvoicing_updated", { processed: result.processed }, companyId);
      }
      return result;
    }
  );
}
