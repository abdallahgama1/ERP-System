import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { generateResourceExport } from "../services/exports.service.ts";

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/exports/:resource", { preHandler: requireAuth }, async (req, reply) => {
    const result = await generateResourceExport(getDb(), req.authUser!, req.params, req.query);
    reply.header("Content-Type", result.contentType);
    reply.header("Content-Disposition", `attachment; filename="${result.fileName}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(result.payload);
  });
}
