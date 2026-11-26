import { expect, test } from "@playwright/test";
import { apiRequest, attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Admin UI: Accounting Setup Health (/accounting/setup-health)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("displays healthy state, surfaces inactive mapping issue, remaps in one click, and renders Arabic RTL", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // 1. Navigate to Setup Health and confirm baseline is healthy
    await page.goto("/accounting/setup-health");
    await expect(page.getByRole("heading", { level: 1, name: /Accounting Setup Health/i })).toBeVisible();
    await expect(page.getByTestId("setup-health-clean-card")).toBeVisible();

    // 2. Create an alternate active equity account (3199) and deactivate current retained_earnings (3100)
    const createAltRes = await apiRequest(page, "POST", "/api/accounting/accounts", {
      code: "3199",
      name: "Retained Earnings Replacement",
      accountType: "equity",
      normalBalance: "credit",
    });
    expect(createAltRes.status()).toBe(201);

    const accountsRes = await page.request.get("/api/accounting/accounts");
    const { accounts } = (await accountsRes.json()) as {
      accounts: Array<{ id: string; code: string }>;
    };
    const acct3100 = accounts.find((a) => a.code === "3100")!;
    expect(acct3100).toBeTruthy();

    const deactRes = await apiRequest(page, "PUT", `/api/accounting/accounts/${acct3100.id}`, {
      isActive: false,
    });
    expect(deactRes.ok()).toBe(true);

    // 3. Refresh Setup Health -> retained_earnings appears as Inactive Account
    await page.getByTestId("setup-health-refresh").click();
    const issueRow = page.getByTestId("setup-issue-row-retained_earnings");
    await expect(issueRow).toBeVisible();
    await expect(issueRow).toContainText(/Inactive Account/i);

    // 4. One-click Remap -> select 3199 and save -> returns to Healthy
    await page.getByTestId("remap-btn-retained_earnings").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("remap-account-select").click();
    await page.getByRole("option", { name: /3199 — Retained Earnings Replacement/i }).click();
    await page.getByTestId("remap-confirm-btn").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("setup-health-clean-card")).toBeVisible();

    // 5. Switch to Arabic and verify RTL direction & Arabic heading
    await page.evaluate(() => {
      window.localStorage.setItem("i18nextLng", "ar");
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1, name: /صحة إعداد المحاسبة/ })).toBeVisible();

    expect(errors).toEqual([]);
  });
});
