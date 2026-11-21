import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  apiRequest,
  attachPageErrorTracker,
  loginViaUi,
  signupFirstAdmin,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

// Mirrors DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT in packages/shared/src/pos.ts
const MAX_CASHIER_DISCOUNT_PCT = 10;

interface PosReceiptSummary {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
}

interface PosReceiptDetail extends PosReceiptSummary {
  lines: Array<{
    id: string;
    productId: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

interface PosShiftSnapshot {
  id: string;
  shiftNumber: string;
  openingFloat: number;
  expectedCash: number;
  countedCash?: number | null;
  cashVariance?: number | null;
  totalCashSales: number;
  totalCardSales: number;
  totalCashRefunds?: number;
  totalCardRefunds?: number;
  totalRefundsCount?: number;
}

async function enterPinInActiveDialog(page: Page, pin: string): Promise<void> {
  const dialog: Locator = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();

  const pinInput = dialog
    .locator('input[type="password"], input[inputmode="numeric"], input[id*="pin" i], input[name*="pin" i]')
    .first();

  if ((await pinInput.count()) > 0) {
    await pinInput.fill(pin);
  } else {
    for (const digit of pin.split("")) {
      await dialog.getByRole("button", { name: digit, exact: true }).click();
    }
  }

  const submitBtn = dialog
    .getByRole("button", { name: /verify|approve|override|confirm|submit|unlock|authorize/i })
    .first();
  await submitBtn.click();
}

test.describe("R4 POS Counter Completeness (Discount Override, Receipts Reprint, POS Returns & Shift Close)", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("enforces discount threshold w/ Manager PIN override without session switch, reprints 80mm/58mm, processes partial/full POS returns, and reconciles shift + GL", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const managerEmail = "pos-supervisor@test.local";
    const managerPassword = "Password123!";
    const cashierEmail = "pos-cashier@test.local";
    const cashierPassword = "Password123!";
    const managerPin = "2468";
    const cashierPin = "1111";

    // 1. Bootstrap supervisor admin + seed product, cashier user, PINs, and POS terminal
    await signupFirstAdmin(page, {
      name: "POS Supervisor",
      email: managerEmail,
      password: managerPassword,
    });

    const meAdminRes = await page.request.get("/api/auth/me");
    expect(meAdminRes.ok()).toBe(true);
    const adminId = ((await meAdminRes.json()) as { user: { id: string } }).user.id;

    const branchesRes = await page.request.get("/api/branches");
    expect(branchesRes.ok()).toBe(true);
    const hqId = ((await branchesRes.json()) as { branches: Array<{ id: string }> }).branches[0].id;

    const prodRes = await apiRequest(page, "POST", "/api/products", {
      sku: "POS-R4-01",
      barcode: "6220001112223",
      name: "Arabica Coffee Pack",
      costPrice: 40,
      sellingPrice: 100,
      initialStock: [{ branchId: hqId, quantity: 20, unitCost: 40 }],
    });
    expect(prodRes.status()).toBe(201);
    const productId = ((await prodRes.json()) as { product: { id: string } }).product.id;

    const cashierRes = await apiRequest(page, "POST", "/api/users", {
      name: "Cashier User",
      email: cashierEmail,
      password: cashierPassword,
      role: "user",
      branchScopeMode: "selected",
      branchIds: [hqId],
      defaultBranchId: hqId,
    });
    expect(cashierRes.status()).toBe(201);
    const cashierId = ((await cashierRes.json()) as { user: { id: string } }).user.id;

    const setMgrPinRes = await apiRequest(page, "PUT", `/api/users/${adminId}/pos-pin`, {
      pin: managerPin,
    });
    expect(setMgrPinRes.ok()).toBe(true);

    const setCashierPinRes = await apiRequest(page, "PUT", `/api/users/${cashierId}/pos-pin`, {
      pin: cashierPin,
    });
    expect(setCashierPinRes.ok()).toBe(true);

    const termRes = await apiRequest(page, "POST", "/api/pos/terminals", {
      branchId: hqId,
      code: "REG-R4",
      name: "Counter Register R4",
    });
    expect(termRes.status()).toBe(201);
    const terminalId = ((await termRes.json()) as { terminal: { id: string } }).terminal.id;

    // 2. Log in as standard cashier (user role)
    const logoutRes = await apiRequest(page, "POST", "/api/auth/logout");
    expect(logoutRes.ok()).toBe(true);
    await loginViaUi(page, cashierEmail, cashierPassword);

    // Verify Manager PIN Override API boundaries while logged in as cashier
    const badPinRes = await apiRequest(page, "POST", "/api/pos/override/verify", {
      pin: "12ab",
      terminalId,
      action: "discount",
    });
    expect(badPinRes.status()).toBe(400);

    const cashierOverrideRes = await apiRequest(page, "POST", "/api/pos/override/verify", {
      pin: cashierPin,
      terminalId,
      action: "discount",
    });
    expect(cashierOverrideRes.status()).toBe(403);

    const validOverrideRes = await apiRequest(page, "POST", "/api/pos/override/verify", {
      pin: managerPin,
      terminalId,
      action: "discount",
      reason: "Pre-check override",
    });
    expect(validOverrideRes.status()).toBe(200);

    // Active session MUST remain on cashier (never switched to supervisor)
    const meAfterOverride = await page.request.get("/api/auth/me");
    expect(meAfterOverride.ok()).toBe(true);
    expect(((await meAfterOverride.json()) as { user: { id: string } }).user.id).toBe(cashierId);

    // 3. Open POS Register & open shift with 200 opening float
    await page.goto("/pos");
    await expect(page.getByRole("button", { name: /Open Shift to Start Selling/i })).toBeVisible();
    await page.getByRole("button", { name: /Open Shift to Start Selling/i }).click();
    await page.locator("#pos-opening-float").fill("200");
    await page.getByRole("button", { name: /^Open Shift$/i }).click();
    await expect(page.getByRole("button", { name: /SHF-/i })).toBeVisible();

    let totalCashSales = 0;

    // 4. Sale 1: qty 2, discount <= DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT (10%) -> completes without override
    await page.getByText("Arabica Coffee Pack").first().click();
    await page.getByText("Arabica Coffee Pack").first().click();
    await expect(page.getByText(/Current Sale \(2\)/i)).toBeVisible();

    const discountInput = page
      .locator('input[aria-label*="discount" i], input[placeholder*="discount" i], input[id*="discount" i]')
      .first();
    if ((await discountInput.count()) > 0 && (await discountInput.isVisible())) {
      const allowedPct = Math.max(1, MAX_CASHIER_DISCOUNT_PCT - 5);
      await discountInput.fill(String(allowedPct));
    }

    const sale1CheckoutPromise = page.waitForResponse(
      (r) => r.url().includes("/api/pos/checkout") && r.request().method() === "POST"
    );
    await page.getByRole("button", { name: /Charge/i }).click();
    await page.getByRole("button", { name: /Complete Sale/i }).click();
    const sale1CheckoutRes = await sale1CheckoutPromise;
    expect(sale1CheckoutRes.status()).toBe(201);
    const sale1 = ((await sale1CheckoutRes.json()) as { receipt: PosReceiptSummary }).receipt;
    totalCashSales += sale1.totalAmount;

    await expect(page.locator("#pos-thermal-receipt")).toBeVisible();
    await expect(page.locator("#pos-thermal-receipt")).toContainText(sale1.invoiceNumber);
    await page.getByRole("button", { name: /New Sale/i }).click();

    // 5. Sale 2: qty 1, discount > 10% -> triggers Manager PIN Override without switching cashier session
    await page.getByText("Arabica Coffee Pack").first().click();
    await expect(page.getByText(/Current Sale \(1\)/i)).toBeVisible();

    const discountField = page
      .locator('input[aria-label*="discount" i], input[placeholder*="discount" i], input[id*="discount" i]')
      .first();
    await expect(discountField).toBeVisible();
    await discountField.fill(String(MAX_CASHIER_DISCOUNT_PCT + 5));

    const overrideResponsePromise = page.waitForResponse(
      (r) => r.url().includes("/api/pos/override/verify") && r.request().method() === "POST"
    );

    // Some UIs prompt on discount entry/blur or upon clicking Charge
    const chargeBtn = page.getByRole("button", { name: /Charge/i });
    if (await chargeBtn.isEnabled()) {
      await chargeBtn.click();
    }

    // Handle Manager PIN override dialog if presented before SplitTenderDialog
    const currentDialog = page.getByRole("dialog").last();
    await expect(currentDialog).toBeVisible();
    const dialogHeading = await currentDialog.textContent();
    if (!/Collect Payment/i.test(dialogHeading ?? "")) {
      await enterPinInActiveDialog(page, managerPin);
      const overrideRes = await overrideResponsePromise;
      expect(overrideRes.status()).toBe(200);
      if (!(await page.getByRole("button", { name: /Complete Sale/i }).isVisible())) {
        await page.getByRole("button", { name: /Charge/i }).click();
      }
    } else {
      // If discount override dialog was triggered earlier or inline, check if Complete Sale prompts override
      await page.getByRole("button", { name: /Complete Sale/i }).click();
      const maybeOverrideDialog = page.getByRole("dialog").last();
      if (await maybeOverrideDialog.isVisible()) {
        await enterPinInActiveDialog(page, managerPin);
        const overrideRes = await overrideResponsePromise;
        expect(overrideRes.status()).toBe(200);
      }
    }

    const sale2CheckoutPromise = page.waitForResponse(
      (r) => r.url().includes("/api/pos/checkout") && r.request().method() === "POST"
    );
    if (await page.getByRole("button", { name: /Complete Sale/i }).isVisible()) {
      await page.getByRole("button", { name: /Complete Sale/i }).click();
    }
    const sale2CheckoutRes = await sale2CheckoutPromise;
    expect(sale2CheckoutRes.status()).toBe(201);
    const sale2 = ((await sale2CheckoutRes.json()) as { receipt: PosReceiptSummary }).receipt;
    totalCashSales += sale2.totalAmount;

    await expect(page.locator("#pos-thermal-receipt")).toBeVisible();
    await page.getByRole("button", { name: /New Sale/i }).click();

    // Confirm active session & top bar user stayed on Cashier User
    await expect(page.getByRole("button", { name: /Cashier User/i })).toBeVisible();
    const meStillCashier = await page.request.get("/api/auth/me");
    expect(((await meStillCashier.json()) as { user: { id: string } }).user.id).toBe(cashierId);

    // 6. Recent Receipts drawer: search by POS- number, toggle 58mm / 80mm reprint
    await page.getByRole("button", { name: /receipts|history/i }).click();
    const receiptSearch = page.getByPlaceholder(/search|receipt|POS-/i).last();
    await expect(receiptSearch).toBeVisible();
    await receiptSearch.fill(sale1.invoiceNumber);
    await expect(page.getByText(sale1.invoiceNumber).first()).toBeVisible();
    await page.getByText(sale1.invoiceNumber).first().click();

    const reprintBtn = page.getByRole("button", { name: /reprint|print|preview/i }).first();
    if (await reprintBtn.isVisible()) {
      await reprintBtn.click();
    }

    const thermalReceipt = page.locator("#pos-thermal-receipt");
    if (await thermalReceipt.isVisible()) {
      await page.getByRole("button", { name: "58mm", exact: true }).click();
      await expect(thermalReceipt).toHaveClass(/w-\[235px\]/);
      await page.getByRole("button", { name: "80mm", exact: true }).click();
      await expect(thermalReceipt).toHaveClass(/w-\[310px\]/);
      // Close reprint dialog back to drawer or receipt detail if needed
      const closePreviewBtn = page.getByRole("button", { name: /new sale|close/i }).first();
      if (await closePreviewBtn.isVisible()) {
        await closePreviewBtn.click();
      }
    }

    // Re-open sale1 in Recent Receipts if drawer closed
    if (!(await page.getByRole("button", { name: /return|refund/i }).first().isVisible())) {
      await page.getByRole("button", { name: /receipts|history/i }).click();
      await page.getByPlaceholder(/search|receipt|POS-/i).last().fill(sale1.invoiceNumber);
      await page.getByText(sale1.invoiceNumber).first().click();
    }

    // 7. Execute partial POS Return (qty 1, restockItems: true, cash refund) via UI Return Dialog
    await page.getByRole("button", { name: /return|refund/i }).first().click();
    const returnDialog = page.getByRole("dialog").last();
    await expect(returnDialog).toBeVisible();

    const qtyInput = returnDialog.locator('input[type="number"]').first();
    if (await qtyInput.isVisible()) {
      await qtyInput.fill("1");
    }

    const restockSwitch = returnDialog.getByRole("checkbox").first();
    if ((await restockSwitch.count()) > 0 && !(await restockSwitch.isChecked())) {
      await restockSwitch.check();
    }

    const reasonInput = returnDialog
      .locator('textarea, input[placeholder*="reason" i], input[aria-label*="reason" i], input[id*="reason" i]')
      .first();
    if (await reasonInput.isVisible()) {
      await reasonInput.fill("Damaged packaging");
    }

    const overridePinField = returnDialog
      .locator('input[type="password"], input[inputmode="numeric"], input[id*="pin" i], input[placeholder*="PIN" i]')
      .first();
    if (await overridePinField.isVisible()) {
      await overridePinField.fill(managerPin);
    }

    const returnPromise = page.waitForResponse(
      (r) => r.url().includes("/api/pos/returns") && r.request().method() === "POST"
    );
    await returnDialog
      .getByRole("button", { name: /process return|confirm return|submit return|refund|return/i })
      .last()
      .click();

    // Handle separate Manager PIN modal if triggered on submit
    if ((await page.getByRole("dialog").count()) > 0) {
      const topDialogText = (await page.getByRole("dialog").last().textContent()) ?? "";
      if (/manager|pin|override|authorize/i.test(topDialogText) && !(await overridePinField.isVisible())) {
        await enterPinInActiveDialog(page, managerPin);
      }
    }

    const returnRes = await returnPromise;
    expect(returnRes.status()).toBe(201);
    const returnBody = (await returnRes.json()) as {
      posReturn?: { returnNumber: string; totalAmount: number };
      returnRecord?: { returnNumber: string; totalAmount: number };
    };
    const createdReturn = returnBody.posReturn ?? returnBody.returnRecord;
    expect(createdReturn?.returnNumber).toMatch(/^POSR-/);

    // Close any open receipt/drawer overlay before verifying shift & stock
    await page.keyboard.press("Escape");

    // Stock restored from 17 (20 - 2 - 1) to 18
    const catalogAfterCashReturn = await page.request.get(`/api/pos/catalog?branchId=${hqId}`);
    expect(catalogAfterCashReturn.ok()).toBe(true);
    const catalogProducts1 = ((await catalogAfterCashReturn.json()) as {
      products: Array<{ id: string; qtyOnHand: number }>;
    }).products;
    const stockAfterCashReturn = catalogProducts1.find((p) => p.id === productId)?.qtyOnHand;
    expect(stockAfterCashReturn).toBe(18);

    // Check active shift totalCashRefunds & expectedCash
    const shiftAfterCashReturnRes = await page.request.get(
      `/api/pos/shifts/active?terminalId=${terminalId}`
    );
    expect(shiftAfterCashReturnRes.ok()).toBe(true);
    const shift1 = ((await shiftAfterCashReturnRes.json()) as { shift: PosShiftSnapshot }).shift;
    expect(shift1.totalRefundsCount).toBe(1);
    expect(shift1.totalCashRefunds ?? 0).toBeGreaterThan(0);
    expect(shift1.expectedCash).toBeCloseTo(
      200 + totalCashSales - (shift1.totalCashRefunds ?? 0),
      2
    );

    // 8. Execute remainder return on sale1 with refundMethod: "card" + verify boundary errors
    const sale1DetailRes = await page.request.get(`/api/pos/receipts/${sale1.id}`);
    expect(sale1DetailRes.ok()).toBe(true);
    const sale1Detail = ((await sale1DetailRes.json()) as { receipt: PosReceiptDetail }).receipt;
    const sale1Line = sale1Detail.lines[0];

    const cardReturnRes = await apiRequest(page, "POST", "/api/pos/returns", {
      originalInvoiceId: sale1.id,
      terminalId,
      shiftId: shift1.id,
      refundMethod: "card",
      restockItems: true,
      reason: "Second unit returned to card",
      managerOverridePin: managerPin,
      lines: [
        {
          originalInvoiceLineId: sale1Line.id,
          productId,
          quantity: 1,
        },
      ],
    });
    expect(cardReturnRes.status()).toBe(201);

    // Fetch sale2 detail for boundary & restockItems: false checks
    const sale2DetailRes = await page.request.get(`/api/pos/receipts/${sale2.id}`);
    expect(sale2DetailRes.ok()).toBe(true);
    const sale2Detail = ((await sale2DetailRes.json()) as { receipt: PosReceiptDetail }).receipt;
    const sale2Line = sale2Detail.lines[0];

    // Boundary 1: qty > sold qty -> 400
    const overQtyRes = await apiRequest(page, "POST", "/api/pos/returns", {
      originalInvoiceId: sale2.id,
      terminalId,
      shiftId: shift1.id,
      refundMethod: "cash",
      restockItems: true,
      reason: "Too many returned",
      managerOverridePin: managerPin,
      lines: [
        {
          originalInvoiceLineId: sale2Line.id,
          productId,
          quantity: 5,
        },
      ],
    });
    expect(overQtyRes.status()).toBe(400);

    // Boundary 2: empty/whitespace reason -> 400
    const emptyReasonRes = await apiRequest(page, "POST", "/api/pos/returns", {
      originalInvoiceId: sale2.id,
      terminalId,
      shiftId: shift1.id,
      refundMethod: "cash",
      restockItems: true,
      reason: "   ",
      managerOverridePin: managerPin,
      lines: [
        {
          originalInvoiceLineId: sale2Line.id,
          productId,
          quantity: 1,
        },
      ],
    });
    expect(emptyReasonRes.status()).toBe(400);

    // Boundary 3: restockItems: false -> succeeds (201) without incrementing stock qtyOnHand
    const noRestockRes = await apiRequest(page, "POST", "/api/pos/returns", {
      originalInvoiceId: sale2.id,
      terminalId,
      shiftId: shift1.id,
      refundMethod: "cash",
      restockItems: false,
      reason: "Opened perishable - do not restock",
      managerOverridePin: managerPin,
      lines: [
        {
          originalInvoiceLineId: sale2Line.id,
          productId,
          quantity: 1,
        },
      ],
    });
    expect(noRestockRes.status()).toBe(201);

    const catalogAfterNoRestock = await page.request.get(`/api/pos/catalog?branchId=${hqId}`);
    expect(catalogAfterNoRestock.ok()).toBe(true);
    const catalogProducts2 = ((await catalogAfterNoRestock.json()) as {
      products: Array<{ id: string; qtyOnHand: number }>;
    }).products;
    // 18 + 1 (from card return w/ restock:true) + 0 (from no-restock return) = 19
    expect(catalogProducts2.find((p) => p.id === productId)?.qtyOnHand).toBe(19);

    // 9. Close shift via UI with exact expectedCash -> cashVariance === 0 & balanced GL
    const shiftBeforeCloseRes = await page.request.get(
      `/api/pos/shifts/active?terminalId=${terminalId}`
    );
    expect(shiftBeforeCloseRes.ok()).toBe(true);
    const activeShift = ((await shiftBeforeCloseRes.json()) as { shift: PosShiftSnapshot }).shift;
    expect(activeShift.totalRefundsCount).toBe(3);
    expect(activeShift.totalCardRefunds ?? 0).toBeGreaterThan(0);

    const closePromise = page.waitForResponse(
      (r) => r.url().includes(`/api/pos/shifts/${activeShift.id}/close`) && r.request().method() === "POST"
    );
    await page.getByRole("button", { name: /SHF-/i }).click();
    await page.locator("#pos-counted-cash").fill(String(activeShift.expectedCash));
    await page.getByRole("button", { name: /Close Shift & Post Variance/i }).click();
    const closeRes = await closePromise;
    expect(closeRes.ok()).toBe(true);
    const closedShift = ((await closeRes.json()) as { shift: PosShiftSnapshot }).shift;
    expect(closedShift.cashVariance).toBe(0);

    // Verify balanced GL Trial Balance as supervisor
    const mgrLoginRes = await apiRequest(page, "POST", "/api/auth/login", {
      email: managerEmail,
      password: managerPassword,
    });
    expect(mgrLoginRes.ok()).toBe(true);

    const tbRes = await page.request.get("/api/accounting/reports/trial-balance");
    expect(tbRes.ok()).toBe(true);
    const tb = (await tbRes.json()) as {
      totalDebit: number;
      totalCredit: number;
      isBalanced: boolean;
    };
    expect(tb.isBalanced).toBe(true);
    expect(Math.abs(tb.totalDebit - tb.totalCredit)).toBeLessThanOrEqual(0.01);

    expect(pageErrors).toEqual([]);
  });
});
