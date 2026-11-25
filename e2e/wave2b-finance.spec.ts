import { expect, test } from "@playwright/test";
import { attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Wave 2B E2E: Fixed Assets, Depreciation, Cash Flow, VAT Return & Year-End Closing", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("End-to-end browser workflow: Register Fixed Asset -> Monthly Depreciation -> Reconciled Cash Flow & VAT Return -> Year-End Fiscal Close", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    const today = new Date().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7);

    // 1. Register a Fixed Asset in /accounting/fixed-assets (Cost 3,600, Salvage 0, 36m Straight-Line => 100/month)
    await page.goto("/accounting/fixed-assets");
    await expect(
      page.getByRole("heading", { level: 1, name: /Fixed Assets & Automated Depreciation/i })
    ).toBeVisible();

    await page.getByRole("button", { name: /Register Fixed Asset/i }).click();
    await page.locator("#fa-name").fill("Forklift Crown Electric");
    await page.locator("#fa-date").fill(today);
    await page.locator("#fa-cost").fill("3600");
    await page.locator("#fa-salvage").fill("0");
    await page.locator("#fa-life").fill("36");
    await page.getByRole("button", { name: /Capitalize Asset/i }).click();
    await expect(page.getByRole("cell", { name: /FA-0001/i })).toBeVisible();
    await expect(page.getByText("Forklift Crown Electric")).toBeVisible();

    // 2. Run Monthly Depreciation for current month -> Accum Dep = 100.00, NBV = 3,500.00
    await page.getByRole("button", { name: /Run Monthly Depreciation/i }).click();
    await page.locator("#dep-period").fill(currentMonth);
    await page.getByRole("button", { name: /Post Depreciation Run/i }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText(/3,500\.00/).first()).toBeVisible();

    // 3. Verify Indirect Cash Flow Statement & VAT Return tabs in /accounting/statements
    await page.goto("/accounting/statements");
    await page.getByRole("tab", { name: /Cash Flow/i }).click();
    await expect(page.getByText(/Reconciled to Cash GL/i)).toBeVisible();
    await expect(page.getByText(/Depreciation & Amortization/i)).toBeVisible();
    await expect(page.getByText(/-3,600\.00|-.*3,600\.00/).first()).toBeVisible();

    await page.getByRole("tab", { name: /VAT Return/i }).click();
    await expect(page.getByText(/Output VAT by Tax Rate/i)).toBeVisible();
    await expect(page.getByText(/Input VAT by Tax Rate/i)).toBeVisible();

    // 4. Create an historical FY 2024 in /accounting/periods and execute Year-End Closing Wizard
    await page.goto("/accounting/periods");
    await expect(
      page.getByRole("heading", { level: 1, name: /Fiscal Years/i })
    ).toBeVisible();
    await page.getByRole("button", { name: /New Fiscal Year/i }).click();
    await page.locator("#fy-name").fill("FY 2024");
    await page.locator("#fy-start").fill("2024-01-01");
    await page.locator("#fy-end").fill("2024-12-31");
    await page.getByRole("button", { name: /^Create$/i }).click();
    await expect(page.getByText("FY 2024")).toBeVisible();

    const fy2024Card = page.locator("div.rounded-lg.border", { hasText: "FY 2024" }).first();
    await fy2024Card.getByRole("button", { name: /Close Fiscal Year/i }).click();
    await page.getByRole("button", { name: /Execute Year-End Close/i }).click();
    await expect(fy2024Card.getByText("closed").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
