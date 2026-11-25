import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Wave 2C E2E: ETA Master Data (Branch Address, GS1/EGS Item Coding, Receiver Type) & B2B e-Invoice v1.0 Queue", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("End-to-end browser workflow: Configure ETA Branch -> GS1 Product -> B2B Customer -> B2B Invoice ('I') & Credit Note ('C') in Queue", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // 1. Enable ETA Egypt mode in company settings
    const compRes = await apiRequest(page, "PUT", "/api/settings/company", {
      companyName: "Delta Industrial Systems",
      legalName: "Delta Industrial Systems SAE",
      taxRegistrationNumber: "310440550",
      baseCurrency: "EGP",
      einvoicingMode: "eta_egypt",
    });
    expect(compRes.ok()).toBe(true);

    // Seed Brand & Category taxonomy for Product UI form
    await apiRequest(page, "POST", "/api/taxonomy", { kind: "brand", name: "Schneider" });
    await apiRequest(page, "POST", "/api/taxonomy", { kind: "category", name: "Switchgear" });

    // 2. Edit HQ Branch in /branches UI with structured ETA Egypt address
    await page.goto("/branches");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.locator("tbody tr").first().locator("button").first().click();
    await page.locator("#contact_number").fill("+20224150000");
    await page.locator("#etaBranchId").fill("1");
    await page.locator("#governorate").fill("Cairo");
    await page.locator("#regionCity").fill("Heliopolis");
    await page.locator("#buildingNumber").fill("22");
    await page.locator("#street").fill("El Merghany St");
    await page.getByRole("dialog").locator('button[type="submit"]').click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // 3. Create Product in /products UI with GS1 code & BX ETA UOM
    await page.goto("/products");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Add Product/i }).click();
    await page.locator("#product_name").fill("Circuit Breaker Panel");
    await page.locator("#product_sku").fill("CB-GS1-200");
    await page.locator("#quantity").fill("15");
    await page.locator("#sellingPrice").fill("2000");
    await page.locator("#costPrice").fill("1200");
    await page.locator("#brand").click();
    await page.getByRole("option", { name: "Schneider" }).click();
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Switchgear" }).click();
    await page.locator("#etaCodeType").click();
    await page.getByRole("option", { name: "GS1" }).click();
    await page.locator("#etaUnitType").click();
    await page.getByRole("option", { name: /BX/i }).click();
    await page.locator("#etaItemCode").fill("6229008007001");
    await page.getByRole("dialog").locator('button[type="submit"]').click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("CB-GS1-200")).toBeVisible();

    // 4. Create B2B Customer in /sales/customers UI with ETA Receiver Type = B & EGP
    await page.goto("/sales/customers");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Add Customer|Create First Customer/i }).first().click();
    await page.locator("#displayName").fill("Suez Canal Logistics");
    await page.locator("#companyName").fill("Suez Canal Logistics SAE");
    await page.locator("#taxNumber").fill("600700800");
    await page.locator("#etaReceiverType").click();
    await page.getByRole("option", { name: /B — Business/i }).click();
    await page.locator("#currency").click();
    await page.getByRole("option", { name: "EGP" }).click();
    await page.getByRole("dialog").locator('button[type="submit"]').click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("Suez Canal Logistics").first()).toBeVisible();

    // 5. Issue back-office Sales Invoice ('I') & Sales Return ('C')
    const branchesData = (await (await page.request.get("/api/branches")).json()) as {
      branches: Array<{ id: string }>;
    };
    const branchId = branchesData.branches[0].id;
    const prodsData = (await (await page.request.get("/api/products")).json()) as {
      products: Array<{ id: string; sku: string }>;
    };
    const productId = prodsData.products.find((p) => p.sku === "CB-GS1-200")!.id;
    const custsData = (await (await page.request.get("/api/customers")).json()) as {
      customers: Array<{ id: string }>;
    };
    const customerId = custsData.customers[0].id;

    const invRes = await apiRequest(page, "POST", "/api/sales-invoices", {
      customerId,
      branchId,
      status: "Sent",
      invoiceDate: "2026-11-25",
      dueDate: "2026-12-25",
      currency: "EGP",
      lines: [
        {
          productId,
          description: "Circuit Breaker Panel",
          quantity: 2,
          unitPrice: 2000,
          taxRate: 14,
        },
      ],
    });
    expect(invRes.status()).toBe(201);
    const invoice = ((await invRes.json()) as { invoice: { id: string; invoiceNumber: string } }).invoice;

    const retRes = await apiRequest(page, "POST", "/api/sales-returns", {
      customerId,
      branchId,
      invoiceId: invoice.id,
      returnDate: "2026-11-25",
      reason: "damaged",
      restockItems: true,
      lines: [{ productId, quantity: 1, unitPrice: 2000, taxRate: 14 }],
    });
    expect(retRes.status()).toBe(201);
    const salesReturn = ((await retRes.json()) as { salesReturn: { creditNoteNumber: string } }).salesReturn;

    // 6. Inspect Admin E-Invoice Queue UI (/admin/einvoicing) -> verify 'I · Invoice' & 'C · Credit Note'
    await page.goto("/admin/einvoicing");
    await expect(page.getByRole("heading", { level: 1, name: /E-Invoicing & ETA Queue/i })).toBeVisible();
    await expect(page.getByText("I · Invoice")).toBeVisible();
    await expect(page.getByText("C · Credit Note")).toBeVisible();
    await expect(page.getByText(invoice.invoiceNumber)).toBeVisible();
    await expect(page.getByText(salesReturn.creditNoteNumber)).toBeVisible();

    // Open payload dialog on the B2B Invoice row and verify GS1 + Heliopolis + RIN
    const invRow = page.locator("tr", { hasText: invoice.invoiceNumber });
    await invRow.getByRole("button", { name: /View Payload/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("6229008007001");
    await expect(dialog).toContainText("Heliopolis");
    await expect(dialog).toContainText("600700800");

    expect(errors).toEqual([]);
  });
});
