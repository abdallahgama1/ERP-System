import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

function getTestDbUrl(): string {
  if (process.env.TEST_DATABASE_URL?.trim()) return process.env.TEST_DATABASE_URL.trim();
  const envPath = path.resolve(process.cwd(), "backend/.env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*TEST_DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("TEST_DATABASE_URL is required in backend/.env to run Playwright E2E tests");
}

test.describe("ERP Full-Stack E2E (Auth, P2P, O2C, ZATCA QR, GL & Approvals)", () => {
  test.beforeAll(async () => {
    const dbUrl = getTestDbUrl();
    const expectedDb = new URL(dbUrl).pathname.replace(/^\//, "");
    const sql = postgres(dbUrl, { connect_timeout: 15, prepare: false });
    const [{ db }] = await sql`SELECT current_database() AS db`;
    if (db !== expectedDb) {
      await sql.end();
      throw new Error(`Refusing to truncate '${db}' instead of '${expectedDb}'`);
    }
    await sql.unsafe(
      "TRUNCATE TABLE approval_requests, approval_rules, journal_lines, journal_entries, fiscal_periods, fiscal_years, exchange_rates, audit_logs, credit_note_applications, retainer_applications, retainer_invoices, sales_return_lines, sales_returns, received_payment_allocations, received_payments, sales_invoice_lines, sales_invoices, sales_order_lines, sales_orders, purchase_return_lines, purchase_returns, payment_made_allocations, payments_made, vendor_bill_lines, vendor_bills, purchase_receive_lines, purchase_receives, purchase_order_lines, purchase_orders, stock_transfer_lines, stock_transfers, stock_session_items, stock_sessions, stock_write_off_lines, stock_write_offs, stock_adjustment_lines, stock_adjustments, stock_movements, branch_products, products, taxonomy_items, customers, vendors, user_branches, user_branch_scopes, user_roles, user_sessions, users, branches RESTART IDENTITY CASCADE"
    );
    await sql.end();
  });

  test("bootstraps admin via Signup UI, renders ZATCA QR invoice, balanced Trial Balance, and Approvals UI", async ({
    page,
  }) => {
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
      data: {
        companyName: "E2E ERP Corp",
        legalName: "E2E ERP Trading LLC",
        taxRegistrationNumber: "300000000000003",
        einvoicingMode: "zatca_qr",
      },
    });
    expect(compRes.ok()).toBeTruthy();

    const prodRes = await page.request.post("/api/products", {
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
      data: { name: "E2E Supplier" },
    });
    expect(vendorRes.status()).toBe(201);
    const vendorId = (await vendorRes.json()).vendor.id as string;

    const custRes = await page.request.post("/api/customers", {
      data: { name: "E2E Customer", creditLimit: 5000 },
    });
    expect(custRes.status()).toBe(201);
    const customerId = (await custRes.json()).customer.id as string;

    const poRes = await page.request.post("/api/purchase-orders", {
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

    // 7. Open Fiscal Periods -> verify open fiscal year renders
    await page.goto("/accounting/periods");
    await expect(page.getByRole("heading", { name: /Fiscal Years & Periods/i })).toBeVisible();
    await expect(page.getByText(`FY ${new Date().getUTCFullYear()}`, { exact: true })).toBeVisible();
  });
});
