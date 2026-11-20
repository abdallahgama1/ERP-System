import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { checkDatabaseConnection } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth } from "../middleware/auth.ts";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async (_req, reply) => {
    const dbStatus = await checkDatabaseConnection();
    const ok = dbStatus.configured && dbStatus.connected;
    return reply.status(ok ? 200 : 503).send({
      ok,
      service: "erp-api",
      timestamp: new Date().toISOString(),
      database: dbStatus,
    });
  });

  app.get("/api/events", { preHandler: requireAuth }, async (req, reply) => {
    reply.hijack();

    const origin = req.headers.origin;
    if (origin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const cleanup = eventBroadcaster.addClient(randomUUID(), req.authUser!.id, reply.raw);
    req.raw.on("close", cleanup);
  });
}
