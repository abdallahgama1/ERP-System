import { buildApp } from "./app.ts";
import { DEV_COOKIE_SECRET_PLACEHOLDER, env, resolveMfaEncryptionKey } from "./config.ts";
import { checkDatabaseConnection, closeDatabase, getDb, isDatabaseConfigured } from "./db/index.ts";
import { createModuleLogger } from "./logging/logger.ts";
import { flushBackendSentry, initBackendSentry } from "./observability/sentry.ts";
import { processPendingEtaSubmissions } from "./services/einvoicing.service.ts";
import { runHousekeeping } from "./services/housekeeping.service.ts";
import { runOverdueSweep } from "./services/overdue-sweep.service.ts";

const log = createModuleLogger("server");

async function start(): Promise<void> {
  if (
    env.NODE_ENV === "production" &&
    (env.AUTH_COOKIE_SECRET === DEV_COOKIE_SECRET_PLACEHOLDER ||
      env.AUTH_COOKIE_SECRET === "change-me-in-production-use-at-least-32-random-chars" ||
      env.AUTH_COOKIE_SECRET.length < 32)
  ) {
    throw new Error(
      "AUTH_COOKIE_SECRET must be set to a random string of at least 32 characters when NODE_ENV=production."
    );
  }
  if (env.NODE_ENV === "production") {
    resolveMfaEncryptionKey();
    if (
      env.STORAGE_DRIVER === "s3" &&
      (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    ) {
      throw new Error(
        "S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must be set when STORAGE_DRIVER=s3 in production."
      );
    }
  }

  initBackendSentry();

  const app = await buildApp();

  let overdueTimer: ReturnType<typeof setInterval> | null = null;
  let housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  let etaWorkerTimer: ReturnType<typeof setInterval> | null = null;

  app.addHook("onClose", async () => {
    if (overdueTimer) clearInterval(overdueTimer);
    if (housekeepingTimer) clearInterval(housekeepingTimer);
    if (etaWorkerTimer) clearInterval(etaWorkerTimer);
  });

  const shutdown = async () => {
    log.info("Shutting down ERP API gracefully");
    if (overdueTimer) clearInterval(overdueTimer);
    if (housekeepingTimer) clearInterval(housekeepingTimer);
    if (etaWorkerTimer) clearInterval(etaWorkerTimer);
    await app.close();
    await closeDatabase();
    await flushBackendSentry(2000);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
  log.info({ host: env.HOST, port: env.PORT }, "ERP API listening");

  if (!isDatabaseConfigured()) {
    log.warn("DATABASE_URL is not configured; set DATABASE_URL in backend/.env and run `npm run db:migrate`.");
  } else {
    const status = await checkDatabaseConnection();
    if (!status.connected) {
      log.warn({ error: status.error }, "Could not reach PostgreSQL at startup");
    } else {
      log.info("Connected to PostgreSQL cleanly");
      const safeSweep = () => {
        void runOverdueSweep(getDb())
          .then((res) => {
            log.info({ ...res }, "Scheduled overdue & lot expiry sweep completed");
          })
          .catch((err) => {
            log.warn({ err }, "Scheduled overdue sweep failed");
          });
      };
      const safeHousekeeping = () => {
        void runHousekeeping(getDb())
          .then((res) => {
            log.info({ ...res }, "Scheduled database housekeeping completed");
          })
          .catch((err) => {
            log.warn({ err }, "Scheduled database housekeeping failed");
          });
      };
      const safeEtaWorker = () => {
        void processPendingEtaSubmissions({ limit: 25, db: getDb() })
          .then((res) => {
            if (!res.skipped && res.processed > 0) {
              log.info({ ...res }, "Scheduled ETA e-Receipt submission worker completed");
            }
          })
          .catch((err) => {
            log.warn({ err }, "Scheduled ETA e-Receipt submission worker failed");
          });
      };
      // Run daily/6-hour overdue sweep & DB housekeeping + 60s ETA queue worker in server runtime
      overdueTimer = setInterval(safeSweep, 6 * 60 * 60 * 1000);
      housekeepingTimer = setInterval(safeHousekeeping, 6 * 60 * 60 * 1000);
      housekeepingTimer.unref?.();
      etaWorkerTimer = setInterval(safeEtaWorker, 60 * 1000);
      etaWorkerTimer.unref?.();
    }
  }
}

start().catch((err) => {
  log.fatal({ err }, "ERP API fatal startup error");
  process.exit(1);
});
