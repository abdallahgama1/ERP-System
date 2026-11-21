import { expect, test } from "@playwright/test";
import { csrfHeaders } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe("POS Offline Outbox & Automatic Reconnect Sync E2E", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("completes sale while offline into IndexedDB outbox and syncs cleanly on reconnect", async ({
    page,
    context,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/signup");
    await page.locator("#name").fill("Offline Admin");
    await page.locator("#email").fill("offline-e2e@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("/", { timeout: 20_000 });

    const branchesRes = await page.request.get("/api/branches");
    const hqId = (await branchesRes.json()).branches[0].id as string;

    const prodRes = await page.request.post("/api/products", {
      headers: csrfHeaders(),
      data: {
        sku: "OFF-01",
        barcode: "6221112223334",
        name: "Offline Coffee Cup",
        costPrice: 10,
        sellingPrice: 50,
        initialStock: [{ branchId: hqId, quantity: 10, unitCost: 10 }],
      },
    });
    expect(prodRes.status()).toBe(201);

    const termRes = await page.request.post("/api/pos/terminals", {
      headers: csrfHeaders(),
      data: { branchId: hqId, code: "REG-OFF", name: "Offline Counter" },
    });
    expect(termRes.status()).toBe(201);
    const terminalId = (await termRes.json()).terminal.id as string;

    const shiftRes = await page.request.post("/api/pos/shifts/open", {
      headers: csrfHeaders(),
      data: { terminalId, openingFloat: 100 },
    });
    expect(shiftRes.status()).toBe(201);

    // Load /pos while online so catalog + shift cache to IndexedDB
    await page.goto("/pos");
    await expect(page.getByText("Offline Coffee Cup")).toBeVisible();

    // Go offline!
    await context.setOffline(true);
    await expect(page.getByText(/^Offline$/i)).toBeVisible();

    // Tap product card and complete cash checkout offline
    await page.getByText("Offline Coffee Cup").click();
    await page.getByRole("button", { name: /Charge/i }).click();
    await page.getByRole("button", { name: /Complete Sale/i }).click();

    await expect(page.locator("#pos-thermal-receipt")).toBeVisible();
    await expect(page.locator("#pos-thermal-receipt")).toContainText("OFFLINE-");
    await page.getByRole("button", { name: /New Sale/i }).click();

    // Outbox badge should show 1 pending transaction
    await expect(page.getByRole("button", { name: /Sync \(1\)/i })).toBeVisible();

    // Reconnect -> auto-sync should flush outbox and create real server invoice
    await context.setOffline(false);
    await expect(page.getByText(/^Online$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Sync \(1\)/i })).toBeHidden({ timeout: 15_000 });

    const invRes = await page.request.get("/api/sales-invoices");
    expect(invRes.ok()).toBeTruthy();
    const invJson = await invRes.json();
    expect(invJson.invoices.length).toBeGreaterThanOrEqual(1);
    expect(invJson.invoices[0].invoiceNumber).toMatch(/^POS-/);

    expect(pageErrors).toEqual([]);
  });
});
