import { expect, test } from "@playwright/test";
import { attachPageErrorTracker, signupFirstAdmin } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("Wave 2A E2E: Cost Centers, Treasury & Bank Reconciliation, Operating Expenses", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("End-to-end browser workflow: Cost Center -> Bank & Cashbox -> Transfer -> CSV Reconciliation -> Operating Expense -> Cost-Center P&L", async ({
    page,
  }) => {
    const errors = attachPageErrorTracker(page);
    await signupFirstAdmin(page);

    // 1. Create a Cost Center in /accounting/cost-centers
    await page.goto("/accounting/cost-centers");
    await expect(page.getByRole("heading", { level: 1, name: "Cost Centers" })).toBeVisible();
    await page.getByRole("button", { name: /New Cost Center/i }).click();
    await page.locator("#cc-code").fill("CC-OPS");
    await page.locator("#cc-name").fill("Retail Operations");
    await page.locator("#cc-desc").fill("Store operating costs");
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByRole("cell", { name: "CC-OPS", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Retail Operations", exact: true })).toBeVisible();

    // 2. Create a Bank Account (opening balance 5,000) and a Cashbox (opening balance 200) in /treasury/accounts
    await page.goto("/treasury/accounts");
    await expect(page.getByRole("heading", { level: 1, name: /Treasury, Bank Accounts/i })).toBeVisible();

    await page.getByRole("button", { name: /New Bank \/ Cashbox/i }).click();
    await page.locator("#ta-code").fill("BNK-CIB");
    await page.locator("#ta-name").fill("CIB Main Current");
    await page.locator("#ta-bank").fill("CIB Egypt");
    await page.locator("#ta-accnum").fill("1000223344");
    await page.locator("#ta-open").fill("5000");
    await page.getByRole("button", { name: /Create Account/i }).click();
    await expect(page.getByRole("cell", { name: "BNK-CIB", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /New Bank \/ Cashbox/i }).click();
    await page.locator("#ta-code").fill("CSH-HQ");
    await page.getByRole("dialog").getByRole("combobox").first().click();
    await page.getByRole("option", { name: /Petty Cash \/ Cashbox/i }).click();
    await page.locator("#ta-name").fill("HQ Petty Cash");
    await page.locator("#ta-open").fill("200");
    await page.getByRole("button", { name: /Create Account/i }).click();
    await expect(page.getByRole("cell", { name: "CSH-HQ", exact: true })).toBeVisible();

    // 3. Post an Inter-Account Transfer of 800 from BNK-CIB -> CSH-HQ
    await page.getByRole("button", { name: /Inter-Account Transfer/i }).click();
    const transferDialog = page.getByRole("dialog", { name: /Inter-Account Treasury Transfer/i });
    await transferDialog.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: /BNK-CIB/i }).click();
    await transferDialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: /CSH-HQ/i }).click();
    await page.locator("#tr-amt").fill("800");
    await page.locator("#tr-ref").fill("REPL-800");
    await page.locator("#tr-memo").fill("Cashbox replenishment");
    await transferDialog.getByRole("button", { name: /Post Transfer/i }).click();
    await expect(transferDialog).toBeHidden();

    // 4. Import Bank Statement CSV on BNK-CIB & reconcile both the -800 transfer and a -25 bank fee
    const cibRow = page.locator("tr", { hasText: "BNK-CIB" });
    await cibRow.getByRole("button", { name: /Reconcile/i }).click();
    await page.getByRole("button", { name: /Import Statement CSV/i }).click();
    const today = new Date().toISOString().slice(0, 10);
    await page
      .locator("#stmt-csv")
      .fill(
        [
          "date,description,reference,amount",
          `${today},Cashbox Withdrawal,REPL-800,-800.00`,
          `${today},Monthly Bank Service Charge,FEE-25,-25.00`,
        ].join("\n")
      );
    await page.getByRole("button", { name: /^Import Statement$/i }).click();
    await expect(page.getByText("Cashbox Withdrawal")).toBeVisible();
    await expect(page.getByText("Monthly Bank Service Charge")).toBeVisible();

    // Reconcile the -800 withdrawal (auto-suggested GL match)
    const withdrawalRow = page.locator("tr", { hasText: "Cashbox Withdrawal" });
    await withdrawalRow.getByRole("button", { name: /Match \/ Post/i }).click();
    await page.getByRole("button", { name: /Confirm Reconciliation/i }).click();
    await expect(withdrawalRow.getByText(/Reconciled/i)).toBeVisible();

    // Reconcile the -25 bank fee via 1-click adjustment tagged to 5500 Operating Expenses + CC-OPS
    const feeRow = page.locator("tr", { hasText: "Monthly Bank Service Charge" });
    await feeRow.getByRole("button", { name: /Match \/ Post/i }).click();
    const reconModal = page.getByRole("dialog", { name: /Reconcile Bank Statement Line/i });
    await reconModal.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: /5500/i }).click();
    await reconModal.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: /CC-OPS/i }).click();
    await reconModal.getByRole("button", { name: /Confirm Reconciliation/i }).click();
    await expect(feeRow.getByText(/Reconciled/i)).toBeVisible();

    // 5. Submit & Approve a Direct Petty Cash Operating Expense (100 net + 14% VAT = 114) tagged to CC-OPS
    await page.goto("/expenses");
    await expect(page.getByRole("heading", { level: 1, name: /Operating Expenses & Petty Cash/i })).toBeVisible();
    await page.getByRole("button", { name: /New Expense \/ Claim/i }).click();
    const expDialog = page.getByRole("dialog", { name: /New Operating Expense/i });
    // Select CSH-HQ treasury account
    await expDialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: /CSH-HQ/i }).click();
    await page.locator("#exp-payee").fill("Cairo Office Supplies");
    await page.locator("#exp-ref").fill("INV-SUP-10");
    await expDialog.getByPlaceholder("Description").fill("Printer toner & paper");
    // Select CC-OPS on line
    await expDialog.getByRole("combobox").nth(4).click();
    await page.getByRole("option", { name: "CC-OPS", exact: true }).click();
    await expDialog.getByPlaceholder("Net").fill("100");
    await expDialog.getByPlaceholder("VAT%").fill("14");
    await expDialog.getByRole("button", { name: /Submit for Approval/i }).click();
    await expect(expDialog).toBeHidden();

    // Approve the submitted expense
    await expect(page.getByRole("cell", { name: /EXP-/i })).toBeVisible();
    await page.getByRole("button", { name: /Approve/i }).click();
    await expect(page.getByText(/^paid$/i)).toBeVisible();

    // 6. Verify Cost-Center-filtered P&L in /accounting/statements shows 125.00 (25 bank fee + 100 net expense)
    await page.goto("/accounting/statements");
    await page.getByRole("tab", { name: /Profit & Loss/i }).click();
    await page.getByTestId("statement-cost-center-filter").click();
    await page.getByRole("option", { name: /CC-OPS/i }).click();
    await expect(page.getByText(/125\.00/).first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
