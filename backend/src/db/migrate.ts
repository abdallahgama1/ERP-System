import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../config.ts";
import { createModuleLogger } from "../logging/logger.ts";

const log = createModuleLogger("db-migrate");

function resolveMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : null,
    // Compiled: backend/dist/migrate.mjs -> backend/drizzle/migrations
    path.resolve(currentDir, "../drizzle/migrations"),
    // Source (tsx): backend/src/db/migrate.ts -> backend/drizzle/migrations
    path.resolve(currentDir, "../../drizzle/migrations"),
    // Working directory fallbacks (/app or /app/backend)
    path.resolve(process.cwd(), "backend/drizzle/migrations"),
    path.resolve(process.cwd(), "drizzle/migrations"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "meta/_journal.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate Drizzle migrations folder (meta/_journal.json). Checked: ${candidates.join(", ")}`
  );
}

export async function runMigrations(): Promise<void> {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const migrationsFolder = resolveMigrationsFolder();
  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    connect_timeout: 15,
    prepare: false,
  });

  try {
    log.info({ migrationsFolder }, "Applying Drizzle PostgreSQL migrations");
    await migrate(drizzle(sql), { migrationsFolder });
    log.info("Drizzle PostgreSQL migrations applied cleanly");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  runMigrations().catch((err) => {
    log.fatal({ err }, "Database migration failed");
    process.exit(1);
  });
}
