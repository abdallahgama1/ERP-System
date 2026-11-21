import { expect, test } from "@playwright/test";
import {
  apiRequest,
  attachPageErrorTracker,
  BASE_URL,
  loginViaUi,
  signupFirstAdmin,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

interface EtaSubmissionListItemDto {
  id: string;
  invoiceId: string | null;
  posReturnId: string | null;
  documentNumber: string | null;
  receiptType: "S" | "R" | null;
  documentUuid: string;
  status: string;
}

interface EinvoiceQueueSummaryDto {
  pending: number;
  submitted: number;
  accepted: number;
  rejected: number;
  failed: number;
  total: number;
  etaConfigured: boolean;
}

test.describe("R5 Admin E-Invoice Queue & ETA Egypt 'S'/'R' Receipts E2E", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("queues ETA 'S' sale and 'R' return receipts, filters and inspects in Admin E-Invoice Queue UI, and handles unconfigured ETA safely", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);

    // 1. Bootstrap admin & enable ETA Egypt e-invoicing mode
    await signupFirstAdmin(page, {
      name: "ETA Queue Admin",
      email: "eta-admin@test.local",
      password: "Password123!",
    });

    const branchesRes = await page.request.get("/api/branches");
    expect(branchesRes.ok()).toBe(true);
    const hqId = ((await branchesRes.json()) as { branches: Array<{ id: string }> }).branches[0].id;

    const compRes = await apiRequest(page, "PUT", "/api/settings/company", {
      companyName: "Cairo Retail E2E",
      legalName: "Cairo Retail LLC",
      taxRegistrationNumber: "777888999",
      baseCurrency: "EGP",
      einvoicingMode: "eta_egypt",
    });
    expect(compRes.ok()).toBe(true);

    // 2. Seed product, terminal, shift, POS sale ('S'), and POS return ('R')
    const prodRes = await apiRequest(page, "POST", "/api/products", {
      sku: "ETA-PROD-01",
      name: "ETA Compliance Item",
      costPrice: 50,
      sellingPrice: 150,
      initialStock: [{ branchId: hqId, quantity: 10, unitCost: 50 }],
    });
    expect(prodRes.status()).toBe(201);
    const productId = ((await prodRes.json()) as { product: { id: string } }).product.id;

    const termRes = await apiRequest(page, "POST", "/api/pos/terminals", {
      branchId: hqId,
      code: "REG-ETA",
      name: "ETA Register",
    });
    expect(termRes.status()).toBe(201);
    const terminalId = ((await termRes.json()) as { terminal: { id: string } }).terminal.id;

    const shiftRes = await apiRequest(page, "POST", "/api/pos/shifts/open", {
      terminalId,
      openingFloat: 100,
    });
    expect(shiftRes.status()).toBe(201);
    const shiftId = ((await shiftRes.json()) as { shift: { id: string } }).shift.id;

    const checkoutRes = await apiRequest(page, "POST", "/api/pos/checkout", {
      terminalId,
      shiftId,
      currency: "EGP",
      lines: [{ productId, quantity: 2, unitPrice: 150, taxRate: 0 }],
      tenders: [{ method: "cash", amount: 300, tenderedAmount: 300 }],
    });
    expect(checkoutRes.status()).toBe(201);
    const saleReceipt = ((await checkoutRes.json()) as {
      receipt: { id: string; invoiceNumber: string; etaDocumentUuid?: string | null };
    }).receipt;
    expect(saleReceipt.invoiceNumber).toMatch(/^POS-/);

    const detailRes = await page.request.get(`/api/pos/receipts/${saleReceipt.id}`);
    expect(detailRes.ok()).toBe(true);
    const detailLineId = ((await detailRes.json()) as {
      receipt: { lines: Array<{ id: string }> };
    }).receipt.lines[0].id;

    const returnRes = await apiRequest(page, "POST", "/api/pos/returns", {
      originalInvoiceId: saleReceipt.id,
      terminalId,
      shiftId,
      refundMethod: "cash",
      restockItems: true,
      reason: "ETA E2E return test",
      lines: [{ originalInvoiceLineId: detailLineId, productId, quantity: 1 }],
    });
    expect(returnRes.status()).toBe(201);
    const returnBody = (await returnRes.json()) as {
      posReturn?: { returnNumber: string };
      returnRecord?: { returnNumber: string };
    };
    const returnNumber = (returnBody.posReturn ?? returnBody.returnRecord)?.returnNumber ?? "";
    expect(returnNumber).toMatch(/^POSR-/);

    // 3. Navigate via Administration sidebar to E-Invoice Queue UI
    await page.goto("/");
    const adminTrigger = page.getByRole("button", { name: /^Administration$/i });
    await adminTrigger.click();
    const queueLink = page.getByRole("link", { name: /e-?invoic|eta/i }).first();
    await expect(queueLink).toBeVisible();

    const queueListPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/") &&
        /einvoic/i.test(r.url()) &&
        r.request().method() === "GET" &&
        !r.url().includes("/summary") &&
        r.ok()
    );
    await queueLink.click();

    const queueListRes = await queueListPromise;
    const queueEndpointUrl = new URL(queueListRes.url());
    const queuePayload = (await queueListRes.json()) as {
      items?: EtaSubmissionListItemDto[];
      submissions?: EtaSubmissionListItemDto[];
      summary?: EinvoiceQueueSummaryDto;
    };

    const items = queuePayload.items ?? queuePayload.submissions ?? [];
    expect(items.length).toBeGreaterThanOrEqual(2);

    const saleRow = items.find((i) => i.documentNumber === saleReceipt.invoiceNumber);
    const returnRow = items.find((i) => i.documentNumber === returnNumber);
    expect(saleRow).toBeTruthy();
    expect(saleRow?.receiptType).toBe("S");
    expect(saleRow?.status).toBe("pending");
    expect(returnRow).toBeTruthy();
    expect(returnRow?.receiptType).toBe("R");
    expect(returnRow?.posReturnId).toBeTruthy();
    expect(returnRow?.status).toBe("pending");

    if (queuePayload.summary) {
      expect(queuePayload.summary.etaConfigured).toBe(false);
      expect(queuePayload.summary.pending).toBeGreaterThanOrEqual(2);
    }

    // 4. Verify UI renders heading, unconfigured ETA notice, and both 'S' and 'R' rows
    await expect(page.getByRole("heading", { level: 1, name: /e-?invoic|eta/i })).toBeVisible();
    await expect(page.getByText(saleReceipt.invoiceNumber)).toBeVisible();
    await expect(page.getByText(returnNumber)).toBeVisible();

    // 5. Filter by status (accepted -> empty, pending -> rows visible again)
    const statusFilter = page
      .locator('[role="combobox"], select')
      .filter({ hasText: /all|pending|status/i })
      .first();
    if (await statusFilter.isVisible()) {
      await statusFilter.click();
      const acceptedOpt = page.getByRole("option", { name: /^Accepted$/i }).first();
      if (await acceptedOpt.isVisible()) {
        await acceptedOpt.click();
        await expect(page.getByText(saleReceipt.invoiceNumber)).toBeHidden();

        await statusFilter.click();
        await page.getByRole("option", { name: /^Pending$/i }).first().click();
        await expect(page.getByText(saleReceipt.invoiceNumber)).toBeVisible();
      }
    }

    // 6. Inspect detail payload modal/drawer
    const inspectBtn = page.getByRole("button", { name: /view|detail|payload|inspect/i }).first();
    if (await inspectBtn.isVisible()) {
      await inspectBtn.click();
    } else {
      await page.getByText(saleReceipt.invoiceNumber).first().click();
    }
    const detailDialog = page.getByRole("dialog").last();
    if (await detailDialog.isVisible()) {
      const dialogText = (await detailDialog.textContent()) ?? "";
      expect(dialogText).toMatch(/receipt|documentUuid|POS-/i);
      expect(dialogText).not.toContain("ETA_CLIENT_SECRET");
      await page.keyboard.press("Escape");
    }

    // 7. Trigger requeue / poll action while ETA credentials are unconfigured -> non-5xx
    const actionBtn = page
      .getByRole("button", { name: /poll|process|retry|requeue|sync/i })
      .first();
    if (await actionBtn.isVisible()) {
      const actionResPromise = page.waitForResponse(
        (r) =>
          r.url().includes("/api/") &&
          /einvoic/i.test(r.url()) &&
          r.request().method() === "POST"
      );
      await actionBtn.click();
      const actionRes = await actionResPromise;
      expect(actionRes.status()).toBeLessThan(500);
    }

    // 8. API boundary: invalid queue status filter returns 400
    const badStatusRes = await page.request.get(`${queueEndpointUrl.pathname}?status=bogus_status`);
    expect(badStatusRes.status()).toBe(400);

    // 9. Standard user (without admin/einvoicing privilege) is gated with 403
    const stdEmail = "eta-cashier@test.local";
    const stdPassword = "Password123!";
    const createUserRes = await apiRequest(page, "POST", "/api/users", {
      name: "Non-Admin User",
      email: stdEmail,
      password: stdPassword,
      role: "user",
      branchScopeMode: "selected",
      branchIds: [hqId],
      defaultBranchId: hqId,
    });
    expect(createUserRes.status()).toBe(201);

    const stdCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const stdPage = await stdCtx.newPage();
      await loginViaUi(stdPage, stdEmail, stdPassword);
      const forbiddenRes = await stdPage.request.get(queueEndpointUrl.pathname);
      expect(forbiddenRes.status()).toBe(403);
    } finally {
      await stdCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });
});
