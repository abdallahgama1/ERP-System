import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

interface PageInfoDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

describe.skipIf(!testDbUrl)("R6 Back-Office Offset Pagination & Server-Side Search Integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let hqBranchId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    app = await buildApp({ logger: false });
    await app.ready();

    const expectedDb = new URL(testDbUrl!).pathname.replace(/^\//, "");
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();
    const check = await db.execute(sql`SELECT current_database() AS db`);
    const activeDb = (check[0] as { db?: string } | undefined)?.db;
    if (activeDb !== expectedDb) {
      throw new Error(`Refusing to run destructive integration tests against '${activeDb}' instead of '${expectedDb}'`);
    }

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);

    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Pagination Admin", email: "r6-pagination@test.local", password: "Password123!" },
    });
    expect(adminSignup.statusCode).toBe(201);
    adminCookie = adminSignup.cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
    });
    expect(branchesRes.statusCode).toBe(200);
    hqBranchId = branchesRes.json().branches[0].id;
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("enforces R6 offset pagination, legacy array keys, disjoint pages, 400 validation, and ILIKE search across all 6 endpoints", async () => {
    const SEED_COUNT = 4;
    const NEEDLE_IDX = 3;
    let baseProductId = "";
    let baseCustomerId = "";
    let baseVendorId = "";
    let needleSoNumber = "";
    let needlePoNumber = "";
    let needleBillNumber = "";

    for (let i = 1; i <= SEED_COUNT; i += 1) {
      const pad = String(i).padStart(2, "0");
      const isNeedle = i === NEEDLE_IDX;

      const [prodRes, custRes, vendRes] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/products",
          cookies: { erp_session: adminCookie },
          payload: {
            sku: `R6-SKU-${pad}`,
            name: isNeedle ? `R6 Product ${pad} NEEDLE_PROD_R6` : `R6 Product ${pad}`,
            costPrice: 10 + i,
            sellingPrice: 25 + i,
            initialStock: i === 1 ? [{ branchId: hqBranchId, quantity: 100, unitCost: 11 }] : [],
          },
        }),
        app.inject({
          method: "POST",
          url: "/api/customers",
          cookies: { erp_session: adminCookie },
          payload: {
            name: isNeedle ? `R6 Customer ${pad} NEEDLE_CUST_R6` : `R6 Customer ${pad}`,
          },
        }),
        app.inject({
          method: "POST",
          url: "/api/vendors",
          cookies: { erp_session: adminCookie },
          payload: {
            name: isNeedle ? `R6 Vendor ${pad} NEEDLE_VEND_R6` : `R6 Vendor ${pad}`,
          },
        }),
      ]);
      expect(prodRes.statusCode).toBe(201);
      expect(custRes.statusCode).toBe(201);
      expect(vendRes.statusCode).toBe(201);
      if (i === 1) {
        baseProductId = prodRes.json().product.id;
        baseCustomerId = custRes.json().customer.id;
        baseVendorId = vendRes.json().vendor.id;
      }
    }

    for (let i = 1; i <= SEED_COUNT; i += 1) {
      const isNeedle = i === NEEDLE_IDX;

      const [soRes, poRes, billRes] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/sales-orders",
          cookies: { erp_session: adminCookie },
          payload: {
            customerId: baseCustomerId,
            branchId: hqBranchId,
            status: "Draft",
            lines: [{ productId: baseProductId, quantity: 1, unitPrice: 30 }],
          },
        }),
        app.inject({
          method: "POST",
          url: "/api/purchase-orders",
          cookies: { erp_session: adminCookie },
          payload: {
            vendorId: baseVendorId,
            branchId: hqBranchId,
            status: "Draft",
            lines: [{ productId: baseProductId, quantity: 1, unitCost: 15 }],
          },
        }),
        app.inject({
          method: "POST",
          url: "/api/vendor-bills",
          cookies: { erp_session: adminCookie },
          payload: {
            vendorId: baseVendorId,
            branchId: hqBranchId,
            dueDate: "2026-12-31",
            lines: [{ productId: baseProductId, quantity: 1, unitCost: 15 }],
          },
        }),
      ]);
      expect(soRes.statusCode).toBe(201);
      expect(poRes.statusCode).toBe(201);
      expect(billRes.statusCode).toBe(201);
      if (isNeedle) {
        needleSoNumber = soRes.json().salesOrder.soNumber;
        needlePoNumber = poRes.json().purchaseOrder.poNumber;
        needleBillNumber = billRes.json().bill.billNumber;
      }
    }

    const specs = [
      { apiPath: "/api/products", legacyKey: "products", needle: "NEEDLE_PROD_R6" },
      { apiPath: "/api/customers", legacyKey: "customers", needle: "NEEDLE_CUST_R6" },
      { apiPath: "/api/vendors", legacyKey: "vendors", needle: "NEEDLE_VEND_R6" },
      { apiPath: "/api/sales-orders", legacyKey: "salesOrders", needle: needleSoNumber },
      { apiPath: "/api/purchase-orders", legacyKey: "purchaseOrders", needle: needlePoNumber },
      { apiPath: "/api/vendor-bills", legacyKey: "bills", needle: needleBillNumber },
    ];

    for (const spec of specs) {
      // 1. Default omitted paging -> pageSize: 200 + legacy key preserved
      const defaultRes = await app.inject({
        method: "GET",
        url: spec.apiPath,
        cookies: { erp_session: adminCookie },
      });
      expect(defaultRes.statusCode).toBe(200);
      const defaultJson = defaultRes.json() as Record<string, unknown>;
      expect(Array.isArray(defaultJson.items)).toBe(true);
      expect(Array.isArray(defaultJson[spec.legacyKey])).toBe(true);
      const defaultInfo = defaultJson.pageInfo as PageInfoDto;
      expect(defaultInfo.page).toBe(1);
      expect(defaultInfo.pageSize).toBe(200);
      expect(defaultInfo.total).toBeGreaterThanOrEqual(SEED_COUNT);

      // 2. Disjoint page 1 & page 2
      const [p1Res, p2Res] = await Promise.all([
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?page=1&pageSize=2`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?page=2&pageSize=2`,
          cookies: { erp_session: adminCookie },
        }),
      ]);
      expect(p1Res.statusCode).toBe(200);
      expect(p2Res.statusCode).toBe(200);
      const p1Json = p1Res.json() as { items: Array<{ id: string }>; pageInfo: PageInfoDto };
      const p2Json = p2Res.json() as { items: Array<{ id: string }>; pageInfo: PageInfoDto };
      expect(p1Json.items).toHaveLength(2);
      expect(p2Json.items).toHaveLength(2);
      expect(p1Json.pageInfo.hasNext).toBe(true);
      expect(p1Json.pageInfo.hasPrev).toBe(false);
      expect(p2Json.pageInfo.hasPrev).toBe(true);
      const p1Ids = new Set(p1Json.items.map((x) => x.id));
      expect(p2Json.items.every((x) => !p1Ids.has(x.id))).toBe(true);

      // 3. Out-of-range page=999, 4. Invalid paging -> 400, 5. Normalized all -> 200, 6. Search, 7. Zero-match
      const [highRes, zeroRes, overRes, allRes, searchRes, emptyRes] = await Promise.all([
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?page=999&pageSize=25`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?page=0`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?pageSize=201`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?status=all&branchId=all&q=`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?q=${encodeURIComponent(spec.needle)}`,
          cookies: { erp_session: adminCookie },
        }),
        app.inject({
          method: "GET",
          url: `${spec.apiPath}?q=NONEXISTENT_NEEDLE_ZZZ_999`,
          cookies: { erp_session: adminCookie },
        }),
      ]);
      expect(highRes.statusCode).toBe(200);
      expect(highRes.json().items).toEqual([]);
      expect(highRes.json().pageInfo.hasNext).toBe(false);
      expect(zeroRes.statusCode).toBe(400);
      expect(overRes.statusCode).toBe(400);
      expect(allRes.statusCode).toBe(200);
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().items.length).toBe(1);
      expect(searchRes.json().pageInfo.total).toBe(1);
      expect(emptyRes.statusCode).toBe(200);
      expect(emptyRes.json().items).toEqual([]);
      expect(emptyRes.json().pageInfo.total).toBe(0);
    }
  });
});
