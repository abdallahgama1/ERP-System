import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  createPrintTemplate,
  deletePrintTemplate,
  emailDocument,
  listPrintTemplates,
  updatePrintTemplate,
} from "../services/print-templates.service.ts";

export async function printTemplatesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/print-templates", { preHandler: requireAuth }, async (req) => {
    const query = req.query as { documentType?: string };
    const templates = await listPrintTemplates(getDb(), req.authUser!, query);
    return { templates };
  });

  app.post(
    "/api/print-templates",
    { preHandler: requirePermission("settings", "edit") },
    async (req, reply) => {
      const template = await createPrintTemplate(getDb(), req.authUser!, req.body, req.ip);
      return reply.status(201).send({ template });
    }
  );

  app.put(
    "/api/print-templates/:id",
    { preHandler: requirePermission("settings", "edit") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      const template = await updatePrintTemplate(getDb(), req.authUser!, id, req.body, req.ip);
      return { template };
    }
  );

  app.delete(
    "/api/print-templates/:id",
    { preHandler: requirePermission("settings", "edit") },
    async (req) => {
      const id = (req.params as { id: string }).id;
      await deletePrintTemplate(getDb(), req.authUser!, id, req.ip);
      return { ok: true };
    }
  );

  app.post("/api/documents/:type/:id/email", { preHandler: requireAuth }, async (req) => {
    return emailDocument(getDb(), req.authUser!, req.params, req.body, req.ip);
  });
}
