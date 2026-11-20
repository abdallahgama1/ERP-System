import { and, desc, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { RequestActor } from "./stock-locks.ts";
import type { AppDatabase } from "../db/index.ts";

/**
 * Fetches branch-scoped rows using the actor's assigned branch scope unless admin/all-scope.
 */
export async function listBranchScoped<TTable extends PgTable>(
  db: AppDatabase,
  table: TTable,
  branchIdCol: AnyColumn,
  createdAtCol: AnyColumn,
  actor: RequestActor,
  extraCondition?: SQL
) {
  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    return db
      .select()
      .from(table as PgTable)
      .where(extraCondition)
      .orderBy(desc(createdAtCol));
  }
  if (actor.branchIds.length === 0) return [];
  const scopeFilter = inArray(branchIdCol, actor.branchIds);
  return db
    .select()
    .from(table as PgTable)
    .where(extraCondition ? and(scopeFilter, extraCondition) : scopeFilter)
    .orderBy(desc(createdAtCol));
}

/**
 * Groups child line records into a Map keyed by parent document identifier.
 */
export function groupByKey<T>(rows: T[], getKey: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const arr = map.get(key) ?? [];
    arr.push(row);
    map.set(key, arr);
  }
  return map;
}

export function normalizeVoidReason(body: unknown): string {
  return ((body as { reason?: string } | undefined)?.reason ?? "").trim() || "Voided by user";
}

export const lockRowSql = sql;
