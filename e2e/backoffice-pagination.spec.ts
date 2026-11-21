import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

interface PageInfoDto {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface PaginatedEndpointSpec {
  route: string;
  apiPath: string;
  legacyKey: string;
  needle: string;
}

const SEED_COUNT = 28;
const NEEDLE_INDEX = 17;

test.describe("R6 Back-Office Offset Pagination & Server-Side Search E2E", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("paginates and server-searches across Products, Customers, Vendors, Sales Orders, Purchase Orders, and Vendor Bills and honors R6 API contracts", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);

    // 1. Bootstrap admin & get HQ branch
    await signupFirstAdmin(page, {
      name: "Pagination Admin",
      email: "pagination-admin@test.local",
      password: "Password123!",
    });

    const branchesRes = await page.request.get("/api/branches");
    expect(branchesRes.ok()).toBe(true);
    const hqId = ((await branchesRes.json()) as { branches: Array<{ id: string }> }).branches[0].id;

    // 2. Seed 28 records for each of the 6 R6 entities
    let baseProductId = "";
    let baseCustomerId = "";
    let baseVendorId = "";
    let needleSoNumber = "";
    let needlePoNumber = "";
    let needleBillNumber = "";

    for (let i = 1; i <= SEED_COUNT; i += 1) {
      const pad = String(i).padStart(2, "0");
      const isNeedle = i === NEEDLE_INDEX;

      const [prodRes, custRes, vendRes] = await Promise.all([
        apiRequest(page, "POST", "/api/products", {
          sku: `PAG-SKU-${pad}`,
          name: isNeedle ? `Paginated Product ${pad} NEEDLE_PROD_X9` : `Paginated Product ${pad}`,
          costPrice: 10 + i,
          sellingPrice: 25 + i,
          initialStock: i === 1 ? [{ branchId: hqId, quantity: 500, unitCost: 11 }] : [],
        }),
        apiRequest(page, "POST", "/api/customers", {
          name: isNeedle ? `Paginated Customer ${pad} NEEDLE_CUST_X9` : `Paginated Customer ${pad}`,
        }),
        apiRequest(page, "POST", "/api/vendors", {
          name: isNeedle ? `Paginated Vendor ${pad} NEEDLE_VEND_X9` : `Paginated Vendor ${pad}`,
        }),
      ]);
      expect(prodRes.status()).toBe(201);
      expect(custRes.status()).toBe(201);
      expect(vendRes.status()).toBe(201);
      if (i === 1) {
        baseProductId = ((await prodRes.json()) as { product: { id: string } }).product.id;
        baseCustomerId = ((await custRes.json()) as { customer: { id: string } }).customer.id;
        baseVendorId = ((await vendRes.json()) as { vendor: { id: string } }).vendor.id;
      }
    }

    for (let i = 1; i <= SEED_COUNT; i += 1) {
      const isNeedle = i === NEEDLE_INDEX;

      const [soRes, poRes, billRes] = await Promise.all([
        apiRequest(page, "POST", "/api/sales-orders", {
          customerId: baseCustomerId,
          branchId: hqId,
          status: "Draft",
          lines: [{ productId: baseProductId, quantity: 1, unitPrice: 30 }],
        }),
        apiRequest(page, "POST", "/api/purchase-orders", {
          vendorId: baseVendorId,
          branchId: hqId,
          status: "Draft",
          lines: [{ productId: baseProductId, quantity: 1, unitCost: 15 }],
        }),
        apiRequest(page, "POST", "/api/vendor-bills", {
          vendorId: baseVendorId,
          branchId: hqId,
          dueDate: "2026-12-31",
          lines: [{ productId: baseProductId, quantity: 1, unitCost: 15 }],
        }),
      ]);
      expect(soRes.status()).toBe(201);
      expect(poRes.status()).toBe(201);
      expect(billRes.status()).toBe(201);
      if (isNeedle) {
        const so = ((await soRes.json()) as { salesOrder: { soNumber: string } }).salesOrder;
        const po = ((await poRes.json()) as { purchaseOrder: { poNumber: string } }).purchaseOrder;
        const bill = ((await billRes.json()) as { bill: { billNumber: string } }).bill;
        needleSoNumber = so.soNumber;
        needlePoNumber = po.poNumber;
        needleBillNumber = bill.billNumber;
      }
    }

    const pagesToVerify: PaginatedEndpointSpec[] = [
      {
        route: "/products",
        apiPath: "/api/products",
        legacyKey: "products",
        needle: "NEEDLE_PROD_X9",
      },
      {
        route: "/sales/customers",
        apiPath: "/api/customers",
        legacyKey: "customers",
        needle: "NEEDLE_CUST_X9",
      },
      {
        route: "/purchases/vendors",
        apiPath: "/api/vendors",
        legacyKey: "vendors",
        needle: "NEEDLE_VEND_X9",
      },
      {
        route: "/sales/orders",
        apiPath: "/api/sales-orders",
        legacyKey: "salesOrders",
        needle: needleSoNumber,
      },
      {
        route: "/purchases/orders",
        apiPath: "/api/purchase-orders",
        legacyKey: "purchaseOrders",
        needle: needlePoNumber,
      },
      {
        route: "/purchases/bills",
        apiPath: "/api/vendor-bills",
        legacyKey: "bills",
        needle: needleBillNumber,
      },
    ];

    // 3. Verify <TablePagination /> + server-side search on all 6 back-office UI pages
    for (const spec of pagesToVerify) {
      await page.goto(spec.route);

      await expect(page.getByText(/Showing \d+[–-]\d+ of \d+/i)).toBeVisible();
      const prevLink = page.getByLabel("Go to previous page");
      const nextLink = page.getByLabel("Go to next page");
      await expect(prevLink).toHaveAttribute("aria-disabled", "true");
      await expect(nextLink).toBeVisible();

      // Page 1 -> Page 2
      await nextLink.click();
      const activePage = page.locator('nav[aria-label="pagination"] a[aria-current="page"]');
      await expect(activePage).toHaveText("2");

      // Page 2 -> Page 1
      await prevLink.click();
      await expect(activePage).toHaveText("1");

      // Server-side search narrows rows via API q= parameter
      const searchInput = page.getByPlaceholder(/Search/i).first();
      await expect(searchInput).toBeVisible();
      const searchResponsePromise = page.waitForResponse(
        (r) =>
          r.url().includes(spec.apiPath) &&
          (r.url().includes("q=") || r.url().includes("search=")) &&
          r.ok()
      );
      await searchInput.fill(spec.needle);
      await searchResponsePromise;
      await expect(page.getByText(spec.needle).first()).toBeVisible();

      // Reset search cleanly
      await searchInput.fill("");
    }

    // 4. Verify R6 API boundary & backward-compatibility contracts on all 6 endpoints
    for (const spec of pagesToVerify) {
      // Omitted paging -> pageSize: 200 and legacy array key preserved alongside items & pageInfo
      const defaultRes = await page.request.get(spec.apiPath);
      expect(defaultRes.status()).toBe(200);
      const defaultJson = (await defaultRes.json()) as Record<string, unknown>;
      expect(Array.isArray(defaultJson.items)).toBe(true);
      expect(Array.isArray(defaultJson[spec.legacyKey])).toBe(true);
      const defaultItems = defaultJson.items as Array<{ id: string }>;
      expect(defaultItems.length).toBeGreaterThanOrEqual(SEED_COUNT);
      const defaultInfo = defaultJson.pageInfo as PageInfoDto;
      expect(defaultInfo.page).toBe(1);
      expect(defaultInfo.pageSize).toBe(200);
      expect(defaultInfo.total).toBeGreaterThanOrEqual(SEED_COUNT);

      // Disjoint pages with explicit paging
      const page1Res = await page.request.get(`${spec.apiPath}?page=1&pageSize=10`);
      const page2Res = await page.request.get(`${spec.apiPath}?page=2&pageSize=10`);
      expect(page1Res.status()).toBe(200);
      expect(page2Res.status()).toBe(200);
      const p1Json = (await page1Res.json()) as { items: Array<{ id: string }>; pageInfo: PageInfoDto };
      const p2Json = (await page2Res.json()) as { items: Array<{ id: string }>; pageInfo: PageInfoDto };
      expect(p1Json.items.length).toBe(10);
      expect(p1Json.pageInfo.hasNext).toBe(true);
      expect(p1Json.pageInfo.hasPrev).toBe(false);
      expect(p2Json.pageInfo.hasPrev).toBe(true);
      const p1Ids = new Set(p1Json.items.map((x) => x.id));
      expect(p2Json.items.every((x) => !p1Ids.has(x.id))).toBe(true);

      // Out-of-range page -> empty items + hasNext: false
      const highPageRes = await page.request.get(`${spec.apiPath}?page=999&pageSize=25`);
      expect(highPageRes.status()).toBe(200);
      const highPageJson = (await highPageRes.json()) as { items: unknown[]; pageInfo: PageInfoDto };
      expect(highPageJson.items).toEqual([]);
      expect(highPageJson.pageInfo.hasNext).toBe(false);
      expect(highPageJson.pageInfo.total).toBeGreaterThanOrEqual(SEED_COUNT);

      // Invalid paging -> 400
      const zeroPageRes = await page.request.get(`${spec.apiPath}?page=0`);
      expect(zeroPageRes.status()).toBe(400);
      const overSizeRes = await page.request.get(`${spec.apiPath}?pageSize=201`);
      expect(overSizeRes.status()).toBe(400);

      // Normalized "all" filters & empty search -> 200
      const allFilterRes = await page.request.get(`${spec.apiPath}?status=all&branchId=all&q=`);
      expect(allFilterRes.status()).toBe(200);

      // Zero-match search -> empty items, total 0
      const emptySearchRes = await page.request.get(
        `${spec.apiPath}?q=NONEXISTENT_NEEDLE_ZZZ_999`
      );
      expect(emptySearchRes.status()).toBe(200);
      const emptySearchJson = (await emptySearchRes.json()) as {
        items: unknown[];
        pageInfo: PageInfoDto;
      };
      expect(emptySearchJson.items).toEqual([]);
      expect(emptySearchJson.pageInfo.total).toBe(0);
    }

    expect(pageErrors).toEqual([]);
  });
});
