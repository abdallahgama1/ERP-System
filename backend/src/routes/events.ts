import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config.ts";
import { checkDatabaseConnection } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth } from "../middleware/auth.ts";
import { recordDbError } from "../observability/metrics.ts";

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const allowedOrigins = new Set(
    env.CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  app.get("/api/health/live", async () => ({
    status: "live",
    service: "erp-api",
    timestamp: new Date().toISOString(),
  }));

  const handleReadyHealth = async (_req: FastifyRequest, reply: FastifyReply) => {
    const dbStatus = await checkDatabaseConnection();
    const ok = dbStatus.configured && dbStatus.connected;
    if (!ok) {
      recordDbError("health_ready");
    }
    return reply.status(ok ? 200 : 503).send({
      ok,
      status: ok ? "ready" : "not_ready",
      db: ok ? "ok" : "error",
      service: "erp-api",
      timestamp: new Date().toISOString(),
      database: dbStatus,
    });
  };

  app.get("/api/health/ready", handleReadyHealth);
  app.get("/api/health", handleReadyHealth);

  app.get("/api/events", { preHandler: requireAuth }, async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.status(403).send({
        message: "Origin not allowed for event stream",
        code: "ORIGIN_FORBIDDEN",
      });
    }

    reply.hijack();

    if (origin && allowedOrigins.has(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const cleanup = eventBroadcaster.addClient(
      randomUUID(),
      req.authUser!.id,
      reply.raw,
      req.authUser!.activeCompanyId ?? null
    );
    req.raw.on("close", cleanup);
  });
}
