import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

function extractSessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === "erp_session")?.value;
}

describe.skipIf(!testDbUrl)(
  "Audit hardening — client audit allow-list, legacy role permissions RBAC, sanitized template emails & migration idempotency",
  () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { buildApp } = await import("../../src/app.ts");
      app = await buildApp({ logger: false });
      await app.ready();

      const { getDb } = await import("../../src/db/index.ts");
      const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
      await assertTestDatabaseName(getDb(), testDbUrl!);
    });

    afterAll(async () => {
      const { setEmailTransportForTests } = await import("../../src/services/email.service.ts");
      setEmailTransportForTests(null);
      if (app) await app.close();
      const { closeDatabase } = await import("../../src/db/index.ts");
      await closeDatabase();
    });

    it("enforces POST /api/audit-logs allow-list + branch scope, deprecated /api/roles/permissions RBAC, sanitized email HTML, and concurrent migration idempotency", async () => {
      const { runMigrations } = await import("../../src/db/migrate.ts");
      const { setEmailTransportForTests } = await import("../../src/services/email.service.ts");
      const { getDb } = await import("../../src/db/index.ts");
      const { resetTestDatabase } = await import("../helpers/db-reset.ts");
      const db = getDb();
      await resetTestDatabase(db);

      // 1. Bootstrap admin + create a second branch + create restricted user assigned only to branch 1
      const adminSignup = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: {
          name: "Hardening Admin",
          email: "hardening-admin@test.local",
          password: "AdminPassword123!",
        },
      });
      expect(adminSignup.statusCode).toBe(201);
      const adminCookie = extractSessionCookie(adminSignup)!;
      const hqBranchId = adminSignup.json().user.defaultBranchId as string;

      const branch2Res = await app.inject({
        method: "POST",
        url: "/api/branches",
        cookies: { erp_session: adminCookie },
        payload: { code: "BR-H2", name: "Restricted Branch 2", branchType: "retail" },
      });
      expect(branch2Res.statusCode).toBe(201);
      const branch2Id = branch2Res.json().branch.id as string;

      const createStaffRes = await app.inject({
        method: "POST",
        url: "/api/users",
        cookies: { erp_session: adminCookie },
        payload: {
          name: "Branch1 Clerk",
          email: "hardening-clerk@test.local",
          password: "ClerkPassword123!",
          role: "user",
          branchScopeMode: "selected",
          branchIds: [hqBranchId],
          defaultBranchId: hqBranchId,
        },
      });
      expect(createStaffRes.statusCode).toBe(201);

      const staffLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "hardening-clerk@test.local",
          password: "ClerkPassword123!",
        },
      });
      expect(staffLogin.statusCode).toBe(200);
      const staffCookie = extractSessionCookie(staffLogin)!;

      // 2. POST /api/audit-logs: unauthenticated 401, disallowed action 400, unauthorized branch 403, allowed action + branch 201
      const unauthAudit = await app.inject({
        method: "POST",
        url: "/api/audit-logs",
        payload: { module: "sales", action: "ui.document_printed" },
      });
      expect(unauthAudit.statusCode).toBe(401);

      const disallowedAction = await app.inject({
        method: "POST",
        url: "/api/audit-logs",
        cookies: { erp_session: staffCookie },
        payload: {
          module: "users",
          action: "user.role_updated",
          branchId: hqBranchId,
        },
      });
      expect(disallowedAction.statusCode).toBe(400);
      expect(disallowedAction.json().code).toBe("AUDIT_ACTION_NOT_ALLOWED");

      const forbiddenBranch = await app.inject({
        method: "POST",
        url: "/api/audit-logs",
        cookies: { erp_session: staffCookie },
        payload: {
          module: "sales",
          action: "ui.document_printed",
          branchId: branch2Id,
        },
      });
      expect(forbiddenBranch.statusCode).toBe(403);

      const allowedAudit = await app.inject({
        method: "POST",
        url: "/api/audit-logs",
        cookies: { erp_session: staffCookie },
        payload: {
          module: "sales",
          action: "ui.document_printed",
          entity: "INV-0001",
          branchId: hqBranchId,
        },
      });
      expect(allowedAudit.statusCode).toBe(201);

      // 3. Deprecated /api/roles/permissions: requires roles.view on GET, admin on PUT, sets Deprecation header
      const staffGetPerms = await app.inject({
        method: "GET",
        url: "/api/roles/permissions",
        cookies: { erp_session: staffCookie },
      });
      expect(staffGetPerms.statusCode).toBe(403);

      const adminGetPerms = await app.inject({
        method: "GET",
        url: "/api/roles/permissions",
        cookies: { erp_session: adminCookie },
      });
      expect(adminGetPerms.statusCode).toBe(200);
      expect(adminGetPerms.headers.deprecation).toBe("true");

      const staffPutPerms = await app.inject({
        method: "PUT",
        url: "/api/roles/permissions",
        cookies: { erp_session: staffCookie },
        payload: { matrix: adminGetPerms.json().matrix },
      });
      expect(staffPutPerms.statusCode).toBe(403);

      const adminPutPerms = await app.inject({
        method: "PUT",
        url: "/api/roles/permissions",
        cookies: { erp_session: adminCookie },
        payload: { matrix: adminGetPerms.json().matrix },
      });
      expect(adminPutPerms.statusCode).toBe(200);
      expect(adminPutPerms.headers.deprecation).toBe("true");

      // 4. Print template email HTML sanitization end-to-end
      let capturedHtml = "";
      setEmailTransportForTests({
        sendMail: async (msg) => {
          capturedHtml = msg.html ?? "";
          return { messageId: "test-sanitized-msg" };
        },
      });

      const tplRes = await app.inject({
        method: "POST",
        url: "/api/print-templates",
        cookies: { erp_session: adminCookie },
        payload: {
          documentType: "invoice",
          name: "XSS Test Template",
          headerHtml:
            '<strong>Safe Header</strong><script>alert(1)</script><img src="https://cdn.example.com/a.png" onerror="alert(2)">',
          footerHtml: '<a href="javascript:alert(3)">Click</a><p onclick="bad()">Footer Note</p>',
          isDefault: true,
        },
      });
      expect(tplRes.statusCode).toBe(201);

      const custRes = await app.inject({
        method: "POST",
        url: "/api/customers",
        cookies: { erp_session: adminCookie },
        payload: { name: "Email Customer", email: "cust@example.com" },
      });
      expect(custRes.statusCode).toBe(201);
      const customerId = custRes.json().customer.id as string;

      const prodRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: adminCookie },
        payload: { sku: "SKU-EMAIL-1", name: "Email Product", sellingPrice: 100, costPrice: 50 },
      });
      expect(prodRes.statusCode).toBe(201);
      const productId = prodRes.json().product.id as string;

      const invRes = await app.inject({
        method: "POST",
        url: "/api/sales-invoices",
        cookies: { erp_session: adminCookie },
        payload: {
          customerId,
          branchId: hqBranchId,
          status: "Draft",
          dueDate: "2027-12-31",
          lines: [{ productId, quantity: 1, unitPrice: 100, taxRate: 0 }],
        },
      });
      expect(invRes.statusCode).toBe(201);
      const invoiceId = invRes.json().invoice.id as string;

      const emailRes = await app.inject({
        method: "POST",
        url: `/api/documents/invoice/${invoiceId}/email`,
        cookies: { erp_session: adminCookie },
        payload: {
          to: "cust@example.com",
          subject: "Your Invoice",
        },
      });
      expect(emailRes.statusCode).toBe(200);
      expect(capturedHtml).toContain("<strong>Safe Header</strong>");
      expect(capturedHtml).toContain("<p>Footer Note</p>");
      expect(capturedHtml.toLowerCase()).not.toContain("<script");
      expect(capturedHtml.toLowerCase()).not.toContain("onerror");
      expect(capturedHtml.toLowerCase()).not.toContain("onclick");
      expect(capturedHtml.toLowerCase()).not.toContain("javascript:");

      // 5. Dedicated-connection advisory lock & concurrent migration idempotency proof
      const { MIGRATION_ADVISORY_LOCK_KEY } = await import("../../src/db/migrate.ts");
      const postgres = (await import("postgres")).default;
      const blockerSql = postgres(testDbUrl!, { max: 1, prepare: false });
      const blockerConn = await blockerSql.reserve();
      let migrationResolved = false;
      try {
        await blockerConn`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
        const [heldBefore] = await blockerConn<{ cnt: number }[]>`
          SELECT count(*)::int AS cnt
          FROM pg_locks
          WHERE locktype = 'advisory' AND objid = ${MIGRATION_ADVISORY_LOCK_KEY} AND granted = true
        `;
        expect(heldBefore?.cnt).toBe(1);

        // Start runMigrations while blockerConn holds the advisory lock — it must wait
        let migrationResult: { lockPid: number; unlockPid: number; unlocked: boolean } | null = null;
        const pendingMigration = runMigrations(testDbUrl!).then((res) => {
          migrationResult = res;
          migrationResolved = true;
        });
        await new Promise((r) => setTimeout(r, 250));
        expect(migrationResolved).toBe(false);

        // Release blocker lock -> runMigrations acquires on its own dedicated connection, finishes, and releases
        await blockerConn`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
        await pendingMigration;
        expect(migrationResolved).toBe(true);
        expect(migrationResult).not.toBeNull();
        expect(migrationResult!.lockPid).toBeGreaterThan(0);
        expect(migrationResult!.unlockPid).toBe(migrationResult!.lockPid);
        expect(migrationResult!.unlocked).toBe(true);

        // Confirm zero lingering advisory locks (proves lock & unlock ran on the exact same dedicated session)
        const [heldAfter] = await blockerConn<{ cnt: number }[]>`
          SELECT count(*)::int AS cnt
          FROM pg_locks
          WHERE locktype = 'advisory' AND objid = ${MIGRATION_ADVISORY_LOCK_KEY} AND granted = true
        `;
        expect(heldAfter?.cnt).toBe(0);
      } finally {
        await blockerConn`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.catch(() => {});
        blockerConn.release();
        await blockerSql.end({ timeout: 5 });
      }

      const [beforeMig] = await db.execute<{ cnt: number }>(
        sql`SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations`
      );
      await Promise.all([runMigrations(testDbUrl!), runMigrations(testDbUrl!)]);
      const [afterMig] = await db.execute<{ cnt: number }>(
        sql`SELECT count(*)::int AS cnt FROM drizzle.__drizzle_migrations`
      );
      expect(afterMig?.cnt).toBe(beforeMig?.cnt);
      expect(afterMig?.cnt).toBeGreaterThanOrEqual(8);
    }, 60_000);
  }
);
