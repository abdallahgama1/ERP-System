import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";
import { sendEmail } from "../../src/services/email.service.ts";

describe("Fastify HTTP surface & security boundaries", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports health cleanly regardless of whether DATABASE_URL is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(typeof body.ok).toBe("boolean");
    expect(body.service).toBe("erp-api");
    expect(typeof body.database?.configured).toBe("boolean");
    expect(typeof body.database?.connected).toBe("boolean");
  });

  it("returns null user on unauthenticated /api/auth/me", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
  });

  it("blocks unauthenticated access to protected ERP routes with 401", async () => {
    const protectedEndpoints = [
      { method: "GET" as const, url: "/api/products" },
      { method: "GET" as const, url: "/api/branches" },
      { method: "GET" as const, url: "/api/sales-orders" },
      { method: "GET" as const, url: "/api/purchase-orders" },
      { method: "GET" as const, url: "/api/users" },
      { method: "GET" as const, url: "/api/sessions" },
      { method: "GET" as const, url: "/api/accounting/accounts" },
      { method: "GET" as const, url: "/api/accounting/journal-entries" },
      { method: "GET" as const, url: "/api/accounting/fiscal-years" },
      { method: "GET" as const, url: "/api/accounting/reports/trial-balance" },
      { method: "GET" as const, url: "/api/accounting/reports/profit-loss" },
      { method: "GET" as const, url: "/api/accounting/reports/balance-sheet" },
      { method: "GET" as const, url: "/api/tax-codes" },
      { method: "GET" as const, url: "/api/currencies" },
      { method: "GET" as const, url: "/api/approvals/rules" },
      { method: "GET" as const, url: "/api/approvals/requests" },
      { method: "POST" as const, url: "/api/admin/jobs/overdue-sweep" },
      { method: "POST" as const, url: "/api/admin/jobs/housekeeping" },
      { method: "GET" as const, url: "/api/tracking/lots" },
      { method: "GET" as const, url: "/api/tracking/serials" },
      { method: "GET" as const, url: "/api/manufacturing/boms" },
      { method: "GET" as const, url: "/api/manufacturing/work-orders" },
    ];

    for (const endpoint of protectedEndpoints) {
      const res = await app.inject(endpoint);
      expect(res.statusCode).toBe(401);
    }
  });

  it("does not expose removed /api/admin/seed-demo endpoint", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/seed-demo" });
    expect(res.statusCode).toBe(404);
  });

  it("attaches Helmet security headers and skips SMTP gracefully when unconfigured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeTruthy();

    const mailRes = await sendEmail({
      to: "ops@test.local",
      subject: "Smoke test",
      text: "Testing safe fallback",
    });
    expect(mailRes.sent).toBe(false);
    expect(mailRes.skippedReason).toBeTruthy();
  });
});
