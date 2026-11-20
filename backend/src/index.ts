import { buildApp } from "./app.ts";
import { env } from "./config.ts";
import { checkDatabaseConnection, closeDatabase, isDatabaseConfigured } from "./db/index.ts";

async function start(): Promise<void> {
  const app = await buildApp();

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
    }
  }

  const shutdown = async () => {
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
