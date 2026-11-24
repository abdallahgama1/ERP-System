import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ATTACHMENT_MAX_BYTES } from "@erp/shared";
import type { DestinationStream } from "pino";
import { env } from "./config.ts";
import { AppError } from "./db/helpers.ts";
import { buildPinoOptions, requestContext, sanitizeRequestId } from "./logging/logger.ts";
import { attachAuthHook } from "./middleware/auth.ts";
import { csrfProtectionHook } from "./middleware/csrf.ts";
import {
  metricsRoutes,
  observeHttpRequest,
  recordAuthEvent,
  recordDbError,
  type AuthMetricEvent,
} from "./observability/metrics.ts";
import { captureBackendException } from "./observability/sentry.ts";
import { accountingRoutes } from "./routes/accounting.ts";
import { adminRoutes } from "./routes/admin.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { auditRoutes } from "./routes/audit.ts";
import { authRoutes } from "./routes/auth.ts";
import { branchRoutes } from "./routes/branches.ts";
import { companiesRoutes } from "./routes/companies.ts";
import { einvoicingRoutes } from "./routes/einvoicing.ts";
import { eventRoutes } from "./routes/events.ts";
import { exportRoutes } from "./routes/exports.ts";
import { inventoryRoutes } from "./routes/inventory.ts";
import { manufacturingRoutes } from "./routes/manufacturing.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { posRoutes } from "./routes/pos.ts";
import { printTemplatesRoutes } from "./routes/print-templates.ts";
import { purchaseRoutes } from "./routes/purchases.ts";
import { salesRoutes } from "./routes/sales.ts";
import { savedViewsRoutes } from "./routes/saved-views.ts";
import { searchRoutes } from "./routes/search.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { taxonomyRoutes } from "./routes/taxonomy.ts";
import { trackingRoutes } from "./routes/tracking.ts";

function resolveAuthMetricEvent(routeUrl: string | undefined): AuthMetricEvent | null {
  switch (routeUrl) {
    case "/api/auth/signup":
      return "signup";
    case "/api/auth/login":
      return "login";
    case "/api/auth/logout":
      return "logout";
    case "/api/auth/change-password":
      return "change_password";
    case "/api/auth/forgot-password":
      return "forgot_password";
    case "/api/auth/reset-password":
      return "reset_password";
    default:
      return null;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
  loggerStream?: DestinationStream;
  logLevel?: string;
}

/**
 * Builds and configures the Fastify ERP application instance cleanly without binding a port.
 * Reusable across server runtime and Vitest `app.inject()` integration tests.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const loggerConfig =
    options.logger === false && !options.loggerStream
      ? false
      : buildPinoOptions({
          level: options.logLevel ?? (env.NODE_ENV === "production" ? env.LOG_LEVEL : "debug"),
          stream: options.loggerStream,
        });

  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    genReqId: (req) => sanitizeRequestId(req.headers["x-request-id"]),
    requestIdHeader: "x-request-id",
    logController: new LogController({
      requestIdLogLabel: "reqId",
      disableRequestLogging: true,
    }),
    logger: loggerConfig,
  });

  app.addHook("onRequest", (req, _reply, done) => {
    requestContext.run({ reqId: req.id }, () => done());
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const durationMs = Math.round(reply.elapsedTime * 100) / 100;
    const path = req.url.split("?")[0] ?? req.url;
    const normalizedRoute = req.routeOptions?.url ?? (req.is404 ? "__unmatched__" : "__unknown__");

    observeHttpRequest({
      method: req.method,
      route: normalizedRoute,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });

    if (req.routeOptions?.url?.startsWith("/api/auth/")) {
      const authEvent = resolveAuthMetricEvent(req.routeOptions.url);
      if (authEvent) {
        recordAuthEvent(authEvent, reply.statusCode < 400 ? "success" : "failure");
      }
    }

    const logFields = {
      method: req.method,
      route: normalizedRoute,
      statusCode: reply.statusCode,
      durationMs,
      userId: req.authUser?.id ?? null,
    };
    const isObservabilityProbe =
      path === "/api/health" ||
      path === "/api/health/live" ||
      path === "/api/health/ready" ||
      path === "/api/metrics";

    if (isObservabilityProbe) {
      req.log.debug(logFields, "http.health");
    } else if (reply.statusCode >= 500) {
      req.log.error(logFields, "http.request");
    } else if (reply.statusCode >= 400) {
      req.log.warn(logFields, "http.request");
    } else {
      req.log.info(logFields, "http.request");
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  if (env.NODE_ENV !== "test" && !env.DISABLE_RATE_LIMIT) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      allowList: (req) => {
        const path = req.url.split("?")[0] ?? "";
        return (
          path === "/api/health" ||
          path === "/api/health/live" ||
          path === "/api/health/ready" ||
          path === "/api/metrics" ||
          path.startsWith("/api/events")
        );
      },
    });
  }

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

  await app.register(multipart, {
    limits: {
      fileSize: ATTACHMENT_MAX_BYTES,
      files: 1,
      fields: 10,
    },
  });

  app.addHook("onRequest", csrfProtectionHook);
  app.addHook("preHandler", attachAuthHook);

  app.setErrorHandler((err, req, reply) => {
    const normalizedRoute = req.routeOptions?.url ?? (req.is404 ? "__unmatched__" : "__unknown__");

    if (err instanceof AppError) {
      const logPayload = {
        code: err.code,
        statusCode: err.statusCode,
        userId: req.authUser?.id ?? null,
        err,
      };
      if (err.statusCode >= 500) {
        req.log.error(logPayload, "app.error");
        recordDbError("unhandled_5xx");
        captureBackendException(err, {
          reqId: req.id,
          method: req.method,
          route: normalizedRoute,
          statusCode: err.statusCode,
          userId: req.authUser?.id ?? null,
        });
      } else {
        req.log.warn(logPayload, "app.rejected");
      }
      return reply.status(err.statusCode).send({
        message: err.message,
        code: err.code,
        details: err.details,
        reqId: req.id,
      });
    }

    const statusCode =
      typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : "Internal server error";

    if (statusCode >= 500) {
      req.log.error(
        { statusCode, userId: req.authUser?.id ?? null, err },
        "http.unhandled_error"
      );
      recordDbError("unhandled_5xx");
      captureBackendException(err, {
        reqId: req.id,
        method: req.method,
        route: normalizedRoute,
        statusCode,
        userId: req.authUser?.id ?? null,
      });
    } else {
      req.log.warn(
        { statusCode, userId: req.authUser?.id ?? null, err },
        "http.client_error"
      );
    }

    return reply.status(statusCode).send({
      message: statusCode >= 500 && env.NODE_ENV === "production" ? "Internal server error" : message,
      code: "SERVER_ERROR",
      reqId: req.id,
    });
  });

  await app.register(eventRoutes);
  await app.register(metricsRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(companiesRoutes);
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
  await app.register(trackingRoutes);
  await app.register(manufacturingRoutes);
  await app.register(posRoutes);
  await app.register(einvoicingRoutes);
  await app.register(attachmentRoutes);
  await app.register(searchRoutes);
  await app.register(exportRoutes);
  await app.register(savedViewsRoutes);
  await app.register(printTemplatesRoutes);

  return app;
}
