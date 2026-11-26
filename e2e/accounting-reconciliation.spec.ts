import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Admin UI: Subledger-to-GL Reconciliation (/accounting/reconciliation)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("reconciles all 8 control accounts with live data, supports as-of date filter, Ctrl+K nav, and Arabic RTL", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // Configure company base currency to EGP
    const compRes = await apiRequest(page, "PUT", "/api/settings/company", {
      baseCurrency: "EGP",
    });
    expect(compRes.ok()).toBe(true);

    // Seed a real customer + product + posted sales invoice so AR, Output VAT, and Inventory have live activity
    const branches = ((await (await page.request.get("/api/branches")).json()) as {
      branches: Array<{ id: string }>;
    }).branches;
    const branchId = branches[0].id;

    const custRes = await apiRequest(page, "POST", "/api/customers", {
      name: "Reconciliation Test Customer",
      email: "recon@test.local",
      currency: "EGP",
    });
    expect(custRes.status()).toBe(201);
    const customerId = ((await custRes.json()) as { customer: { id: string } }).customer.id;

    const prodRes = await apiRequest(page, "POST", "/api/products", {
      name: "Recon Widget",
      sku: "RECON-001",
      costPrice: 100,
      sellingPrice: 200,
      initialStock: [{ branchId, quantity: 10, unitCost: 100 }],
    });
    expect(prodRes.status()).toBe(201);
    const productId = ((await prodRes.json()) as { product: { id: string } }).product.id;

    const invRes = await apiRequest(page, "POST", "/api/sales-invoices", {
      customerId,
      branchId,
      status: "Sent",
      invoiceDate: "2026-05-15",
      dueDate: "2026-06-15",
      currency: "EGP",
      lines: [
        {
          productId,
          description: "Recon Widget",
          quantity: 2,
          unitPrice: 200,
          taxRate: 14,
        },
      ],
    });
    expect(invRes.status()).toBe(201);

    // Open Command Palette (Ctrl+K) and jump to Subledger Reconciliation
    await page.goto("/");
    await expect(page.getByTestId("command-palette-trigger")).toBeVisible();
    await page.getByTestId("command-palette-trigger").click();
    await page.getByRole("dialog").getByPlaceholder(/Search products/i).fill("Reconciliation");
    await page.getByRole("option", { name: /Subledger Reconciliation/i }).click();

    await expect(page).toHaveURL(/\/accounting\/reconciliation/);
    await expect(
      page.getByRole("heading", { level: 1, name: /Subledger-to-GL Reconciliation/i })
    ).toBeVisible();

    // All 8 control accounts pass
    await expect(page.getByTestId("reconciliation-pass-count")).toHaveText("8 / 8");
    const keys = [
      "accounts_receivable",
      "accounts_payable",
      "inventory_asset",
      "output_vat",
      "input_vat",
      "fixed_assets_cost",
      "accumulated_depreciation",
      "treasury",
    ];
    for (const k of keys) {
      await expect(page.getByTestId(`reconciliation-status-${k}`)).toContainText(/Pass/i);
    }

    // Apply "as of" date cutoff and verify display updates
    await page.getByTestId("reconciliation-as-of-input").fill("2026-06-30");
    await expect(page.getByTestId("reconciliation-as-of-display")).toHaveText("2026-06-30");

    // Verify Arabic RTL
    await page.evaluate(() => {
      window.localStorage.setItem("i18nextLng", "ar");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByRole("heading", { level: 1, name: /مطابقة الأستاذ المساعد مع الأستاذ العام/ })
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
