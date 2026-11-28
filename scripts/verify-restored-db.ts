/**
 * Internal verification runner invoked by scripts/monthly-restore-drill.mjs
 * against an isolated restored scratch database (DATABASE_URL).
 *
 * Checks:
 *   1. All 8 Subledger-to-GL Reconciliation controls
 *   2. Accounting Setup Health (all 28 required COA mappings)
 *   3. Tamper-evident Audit Log SHA-256 Hash Chain
 */
import { sql } from "drizzle-orm";
import { DEFAULT_COMPANY_ID, companies } from "../backend/drizzle/schema.ts";
import { closeDatabase, getDb } from "../backend/src/db/index.ts";
import { verifyAuditLogChain } from "../backend/src/db/helpers.ts";
import { getSubledgerReconciliation } from "../backend/src/services/accounting-reports.service.ts";
import { getAccountingSetupHealth } from "../backend/src/services/gl.service.ts";
import type { RequestActor } from "../backend/src/services/stock-locks.ts";

async function main() {
  const db = getDb();
  try {
    const companyRows = await db.select({ id: companies.id, code: companies.code, name: companies.name }).from(companies);
    const activeCompanyId = companyRows[0]?.id ?? DEFAULT_COMPANY_ID;

    const drillActor: RequestActor = {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Monthly Restore Drill",
      email: "drill@system.local",
      role: "admin",
      activeCompanyId,
      companyIds: [activeCompanyId],
      branchScopeMode: "all",
      branchIds: [],
      defaultBranchId: null,
      permissions: {},
    };

    const [reconciliation, setupHealth, auditChain, counts] = await Promise.all([
      getSubledgerReconciliation(db, drillActor),
      getAccountingSetupHealth(db, drillActor),
      verifyAuditLogChain(db, activeCompanyId),
      db.execute<{
        users_cnt: number;
        journals_cnt: number;
        invoices_cnt: number;
        audit_cnt: number;
      }>(sql`
        SELECT
          (SELECT count(*)::int FROM public.users) AS users_cnt,
          (SELECT count(*)::int FROM public.journal_entries) AS journals_cnt,
          (SELECT count(*)::int FROM public.sales_invoices) AS invoices_cnt,
          (SELECT count(*)::int FROM public.audit_logs) AS audit_cnt
      `),
    ]);

    const rowCounts = counts[0] ?? { users_cnt: 0, journals_cnt: 0, invoices_cnt: 0, audit_cnt: 0 };
    const failingControls = reconciliation.items.filter((i) => !i.isReconciled).map((i) => i.key);
    const ok = reconciliation.allReconciled && setupHealth.healthy && auditChain.valid;

    const report = {
      ok,
      companyId: activeCompanyId,
      rowCounts: {
        users: Number(rowCounts.users_cnt),
        journalEntries: Number(rowCounts.journals_cnt),
        salesInvoices: Number(rowCounts.invoices_cnt),
        auditLogs: Number(rowCounts.audit_cnt),
      },
      reconciliation: {
        allReconciled: reconciliation.allReconciled,
        totalControls: reconciliation.items.length,
        passedControls: reconciliation.items.length - failingControls.length,
        failingControls,
      },
      setupHealth: {
        healthy: setupHealth.healthy,
        totalMappings: setupHealth.totalMappings,
        validMappings: setupHealth.validMappings,
        issueCount: setupHealth.issues.length,
      },
      auditChain: {
        valid: auditChain.valid,
        totalChainedRows: auditChain.totalChainedRows,
        firstBrokenId: auditChain.firstBrokenId,
        reason: auditChain.reason,
      },
    };

    console.log(JSON.stringify(report, null, 2));
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error("[verify-restored-db] ERROR:", err);
  process.exit(1);
});
