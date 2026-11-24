import type { z } from "zod";
import {
  buildOffsetPageInfo,
  decodeCursor,
  parseBackwardCompatibleOffsetQuery,
  type CursorPayload,
  type OffsetPageInfo,
  type OffsetPageQuery,
  type SortDirection,
} from "@erp/shared";
import { and, asc, desc, eq, gt, inArray, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { AppError } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

function tableCompanyCondition(table: PgTable, actor: RequestActor): SQL | null {
  const companyCol = (table as unknown as Record<string, AnyColumn | undefined>).companyId;
  if (!companyCol) return null;
  return eq(companyCol, actorCompanyId(actor));
}

export function parseOffsetQueryOrThrow<
  TSchema extends z.ZodType<OffsetPageQuery, z.ZodTypeDef, unknown>,
>(
  schema: TSchema,
  rawQuery: Record<string, unknown> | undefined,
  legacyDefaultPageSize = 200
): z.infer<TSchema> {
  try {
    return parseBackwardCompatibleOffsetQuery(schema, rawQuery, legacyDefaultPageSize);
  } catch (err) {
    const issues =
      err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown[] }).issues)
        ? (err as { issues: Array<{ message?: string }> }).issues
        : [];
    throw new AppError(400, issues[0]?.message ?? "Invalid pagination query parameters", "VALIDATION_ERROR");
  }
}

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
  const companyCond = tableCompanyCondition(table, actor);
  const baseConds: SQL[] = [];
  if (companyCond) baseConds.push(companyCond);
  if (extraCondition) baseConds.push(extraCondition);

  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    return db
      .select()
      .from(table as PgTable)
      .where(baseConds.length > 0 ? and(...baseConds) : undefined)
      .orderBy(desc(createdAtCol));
  }
  if (actor.branchIds.length === 0) return [];
  const scopeFilter = inArray(branchIdCol, actor.branchIds);
  baseConds.push(scopeFilter);
  return db
    .select()
    .from(table as PgTable)
    .where(and(...baseConds))
    .orderBy(desc(createdAtCol));
}

export function buildBranchScopeCondition(
  branchIdCol: AnyColumn,
  actor: RequestActor,
  requestedBranchId?: string,
  allowNullBranch = false
): SQL | null | "EMPTY" {
  if (requestedBranchId) {
    return eq(branchIdCol, requestedBranchId);
  }
  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    return null;
  }
  if (actor.branchIds.length === 0) {
    return allowNullBranch ? sql`${branchIdCol} IS NULL` : "EMPTY";
  }
  const inBranches = inArray(branchIdCol, actor.branchIds);
  return allowNullBranch ? or(sql`${branchIdCol} IS NULL`, inBranches)! : inBranches;
}

export function parseCursorOrThrow(raw?: string): CursorPayload | null {
  if (!raw || !raw.trim()) return null;
  const decoded = decodeCursor(raw);
  if (!decoded) {
    throw new AppError(400, "Malformed pagination cursor", "INVALID_CURSOR");
  }
  return decoded;
}

export function buildKeysetCondition(
  createdAtCol: AnyColumn,
  idCol: AnyColumn,
  cursor: CursorPayload,
  sortDir: SortDirection = "desc"
): SQL {
  const ts = new Date(cursor.ts);
  if (sortDir === "asc") {
    return or(gt(createdAtCol, ts), and(eq(createdAtCol, ts), gt(idCol, cursor.id)))!;
  }
  return or(lt(createdAtCol, ts), and(eq(createdAtCol, ts), lt(idCol, cursor.id)))!;
}

export async function listBranchScopedPaginated<TTable extends PgTable>(
  db: AppDatabase,
  table: TTable,
  branchIdCol: AnyColumn,
  createdAtCol: AnyColumn,
  idCol: AnyColumn,
  actor: RequestActor,
  options: {
    page: number;
    pageSize: number;
    sortDir?: SortDirection;
    requestedBranchId?: string;
    extraConditions?: SQL[];
  }
): Promise<{ rows: Array<Record<string, unknown>>; pageInfo: OffsetPageInfo }> {
  const scopeCond = buildBranchScopeCondition(branchIdCol, actor, options.requestedBranchId);
  if (scopeCond === "EMPTY") {
    return { rows: [], pageInfo: buildOffsetPageInfo(options.page, options.pageSize, 0) };
  }

  const conds: SQL[] = [];
  const companyCond = tableCompanyCondition(table, actor);
  if (companyCond) conds.push(companyCond);
  if (scopeCond) conds.push(scopeCond);
  if (options.extraConditions) conds.push(...options.extraConditions);
  const whereClause = conds.length > 0 ? and(...conds) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(table as PgTable)
    .where(whereClause);

  const dir = options.sortDir === "asc" ? asc : desc;
  const rows = await db
    .select()
    .from(table as PgTable)
    .where(whereClause)
    .orderBy(dir(createdAtCol), dir(idCol))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);

  return {
    rows: rows as Array<Record<string, unknown>>,
    pageInfo: buildOffsetPageInfo(options.page, options.pageSize, total),
  };
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
