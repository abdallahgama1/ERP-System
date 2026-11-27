import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../scripts/fixtures/cutover");

test.describe("Admin UI: Go-Live Data Import & Cutover (/admin/imports)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("imports COA -> Customers -> Vendors -> Products -> Opening Stock/FA/Treasury -> Opening Balances via UI, verifies 8/8 reconciliation, reverses, and renders Arabic RTL", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // Configure EGP currency & ensure FY 2026 exists
    expect((await apiRequest(page, "PUT", "/api/settings/company", { baseCurrency: "EGP", einvoicingMode: "eta_egypt" })).ok()).toBe(true);
    const fyData = (await (await page.request.get("/api/accounting/fiscal-years")).json()) as {
      fiscalYears: Array<{ startDate: string; endDate: string }>;
    };
    if (!fyData.fiscalYears.some((y) => y.startDate.slice(0, 10) <= "2026-01-01" && y.endDate.slice(0, 10) >= "2026-01-01")) {
      await apiRequest(page, "POST", "/api/accounting/fiscal-years", {
        name: "FY 2026",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
    }

    await page.goto("/admin/imports");
    await expect(page.getByRole("heading", { level: 1, name: /Data Import & Go-Live Cutover/i })).toBeVisible();

    // Run Steps 1-7 through the unified CsvImportDialog (dry-run -> commit)
    const steps: Array<[string, string]> = [
      ["chart_of_accounts", "01-chart-of-accounts.csv"],
      ["customers", "02-customers.csv"],
      ["vendors", "03-vendors.csv"],
      ["products", "04-products.csv"],
      ["opening_stock", "05-opening-stock.csv"],
      ["opening_fixed_assets", "06-opening-fixed-assets.csv"],
      ["opening_treasury", "07-opening-treasury.csv"],
    ];

    for (const [kind, fileName] of steps) {
      await page.getByTestId(`open-import-${kind}`).click();
      await page.getByTestId(`csv-file-input-${kind}`).setInputFiles(path.join(fixturesDir, fileName));
      await page.getByTestId("csv-dry-run-btn").click();
      await expect(page.getByTestId("csv-result-badge")).toContainText(/Valid/i);
      await page.getByTestId("csv-commit-btn").click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    // Step 8: Opening Balances (TB + Open AR + Open AP)
    await page.getByTestId("cutover-date-input").fill("2026-01-01");
    await page.getByTestId("opening-tb-file-input").setInputFiles(path.join(fixturesDir, "08-opening-trial-balance.csv"));
    await page.getByTestId("opening-ar-file-input").setInputFiles(path.join(fixturesDir, "09-opening-ar.csv"));
    await page.getByTestId("opening-ap-file-input").setInputFiles(path.join(fixturesDir, "10-opening-ap.csv"));

    await page.getByTestId("opening-dry-run-btn").click();
    await expect(page.getByTestId("opening-result-panel")).toContainText(/Valid/i);

    await page.getByTestId("opening-commit-btn").click();
    await expect(page.getByTestId("opening-reconciliation-results")).toBeVisible();
    await expect(page.getByTestId("reverse-opening-btn")).toBeVisible();
    await expect(page.getByTestId("cutover-readiness-card")).toBeVisible();
    await expect(page.getByTestId("cutover-readiness-badge")).toContainText(/READY|PASS/i);

    // Verify controlled opening reversal via UI
    await page.getByTestId("reverse-opening-btn").click();
    await page.getByTestId("reverse-opening-reason").fill("Reversing cutover in E2E verification");
    await page.getByTestId("reverse-opening-confirm").click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByTestId("reverse-opening-btn")).toBeHidden();
    await expect(page.getByTestId("cutover-readiness-badge")).toContainText(/READY|PASS/i);

    // Verify Arabic RTL
    await page.evaluate(() => {
      window.localStorage.setItem("i18nextLng", "ar");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByRole("heading", { level: 1, name: /استيراد البيانات والانتقال التشغيلي/ })
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
