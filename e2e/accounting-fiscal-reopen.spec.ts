import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Admin UI: Controlled Fiscal Year Reopen (/accounting/periods)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("enforces later-year-closed guard, reopens with confirmation & reason, keeps audit chain valid, and renders Arabic RTL", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // Seed FY 2024 and FY 2025 and close both via API
    const fy24Res = await apiRequest(page, "POST", "/api/accounting/fiscal-years", {
      name: "FY 2024",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    expect(fy24Res.status()).toBe(201);
    const fy24Id = ((await fy24Res.json()) as { fiscalYear: { id: string } }).fiscalYear.id;

    const fy25Res = await apiRequest(page, "POST", "/api/accounting/fiscal-years", {
      name: "FY 2025",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(fy25Res.status()).toBe(201);
    const fy25Id = ((await fy25Res.json()) as { fiscalYear: { id: string } }).fiscalYear.id;

    expect((await apiRequest(page, "POST", `/api/accounting/fiscal-years/${fy24Id}/close`, {})).ok()).toBe(true);
    expect((await apiRequest(page, "POST", `/api/accounting/fiscal-years/${fy25Id}/close`, {})).ok()).toBe(true);

    // Navigate to Fiscal Periods
    await page.goto("/accounting/periods");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // 1. Attempt to reopen FY 2024 while FY 2025 is still closed -> clear inline error
    await page.getByTestId(`reopen-fy-btn-${fy24Id}`).click();
    await expect(page.getByTestId("reopen-consequences-box")).toBeVisible();
    await expect(page.getByTestId("reopen-confirm-btn")).toBeDisabled();
    await page.getByTestId("reopen-reason-input").fill("Auditor adjustment for FY 2024");
    await page.getByTestId("reopen-confirm-btn").click();
    await expect(page.getByTestId("reopen-error-alert")).toContainText(/FY 2025/i);
    await page.getByRole("button", { name: /Cancel/i }).click();

    // 2. Reopen FY 2025 first -> succeeds
    await page.getByTestId(`reopen-fy-btn-${fy25Id}`).click();
    await page.getByTestId("reopen-reason-input").fill("Reopen FY 2025 before FY 2024");
    await page.getByTestId("reopen-confirm-btn").click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByTestId(`reopen-fy-btn-${fy25Id}`)).toBeHidden();

    // 3. Now reopen FY 2024 -> succeeds
    await page.getByTestId(`reopen-fy-btn-${fy24Id}`).click();
    await page.getByTestId("reopen-reason-input").fill("Auditor year-end adjustment");
    await page.getByTestId("reopen-confirm-btn").click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByTestId(`reopen-fy-btn-${fy24Id}`)).toBeHidden();

    // 4. Verify audit hash chain remains valid
    const verifyRes = await page.request.get("/api/audit-logs/verify");
    expect(verifyRes.ok()).toBe(true);
    const verifyBody = (await verifyRes.json()) as { valid: boolean };
    expect(verifyBody.valid).toBe(true);

    // 5. Verify Arabic RTL
    await page.evaluate(() => {
      window.localStorage.setItem("i18nextLng", "ar");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByRole("heading", { level: 1, name: /السنوات والفترات المالية/ })
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
