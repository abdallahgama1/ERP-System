import { expect, test, type Locator, type Page } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

const DELAY_MS = 3_800;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CapturedPost {
  url: string;
  idempotencyKey: string | null;
}

async function interceptDelayedPost(
  page: Page,
  urlPattern: string,
  delayMs = DELAY_MS
): Promise<{ captured: CapturedPost[]; remove: () => Promise<void> }> {
  const captured: CapturedPost[] = [];
  const handler = async (route: import("@playwright/test").Route) => {
    const req = route.request();
    if (req.method() !== "POST") {
      await route.continue();
      return;
    }
    captured.push({
      url: req.url(),
      idempotencyKey: req.headers()["idempotency-key"] ?? null,
    });
    await new Promise((r) => setTimeout(r, delayMs));
    await route.continue();
  };
  await page.route(urlPattern, handler);
  return {
    captured,
    remove: () => page.unroute(urlPattern, handler),
  };
}

/**
 * Clicks submit, immediately fires rapid duplicate click + Enter + Escape while pending,
 * and asserts spinner, locked dialog, and 3s "Still working..." feedback.
 */
async function submitTwiceAndVerifySlowLock(
  page: Page,
  dialog: Locator,
  submitBtn: Locator,
  extraEnterTarget?: Locator
): Promise<void> {
  await submitBtn.click();

  // Immediately fire rapid duplicate attempts while the first request is in flight
  await submitBtn.dispatchEvent("click");
  await submitBtn.evaluate((el) => (el as HTMLButtonElement).click());
  if (extraEnterTarget) {
    await extraEnterTarget.press("Enter").catch(() => {});
  }

  // 1. Button disables immediately and spinner appears
  await expect(submitBtn).toBeDisabled({ timeout: 2_000 });
  await expect(dialog.getByTestId("submit-spinner")).toBeVisible({ timeout: 2_000 });

  // 2. Dialog refuses to dismiss on Escape while server request is in flight
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  // 3. After 3 seconds on the throttled/delayed API, "Still working..." appears
  await expect(dialog.getByTestId("submit-still-working")).toBeVisible({ timeout: 5_000 });
}

test.describe("Double-Click & Slow-API Idempotency E2E (3.4s Delayed Backend)", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("prevents duplicate submissions and shows spinner + 'Still working...' across 6 key forms on a 3.4s delayed API", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);

    // 0. Bootstrap first admin & seed shared master data
    await signupFirstAdmin(page, {
      name: "Idempotency Admin",
      email: "idempotency-e2e@test.local",
      password: "Password123!",
    });

    const branchesInitRes = await apiRequest(page, "GET", "/api/branches");
    const initBranches = (await branchesInitRes.json()).branches as Array<{ id: string; name: string }>;
    const hqBranchId = initBranches[0].id;

    const custSeedRes = await apiRequest(page, "POST", "/api/customers", {
      name: "SlowNet Customer",
      email: "slownet@customer.local",
    });
    expect(custSeedRes.status()).toBe(201);
    const customerId = (await custSeedRes.json()).customer.id as string;

    const prodSeedRes = await apiRequest(page, "POST", "/api/products", {
      sku: "SLOW-SKU-01",
      barcode: "6220001112223",
      name: "SlowNet Widget",
      costPrice: 40,
      sellingPrice: 120,
      initialStock: [{ branchId: hqBranchId, quantity: 25, unitCost: 40 }],
    });
    expect(prodSeedRes.status()).toBe(201);
    const productId = (await prodSeedRes.json()).product.id as string;

    // =========================================================================
    // 1. Add Branch (/branches -> POST /api/branches)
    // =========================================================================
    await page.goto("/branches");
    await page.getByRole("button", { name: /Add Branch/i }).click();
    const branchDialog = page.getByRole("dialog");
    await expect(branchDialog).toBeVisible();

    await branchDialog.locator("#branch_name").fill("Alexandria Port Branch");
    await branchDialog.locator("#branch_location").fill("Corniche Road 42");
    await branchDialog.locator("#contact_number").fill("+201001112233");

    const branchIntercept = await interceptDelayedPost(page, "**/api/branches");
    const branchSubmitBtn = branchDialog.locator('button[type="submit"]');
    await submitTwiceAndVerifySlowLock(page, branchDialog, branchSubmitBtn, branchDialog.locator("#contact_number"));

    await expect(branchDialog).toBeHidden({ timeout: 10_000 });
    await branchIntercept.remove();

    expect(branchIntercept.captured).toHaveLength(1);
    expect(branchIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const branchesAfterRes = await apiRequest(page, "GET", "/api/branches");
    const branchesAfter = (await branchesAfterRes.json()).branches as Array<{ name: string }>;
    expect(branchesAfter.filter((b) => b.name === "Alexandria Port Branch")).toHaveLength(1);

    // =========================================================================
    // 2. Sales Invoice (/sales/invoices -> POST /api/sales-invoices)
    // =========================================================================
    await page.goto("/sales/invoices");
    await page.getByRole("button", { name: /New Invoice/i }).click();
    const invDialog = page.getByRole("dialog");
    await expect(invDialog).toBeVisible();

    // Select Customer
    await invDialog.getByRole("combobox", { name: /Customer/i }).click();
    await page.getByRole("option", { name: /SlowNet Customer/i }).click();

    // Add Product line via ProductSelector
    const prodSearch = invDialog.getByPlaceholder(/Search product|Select product|SKU/i).first();
    await prodSearch.click();
    await prodSearch.fill("SlowNet Widget");
    await page.getByText(/SlowNet Widget/i).first().click();

    const invIntercept = await interceptDelayedPost(page, "**/api/sales-invoices");
    const invSubmitBtn = invDialog.getByRole("button", { name: /^Save$/i });
    await submitTwiceAndVerifySlowLock(page, invDialog, invSubmitBtn);

    await expect(invDialog).toBeHidden({ timeout: 10_000 });
    await invIntercept.remove();

    expect(invIntercept.captured).toHaveLength(1);
    expect(invIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const invListRes = await apiRequest(page, "GET", "/api/sales-invoices");
    const invListBody = await invListRes.json();
    const invoices = (invListBody.invoices ?? invListBody.items ?? []) as Array<{ id: string; status?: string }>;
    expect(invoices).toHaveLength(1);

    // Ensure invoice is Sent so Received Payment can allocate against it
    if (invoices[0].status === "Draft") {
      const sendRes = await apiRequest(page, "POST", `/api/sales-invoices/${invoices[0].id}/send`, {});
      expect(sendRes.ok()).toBeTruthy();
    }

    // =========================================================================
    // 3. Received Payment (/sales/payments -> POST /api/received-payments)
    // =========================================================================
    await page.goto("/sales/payments");
    await page.getByRole("button", { name: /Record Payment/i }).click();
    const payDialog = page.getByRole("dialog");
    await expect(payDialog).toBeVisible();

    // Select customer (first combobox in dialog)
    await payDialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /SlowNet Customer/i }).click();

    // Enter payment amount (100)
    const payAmountInput = payDialog.locator('input[type="number"]').first();
    await payAmountInput.fill("100");

    const payIntercept = await interceptDelayedPost(page, "**/api/received-payments");
    const paySubmitBtn = payDialog.getByRole("button", { name: /Record Payment/i });
    await submitTwiceAndVerifySlowLock(page, payDialog, paySubmitBtn);

    await expect(payDialog).toBeHidden({ timeout: 10_000 });
    await payIntercept.remove();

    expect(payIntercept.captured).toHaveLength(1);
    expect(payIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const payListRes = await apiRequest(page, "GET", "/api/received-payments");
    const payListBody = await payListRes.json();
    const payments = (payListBody.payments ?? payListBody.receivedPayments ?? payListBody.items ?? []) as Array<{ id: string }>;
    expect(payments).toHaveLength(1);

    // =========================================================================
    // 4. Journal Entry (/accounting/journal-entries -> POST /api/accounting/journal-entries)
    // =========================================================================
    await page.goto("/accounting/journal-entries");
    await page.getByRole("button", { name: /New Journal Entry/i }).click();
    const jeDialog = page.getByRole("dialog");
    await expect(jeDialog).toBeVisible();

    await jeDialog.locator("#je-memo").fill("SlowNet Balanced Accrual Test");

    // Pick accounts for row 1 (Debit 100) and row 2 (Credit 100)
    const jeRows = jeDialog.locator("tbody tr");
    await jeRows.nth(0).getByRole("combobox").first().click();
    await page.getByRole("option", { name: /^1000\b/i }).click();
    await jeRows.nth(0).locator('input[type="number"]').nth(1).fill("100");

    await jeRows.nth(1).getByRole("combobox").first().click();
    await page.getByRole("option", { name: /^3000\b/i }).click();
    await jeRows.nth(1).locator('input[type="number"]').nth(2).fill("100");

    const jeIntercept = await interceptDelayedPost(page, "**/api/accounting/journal-entries");
    const jeSubmitBtn = jeDialog.getByRole("button", { name: /Post Entry/i });
    await expect(jeSubmitBtn).toBeEnabled();
    await submitTwiceAndVerifySlowLock(page, jeDialog, jeSubmitBtn);

    await expect(jeDialog).toBeHidden({ timeout: 10_000 });
    await jeIntercept.remove();

    expect(jeIntercept.captured).toHaveLength(1);
    expect(jeIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const jeListRes = await apiRequest(page, "GET", "/api/accounting/journal-entries?q=SlowNet");
    const jeListBody = await jeListRes.json();
    const matchingEntries = ((jeListBody.entries ?? jeListBody.items ?? []) as Array<{ memo?: string }>).filter(
      (e) => e.memo === "SlowNet Balanced Accrual Test"
    );
    expect(matchingEntries).toHaveLength(1);

    // =========================================================================
    // 5. Stock Adjustment (/inventory/adjustments -> POST /api/adjustments)
    // =========================================================================
    await page.goto("/inventory/adjustments");
    await page.getByRole("button", { name: /New Adjustment/i }).click();
    const adjDialog = page.getByRole("dialog");
    await expect(adjDialog).toBeVisible();

    const adjCombos = adjDialog.getByRole("combobox");
    await adjCombos.nth(0).click();
    await page.getByRole("option").first().click();
    await adjCombos.nth(1).click();
    await page.getByRole("option", { name: /SlowNet Widget/i }).click();

    await adjDialog.locator('input[type="number"]').fill("20");

    const adjIntercept = await interceptDelayedPost(page, "**/api/adjustments");
    const adjSubmitBtn = adjDialog.getByRole("button", { name: /^Save$/i });
    await submitTwiceAndVerifySlowLock(page, adjDialog, adjSubmitBtn);

    await expect(adjDialog).toBeHidden({ timeout: 10_000 });
    await adjIntercept.remove();

    expect(adjIntercept.captured).toHaveLength(1);
    expect(adjIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const adjListRes = await apiRequest(page, "GET", "/api/adjustments");
    const adjListBody = await adjListRes.json();
    const adjustments = (adjListBody.adjustments ?? adjListBody.items ?? []) as Array<{ id: string }>;
    expect(adjustments).toHaveLength(1);

    // =========================================================================
    // 6. POS Checkout (/pos -> POST /api/pos/checkout, F9 + double-click)
    // =========================================================================
    const termRes = await apiRequest(page, "POST", "/api/pos/terminals", {
      branchId: hqBranchId,
      code: "REG-SLOW",
      name: "SlowNet POS Register",
    });
    expect(termRes.status()).toBe(201);
    const terminalId = (await termRes.json()).terminal.id as string;

    const shiftRes = await apiRequest(page, "POST", "/api/pos/shifts/open", {
      terminalId,
      openingFloat: 200,
    });
    expect(shiftRes.status()).toBe(201);

    await page.goto("/pos");
    await expect(page.getByText("SlowNet Widget")).toBeVisible();

    const scanInput = page.getByPlaceholder(/Scan barcode or search/i);
    await scanInput.fill("6220001112223");
    await scanInput.press("Enter");
    await expect(page.getByText(/Current Sale \(1\)/i)).toBeVisible();

    // Open SplitTenderDialog via F9 hotkey (and press F9 again to confirm no duplicate modal)
    await page.keyboard.press("F9");
    await page.keyboard.press("F9");
    const posDialog = page.getByRole("dialog");
    await expect(posDialog).toBeVisible();

    const posIntercept = await interceptDelayedPost(page, "**/api/pos/checkout");
    const completeSaleBtn = posDialog.getByRole("button", { name: /Complete Sale/i });
    await submitTwiceAndVerifySlowLock(page, posDialog, completeSaleBtn);

    // Wait for thermal receipt to confirm checkout completed cleanly
    await expect(page.locator("#pos-thermal-receipt")).toBeVisible({ timeout: 10_000 });
    await posIntercept.remove();

    expect(posIntercept.captured).toHaveLength(1);
    expect(posIntercept.captured[0].idempotencyKey).toMatch(UUID_RE);

    const receiptsRes = await apiRequest(page, "GET", `/api/pos/receipts?terminalId=${terminalId}`);
    const receiptsBody = await receiptsRes.json();
    const receipts = (receiptsBody.receipts ?? receiptsBody.items ?? []) as Array<{ id: string }>;
    expect(receipts).toHaveLength(1);

    // Unused variable guard (productId was verified via stock adjustment & POS)
    expect(productId).toBeTruthy();
    expect(customerId).toBeTruthy();
    expect(pageErrors).toEqual([]);
  });
});
