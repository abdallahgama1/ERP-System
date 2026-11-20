import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { env } from "./config.ts";
import { AppError } from "./db/helpers.ts";
import { attachAuthHook } from "./middleware/auth.ts";
import { accountingRoutes } from "./routes/accounting.ts";
import { adminRoutes } from "./routes/admin.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { auditRoutes } from "./routes/audit.ts";
import { authRoutes } from "./routes/auth.ts";
import { branchRoutes } from "./routes/branches.ts";
import { eventRoutes } from "./routes/events.ts";
import { inventoryRoutes } from "./routes/inventory.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { purchaseRoutes } from "./routes/purchases.ts";
import { salesRoutes } from "./routes/sales.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { taxonomyRoutes } from "./routes/taxonomy.ts";

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Builds and configures the Fastify ERP application instance cleanly without binding a port.
 * Reusable across server runtime and Vitest `app.inject()` integration tests.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: env.NODE_ENV === "production" ? "info" : "warn",
          },
  });

  const allowedOrigins = env.CORS_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.AUTH_COOKIE_SECRET,
  });

  app.addHook("preHandler", attachAuthHook);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        message: err.message,
        code: err.code,
        details: err.details,
      });
    }

    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : "Internal server error";

    if (statusCode >= 500 && options.logger !== false) {
      app.log.error(err);
    }

    return reply.status(statusCode).send({
      message: statusCode >= 500 && env.NODE_ENV === "production" ? "Internal server error" : message,
      code: "SERVER_ERROR",
    });
  });

  await app.register(eventRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(settingsRoutes);
  await app.register(auditRoutes);
  await app.register(notificationRoutes);
  await app.register(branchRoutes);
  await app.register(taxonomyRoutes);
  await app.register(inventoryRoutes);
  await app.register(sessionRoutes);
  await app.register(purchaseRoutes);
  await app.register(salesRoutes);
  await app.register(accountingRoutes);
  await app.register(approvalRoutes);

  return app;
}
