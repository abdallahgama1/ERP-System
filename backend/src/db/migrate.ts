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

export const MIGRATION_ADVISORY_LOCK_KEY = 749207;

export interface MigrationRunResult {
  lockPid: number;
  unlockPid: number;
  unlocked: boolean;
}

export async function runMigrations(
  databaseUrl: string = env.DATABASE_URL
): Promise<MigrationRunResult> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const migrationsFolder = resolveMigrationsFolder();
  // Dedicated single-connection client (max: 1, no idle/lifetime recycling) so
  // pg_advisory_lock, Drizzle migrate(), and pg_advisory_unlock share one backend session.
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    connect_timeout: 15,
    prepare: false,
  });

  let lockPid = 0;
  let unlockPid = 0;
  let unlocked = false;
  try {
    const [lockRow] = await sql<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid, pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})
    `;
    lockPid = lockRow?.pid ?? 0;
    log.info({ migrationsFolder, backendPid: lockPid }, "Applying Drizzle PostgreSQL migrations");
    await migrate(drizzle(sql), { migrationsFolder });
    log.info({ backendPid: lockPid }, "Drizzle PostgreSQL migrations applied cleanly");
  } finally {
    try {
      if (lockPid > 0) {
        const [unlockRow] = await sql<{ pid: number; unlocked: boolean }[]>`
          SELECT pg_backend_pid()::int AS pid, pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY}) AS unlocked
        `.catch(() => [{ pid: 0, unlocked: false }]);
        unlockPid = unlockRow?.pid ?? 0;
        unlocked = Boolean(unlockRow?.unlocked);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  return { lockPid, unlockPid, unlocked };
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
