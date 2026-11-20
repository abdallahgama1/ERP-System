import { buildApp } from "./app.ts";
import { DEV_COOKIE_SECRET_PLACEHOLDER, env } from "./config.ts";
import { checkDatabaseConnection, closeDatabase, getDb, isDatabaseConfigured } from "./db/index.ts";
import { runOverdueSweep } from "./services/overdue-sweep.service.ts";

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
    console.warn(
      "\n[ERP API WARNING] DATABASE_URL is not set in .env.\n" +
        "Set DATABASE_URL=postgresql://... in .env and run `npm run db:push` (or `npm run db:migrate`).\n"
    );
  } else {
    const status = await checkDatabaseConnection();
    if (!status.connected) {
      console.warn(`[ERP API WARNING] Could not reach PostgreSQL at startup: ${status.error}`);
    } else {
      console.log("[ERP API] Connected to PostgreSQL cleanly.");
      const safeSweep = () => {
        void runOverdueSweep(getDb()).catch((err) => {
          console.warn("[ERP API] Scheduled overdue sweep failed:", err instanceof Error ? err.message : err);
        });
      };
      // Run daily/6-hour overdue sweep in server runtime (never during Vitest buildApp())
      overdueTimer = setInterval(safeSweep, 6 * 60 * 60 * 1000);
    }
  }

  const shutdown = async () => {
    if (overdueTimer) clearInterval(overdueTimer);
    await app.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`[ERP API] Listening on http://${env.HOST}:${env.PORT}`);
}

start().catch((err) => {
  console.error("[ERP API FATAL]", err);
  process.exit(1);
});
