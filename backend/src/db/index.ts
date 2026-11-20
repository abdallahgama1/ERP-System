import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../drizzle/schema.ts";
import { env } from "../config.ts";
import { AppError } from "./helpers.ts";

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

let sqlClient: ReturnType<typeof postgres> | null = null;
let dbInstance: AppDatabase | null = null;

if (env.DATABASE_URL) {
  sqlClient = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: !env.DATABASE_URL.includes("-pooler."),
  });
  dbInstance = drizzle(sqlClient, { schema });
}

export function isDatabaseConfigured(): boolean {
  return Boolean(dbInstance && sqlClient);
}

export function getDb(): AppDatabase {
  if (!dbInstance) {
    throw new AppError(
      503,
      "Database is not configured. Set DATABASE_URL in .env and run npm run db:push.",
      "DATABASE_NOT_CONFIGURED"
    );
  }
  return dbInstance;
}

export async function checkDatabaseConnection(): Promise<{
  configured: boolean;
  connected: boolean;
  error?: string;
}> {
  if (!sqlClient) {
    return {
      configured: false,
      connected: false,
      error: "DATABASE_URL is missing in .env",
    };
  }
  try {
    await sqlClient`SELECT 1`;
    return { configured: true, connected: true };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : "Database connection failed",
    };
  }
}

export async function closeDatabase(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
  }
}
