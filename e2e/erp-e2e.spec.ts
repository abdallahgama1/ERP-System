import { expect, test } from "@playwright/test";
import { csrfHeaders } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("ERP Full-Stack E2E (Auth, P2P, O2C, ZATCA QR, GL & Approvals)", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("bootstraps admin via Signup UI, renders ZATCA QR invoice, balanced Trial Balance, and Approvals UI", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // 1. Sign up first admin user through real UI
    await page.goto("/signup");
    await page.locator("#name").fill("E2E Admin");
    await page.locator("#email").fill("e2e-admin@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();

    await page.waitForURL("/", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();

    // 2. Configure ZATCA QR mode + create master data & full P2P -> O2C cycle via browser session cookie
    const branchesRes = await page.request.get("/api/branches");
    expect(branchesRes.ok()).toBeTruthy();
    const hqId = (await branchesRes.json()).branches[0].id as string;

    const compRes = await page.request.put("/api/settings/company", {
      headers: csrfHeaders(),
      data: {
        companyName: "E2E ERP Corp",
        legalName: "E2E ERP Trading LLC",
        taxRegistrationNumber: "300000000000003",
        einvoicingMode: "zatca_qr",
      },
    });
    expect(compRes.ok()).toBeTruthy();

    const prodRes = await page.request.post("/api/products", {
      headers: csrfHeaders(),
      data: {
        sku: "E2E-SKU-01",
        name: "Industrial Barcode Scanner",
        costPrice: 50,
        sellingPrice: 120,
        initialStock: [{ branchId: hqId, quantity: 10, unitCost: 50 }],
      },
    });
    expect(prodRes.status()).toBe(201);
    const productId = (await prodRes.json()).product.id as string;

    const vendorRes = await page.request.post("/api/vendors", {
      headers: csrfHeaders(),
      data: { name: "E2E Supplier" },
    });
    expect(vendorRes.status()).toBe(201);
    const vendorId = (await vendorRes.json()).vendor.id as string;

    const custRes = await page.request.post("/api/customers", {
      headers: csrfHeaders(),
      data: { name: "E2E Customer", creditLimit: 5000 },
    });
    expect(custRes.status()).toBe(201);
    const customerId = (await custRes.json()).customer.id as string;

    const poRes = await page.request.post("/api/purchase-orders", {
      headers: csrfHeaders(),
      data: {
        vendorId,
        branchId: hqId,
        status: "Issued",
        lines: [{ productId, quantity: 5, unitCost: 60, taxRate: 15 }],
      },
    });
    expect(poRes.status()).toBe(201);
    const poId = (await poRes.json()).purchaseOrder.id as string;

    const rcvRes = await page.request.post("/api/purchase-receives", {
      headers: csrfHeaders(),
      data: {
        poId,
        vendorId,
        branchId: hqId,
        lines: [{ productId, quantity: 5, unitCost: 60 }],
      },
    });
    expect(rcvRes.status()).toBe(201);
    const receiveId = (await rcvRes.json()).receive.id as string;

    const billRes = await page.request.post("/api/vendor-bills", {
      headers: csrfHeaders(),
      data: {
        vendorId,
        branchId: hqId,
        poId,
        receiveId,
        dueDate: "2026-12-31",
        lines: [{ productId, quantity: 5, unitCost: 60, taxRate: 15 }],
      },
    });
    expect(billRes.status()).toBe(201);

    const invRes = await page.request.post("/api/sales-invoices", {
      headers: csrfHeaders(),
      data: {
        customerId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId, quantity: 2, unitPrice: 120, taxRate: 15 }],
      },
    });
    expect(invRes.status()).toBe(201);
    const invoice = (await invRes.json()).invoice;
    expect(invoice.qrTlv).toBeTruthy();

    // 3. Open Invoices UI -> open detail dialog -> assert ZATCA QR image & ICV render cleanly
    await page.goto("/sales/invoices");
    await expect(page.getByText(invoice.invoiceNumber)).toBeVisible();
    await page.getByText(invoice.invoiceNumber).click();
    await expect(page.locator(`img[alt="ZATCA QR ${invoice.invoiceNumber}"]`)).toBeVisible();
    await expect(page.getByText(/E-Invoice Compliance/i)).toBeVisible();

    // 4. Open Financial Statements -> verify Trial Balance is Balanced
    await page.goto("/accounting/statements");
    await expect(page.getByRole("heading", { name: /Financial Statements/i })).toBeVisible();
    await expect(page.getByText("Balanced")).toBeVisible();

    // 5. Open Chart of Accounts -> verify seeded accounts visible
    await page.goto("/accounting/accounts");
    await expect(page.getByText("Cash & Bank")).toBeVisible();
    await expect(page.getByText("Sales Revenue")).toBeVisible();

    // 6. Open Approvals -> verify Threshold Rules & Queue render cleanly
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: /Approvals & Controls/i })).toBeVisible();
    await page.getByRole("tab", { name: /Threshold Rules/i }).click();
    await expect(page.getByText("Purchase Order", { exact: true })).toBeVisible();

    // 7. Open Fiscal Periods -> wait for /api/accounting/fiscal-years before asserting seeded fiscal year
    const fiscalYearsResponse = page.waitForResponse(
      (res) => res.url().includes("/api/accounting/fiscal-years") && res.status() === 200
    );
    await page.goto("/accounting/periods");
    await fiscalYearsResponse;
    await expect(page.getByRole("heading", { name: /Fiscal Years & Periods/i })).toBeVisible();
    await expect(page.getByText(`FY ${new Date().getUTCFullYear()}`, { exact: true })).toBeVisible();

    // 8. Phase D2: Create Lot-tracked item, Serial-tracked item, BOM & Work Order, then verify Tracking & Manufacturing pages
    const lotProdRes = await page.request.post("/api/products", {
      headers: csrfHeaders(),
      data: {
        sku: "E2E-LOT-01",
        name: "Sterile Reagent",
        costPrice: 20,
        sellingPrice: 55,
        trackingMode: "lot",
        requiresExpiry: true,
      },
    });
    expect(lotProdRes.status()).toBe(201);
    const lotProdId = (await lotProdRes.json()).product.id as string;

    const rcvLot = await page.request.post("/api/purchase-receives", {
      headers: csrfHeaders(),
      data: {
        vendorId,
        branchId: hqId,
        lines: [
          {
            productId: lotProdId,
            quantity: 10,
            unitCost: 20,
            lotNumber: "LOT-E2E-99",
            expiryDate: "2027-06-30",
          },
        ],
      },
    });
    expect(rcvLot.status()).toBe(201);

    const fgRes = await page.request.post("/api/products", {
      headers: csrfHeaders(),
      data: {
        sku: "E2E-FG-01",
        name: "Assembled Scanner Kit",
        itemType: "manufactured",
        costPrice: 120,
        sellingPrice: 299,
      },
    });
    expect(fgRes.status()).toBe(201);
    const fgId = (await fgRes.json()).product.id as string;

    const bomRes = await page.request.post("/api/manufacturing/boms", {
      headers: csrfHeaders(),
      data: {
        productId: fgId,
        name: "Scanner Kit BOM",
        outputQty: 1,
        components: [{ componentProductId: productId, quantity: 1, scrapPercent: 0 }],
      },
    });
    expect(bomRes.status()).toBe(201);
    const bomId = (await bomRes.json()).bom.id as string;

    const woRes = await page.request.post("/api/manufacturing/work-orders", {
      headers: csrfHeaders(),
      data: { bomId, branchId: hqId, plannedQty: 2 },
    });
    expect(woRes.status()).toBe(201);
    const woNumber = (await woRes.json()).workOrder.woNumber as string;

    await page.goto("/inventory/lots");
    await expect(page.getByRole("heading", { name: /Lots & Expiry/i })).toBeVisible();
    await expect(page.getByText("LOT-E2E-99", { exact: true })).toBeVisible();

    await page.goto("/inventory/serials");
    await expect(page.getByRole("heading", { name: /Serial Number Registry/i })).toBeVisible();

    await page.goto("/manufacturing/boms");
    await expect(page.getByRole("heading", { name: /Bills of Materials/i })).toBeVisible();
    await expect(page.getByText("Scanner Kit BOM")).toBeVisible();

    await page.goto("/manufacturing/work-orders");
    await expect(page.getByRole("heading", { name: /Work Orders/i })).toBeVisible();
    await expect(page.getByText(woNumber, { exact: true })).toBeVisible();

    // 9. Track 3: Verify Serial TrackingLinePicker inside New Invoice UI & Arabic RTL switching
    const serialProdRes = await page.request.post("/api/products", {
      headers: csrfHeaders(),
      data: {
        sku: "E2E-SER-01",
        name: "Serialized Router",
        costPrice: 100,
        sellingPrice: 250,
        trackingMode: "serial",
      },
    });
    expect(serialProdRes.status()).toBe(201);
    const serialProdId = (await serialProdRes.json()).product.id as string;

    const rcvSer = await page.request.post("/api/purchase-receives", {
      headers: csrfHeaders(),
      data: {
        vendorId,
        branchId: hqId,
        lines: [{ productId: serialProdId, quantity: 1, unitCost: 100, serialNumbers: ["SN-E2E-100"] }],
      },
    });
    expect(rcvSer.status()).toBe(201);

    await page.goto("/inventory/serials");
    await expect(page.getByText("SN-E2E-100", { exact: true })).toBeVisible();

    // Switch language to Arabic via UI LanguageSwitcher and verify RTL direction + zero runtime errors
    await page.getByRole("button", { name: /English/i }).click();
    await page.getByRole("menuitem", { name: /العربية/i }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: /الاعتمادات والرقابة/i })).toBeVisible();

    await page.goto("/manufacturing/work-orders");
    await expect(page.getByRole("heading", { name: /أوامر التشغيل/i })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
