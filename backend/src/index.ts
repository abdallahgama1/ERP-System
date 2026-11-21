import { buildApp } from "./app.ts";
import { DEV_COOKIE_SECRET_PLACEHOLDER, env } from "./config.ts";
import { checkDatabaseConnection, closeDatabase, getDb, isDatabaseConfigured } from "./db/index.ts";
import { createModuleLogger } from "./logging/logger.ts";
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

  const app = await buildApp();

  let overdueTimer: ReturnType<typeof setInterval> | null = null;

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
      // Run daily/6-hour overdue sweep in server runtime (never during Vitest buildApp())
      overdueTimer = setInterval(safeSweep, 6 * 60 * 60 * 1000);
    }
  }

  const shutdown = async () => {
    log.info("Shutting down ERP API gracefully");
    if (overdueTimer) clearInterval(overdueTimer);
    await app.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
  log.info({ host: env.HOST, port: env.PORT }, "ERP API listening");
}

start().catch((err) => {
  log.fatal({ err }, "ERP API fatal startup error");
  process.exit(1);
});
