import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env, getUptimeStatusConfig } from "../config.ts";
import { checkDatabaseConnection } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth } from "../middleware/auth.ts";
import { isValidBearerToken, isValidConstantTimeToken, recordDbError } from "../observability/metrics.ts";
import { getBackupFreshness } from "../services/backup-freshness.service.ts";
import { checkStorageHealth } from "../services/storage.service.ts";

export async function eventRoutes(
  app: FastifyInstance,
  opts: { enableRateLimit?: boolean } = {}
): Promise<void> {
  const allowedOrigins = new Set(
    env.CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const uptimeCfg = getUptimeStatusConfig();
  const rateLimitActive =
    opts.enableRateLimit ?? (env.NODE_ENV !== "test" && !env.DISABLE_RATE_LIMIT);
  const statusRateLimit = rateLimitActive
    ? {
        config: {
          rateLimit: {
            max: uptimeCfg.rateLimitMax,
            timeWindow: uptimeCfg.rateLimitWindowMs,
          },
        },
      }
    : {};

  app.get("/health", async () => ({
    ok: true,
    status: "ok",
    service: "erp-api",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get("/api/health/live", async () => ({
    status: "live",
    service: "erp-api",
    timestamp: new Date().toISOString(),
  }));

  const handleReadyHealth = async (_req: FastifyRequest, reply: FastifyReply) => {
    const [dbStatus, storageStatus] = await Promise.all([
      checkDatabaseConnection(),
      checkStorageHealth(),
    ]);
    const dbOk = dbStatus.configured && dbStatus.connected;
    const storageOk = storageStatus.ok;
    const ok = dbOk && storageOk;
    if (!dbOk) {
      recordDbError("health_ready");
    }
    return reply.status(ok ? 200 : 503).send({
      ok,
      status: ok ? "ready" : "not_ready",
      db: dbOk ? "ok" : "error",
      storage: storageOk ? "ok" : "error",
      service: "erp-api",
      timestamp: new Date().toISOString(),
      database: dbStatus,
      storageCheck: storageStatus,
    });
  };

  app.get("/ready", handleReadyHealth);
  app.get("/api/health/ready", handleReadyHealth);
  app.get("/api/health", handleReadyHealth);

  /**
   * Token-authenticated read-only status endpoint for external uptime monitors.
   * Returns strictly minimal booleans (no operational data, timestamps, or paths),
   * and returns HTTP 503 if the app is not ready OR the last backup is stale (>26h).
   */
  app.get("/api/status", statusRateLimit, async (req, reply) => {
    const expectedToken = getUptimeStatusConfig().token;
    reply.header("Cache-Control", "no-store");

    if (!expectedToken) {
      return reply.status(404).send({ message: "Not found", code: "NOT_FOUND" });
    }

    const headerToken =
      typeof req.headers["x-status-token"] === "string" ? req.headers["x-status-token"] : undefined;
    const authorized =
      isValidBearerToken(req.headers.authorization, expectedToken) ||
      isValidConstantTimeToken(headerToken, expectedToken);

    if (!authorized) {
      reply.header("WWW-Authenticate", 'Bearer realm="status"');
      return reply.status(401).send({ message: "Unauthorized", code: "UNAUTHORIZED" });
    }

    const [dbStatus, storageStatus, backupStatus] = await Promise.all([
      checkDatabaseConnection(),
      checkStorageHealth(),
      getBackupFreshness().catch(() => ({ ok: false })),
    ]);

    const database = Boolean(dbStatus.configured && dbStatus.connected);
    const storage = Boolean(storageStatus.ok);
    const ready = database && storage;
    const backupFresh = Boolean(backupStatus.ok);

    if (!database) {
      recordDbError("uptime_status");
    }

    const allOk = ready && backupFresh;
    return reply.status(allOk ? 200 : 503).send({
      ready,
      database,
      storage,
      backupFresh,
    });
  });

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
