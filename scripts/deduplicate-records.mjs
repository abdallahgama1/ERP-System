#!/usr/bin/env node
/**
 * Natural-Key Duplicate Scanner & Safe Deduplication CLI
 *
 * Modes:
 *   - Check only (pre-migration / deploy gate):
 *       npm run ops:check-duplicates
 *       node scripts/deduplicate-records.mjs --check [--env-file <path>]
 *       Exits 0 when zero duplicates exist, exits 1 with a full report otherwise.
 *
 *   - Deduplicate (dry-run by default; --apply deletes ONLY duplicates with zero history):
 *       npm run ops:deduplicate
 *       npm run ops:deduplicate -- --apply [--i-have-a-backup]
 *
 * Safety guarantees:
 *   1. Keeps the oldest row per duplicate group (ORDER BY created_at ASC, id ASC).
 *   2. Dynamically inspects EVERY PostgreSQL foreign key referencing the table AND
 *      table-specific transaction/default guards; refuses to delete any row that has
 *      transactions, stock, orders, journals, payments, or is marked is_default=true.
 *   3. Refuses to delete rows referenced by chained audit_logs if an ON DELETE SET NULL
 *      FK is still present (prevents breaking the SHA-256 audit hash chain).
 *   4. Refuses to run --apply against a production or non-local DATABASE_URL unless
 *      --i-have-a-backup is explicitly passed.
 *   5. Logs every deleted duplicate record into the tamper-evident audit_logs hash chain.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export const NATURAL_KEY_CHECKS = [
  {
    id: "branches_company_code_norm_uq",
    table: "branches",
    label: "branches (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name", "is_default"],
  },
  {
    id: "branches_company_name_norm_uq",
    table: "branches",
    label: "branches (company_id, lower(btrim(name)))",
    groupExpr: "lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["code", "name", "is_default"],
  },
  {
    id: "products_company_sku_norm_uq",
    table: "products",
    label: "products (company_id, lower(btrim(sku)))",
    groupExpr: "lower(btrim(sku))",
    whereClause: "btrim(sku) <> ''",
    displayCols: ["sku", "name", "barcode"],
  },
  {
    id: "products_company_barcode_norm_uq",
    table: "products",
    label: "products (company_id, lower(btrim(barcode))) [non-empty]",
    groupExpr: "lower(btrim(barcode))",
    whereClause: "barcode IS NOT NULL AND btrim(barcode) <> ''",
    displayCols: ["sku", "name", "barcode"],
  },
  {
    id: "customers_company_code_norm_uq",
    table: "customers",
    label: "customers (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name", "tax_number"],
  },
  {
    id: "vendors_company_code_norm_uq",
    table: "vendors",
    label: "vendors (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name", "tax_number"],
  },
  {
    id: "coa_company_code_norm_uq",
    table: "chart_of_accounts",
    label: "chart_of_accounts (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name", "account_type"],
  },
  {
    id: "cost_centers_company_code_norm_uq",
    table: "cost_centers",
    label: "cost_centers (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name"],
  },
  {
    id: "cost_centers_company_name_norm_uq",
    table: "cost_centers",
    label: "cost_centers (company_id, lower(btrim(name)))",
    groupExpr: "lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["code", "name"],
  },
  {
    id: "tax_codes_company_code_norm_uq",
    table: "tax_codes",
    label: "tax_codes (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name"],
  },
  {
    id: "treasury_accounts_company_code_norm_uq",
    table: "treasury_accounts",
    label: "treasury_accounts (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name", "iban"],
  },
  {
    id: "treasury_accounts_company_name_norm_uq",
    table: "treasury_accounts",
    label: "treasury_accounts (company_id, lower(btrim(name)))",
    groupExpr: "lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["code", "name", "iban"],
  },
  {
    id: "treasury_accounts_company_iban_norm_uq",
    table: "treasury_accounts",
    label: "treasury_accounts (company_id, lower(btrim(iban))) [non-empty]",
    groupExpr: "lower(btrim(iban))",
    whereClause: "btrim(iban) <> ''",
    displayCols: ["code", "name", "iban"],
  },
  {
    id: "fixed_assets_company_code_norm_uq",
    table: "fixed_assets",
    label: "fixed_assets (company_id, lower(btrim(asset_code)))",
    groupExpr: "lower(btrim(asset_code))",
    whereClause: "btrim(asset_code) <> ''",
    displayCols: ["asset_code", "name", "serial_number"],
  },
  {
    id: "fixed_assets_company_serial_norm_uq",
    table: "fixed_assets",
    label: "fixed_assets (company_id, lower(btrim(serial_number))) [non-empty]",
    groupExpr: "lower(btrim(serial_number))",
    whereClause: "btrim(serial_number) <> ''",
    displayCols: ["asset_code", "name", "serial_number"],
  },
  {
    id: "pos_terminals_company_code_norm_uq",
    table: "pos_terminals",
    label: "pos_terminals (company_id, lower(btrim(code)))",
    groupExpr: "lower(btrim(code))",
    whereClause: "btrim(code) <> ''",
    displayCols: ["code", "name"],
  },
  {
    id: "pos_terminals_company_name_norm_uq",
    table: "pos_terminals",
    label: "pos_terminals (company_id, lower(btrim(name)))",
    groupExpr: "lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["code", "name"],
  },
  {
    id: "taxonomy_company_kind_name_norm_uq",
    table: "taxonomy_items",
    label: "taxonomy_items (company_id, kind, lower(btrim(name)))",
    groupExpr: "kind || ':' || lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["kind", "name"],
  },
  {
    id: "custom_roles_company_name_norm_uq",
    table: "custom_roles",
    label: "custom_roles (company_id, lower(btrim(name)))",
    groupExpr: "lower(btrim(name))",
    whereClause: "btrim(name) <> ''",
    displayCols: ["name", "base_role"],
  },
];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        opts[k] = true;
      } else {
        opts[k] = next;
        i += 1;
      }
    }
  }
  return opts;
}

export function isProductionOrRemoteDbUrl(databaseUrl, nodeEnv = process.env.NODE_ENV ?? "") {
  if (String(nodeEnv).trim().toLowerCase() === "production") return true;
  try {
    const u = new URL(String(databaseUrl ?? "").trim());
    const host = u.hostname.toLowerCase();
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "postgres" || host === "postgres-test";
    return !isLocal;
  } catch {
    return true;
  }
}

async function getForeignKeysReferencing(sql, tableName) {
  return sql.unsafe(
    `
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      rc.delete_rule AS delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = $1
    ORDER BY tc.table_name, kcu.column_name
    `,
    [tableName]
  );
}

/**
 * Checks whether a candidate duplicate row has ANY referencing transactions/history
 * or protected flags (e.g. is_default, is_system).
 */
export async function inspectRowReferences(sql, tableName, row) {
  const blockers = [];

  if (row.is_default === true) {
    blockers.push({ table: tableName, column: "is_default", count: 1, reason: "Row is marked as default" });
  }
  if (row.is_system === true) {
    blockers.push({ table: tableName, column: "is_system", count: 1, reason: "Row is a protected system record" });
  }

  const fks = await getForeignKeysReferencing(sql, tableName);
  for (const fk of fks) {
    // audit_logs is immutable history; if the FK was already dropped it won't appear here.
    // If the FK STILL exists with SET NULL, deleting a referenced row would mutate audit_logs
    // and break the SHA-256 hash chain — so block safely until migration 0014 drops the FK!
    const [res] = await sql.unsafe(
      `SELECT count(*)::int AS cnt FROM "public"."${fk.child_table}" WHERE "${fk.child_column}" = $1`,
      [row.id]
    );
    const cnt = Number(res?.cnt ?? 0);
    if (cnt > 0) {
      if (fk.child_table === "audit_logs") {
        blockers.push({
          table: fk.child_table,
          column: fk.child_column,
          count: cnt,
          reason:
            "audit_logs FK still active (ON DELETE SET NULL would invalidate the audit hash chain; apply migration 0014 first)",
        });
      } else {
        blockers.push({
          table: fk.child_table,
          column: fk.child_column,
          count: cnt,
          reason: `Referenced by ${cnt} row(s) in ${fk.child_table}.${fk.child_column}`,
        });
      }
    }
  }

  // Extra non-FK safety checks for special tables
  if (tableName === "branches") {
    const [compRef] = await sql.unsafe(
      `SELECT count(*)::int AS cnt FROM "public"."companies" WHERE "default_branch_id" = $1`,
      [row.id]
    );
    if (Number(compRef?.cnt ?? 0) > 0) {
      blockers.push({
        table: "companies",
        column: "default_branch_id",
        count: Number(compRef.cnt),
        reason: "Referenced as company default_branch_id",
      });
    }
  }

  if (tableName === "chart_of_accounts") {
    const [parentRef] = await sql.unsafe(
      `SELECT count(*)::int AS cnt FROM "public"."chart_of_accounts" WHERE "parent_id" = $1`,
      [row.id]
    );
    if (Number(parentRef?.cnt ?? 0) > 0) {
      blockers.push({
        table: "chart_of_accounts",
        column: "parent_id",
        count: Number(parentRef.cnt),
        reason: "Referenced as parent account by child accounts",
      });
    }
  }

  return blockers;
}

export async function checkDuplicates(sql) {
  const existingTablesRows = await sql.unsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const existingTables = new Set(existingTablesRows.map((r) => r.tablename));

  const groups = [];
  for (const check of NATURAL_KEY_CHECKS) {
    if (!existingTables.has(check.table)) continue;
    const dupRows = await sql.unsafe(`
      SELECT company_id, ${check.groupExpr} AS normalized_key, count(*)::int AS cnt
      FROM "public"."${check.table}"
      WHERE ${check.whereClause}
      GROUP BY 1, 2
      HAVING count(*) > 1
      ORDER BY company_id, normalized_key
    `);

    for (const grp of dupRows) {
      const cols = ["id", "company_id", "created_at", ...check.displayCols];
      const optionalFlagCols =
        check.table === "branches"
          ? ["is_default"]
          : check.table === "chart_of_accounts" || check.table === "custom_roles"
            ? ["is_system"]
            : [];
      const selectCols = Array.from(new Set([...cols, ...optionalFlagCols]))
        .map((c) => `"${c}"`)
        .join(", ");

      const memberRows = await sql.unsafe(
        `
        SELECT ${selectCols}
        FROM "public"."${check.table}"
        WHERE company_id = $1
          AND (${check.whereClause})
          AND (${check.groupExpr}) = $2
        ORDER BY created_at ASC, id ASC
        `,
        [grp.company_id, grp.normalized_key]
      );

      const enriched = [];
      for (let idx = 0; idx < memberRows.length; idx++) {
        const row = memberRows[idx];
        const blockers = idx === 0 ? [] : await inspectRowReferences(sql, check.table, row);
        enriched.push({
          ...row,
          keepAsOldest: idx === 0,
          canSafelyDelete: idx > 0 && blockers.length === 0,
          blockers,
        });
      }

      groups.push({
        constraintId: check.id,
        table: check.table,
        label: check.label,
        companyId: grp.company_id,
        normalizedKey: grp.normalized_key,
        count: Number(grp.cnt),
        rows: enriched,
      });
    }
  }

  return {
    clean: groups.length === 0,
    duplicateGroupCount: groups.length,
    totalExcessRows: groups.reduce((acc, g) => acc + Math.max(0, g.count - 1), 0),
    groups,
  };
}

export async function runDeduplicate({
  databaseUrl = process.env.DATABASE_URL ?? "",
  apply = false,
  iHaveABackup = false,
  nodeEnv = process.env.NODE_ENV ?? "",
} = {}) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  if (apply && isProductionOrRemoteDbUrl(databaseUrl, nodeEnv) && !iHaveABackup) {
    throw new Error(
      "Refusing to run --apply against a production or non-local DATABASE_URL without --i-have-a-backup. " +
        "Take a verified backup first, inspect the dry-run output, then re-run with --apply --i-have-a-backup."
    );
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 15 });
  try {
    const scan = await checkDuplicates(sql);
    if (!apply || scan.clean) {
      return {
        mode: apply ? "apply" : "dry_run",
        ...scan,
        deleted: [],
        refused: scan.groups.flatMap((g) =>
          g.rows
            .filter((r) => !r.keepAsOldest && !r.canSafelyDelete)
            .map((r) => ({ table: g.table, id: r.id, normalizedKey: g.normalizedKey, blockers: r.blockers }))
        ),
      };
    }

    const unregisterTsx = process.env.VITEST ? () => {} : register();
    const deleted = [];
    const refused = [];
    const seenDeletedIds = new Set();

    try {
      const { sql: drizzleSql } = await import("drizzle-orm");
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const schema = await import("../backend/drizzle/schema.ts");
      const { writeAuditLog } = await import("../backend/src/db/helpers.ts");

      const db = drizzle(sql, { schema });

      for (const group of scan.groups) {
        const kept = group.rows[0];
        for (const candidate of group.rows.slice(1)) {
          const dedupeKey = `${group.table}:${candidate.id}`;
          if (seenDeletedIds.has(dedupeKey)) continue;

          // Re-verify references right before deleting
          const blockers = await inspectRowReferences(sql, group.table, candidate);
          if (blockers.length > 0) {
            refused.push({
              table: group.table,
              id: candidate.id,
              normalizedKey: group.normalizedKey,
              blockers,
            });
            continue;
          }

          await db.transaction(async (tx) => {
            await tx.execute(
              drizzleSql`DELETE FROM "public".${drizzleSql.identifier(group.table)} WHERE id = ${candidate.id} AND company_id = ${group.companyId}`
            );
            await writeAuditLog(tx, {
              companyId: group.companyId,
              userId: null,
              userName: "system:deduplicate-records",
              userRole: "system",
              action: "ops.duplicate_removed",
              entityType: group.table,
              entityId: candidate.id,
              entityLabel: String(candidate.code ?? candidate.sku ?? candidate.asset_code ?? candidate.name ?? candidate.id),
              details: {
                constraintId: group.constraintId,
                normalizedKey: group.normalizedKey,
                keptOldestId: kept.id,
              },
              before: candidate,
              after: null,
            });
          });

          seenDeletedIds.add(dedupeKey);
          deleted.push({
            table: group.table,
            id: candidate.id,
            keptOldestId: kept.id,
            normalizedKey: group.normalizedKey,
            code: candidate.code ?? candidate.sku ?? candidate.asset_code ?? null,
            name: candidate.name ?? null,
          });
        }
      }
    } finally {
      unregisterTsx();
    }

    const afterScan = await checkDuplicates(sql);
    return {
      mode: "apply",
      ...afterScan,
      deleted,
      refused,
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage:
  npm run ops:check-duplicates [-- --env-file <path>]
  npm run ops:deduplicate [-- --apply] [--i-have-a-backup] [--env-file <path>] [--json]`);
    process.exit(0);
  }

  if (opts["env-file"]) {
    dotenv.config({ path: path.resolve(process.cwd(), opts["env-file"]) });
  } else if (!process.env.DATABASE_URL) {
    const backendEnv = path.resolve(repoRoot, "backend/.env");
    const rootEnv = path.resolve(repoRoot, ".env");
    if (fs.existsSync(backendEnv)) dotenv.config({ path: backendEnv });
    else if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
  }

  const checkOnly = Boolean(opts.check);
  const apply = !checkOnly && Boolean(opts.apply);

  runDeduplicate({
    databaseUrl: process.env.DATABASE_URL ?? "",
    apply,
    iHaveABackup: Boolean(opts["i-have-a-backup"]),
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (checkOnly && !report.clean) {
        console.error(
          `[ops:check-duplicates] FAILED: found ${report.duplicateGroupCount} duplicate natural-key group(s) (${report.totalExcessRows} excess row(s)). ` +
            `Resolve duplicates with 'npm run ops:deduplicate' before running migrations.`
        );
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`[deduplicate-records] ERROR: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
