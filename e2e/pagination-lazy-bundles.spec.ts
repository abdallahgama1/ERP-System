import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { resetTestDatabase } from "./helpers/db";

test.describe("Pagination & Lazy Bundle Enforcement E2E", () => {
  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("never eagerly loads xlsx/jspdf/zxing/@sentry on Dashboard or POS and renders paginated views cleanly", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const requestedUrls: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("request", (req) => requestedUrls.push(req.url()));

    await page.goto("/signup");
    await page.locator("#name").fill("Scale Admin");
    await page.locator("#email").fill("scale-e2e@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("/", { timeout: 20_000 });

    // Heavy export, scanner & error-reporting libraries must NOT be eagerly requested on Dashboard
    const heavyDashboardHits = requestedUrls.filter((u) =>
      /xlsx|jspdf|html2canvas|zxing|@sentry/i.test(u)
    );
    expect(heavyDashboardHits).toEqual([]);

    // Visit /pos and confirm heavy bundles remain unrequested on initial POS register load
    await page.goto("/pos");
    await expect(
      page.getByText(/POS Cashier Register|Current Sale|Select register/i).first()
    ).toBeVisible();
    const heavyPosHits = requestedUrls.filter((u) =>
      /xlsx|jspdf|html2canvas|zxing|@sentry/i.test(u)
    );
    expect(heavyPosHits).toEqual([]);

    // If built dist/index.html is present on disk, confirm zero heavy <link rel="modulepreload"> tags
    const distIndexPath = path.resolve(process.cwd(), "frontend/dist/index.html");
    if (fs.existsSync(distIndexPath)) {
      const distHtml = fs.readFileSync(distIndexPath, "utf8");
      const modulePreloads = distHtml.match(/<link[^>]*rel=["']modulepreload["'][^>]*>/gi) ?? [];
      const heavyPreloads = modulePreloads.filter((tag) =>
        /xlsx|jspdf|html2canvas|zxing|@sentry/i.test(tag)
      );
      expect(heavyPreloads).toEqual([]);
    }

    // Navigate paginated pages cleanly
    await page.goto("/audit-log");
    await expect(page.getByRole("heading", { name: /Audit Log/i, level: 1 })).toBeVisible();

    await page.goto("/reports/movement-history");
    await expect(page.getByRole("heading", { name: /Movement History/i, level: 1 })).toBeVisible();

    await page.goto("/accounting/journal-entries");
    await expect(page.getByRole("heading", { name: /Journal Entries/i, level: 1 })).toBeVisible();

    await page.goto("/sales/invoices");
    await expect(page.getByRole("heading", { name: /Invoices/i, level: 1 })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
