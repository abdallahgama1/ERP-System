import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { env } from "../config.ts";
import { getBackupFreshness } from "../services/backup-freshness.service.ts";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

const erpAuthEventsTotal = new Counter({
  name: "erp_auth_events_total",
  help: "Total number of ERP authentication events",
  labelNames: ["event", "outcome"] as const,
  registers: [metricsRegistry],
});

const erpDbErrorsTotal = new Counter({
  name: "erp_db_errors_total",
  help: "Total number of database and server errors",
  labelNames: ["operation"] as const,
  registers: [metricsRegistry],
});

const erpHousekeepingRunsTotal = new Counter({
  name: "erp_housekeeping_runs_total",
  help: "Total number of database housekeeping runs",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

const erpHousekeepingPurgedRowsTotal = new Counter({
  name: "erp_housekeeping_purged_rows_total",
  help: "Total number of rows purged by database housekeeping",
  labelNames: ["table"] as const,
  registers: [metricsRegistry],
});

const erpBackupLastSuccessTimestampSeconds = new Gauge({
  name: "erp_backup_last_success_timestamp_seconds",
  help: "Unix timestamp (seconds) of the last successful backup (0 when missing)",
  registers: [metricsRegistry],
});

const erpBackupAgeSeconds = new Gauge({
  name: "erp_backup_age_seconds",
  help: "Age in seconds since the last successful backup (-1 when missing)",
  registers: [metricsRegistry],
});

const erpBackupFreshnessOk = new Gauge({
  name: "erp_backup_freshness_ok",
  help: "1 when last successful backup is within BACKUP_MAX_AGE_HOURS (default 26h), 0 otherwise",
  registers: [metricsRegistry],
});

export type AuthMetricEvent =
  | "signup"
  | "login"
  | "logout"
  | "change_password"
  | "forgot_password"
  | "reset_password";

export function observeHttpRequest(params: {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}): void {
  const labels = {
    method: params.method.toUpperCase(),
    route: params.route,
    status_code: String(params.statusCode),
  };
  httpRequestsTotal.inc(labels);
  if (Number.isFinite(params.durationSeconds) && params.durationSeconds >= 0) {
    httpRequestDurationSeconds.observe(labels, params.durationSeconds);
  }
}

export function recordAuthEvent(event: AuthMetricEvent, outcome: "success" | "failure"): void {
  erpAuthEventsTotal.inc({ event, outcome });
}

export function recordDbError(operation: string): void {
  erpDbErrorsTotal.inc({ operation });
}

export function recordHousekeepingResult(res: {
  skipped: boolean;
  deletedSessions: number;
  deletedResetTokens: number;
  deletedIdempotencyKeys: number;
}): void {
  erpHousekeepingRunsTotal.inc({ outcome: res.skipped ? "skipped_locked" : "completed" });
  if (res.deletedSessions > 0) {
    erpHousekeepingPurgedRowsTotal.inc({ table: "user_sessions" }, res.deletedSessions);
  }
  if (res.deletedResetTokens > 0) {
    erpHousekeepingPurgedRowsTotal.inc({ table: "password_reset_tokens" }, res.deletedResetTokens);
  }
  if (res.deletedIdempotencyKeys > 0) {
    erpHousekeepingPurgedRowsTotal.inc({ table: "idempotency_keys" }, res.deletedIdempotencyKeys);
  }
}

export function recordHousekeepingFailure(): void {
  erpHousekeepingRunsTotal.inc({ outcome: "failed" });
}

export function isValidBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!match) return false;
  const providedToken = match[1]?.trim() ?? "";
  if (!providedToken) return false;

  const providedDigest = createHash("sha256").update(providedToken, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/metrics", async (req, reply) => {
    const metricsToken = (process.env.METRICS_TOKEN ?? env.METRICS_TOKEN).trim();

    if (!metricsToken) {
      return reply.status(404).send({ message: "Not found", code: "NOT_FOUND" });
    }
    if (!isValidBearerToken(req.headers.authorization, metricsToken)) {
      reply.header("WWW-Authenticate", 'Bearer realm="metrics"');
      return reply.status(401).send({ message: "Unauthorized", code: "UNAUTHORIZED" });
    }

    try {
      const freshness = await getBackupFreshness();
      erpBackupFreshnessOk.set(freshness.ok ? 1 : 0);
      erpBackupAgeSeconds.set(freshness.ageSeconds ?? -1);
      erpBackupLastSuccessTimestampSeconds.set(
        freshness.lastBackupAt ? Math.floor(new Date(freshness.lastBackupAt).getTime() / 1000) : 0
      );
    } catch {
      erpBackupFreshnessOk.set(0);
    }

    reply.header("Content-Type", metricsRegistry.contentType);
    reply.header("Cache-Control", "no-store");
    return reply.status(200).send(await metricsRegistry.metrics());
  });
}
