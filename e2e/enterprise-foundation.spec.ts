import fs from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";
import {
  apiRequest,
  attachPageErrorTracker,
  BASE_URL,
  csrfHeaders,
  loginViaUi,
  signupFirstAdmin,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";
import {
  assertNoSecretsInAuditEntry,
  buildMinimalPdfBuffer,
  buildMinimalPngBuffer,
  buildMinimalZipPayload,
  buildPermissionMap,
  cleanupAttachments,
  createCustomerApi,
  createInvoiceApi,
  createManualJournalApi,
  createProductApi,
  createUserWithCustomRoleApi,
  createVendorApi,
  createVendorBillApi,
  DEFAULT_COMPANY_ID,
  extractSecretFromOtpauthUrl,
  findPresetRoleId,
  fullAccess,
  generateTotpCode,
  getDefaultBranchId,
  loginWithMfaChallengeUi,
  logoutViaApi,
  readOnlyAccess,
  sha256Hex,
  switchCompanyViaUi,
  SYSTEM_ROLE_PRESET_NAMES,
  trackApiGets,
  uploadAttachmentApi,
  waitForSafeTotpWindow,
} from "./helpers/enterprise";

const HEAVY_BUNDLE_RE = /xlsx|jspdf|html2canvas|zxing|@sentry/i;

async function createCompanyApi(
  page: Page,
  opts: { code: string; name: string; baseCurrency?: string; einvoicingMode?: string }
): Promise<{ id: string; code: string; name: string; baseCurrency: string; defaultBranchId?: string | null }> {
  const res = await apiRequest(page, "POST", "/api/companies", {
    code: opts.code,
    name: opts.name,
    baseCurrency: opts.baseCurrency ?? "EUR",
    einvoicingMode: opts.einvoicingMode ?? "none",
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as {
    company: { id: string; code: string; name: string; baseCurrency: string; defaultBranchId?: string | null };
  };
  return body.company;
}

async function enrollAndVerifyMfaApi(
  page: Page
): Promise<{ secret: string; recoveryCodes: string[]; otpauthUrl: string }> {
  const enrollRes = await apiRequest(page, "POST", "/api/auth/mfa/enroll", {});
  expect(enrollRes.status()).toBe(200);
  const enrollJson = (await enrollRes.json()) as {
    otpauthUrl: string;
    secretMasked: string;
    recoveryCodes: string[];
  };
  expect(enrollJson.otpauthUrl).toMatch(/^otpauth:\/\/totp\//i);
  expect(enrollJson.secretMasked.length).toBeGreaterThan(0);
  expect(enrollJson.recoveryCodes).toHaveLength(8);

  const secret = extractSecretFromOtpauthUrl(enrollJson.otpauthUrl);
  await waitForSafeTotpWindow();
  const code = generateTotpCode(secret);

  const verifyRes = await apiRequest(page, "POST", "/api/auth/mfa/verify", { code });
  expect(verifyRes.status()).toBe(200);

  return {
    secret,
    recoveryCodes: enrollJson.recoveryCodes,
    otpauthUrl: enrollJson.otpauthUrl,
  };
}

// ============================================================================
// TIER 1: FEATURE COVERAGE — HAPPY PATHS (50 CASES: T1-EF1-01 .. T1-EF10-05)
// ============================================================================

test.describe("Tier 1: Wave 1 Feature Coverage — Happy Paths (50 Cases)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("EF1 (T1-EF1-01..05): Signup/Login/Reload initial API footprint <= 5 GETs, lazy route hydration & zero heavy bundles", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const tracker = trackApiGets(page);

    // T1-EF1-01: Signup -> Dashboard <= 5 API GETs & zero legacy flood
    await signupFirstAdmin(page, {
      name: "EF1 Admin",
      email: "ef1-admin@test.local",
      password: "Password123!",
    });
    await page.waitForTimeout(600);
    expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);
    expect(tracker.getApiPaths.some((p) => /\/api\/(products|sales|purchases|audit-logs|sessions)/.test(p))).toBe(false);
    expect(tracker.allUrls.filter((u) => HEAVY_BUNDLE_RE.test(u))).toEqual([]);

    // T1-EF1-02: Logout -> Login -> Dashboard <= 5 API GETs
    await logoutViaApi(page);
    tracker.reset();
    await loginViaUi(page, "ef1-admin@test.local", "Password123!");
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.waitForTimeout(600);
    expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);
    expect(tracker.allUrls.filter((u) => HEAVY_BUNDLE_RE.test(u))).toEqual([]);

    // T1-EF1-03: Authenticated reload -> Dashboard <= 5 API GETs
    tracker.reset();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.waitForTimeout(600);
    expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);

    // T1-EF1-04: Route-level lazy query hydration on navigation
    tracker.reset();
    await page.goto("/products");
    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible();
    await expect.poll(() => tracker.getApiPaths.some((p) => p.includes("/api/products"))).toBe(true);

    tracker.reset();
    await page.goto("/sales/invoices");
    await expect(page.getByRole("heading", { level: 1, name: /invoices/i })).toBeVisible();
    await expect
      .poll(() => tracker.getApiPaths.some((p) => /\/api\/sales[-/]invoices/i.test(p)))
      .toBe(true);

    // T1-EF1-05: Zero heavy <link rel="modulepreload"> in built dist/index.html if present
    const distIndexPath = path.resolve(process.cwd(), "frontend/dist/index.html");
    if (fs.existsSync(distIndexPath)) {
      const distHtml = fs.readFileSync(distIndexPath, "utf8");
      const modulePreloads = distHtml.match(/<link[^>]*rel=["']modulepreload["'][^>]*>/gi) ?? [];
      expect(modulePreloads.filter((tag) => HEAVY_BUNDLE_RE.test(tag))).toEqual([]);
    }

    tracker.stop();
    expect(pageErrors).toEqual([]);
  });

  test("EF2 (T1-EF2-01..05): Multi-company COMP-01 bootstrap, COMP-02 creation, Company Switcher UI, isolation & reload persistence", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "ef2-admin@test.local" });

    // T1-EF2-01: Default primary company COMP-01 bootstrap
    const meRes = await page.request.get("/api/auth/me");
    expect(meRes.status()).toBe(200);
    const meJson = (await meRes.json()) as {
      user: {
        activeCompanyId: string;
        companies: Array<{ id: string; code: string; name: string }>;
      };
    };
    expect(meJson.user.activeCompanyId).toBe(DEFAULT_COMPANY_ID);
    expect(meJson.user.companies.some((c) => c.id === DEFAULT_COMPANY_ID && c.code === "COMP-01")).toBe(true);

    // Create master & transactional records in COMP-01
    const hq1 = await getDefaultBranchId(page);
    const prod1 = await createProductApi(page, { sku: "C1-SKU-01", name: "Comp1 Widget", branchId: hq1 });
    const cust1 = await createCustomerApi(page, "Comp1 Customer");
    const inv1 = await createInvoiceApi(page, { customerId: cust1.id, branchId: hq1, productId: prod1.id });

    // T1-EF2-02: Create COMP-02 with auto-seeded defaults
    const comp2 = await createCompanyApi(page, {
      code: "COMP-02",
      name: "Subsidiary Beta",
      baseCurrency: "EUR",
    });
    expect(comp2.code).toBe("COMP-02");
    expect(comp2.baseCurrency).toBe("EUR");

    // T1-EF2-03: Switch active company via top-bar Company Switcher UI
    await page.reload();
    await switchCompanyViaUi(page, /COMP-02|Subsidiary Beta/i);

    const me2Res = await page.request.get("/api/auth/me");
    const me2Json = (await me2Res.json()) as { user: { activeCompanyId: string } };
    expect(me2Json.user.activeCompanyId).toBe(comp2.id);

    // Verify COMP-02 auto-seeded 8 presets & default branch
    const roles2Res = await page.request.get("/api/custom-roles");
    expect(roles2Res.status()).toBe(200);
    const roles2Json = (await roles2Res.json()) as { roles: Array<{ name: string; isSystem: boolean }> };
    expect(roles2Json.roles.filter((r) => r.isSystem).length).toBeGreaterThanOrEqual(8);

    // T1-EF2-04: Complete tenant isolation across products, customers, invoices, branches
    const [p2Res, c2Res, i2Res, b2Res] = await Promise.all([
      page.request.get("/api/products"),
      page.request.get("/api/customers"),
      page.request.get("/api/sales-invoices"),
      page.request.get("/api/branches"),
    ]);
    expect(((await p2Res.json()) as { products: Array<{ id: string }> }).products.some((p) => p.id === prod1.id)).toBe(
      false
    );
    expect(((await c2Res.json()) as { customers: Array<{ id: string }> }).customers.some((c) => c.id === cust1.id)).toBe(
      false
    );
    expect(((await i2Res.json()) as { invoices: Array<{ id: string }> }).invoices.some((i) => i.id === inv1.id)).toBe(
      false
    );
    expect(((await b2Res.json()) as { branches: Array<{ id: string }> }).branches.some((b) => b.id === hq1)).toBe(
      false
    );

    // T1-EF2-05: Active company persists across reload & COMP-01 settings sync stays distinct
    await page.reload();
    const meReload = (await (await page.request.get("/api/auth/me")).json()) as {
      user: { activeCompanyId: string };
    };
    expect(meReload.user.activeCompanyId).toBe(comp2.id);

    await switchCompanyViaUi(page, /COMP-01|Count It Keep It/i);
    const putSettingsRes = await apiRequest(page, "PUT", "/api/settings/company", {
      companyName: "HQ Renamed Corp",
      legalName: "HQ Legal LLC",
      taxRegistrationNumber: "TAX-HQ-1",
    });
    expect(putSettingsRes.ok()).toBe(true);

    const comp1Settings = (await (await page.request.get("/api/settings/company")).json()) as {
      settings: { companyName: string };
    };
    expect(comp1Settings.settings.companyName).toBe("HQ Renamed Corp");

    await switchCompanyViaUi(page, /COMP-02|Subsidiary Beta/i);
    const comp2Settings = (await (await page.request.get("/api/settings/company")).json()) as {
      settings: { companyName: string };
    };
    expect(comp2Settings.settings.companyName).not.toBe("HQ Renamed Corp");

    expect(pageErrors).toEqual([]);
  });

  test("EF3 (T1-EF3-01..05): 8 System Presets, Custom Role CRUD, role sync, Sidebar/Route RBAC & live edit propagation", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "ef3-admin@test.local" });
    const hqId = await getDefaultBranchId(page);

    // T1-EF3-01: 8 system role presets seeded per company
    const presetsRes = await page.request.get("/api/custom-roles");
    expect(presetsRes.status()).toBe(200);
    const presetsJson = (await presetsRes.json()) as {
      roles: Array<{ id: string; name: string; isSystem: boolean }>;
    };
    for (const presetName of SYSTEM_ROLE_PRESET_NAMES) {
      expect(presetsJson.roles.some((r) => r.name === presetName && r.isSystem)).toBe(true);
    }

    await page.goto("/roles");
    await expect(page.getByRole("heading", { level: 1, name: /roles/i })).toBeVisible();
    for (const presetName of SYSTEM_ROLE_PRESET_NAMES) {
      await expect(page.getByText(presetName, { exact: false }).first()).toBeVisible();
    }

    // T1-EF3-02: Create custom role with granular 18-module matrix
    const auditorPerms = buildPermissionMap({
      products: readOnlyAccess(),
      inventory: readOnlyAccess(),
      audit: readOnlyAccess(),
      branches: readOnlyAccess(),
    });
    const createRoleRes = await apiRequest(page, "POST", "/api/custom-roles", {
      name: "Inventory Auditor",
      description: "Read-only stock and audit access",
      baseRole: "user",
      permissions: auditorPerms,
    });
    expect(createRoleRes.status()).toBe(201);
    const customRole = ((await createRoleRes.json()) as { role: { id: string; name: string } }).role;
    await page.reload();
    await expect(page.getByText("Inventory Auditor").first()).toBeVisible();

    // T1-EF3-03: Assign custom role to user & verify user_roles.role sync
    await createUserWithCustomRoleApi(page, {
      name: "Auditor User",
      email: "auditor@test.local",
      password: "Password123!",
      baseRole: "user",
      customRoleId: customRole.id,
      branchId: hqId,
    });

    const userCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const userPage = await userCtx.newPage();
      await loginViaUi(userPage, "auditor@test.local", "Password123!");
      const meJson = (await (await userPage.request.get("/api/auth/me")).json()) as {
        user: { role: string; customRoleName?: string; permissions: Record<string, Record<string, boolean>> };
      };
      expect(meJson.user.role).toBe("user");
      expect(meJson.user.customRoleName).toBe("Inventory Auditor");
      expect(meJson.user.permissions.products.view).toBe(true);
      expect(meJson.user.permissions.products.create).toBe(false);

      // T1-EF3-04: Sidebar link hiding & <RequirePermission> route gating
      await expect(userPage.getByRole("link", { name: /^Users$/i })).toBeHidden();
      await userPage.goto("/users");
      const accessDeniedVisible = await userPage
        .getByText(/access denied|forbidden|not authorized|permission/i)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!accessDeniedVisible) {
        await expect(userPage).not.toHaveURL(/\/users$/);
      }

      // T1-EF3-05: Page action button gating + edit propagation
      await userPage.goto("/products");
      await expect(userPage.getByRole("heading", { level: 1, name: /products/i })).toBeVisible();
      await expect(userPage.getByRole("button", { name: /add product/i })).toBeHidden();

      // Admin edits role to enable products.create
      const updatedPerms = {
        ...auditorPerms,
        products: { view: true, create: true, edit: false, delete: false, approve: false },
      };
      const editRoleRes = await apiRequest(page, "PUT", `/api/custom-roles/${customRole.id}`, {
        permissions: updatedPerms,
      });
      expect(editRoleRes.status()).toBe(200);

      await userPage.reload();
      await expect(userPage.getByRole("button", { name: /add product/i })).toBeVisible();
      const createProdRes = await apiRequest(userPage, "POST", "/api/products", {
        sku: "AUD-NEW-01",
        name: "Auditor Added Item",
        costPrice: 10,
        sellingPrice: 20,
      });
      expect(createProdRes.status()).toBe(201);
    } finally {
      await userCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("EF4 (T1-EF4-01..05): RFC 6238 TOTP 2FA enrollment, verify, MFA challenge login, recovery code & disable", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const email = "ef4-admin@test.local";
    const password = "Password123!";
    await signupFirstAdmin(page, { email, password });

    // T1-EF4-01: Enroll TOTP 2FA
    const enrollRes = await apiRequest(page, "POST", "/api/auth/mfa/enroll", {});
    expect(enrollRes.status()).toBe(200);
    const enrollJson = (await enrollRes.json()) as {
      otpauthUrl: string;
      secretMasked: string;
      recoveryCodes: string[];
    };
    expect(enrollJson.otpauthUrl).toMatch(/^otpauth:\/\/totp\//i);
    expect(enrollJson.recoveryCodes).toHaveLength(8);
    expect(new Set(enrollJson.recoveryCodes).size).toBe(8);

    const statusBefore = (await (await page.request.get("/api/auth/mfa/status")).json()) as {
      enabled: boolean;
    };
    expect(statusBefore.enabled).toBe(false);

    // T1-EF4-02: Verify TOTP enrollment with live node:crypto code
    const secret = extractSecretFromOtpauthUrl(enrollJson.otpauthUrl);
    await waitForSafeTotpWindow();
    const totpCode = generateTotpCode(secret);
    const verifyRes = await apiRequest(page, "POST", "/api/auth/mfa/verify", { code: totpCode });
    expect(verifyRes.status()).toBe(200);

    const statusAfter = (await (await page.request.get("/api/auth/mfa/status")).json()) as {
      enabled: boolean;
      verifiedAt: string | null;
      recoveryCodesRemaining: number;
    };
    expect(statusAfter.enabled).toBe(true);
    expect(statusAfter.verifiedAt).toBeTruthy();
    expect(statusAfter.recoveryCodesRemaining).toBe(8);

    // T1-EF4-03: MFA challenge on login & completion via valid TOTP
    await logoutViaApi(page);
    await waitForSafeTotpWindow();
    await loginWithMfaChallengeUi(page, email, password, generateTotpCode(secret));
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();

    // T1-EF4-04: Login using single-use recovery code
    await logoutViaApi(page);
    await loginWithMfaChallengeUi(page, email, password, enrollJson.recoveryCodes[0]);
    const statusRecovery = (await (await page.request.get("/api/auth/mfa/status")).json()) as {
      recoveryCodesRemaining: number;
    };
    expect(statusRecovery.recoveryCodesRemaining).toBe(7);

    // T1-EF4-05: Regenerate recovery codes & disable 2FA
    const regenRes = await apiRequest(page, "POST", "/api/auth/mfa/recovery-codes", { password });
    expect(regenRes.status()).toBe(200);
    const regenJson = (await regenRes.json()) as { recoveryCodes: string[] };
    expect(regenJson.recoveryCodes).toHaveLength(8);

    const disableRes = await apiRequest(page, "POST", "/api/auth/mfa/disable", { password });
    expect(disableRes.status()).toBe(200);
    const statusDisabled = (await (await page.request.get("/api/auth/mfa/status")).json()) as {
      enabled: boolean;
    };
    expect(statusDisabled.enabled).toBe(false);

    // Subsequent login goes directly to / without MFA prompt
    await logoutViaApi(page);
    await loginViaUi(page, email, password);
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("EF5 (T1-EF5-01..05): Active Sessions multi-context list, single revoke, revoke-others, lastActivityAt & self-revoke", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const email = "ef5-admin@test.local";
    const password = "Password123!";
    await signupFirstAdmin(page, { email, password });

    const ctxB = await browser.newContext({ baseURL: BASE_URL, userAgent: "Playwright-Device-B/1.0" });
    const ctxC = await browser.newContext({ baseURL: BASE_URL, userAgent: "Playwright-Device-C/1.0" });
    try {
      const pageB = await ctxB.newPage();
      const pageC = await ctxC.newPage();
      await loginViaUi(pageB, email, password);
      await loginViaUi(pageC, email, password);

      // T1-EF5-01: List active sessions across contexts
      const listRes = await page.request.get("/api/auth/sessions");
      expect(listRes.status()).toBe(200);
      const listJson = (await listRes.json()) as {
        sessions: Array<{
          id: string;
          userAgent: string | null;
          lastActivityAt: string;
          createdAt: string;
          expiresAt: string;
          isCurrent: boolean;
        }>;
      };
      expect(listJson.sessions.length).toBe(3);
      const currentSessions = listJson.sessions.filter((s) => s.isCurrent);
      expect(currentSessions).toHaveLength(1);
      const currentSession = currentSessions[0];
      expect(Number.isFinite(Date.parse(currentSession.lastActivityAt))).toBe(true);

      // T1-EF5-04: lastActivityAt updates on authenticated activity
      const beforeActivityMs = Date.parse(currentSession.lastActivityAt);
      await page.waitForTimeout(1100);
      await page.request.get("/api/branches");
      const listAfterAct = (await (await page.request.get("/api/auth/sessions")).json()) as {
        sessions: Array<{ id: string; lastActivityAt: string; isCurrent: boolean }>;
      };
      const updatedCurrent = listAfterAct.sessions.find((s) => s.isCurrent);
      expect(updatedCurrent).toBeTruthy();
      expect(Date.parse(updatedCurrent!.lastActivityAt)).toBeGreaterThanOrEqual(beforeActivityMs);

      // T1-EF5-02: Revoke single non-current session (Context B)
      const sessionB = listJson.sessions.find((s) => !s.isCurrent && (s.userAgent ?? "").includes("Device-B"));
      expect(sessionB).toBeTruthy();
      const revokeBRes = await apiRequest(page, "DELETE", `/api/auth/sessions/${sessionB!.id}`);
      expect(revokeBRes.status()).toBe(200);

      expect((await pageB.request.get("/api/branches")).status()).toBe(401);
      expect((await pageC.request.get("/api/branches")).status()).toBe(200);

      // T1-EF5-03: Revoke all other sessions
      const revokeOthersRes = await apiRequest(page, "POST", "/api/auth/sessions/revoke-others", {});
      expect(revokeOthersRes.status()).toBe(200);
      expect((await pageC.request.get("/api/branches")).status()).toBe(401);

      const listRemaining = (await (await page.request.get("/api/auth/sessions")).json()) as {
        sessions: Array<{ id: string; isCurrent: boolean }>;
      };
      expect(listRemaining.sessions).toHaveLength(1);
      expect(listRemaining.sessions[0].isCurrent).toBe(true);

      // T1-EF5-05: Revoking current session logs out caller cleanly
      const selfRevoke = await apiRequest(page, "DELETE", `/api/auth/sessions/${currentSession.id}`);
      expect(selfRevoke.status()).toBe(200);
      expect((await page.request.get("/api/branches")).status()).toBe(401);
      await page.goto("/products");
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await ctxB.close();
      await ctxC.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("EF6 (T1-EF6-01..05): Before/After Audit Diffs, UI Diff Viewer, Secret Scrubbing & Company Filtering", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const password = "Password123!";
    const newPassword = "NewPassword456!";
    await signupFirstAdmin(page, { email: "ef6-admin@test.local", password });
    const hq1 = await getDefaultBranchId(page);

    // T1-EF6-01: Audit Diff recorded on creation
    const prod = await createProductApi(page, {
      sku: "DIFF-SKU-01",
      name: "Audit Diff Widget",
      branchId: hq1,
      sellingPrice: 100,
    });

    // T1-EF6-02: Audit Diff recorded on update
    const updateProdRes = await apiRequest(page, "PUT", `/api/products/${prod.id}`, {
      sellingPrice: 145,
    });
    expect(updateProdRes.ok()).toBe(true);

    const logsRes = await page.request.get(`/api/audit-logs?q=${encodeURIComponent(prod.sku)}`);
    expect(logsRes.status()).toBe(200);
    const logsJson = (await logsRes.json()) as {
      entries: Array<{
        action: string;
        entityId: string;
        companyId?: string;
        beforeJson: Record<string, unknown> | null;
        afterJson: Record<string, unknown> | null;
        changedFields: string[];
      }>;
    };
    const createEntry = logsJson.entries.find((e) => e.entityId === prod.id && e.beforeJson === null);
    expect(createEntry).toBeTruthy();
    expect(createEntry!.afterJson).toBeTruthy();
    expect(createEntry!.changedFields.length).toBeGreaterThan(0);

    const updateEntry = logsJson.entries.find(
      (e) => e.entityId === prod.id && e.beforeJson !== null && e.changedFields.includes("sellingPrice")
    );
    expect(updateEntry).toBeTruthy();
    expect(updateEntry!.beforeJson!.sellingPrice).toBe(100);
    expect(updateEntry!.afterJson!.sellingPrice).toBe(145);

    // T1-EF6-03: Audit Diff UI viewer renders cleanly
    await page.goto("/audit-log");
    await expect(page.getByRole("heading", { level: 1, name: /audit log/i })).toBeVisible();
    const diffBtn = page.getByRole("button", { name: /view diff|diff|details|inspect/i }).first();
    if (await diffBtn.isVisible().catch(() => false)) {
      await diffBtn.click();
      const dialog = page.getByRole("dialog").last();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
    }

    // T1-EF6-04: Secret scrubbing on password change & MFA lifecycle
    const pwRes = await apiRequest(page, "POST", "/api/auth/change-password", {
      currentPassword: password,
      newPassword,
    });
    expect(pwRes.status()).toBe(200);
    const { secret } = await enrollAndVerifyMfaApi(page);

    const allLogsJson = (await (await page.request.get("/api/audit-logs?limit=50")).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    for (const entry of allLogsJson.entries) {
      assertNoSecretsInAuditEntry(entry);
      const text = JSON.stringify(entry);
      expect(text).not.toContain(password);
      expect(text).not.toContain(newPassword);
      expect(text).not.toContain(secret);
    }

    // T1-EF6-05: Audit logs scoped to activeCompanyId
    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Audit Beta" });
    await switchCompanyViaUi(page, /COMP-02|Audit Beta/i);
    const comp2Logs = (await (await page.request.get(`/api/audit-logs?q=${encodeURIComponent(prod.sku)}`)).json()) as {
      entries: Array<{ companyId?: string; entityId?: string }>;
    };
    expect(comp2Logs.entries.some((e) => e.entityId === prod.id)).toBe(false);
    expect(comp2Logs.entries.every((e) => !e.companyId || e.companyId === comp2.id)).toBe(true);

    expect(pageErrors).toEqual([]);
  });

  test("EF7 (T1-EF7-01..05): Command Palette Ctrl+K, /api/search, keyboard/click navigation, normalization & Escape", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "ef7-admin@test.local" });
    const hqId = await getDefaultBranchId(page);

    await createProductApi(page, { sku: "LSR-X9", name: "Laser Printer X9", branchId: hqId });
    await createCustomerApi(page, "Acme Retail Corp");

    // T1-EF7-01: Open Command Palette via Ctrl+K
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.keyboard.press("Control+k");
    const cmdDialog = page.getByRole("dialog").last();
    await expect(cmdDialog).toBeVisible();

    const searchInput = cmdDialog.locator('input[cmdk-input], input').first();
    await expect(searchInput).toBeFocused();

    // T1-EF7-02: Search via GET /api/search?q=Laser
    const searchPromise = page.waitForResponse(
      (res) => res.url().includes("/api/search") && res.url().includes("Laser") && res.status() === 200
    );
    await searchInput.fill("Laser");
    await searchPromise;

    const laserOption = cmdDialog
      .locator('[cmdk-item], [role="option"]')
      .filter({ hasText: /Laser Printer X9/i })
      .first();
    await expect(laserOption).toBeVisible();

    // T1-EF7-03: Navigate on click / Enter
    await laserOption.click();
    await expect(cmdDialog).toBeHidden();
    await expect(page).toHaveURL(/\/products/i);

    // T1-EF7-04: Query trim & limit normalization
    const normRes = await page.request.get("/api/search?q=%20%20Laser%20%20&limit=5");
    expect(normRes.status()).toBe(200);
    const normJson = (await normRes.json()) as { query: string; results: Array<{ title: string }> };
    expect(normJson.query).toBe("Laser");
    expect(normJson.results.length).toBeLessThanOrEqual(5);

    // T1-EF7-05: Close Command Palette with Escape
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog").last()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test("EF8 (T1-EF8-01..05): EnterpriseDataTable column visibility, Saved Views persistence, bulk selection & streaming CSV/XLSX exports", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "ef8-admin@test.local" });
    const hqId = await getDefaultBranchId(page);

    await createProductApi(page, { sku: "TBL-01", name: "Alpha Desk", branchId: hqId });
    await createProductApi(page, { sku: "TBL-02", name: "Beta Chair", branchId: hqId });

    await page.goto("/products");
    await expect(page.getByRole("heading", { level: 1, name: /products/i })).toBeVisible();
    await expect(page.getByText("Alpha Desk")).toBeVisible();

    // T1-EF8-01: Column visibility toggle (if Columns button rendered)
    const columnsBtn = page.getByRole("button", { name: /columns|view/i }).first();
    if (await columnsBtn.isVisible().catch(() => false)) {
      await columnsBtn.click();
      const firstToggle = page.getByRole("menuitemcheckbox").or(page.getByRole("checkbox")).first();
      if (await firstToggle.isVisible().catch(() => false)) {
        await firstToggle.click();
        await page.keyboard.press("Escape");
      }
    }

    // T1-EF8-02 & T1-EF8-03: Saved Views create, persist across reload, update & delete
    const createViewRes = await apiRequest(page, "POST", "/api/saved-views", {
      resource: "products",
      name: "Compact Stock View",
      configJson: { columns: { sku: true, name: true }, sortBy: "name", sortDir: "asc", pageSize: 25 },
      isDefault: true,
    });
    expect(createViewRes.status()).toBe(201);
    const savedView = ((await createViewRes.json()) as { view: { id: string; name: string } }).view;

    await page.reload();
    const listViewsRes = await page.request.get("/api/saved-views?resource=products");
    expect(listViewsRes.status()).toBe(200);
    const listViewsJson = (await listViewsRes.json()) as { views: Array<{ id: string; name: string; isDefault: boolean }> };
    expect(listViewsJson.views.some((v) => v.id === savedView.id && v.name === "Compact Stock View")).toBe(true);

    const updateViewRes = await apiRequest(page, "PUT", `/api/saved-views/${savedView.id}`, {
      name: "Compact Stock View v2",
    });
    expect(updateViewRes.status()).toBe(200);

    const deleteViewRes = await apiRequest(page, "DELETE", `/api/saved-views/${savedView.id}`);
    expect(deleteViewRes.status()).toBe(200);

    // T1-EF8-04: Bulk row selection
    const checkboxes = page.locator("table").getByRole("checkbox");
    if ((await checkboxes.count()) >= 3) {
      await checkboxes.nth(1).check();
      await checkboxes.nth(2).check();
      await expect(page.getByText(/2 selected/i)).toBeVisible();
    }

    // T1-EF8-05: Server-side streaming CSV & XLSX exports
    const csvRes = await page.request.get("/api/exports/products?format=csv");
    expect(csvRes.status()).toBe(200);
    expect(csvRes.headers()["content-type"] ?? "").toMatch(/text\/csv/i);
    expect(csvRes.headers()["content-disposition"] ?? "").toMatch(/attachment/i);
    expect((csvRes.headers()["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff");
    const csvBody = await csvRes.text();
    expect(csvBody).toContain("Alpha Desk");
    expect(csvBody).toContain("Beta Chair");

    const xlsxRes = await page.request.get("/api/exports/products?format=xlsx");
    expect(xlsxRes.status()).toBe(200);
    expect(xlsxRes.headers()["content-type"] ?? "").toMatch(
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i
    );
    expect(xlsxRes.headers()["content-disposition"] ?? "").toMatch(/attachment/i);
    expect((xlsxRes.headers()["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff");
    const xlsxBuf = await xlsxRes.body();
    expect(xlsxBuf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    expect(pageErrors).toEqual([]);
  });

  test("EF9 (T1-EF9-01..05): Pluggable local Attachments upload/download/SHA-256/delete across Invoice, Bill, Product, Journal & 8 MIME types", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "ef9-admin@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "ATT-SKU-01", name: "Attachment Item", branchId: hqId });
      const cust = await createCustomerApi(page, "Attachment Customer");
      const vendor = await createVendorApi(page, "Attachment Vendor");
      const invoice = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });
      const bill = await createVendorBillApi(page, { vendorId: vendor.id, branchId: hqId, productId: prod.id });
      const journal = await createManualJournalApi(page, { branchId: hqId, memo: "Attachment JE" });

      // T1-EF9-01: Upload PDF attachment on Invoice via UI panel (or API fallback if panel tab differs)
      const pdfBytes = buildMinimalPdfBuffer("Invoice Attachment E2E");
      const pdfSha = sha256Hex(pdfBytes);

      await page.goto("/sales/invoices");
      await expect(page.getByText(invoice.invoiceNumber)).toBeVisible();
      await page.getByText(invoice.invoiceNumber).click();
      const dialog = page.getByRole("dialog").last();
      await expect(dialog).toBeVisible();

      const fileInput = dialog.locator('input[type="file"]').first();
      if ((await fileInput.count()) > 0) {
        const uploadPromise = page.waitForResponse(
          (res) => res.url().includes("/api/attachments") && res.request().method() === "POST"
        );
        await fileInput.setInputFiles({
          name: "receipt-test.pdf",
          mimeType: "application/pdf",
          buffer: pdfBytes,
        });
        const upRes = await uploadPromise;
        expect(upRes.status()).toBe(201);
        const upJson = (await upRes.json()) as {
          attachment: { id: string; sha256: string; storageDriver: string; sizeBytes: number };
        };
        uploadedIds.push(upJson.attachment.id);
        expect(upJson.attachment.storageDriver).toBe("local");
        expect(upJson.attachment.sha256).toBe(pdfSha);
        expect(upJson.attachment.sizeBytes).toBe(pdfBytes.length);
        await expect(dialog.getByText("receipt-test.pdf")).toBeVisible();
      } else {
        const upRes = await uploadAttachmentApi(page, {
          entityType: "invoice",
          entityId: invoice.id,
          fileName: "receipt-test.pdf",
          mimeType: "application/pdf",
          buffer: pdfBytes,
        });
        expect(upRes.status()).toBe(201);
        const upJson = (await upRes.json()) as {
          attachment: { id: string; sha256: string; storageDriver: string };
        };
        uploadedIds.push(upJson.attachment.id);
        expect(upJson.attachment.storageDriver).toBe("local");
        expect(upJson.attachment.sha256).toBe(pdfSha);
      }

      // T1-EF9-02: Download attachment with security headers & SHA-256 verification
      const invAttId = uploadedIds[0];
      const dlRes = await page.request.get(`/api/attachments/${invAttId}/download`);
      expect(dlRes.status()).toBe(200);
      expect(dlRes.headers()["content-disposition"] ?? "").toMatch(/attachment/i);
      expect((dlRes.headers()["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff");
      const dlBytes = await dlRes.body();
      expect(sha256Hex(dlBytes)).toBe(pdfSha);

      // T1-EF9-03: Upload & list across vendor_bill, product, journal_entry
      const targets = [
        { entityType: "vendor_bill", entityId: bill.id, fileName: "bill.txt", mimeType: "text/plain", buf: Buffer.from("bill proof") },
        { entityType: "product", entityId: prod.id, fileName: "spec.png", mimeType: "image/png", buf: buildMinimalPngBuffer() },
        { entityType: "journal_entry", entityId: journal.id, fileName: "ledger.csv", mimeType: "text/csv", buf: Buffer.from("col1,col2\n1,2\n") },
      ];
      for (const t of targets) {
        const r = await uploadAttachmentApi(page, {
          entityType: t.entityType,
          entityId: t.entityId,
          fileName: t.fileName,
          mimeType: t.mimeType,
          buffer: t.buf,
        });
        expect(r.status()).toBe(201);
        const j = (await r.json()) as { attachment: { id: string } };
        uploadedIds.push(j.attachment.id);

        const listR = await page.request.get(
          `/api/attachments?entityType=${encodeURIComponent(t.entityType)}&entityId=${encodeURIComponent(t.entityId)}`
        );
        expect(listR.status()).toBe(200);
        const listJ = (await listR.json()) as { attachments: Array<{ id: string; fileName: string }> };
        expect(listJ.attachments).toHaveLength(1);
        expect(listJ.attachments[0].fileName).toBe(t.fileName);
      }

      // T1-EF9-05: Remaining allowlisted MIME types (jpeg, webp, xlsx, docx)
      const extraMimes = [
        { name: "photo.jpg", mime: "image/jpeg", buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
        { name: "img.webp", mime: "image/webp", buf: Buffer.from("RIFF\x00\x00\x00\x00WEBP") },
        { name: "sheet.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf: buildMinimalZipPayload("xlsx") },
        { name: "doc.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buf: buildMinimalZipPayload("docx") },
      ];
      for (const m of extraMimes) {
        const r = await uploadAttachmentApi(page, {
          entityType: "product",
          entityId: prod.id,
          fileName: m.name,
          mimeType: m.mime,
          buffer: m.buf,
        });
        expect(r.status()).toBe(201);
        uploadedIds.push(((await r.json()) as { attachment: { id: string } }).attachment.id);
      }

      // T1-EF9-04: Delete attachment removes DB record & file
      const delRes = await apiRequest(page, "DELETE", `/api/attachments/${invAttId}`);
      expect(delRes.status()).toBe(200);
      expect((await page.request.get(`/api/attachments/${invAttId}/download`)).status()).toBe(404);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    expect(pageErrors).toEqual([]);
  });

  test("EF10 (T1-EF10-01..05): Print Templates CRUD, Document Emailing with attachments & clean 0007 resetTestDatabase()", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "ef10-admin@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "PRT-01", name: "Template Item", branchId: hqId });
      const cust = await createCustomerApi(page, "Email Client", "client@example.com");
      const invoice = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

      // T1-EF10-01: Create & list Print Template
      const tplRes = await apiRequest(page, "POST", "/api/print-templates", {
        documentType: "invoice",
        name: "Modern Invoice A4",
        headerHtml: "<div>Acme Header</div>",
        footerHtml: "<div>Thank you</div>",
        logoUrl: "/logo.png",
        accentColor: "#1d4ed8",
        isDefault: true,
      });
      expect(tplRes.status()).toBe(201);
      const tpl1 = ((await tplRes.json()) as { template: { id: string; name: string } }).template;

      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: /settings/i })).toBeVisible();
      const printTab = page.getByRole("tab", { name: /print templates/i });
      if (await printTab.isVisible().catch(() => false)) {
        await printTab.click();
        await expect(page.getByText("Modern Invoice A4").first()).toBeVisible();
      }

      // T1-EF10-02: Update & set second template as default + delete
      const updRes = await apiRequest(page, "PUT", `/api/print-templates/${tpl1.id}`, {
        footerHtml: "<div>Updated Footer</div>",
      });
      expect(updRes.status()).toBe(200);

      const tpl2Res = await apiRequest(page, "POST", "/api/print-templates", {
        documentType: "invoice",
        name: "Compact Invoice",
        isDefault: true,
      });
      expect(tpl2Res.status()).toBe(201);
      const tpl2 = ((await tpl2Res.json()) as { template: { id: string } }).template;

      const listTpl = (await (await page.request.get("/api/print-templates?documentType=invoice")).json()) as {
        templates: Array<{ id: string; isDefault: boolean }>;
      };
      expect(listTpl.templates.filter((t) => t.isDefault)).toHaveLength(1);

      const delTplRes = await apiRequest(page, "DELETE", `/api/print-templates/${tpl2.id}`);
      expect(delTplRes.status()).toBe(200);

      // T1-EF10-03 & T1-EF10-04: Email document with stored attachments, cc & templateId
      const attRes = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: invoice.id,
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("Email Attachment"),
      });
      expect(attRes.status()).toBe(201);
      const attId = ((await attRes.json()) as { attachment: { id: string } }).attachment.id;
      uploadedIds.push(attId);

      const email1Res = await apiRequest(page, "POST", `/api/documents/invoice/${invoice.id}/email`, {
        to: "client@example.com",
        subject: `Invoice ${invoice.invoiceNumber}`,
        message: "Please find your invoice attached.",
        attachStoredFiles: true,
      });
      expect(email1Res.status()).toBe(200);
      const email1Json = (await email1Res.json()) as {
        recipients: string[];
        subject: string;
        attachmentCount: number;
      };
      expect(email1Json.recipients).toContain("client@example.com");
      expect(email1Json.attachmentCount).toBeGreaterThanOrEqual(1);

      const email2Res = await apiRequest(page, "POST", `/api/documents/invoice/${invoice.id}/email`, {
        to: ["billing@example.com"],
        cc: ["finance@example.com"],
        subject: `Copy ${invoice.invoiceNumber}`,
        message: "CC copy.",
        attachmentIds: [attId],
        templateId: tpl1.id,
      });
      expect(email2Res.status()).toBe(200);
      const email2Json = (await email2Res.json()) as { recipients: string[]; attachmentCount: number };
      expect(email2Json.attachmentCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    // T1-EF10-05: Clean 0007 DB reset compatibility & re-bootstrap COMP-01
    await resetTestDatabase();
    await page.context().clearCookies();
    await signupFirstAdmin(page, { email: "ef10-rebootstrap@test.local" });
    const reMe = (await (await page.request.get("/api/auth/me")).json()) as {
      user: { activeCompanyId: string };
    };
    expect(reMe.user.activeCompanyId).toBe(DEFAULT_COMPANY_ID);

    expect(pageErrors).toEqual([]);
  });
});

// ============================================================================
// TIER 2: BOUNDARY, NEGATIVE, AUTHZ & INJECTION CASES (54 CASES)
// ============================================================================

test.describe("Tier 2: Boundary, Negative, AuthZ & Injection Cases (54 Cases)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("T2-EF1 (01..05): Unauthenticated guards, TERMINAL_LOCKED 423, invalid creds & CSRF origin", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);

    // T2-EF1-01 & T2-EF1-02: Unauthenticated redirect & 401 API probes
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);

    const anonCtx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      for (const pathUrl of ["/api/companies", "/api/audit-logs", "/api/search?q=a"]) {
        const res = await anonCtx.get(pathUrl);
        expect(res.status()).toBe(401);
      }
    } finally {
      await anonCtx.dispose();
    }

    // Signup admin for remaining EF1 boundary checks
    const adminEmail = "t2-ef1@test.local";
    const adminPass = "Password123!";
    await signupFirstAdmin(page, { email: adminEmail, password: adminPass });
    const hqId = await getDefaultBranchId(page);

    // T2-EF1-03: Locked POS terminal blocks non-exempt routes (423 TERMINAL_LOCKED)
    const termRes = await apiRequest(page, "POST", "/api/pos/terminals", {
      branchId: hqId,
      name: "Lock Test Reg",
      code: "LOCK-01",
    });
    expect(termRes.status()).toBe(201);
    const termId = ((await termRes.json()) as { terminal: { id: string } }).terminal.id;
    expect((await apiRequest(page, "POST", "/api/pos/terminal/bind", { terminalId: termId })).status()).toBe(200);
    expect((await apiRequest(page, "POST", "/api/pos/terminal/lock", {})).status()).toBe(200);

    const lockedProdRes = await page.request.get("/api/products");
    expect(lockedProdRes.status()).toBe(423);
    expect(((await lockedProdRes.json()) as { code?: string }).code).toBe("TERMINAL_LOCKED");

    // T2-EF1-04 & T2-EF1-05: Wrong password 401, deactivated user 403 & CSRF evil Origin 403
    await logoutViaApi(page);
    const badLogin = await apiRequest(page, "POST", "/api/auth/login", {
      email: adminEmail,
      password: "WrongPassword999!",
    });
    expect(badLogin.status()).toBe(401);

    const evilOriginLogin = await page.request.post("/api/auth/login", {
      headers: { Origin: "https://evil.example" },
      data: { email: adminEmail, password: adminPass },
    });
    expect(evilOriginLogin.status()).toBe(403);
    expect(((await evilOriginLogin.json()) as { code?: string }).code).toBe("CSRF_ORIGIN_FORBIDDEN");

    // Login again, create & deactivate user -> 403 ACCOUNT_DISABLED
    await loginViaUi(page, adminEmail, adminPass);
    const cashierId = await findPresetRoleId(page, "Cashier");
    const disUser = await createUserWithCustomRoleApi(page, {
      name: "Disabled User",
      email: "disabled@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });
    await apiRequest(page, "PUT", `/api/users/${disUser.id}/status`, { isActive: false });
    const disLogin = await apiRequest(page, "POST", "/api/auth/login", {
      email: "disabled@test.local",
      password: "Password123!",
    });
    expect(disLogin.status()).toBe(403);

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF2 (01..06): Multi-company invalid switch, non-member 403, cross-company IDOR, bad code & duplicate", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef2@test.local" });
    const hq1 = await getDefaultBranchId(page);
    const prod1 = await createProductApi(page, { sku: "IDOR-P1", name: "Comp1 Secret", branchId: hq1 });
    const cust1 = await createCustomerApi(page, "Comp1 Client");
    const inv1 = await createInvoiceApi(page, { customerId: cust1.id, branchId: hq1, productId: prod1.id });

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Beta Corp" });

    // T2-EF2-01 & T2-EF2-02: Nonexistent & malformed company switch
    expect(
      (
        await apiRequest(page, "POST", "/api/auth/switch-company", {
          companyId: "99999999-9999-4999-8999-999999999999",
        })
      ).status()
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: "not-a-uuid" })).status()
    ).toBe(400);

    // T2-EF2-05: Invalid company code & duplicate COMP-01 & cross-company defaultBranchId
    expect(
      (await apiRequest(page, "POST", "/api/companies", { code: "bad code!", name: "Bad" })).status()
    ).toBe(400);
    expect((await apiRequest(page, "POST", "/api/companies", { code: "A", name: "Short" })).status()).toBe(400);
    expect(
      (await apiRequest(page, "POST", "/api/companies", { code: "COMP-01", name: "Dup" })).status()
    ).toBe(409);
    expect(
      (await apiRequest(page, "PUT", `/api/companies/${comp2.id}`, { defaultBranchId: hq1 })).status()
    ).toBe(400);

    // T2-EF2-03, T2-EF2-04, T2-EF2-06: Non-member switch 403, non-admin create 403, cross-company IDOR
    const cashierRoleId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Comp1 Cashier",
      email: "c1-cashier@test.local",
      password: "Password123!",
      customRoleId: cashierRoleId,
      branchId: hq1,
    });

    const userCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const userPage = await userCtx.newPage();
      await loginViaUi(userPage, "c1-cashier@test.local", "Password123!");
      expect(
        (await apiRequest(userPage, "POST", "/api/auth/switch-company", { companyId: comp2.id })).status()
      ).toBe(403);
      expect(
        (await apiRequest(userPage, "POST", "/api/companies", { code: "COMP-99", name: "Rogue" })).status()
      ).toBe(403);
    } finally {
      await userCtx.close();
    }

    // Admin switches to COMP-02 -> cross-company IDOR on COMP-01 invoice/product fails with 403/404
    expect(
      (await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id })).status()
    ).toBe(200);
    expect([403, 404]).toContain((await page.request.get(`/api/sales-invoices/${inv1.id}`)).status());
    expect([403, 404]).toContain(
      (await apiRequest(page, "PUT", `/api/products/${prod1.id}`, { name: "Hijacked" })).status()
    );

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF3 (01..06): Custom role validation bounds, system preset protection, 403s, cross-company & escalation block", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef3@test.local" });
    const hqId = await getDefaultBranchId(page);
    const adminPresetId = await findPresetRoleId(page, "Admin");
    const cashierPresetId = await findPresetRoleId(page, "Cashier");

    // T2-EF3-01: Incomplete & unknown-module permissions rejected
    expect(
      (await apiRequest(page, "POST", "/api/custom-roles", { name: "EmptyPerms", permissions: {} })).status()
    ).toBe(400);
    expect(
      (
        await apiRequest(page, "POST", "/api/custom-roles", {
          name: "UnknownMod",
          permissions: { ...buildPermissionMap(), nonexistent: fullAccess() },
        })
      ).status()
    ).toBe(400);

    // T2-EF3-02: Name length bounds & duplicate name
    expect(
      (
        await apiRequest(page, "POST", "/api/custom-roles", {
          name: "A",
          permissions: buildPermissionMap(),
        })
      ).status()
    ).toBe(400);
    expect(
      (
        await apiRequest(page, "POST", "/api/custom-roles", {
          name: "X".repeat(81),
          permissions: buildPermissionMap(),
        })
      ).status()
    ).toBe(400);
    expect(
      (
        await apiRequest(page, "POST", "/api/custom-roles", {
          name: "Admin",
          permissions: buildPermissionMap(),
        })
      ).status()
    ).toBe(409);

    // T2-EF3-03: Delete protected system preset blocked
    expect([400, 403, 409]).toContain(
      (await apiRequest(page, "DELETE", `/api/custom-roles/${adminPresetId}`)).status()
    );

    // T2-EF3-05: Cross-company custom role assignment rejected
    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Role Isolation" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const comp2RoleId = await findPresetRoleId(page, "Cashier");
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });

    const targetUser = await createUserWithCustomRoleApi(page, {
      name: "Target User",
      email: "target-ef3@test.local",
      password: "Password123!",
      customRoleId: cashierPresetId,
      branchId: hqId,
    });
    expect([400, 404]).toContain(
      (
        await apiRequest(page, "PUT", `/api/users/${targetUser.id}/custom-role`, {
          customRoleId: comp2RoleId,
          companyId: DEFAULT_COMPANY_ID,
        })
      ).status()
    );

    // T2-EF3-04 & T2-EF3-06: Cashier 403s & non-admin Manager privilege escalation blocked
    const userMgrRoleRes = await apiRequest(page, "POST", "/api/custom-roles", {
      name: "User Admin Lite",
      baseRole: "manager",
      permissions: buildPermissionMap({
        users: { view: true, create: true, edit: true, delete: false, approve: false },
        roles: readOnlyAccess(),
      }),
    });
    expect(userMgrRoleRes.status()).toBe(201);
    const userMgrRoleId = ((await userMgrRoleRes.json()) as { role: { id: string } }).role.id;

    await createUserWithCustomRoleApi(page, {
      name: "Mgr Lite",
      email: "mgr-lite@test.local",
      password: "Password123!",
      baseRole: "manager",
      customRoleId: userMgrRoleId,
      branchId: hqId,
    });

    const cashierCtx = await browser.newContext({ baseURL: BASE_URL });
    const mgrCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const cashierPage = await cashierCtx.newPage();
      await loginViaUi(cashierPage, "target-ef3@test.local", "Password123!");
      expect(
        (
          await apiRequest(cashierPage, "POST", "/api/custom-roles", {
            name: "Rogue",
            permissions: buildPermissionMap(),
          })
        ).status()
      ).toBe(403);
      expect((await cashierPage.request.get("/api/users")).status()).toBe(403);
      expect(
        (
          await apiRequest(cashierPage, "POST", "/api/products", {
            sku: "R-1",
            name: "Rogue",
            costPrice: 1,
            sellingPrice: 2,
          })
        ).status()
      ).toBe(403);

      const mgrPage = await mgrCtx.newPage();
      await loginViaUi(mgrPage, "mgr-lite@test.local", "Password123!");
      expect(
        (
          await apiRequest(mgrPage, "PUT", `/api/users/${targetUser.id}/custom-role`, {
            customRoleId: adminPresetId,
          })
        ).status()
      ).toBe(403);
    } finally {
      await cashierCtx.close();
      await mgrCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF4 (01..05): TOTP invalid format, stale code, recovery reuse, tampered token & empty disable/regen", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const email = "t2-ef4@test.local";
    const password = "Password123!";
    await signupFirstAdmin(page, { email, password });

    const enrollJson = (await (await apiRequest(page, "POST", "/api/auth/mfa/enroll", {})).json()) as {
      otpauthUrl: string;
      recoveryCodes: string[];
    };
    const secret = extractSecretFromOtpauthUrl(enrollJson.otpauthUrl);

    // T2-EF4-01: Invalid TOTP format
    for (const badCode of ["12ab56", "12345", "1234567"]) {
      expect((await apiRequest(page, "POST", "/api/auth/mfa/verify", { code: badCode })).status()).toBe(400);
    }

    // T2-EF4-02 (part 1): Stale code rejected during enroll verify
    const staleCode = generateTotpCode(secret, { stepOffset: -10 });
    expect([400, 401]).toContain(
      (await apiRequest(page, "POST", "/api/auth/mfa/verify", { code: staleCode })).status()
    );
    expect(((await (await page.request.get("/api/auth/mfa/status")).json()) as { enabled: boolean }).enabled).toBe(
      false
    );

    // Enable validly to test login challenge errors
    await waitForSafeTotpWindow();
    expect(
      (await apiRequest(page, "POST", "/api/auth/mfa/verify", { code: generateTotpCode(secret) })).status()
    ).toBe(200);

    // T2-EF4-05: Wrong password on disable & empty body on regenerate
    expect(
      [400, 401]
    ).toContain((await apiRequest(page, "POST", "/api/auth/mfa/disable", { password: "Wrong!" })).status());
    expect((await apiRequest(page, "POST", "/api/auth/mfa/recovery-codes", {})).status()).toBe(400);

    // T2-EF4-02 (part 2) & T2-EF4-04: Stale TOTP and tampered/short mfaChallengeToken on login
    await logoutViaApi(page);
    const loginChal = (await (
      await apiRequest(page, "POST", "/api/auth/login", { email, password })
    ).json()) as { mfaRequired: boolean; mfaChallengeToken: string };
    expect(loginChal.mfaRequired).toBe(true);

    expect(
      (
        await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
          mfaChallengeToken: loginChal.mfaChallengeToken,
          code: staleCode,
        })
      ).status()
    ).toBe(401);
    expect(
      (
        await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
          mfaChallengeToken: "short",
          code: "123456",
        })
      ).status()
    ).toBe(400);
    await waitForSafeTotpWindow();
    expect(
      (
        await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
          mfaChallengeToken: "forged-challenge-token-1234567890",
          code: generateTotpCode(secret),
        })
      ).status()
    ).toBe(401);

    // T2-EF4-03: Reused single-use recovery code rejected on 2nd login
    const usedRecovery = enrollJson.recoveryCodes[0];
    expect(
      (
        await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
          mfaChallengeToken: loginChal.mfaChallengeToken,
          code: usedRecovery,
        })
      ).status()
    ).toBe(200);

    await logoutViaApi(page);
    const loginChal2 = (await (
      await apiRequest(page, "POST", "/api/auth/login", { email, password })
    ).json()) as { mfaChallengeToken: string };
    expect(
      (
        await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
          mfaChallengeToken: loginChal2.mfaChallengeToken,
          code: usedRecovery,
        })
      ).status()
    ).toBe(401);

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF5 (01..05): Malformed/nonexistent session ID, cross-user session IDOR, revoked 401 & CSRF", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef5@test.local" });
    const hqId = await getDefaultBranchId(page);

    // T2-EF5-01 & T2-EF5-02
    expect((await apiRequest(page, "DELETE", "/api/auth/sessions/not-a-uuid")).status()).toBe(400);
    expect(
      (await apiRequest(page, "DELETE", "/api/auth/sessions/99999999-9999-4999-8999-999999999999")).status()
    ).toBe(404);

    // T2-EF5-05: CSRF on session endpoints
    const adminSessions = (await (await page.request.get("/api/auth/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    const adminSessionId = adminSessions.sessions[0].id;
    expect(
      (
        await page.request.delete(`/api/auth/sessions/${adminSessionId}`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status()
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/auth/sessions/revoke-others", {
          headers: { Origin: "https://evil.example" },
        })
      ).status()
    ).toBe(403);

    // T2-EF5-03 & T2-EF5-04: Cross-user session IDOR & revoked session 401 on GET+POST
    const cashierId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Other User",
      email: "other-ef5@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });

    const userCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const userPage = await userCtx.newPage();
      await loginViaUi(userPage, "other-ef5@test.local", "Password123!");
      expect([403, 404]).toContain(
        (await apiRequest(userPage, "DELETE", `/api/auth/sessions/${adminSessionId}`)).status()
      );
      expect((await page.request.get("/api/branches")).status()).toBe(200);

      // Revoke own session -> subsequent GET and POST return 401
      const uSess = (await (await userPage.request.get("/api/auth/sessions")).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect((await apiRequest(userPage, "DELETE", `/api/auth/sessions/${uSess.sessions[0].id}`)).status()).toBe(200);
      expect((await userPage.request.get("/api/products")).status()).toBe(401);
      expect(
        (await apiRequest(userPage, "POST", "/api/customers", { name: "After Revoke" })).status()
      ).toBe(401);
    } finally {
      await userCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF6 (01..05): Audit 403 unauthorized, secret scrubbing, company isolation, pagination bounds & branch restriction", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef6@test.local" });
    const hqId = await getDefaultBranchId(page);
    await createProductApi(page, { sku: "AUD-C1", name: "Comp1 Audit Prod", branchId: hqId });

    // T2-EF6-04: Pagination limit clamp & malformed cursor
    const limitRes = await page.request.get("/api/audit-logs?limit=999");
    expect(limitRes.status()).toBe(200);
    const limitJson = (await limitRes.json()) as { entries: Array<unknown> };
    expect(limitJson.entries.length).toBeLessThanOrEqual(200);
    expect((await page.request.get("/api/audit-logs?cursor=invalid-cursor!!!")).status()).toBe(400);

    // T2-EF6-02: Secret scrubbing check
    const allLogs = (await (await page.request.get("/api/audit-logs?limit=25")).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    for (const entry of allLogs.entries) {
      assertNoSecretsInAuditEntry(entry);
    }

    // T2-EF6-03: Cross-company audit isolation
    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Audit Isolation" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const c2Logs = (await (await page.request.get("/api/audit-logs?q=AUD-C1")).json()) as {
      entries: Array<unknown>;
    };
    expect(c2Logs.entries).toHaveLength(0);
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });

    // Create 2nd branch to test branch-scoped audit access (T2-EF6-05)
    const br2Res = await apiRequest(page, "POST", "/api/branches", {
      code: "BR-02",
      name: "Second Branch",
      branchType: "retail",
    });
    expect(br2Res.status()).toBe(201);
    const br2Id = ((await br2Res.json()) as { branch: { id: string } }).branch.id;

    // T2-EF6-01 & T2-EF6-05
    const cashierId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Cashier Audit",
      email: "cashier-audit@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });

    const auditReaderRole = await apiRequest(page, "POST", "/api/custom-roles", {
      name: "Branch Audit Reader",
      baseRole: "user",
      permissions: buildPermissionMap({ audit: readOnlyAccess() }),
    });
    expect(auditReaderRole.status()).toBe(201);
    const auditReaderRoleId = ((await auditReaderRole.json()) as { role: { id: string } }).role.id;
    await createUserWithCustomRoleApi(page, {
      name: "Scoped Auditor",
      email: "scoped-auditor@test.local",
      password: "Password123!",
      customRoleId: auditReaderRoleId,
      branchId: hqId,
      branchScopeMode: "selected",
    });

    const cCtx = await browser.newContext({ baseURL: BASE_URL });
    const aCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const cPage = await cCtx.newPage();
      await loginViaUi(cPage, "cashier-audit@test.local", "Password123!");
      expect((await cPage.request.get("/api/audit-logs")).status()).toBe(403);

      const aPage = await aCtx.newPage();
      await loginViaUi(aPage, "scoped-auditor@test.local", "Password123!");
      expect((await aPage.request.get(`/api/audit-logs?branchId=${br2Id}`)).status()).toBe(403);
    } finally {
      await cCtx.close();
      await aCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF7 (01..05): Command Palette search bounds, permission filter, company isolation & SQL/XSS character safety", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef7@test.local" });
    const hqId = await getDefaultBranchId(page);

    const prod = await createProductApi(page, { sku: "SEC-ALPHA", name: "Secret Alpha Product", branchId: hqId });
    await createManualJournalApi(page, { branchId: hqId, memo: "Secret Ledger Memo" });

    // T2-EF7-01 & T2-EF7-02
    expect((await page.request.get("/api/search?q=")).status()).toBe(400);
    expect((await page.request.get("/api/search?q=%20%20%20")).status()).toBe(400);
    expect((await page.request.get(`/api/search?q=${"a".repeat(121)}`)).status()).toBe(400);
    expect((await page.request.get("/api/search?q=Secret&limit=51")).status()).toBe(400);

    // T2-EF7-05: SQL wildcard & XSS character safety
    const specialRes = await page.request.get(
      `/api/search?q=${encodeURIComponent(`%_'"<script>alert(1)</script>`)}`
    );
    expect(specialRes.status()).toBe(200);

    // T2-EF7-03: Permission filtering for Cashier
    const cashierId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Search Cashier",
      email: "search-cashier@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });
    const cCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const cPage = await cCtx.newPage();
      await loginViaUi(cPage, "search-cashier@test.local", "Password123!");
      const cSearch = (await (await cPage.request.get("/api/search?q=Secret")).json()) as {
        results: Array<{ type: string; id: string }>;
      };
      expect(cSearch.results.some((r) => r.type === "journal_entry" || r.type === "vendor_bill")).toBe(false);
    } finally {
      await cCtx.close();
    }

    // T2-EF7-04: Company isolation in search
    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Search Beta" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const comp2Search = (await (await page.request.get("/api/search?q=Secret%20Alpha")).json()) as {
      results: Array<{ id: string }>;
    };
    expect(comp2Search.results.some((r) => r.id === prod.id)).toBe(false);

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF8 (01..05): Export invalid resource/format, 403 RBAC, CSV quoting/company scoping & Saved Views bounds/IDOR", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t2-ef8@test.local" });
    const hqId = await getDefaultBranchId(page);

    await createProductApi(page, { sku: "CSV-Q1", name: 'Widget, "Pro"', branchId: hqId });

    // T2-EF8-01
    expect((await page.request.get("/api/exports/nonexistent?format=csv")).status()).toBe(400);
    expect((await page.request.get("/api/exports/products?format=pdf")).status()).toBe(400);

    // T2-EF8-03: CSV quoting & COMP-02 exclusion
    const csv1 = await (await page.request.get("/api/exports/products?format=csv")).text();
    expect(csv1).toContain('"Widget, ""Pro"""');

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Export Beta" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const csv2 = await (await page.request.get("/api/exports/products?format=csv")).text();
    expect(csv2).not.toContain("CSV-Q1");
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });

    // T2-EF8-04: Saved view duplicate name & pageSize > 200 / 0
    expect(
      (
        await apiRequest(page, "POST", "/api/saved-views", {
          resource: "products",
          name: "My View",
          configJson: {},
        })
      ).status()
    ).toBe(201);
    const viewList = (await (await page.request.get("/api/saved-views?resource=products")).json()) as {
      views: Array<{ id: string }>;
    };
    const viewId = viewList.views[0].id;
    expect(
      (
        await apiRequest(page, "POST", "/api/saved-views", {
          resource: "products",
          name: "My View",
          configJson: {},
        })
      ).status()
    ).toBe(409);
    expect(
      (
        await apiRequest(page, "POST", "/api/saved-views", {
          resource: "products",
          name: "Bad PageSize",
          configJson: { pageSize: 201 },
        })
      ).status()
    ).toBe(400);

    // T2-EF8-02 & T2-EF8-05: Cashier export 403 & cross-user saved view modify blocked
    const cashierId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Export Cashier",
      email: "export-cashier@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });
    const cCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const cPage = await cCtx.newPage();
      await loginViaUi(cPage, "export-cashier@test.local", "Password123!");
      expect((await cPage.request.get("/api/exports/journal-entries?format=csv")).status()).toBe(403);
      expect((await cPage.request.get("/api/exports/audit-logs?format=xlsx")).status()).toBe(403);
      expect([403, 404]).toContain(
        (await apiRequest(cPage, "PUT", `/api/saved-views/${viewId}`, { name: "Hijack" })).status()
      );
      expect([403, 404]).toContain(
        (await apiRequest(cPage, "DELETE", `/api/saved-views/${viewId}`)).status()
      );
    } finally {
      await cCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF9 (01..05): Attachments disallowed MIME, >10MB BVA, 0-byte/bad entity, cross-company IDOR & path traversal", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "t2-ef9@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "ATT-BVA-1", name: "BVA Item", branchId: hqId });

      // T2-EF9-01: Disallowed MIME types rejected
      for (const bad of [
        { fileName: "evil.html", mimeType: "text/html", buf: Buffer.from("<script>1</script>") },
        { fileName: "evil.svg", mimeType: "image/svg+xml", buf: Buffer.from("<svg onload=alert(1)/>") },
        { fileName: "evil.js", mimeType: "application/javascript", buf: Buffer.from("alert(1)") },
      ]) {
        const res = await uploadAttachmentApi(page, {
          entityType: "product",
          entityId: prod.id,
          fileName: bad.fileName,
          mimeType: bad.mimeType,
          buffer: bad.buf,
        });
        expect([400, 415]).toContain(res.status());
      }

      // T2-EF9-02: Oversized file (10MB + 1 byte = 10,485,761 bytes) rejected
      const tooBigBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
      const bigRes = await uploadAttachmentApi(page, {
        entityType: "product",
        entityId: prod.id,
        fileName: "too-big.txt",
        mimeType: "text/plain",
        buffer: tooBigBuf,
      });
      expect([400, 413]).toContain(bigRes.status());

      // T2-EF9-03: 0-byte file & invalid entityType rejected
      const emptyRes = await uploadAttachmentApi(page, {
        entityType: "product",
        entityId: prod.id,
        fileName: "empty.txt",
        mimeType: "text/plain",
        buffer: Buffer.alloc(0),
      });
      expect(emptyRes.status()).toBe(400);

      const badEntityRes = await uploadAttachmentApi(page, {
        entityType: "users",
        entityId: prod.id,
        fileName: "ok.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("ok"),
      });
      expect(badEntityRes.status()).toBe(400);

      // T2-EF9-05: Path traversal filename rejected or safely sanitized
      const travRes = await uploadAttachmentApi(page, {
        entityType: "product",
        entityId: prod.id,
        fileName: "../../evil.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("Traversal Test"),
      });
      if (travRes.status() === 201) {
        const travJson = (await travRes.json()) as { attachment: { id: string; fileName: string } };
        uploadedIds.push(travJson.attachment.id);
        expect(travJson.attachment.fileName).not.toContain("..");
      } else {
        expect(travRes.status()).toBe(400);
      }

      // T2-EF9-04: Cross-company download/delete/upload IDOR blocked
      const validRes = await uploadAttachmentApi(page, {
        entityType: "product",
        entityId: prod.id,
        fileName: "comp1-doc.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("Comp1 Confidential"),
      });
      expect(validRes.status()).toBe(201);
      const attId = ((await validRes.json()) as { attachment: { id: string } }).attachment.id;
      uploadedIds.push(attId);

      const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Att Isolation" });
      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
      expect([403, 404]).toContain((await page.request.get(`/api/attachments/${attId}/download`)).status());
      expect([403, 404]).toContain((await apiRequest(page, "DELETE", `/api/attachments/${attId}`)).status());
      const crossUp = await uploadAttachmentApi(page, {
        entityType: "product",
        entityId: prod.id,
        fileName: "cross.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("cross"),
      });
      expect([403, 404]).toContain(crossUp.status());

      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    expect(pageErrors).toEqual([]);
  });

  test("T2-EF10 (01..05): Print template XSS logoUrl/hex/RBAC & Email CRLF injection, recipient bounds & cross-company IDOR", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "t2-ef10@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "EM-01", name: "Email Item", branchId: hqId });
      const cust = await createCustomerApi(page, "Email Cust");
      const inv = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

      // T2-EF10-01: XSS/unsafe logoUrl rejected
      for (const badLogo of ["javascript:alert(1)", "//evil.example.com/a.png", "data:text/html,<script>1</script>"]) {
        expect(
          (
            await apiRequest(page, "POST", "/api/print-templates", {
              documentType: "invoice",
              name: "Bad Logo",
              logoUrl: badLogo,
            })
          ).status()
        ).toBe(400);
      }

      // T2-EF10-02: Invalid accentColor, documentType & unauthorized role
      expect(
        (
          await apiRequest(page, "POST", "/api/print-templates", {
            documentType: "invoice",
            name: "Bad Color",
            accentColor: "red",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", "/api/print-templates", {
            documentType: "unknown_type",
            name: "Bad Doc",
          })
        ).status()
      ).toBe(400);

      const cashierId = await findPresetRoleId(page, "Cashier");
      await createUserWithCustomRoleApi(page, {
        name: "Tpl Cashier",
        email: "tpl-cashier@test.local",
        password: "Password123!",
        customRoleId: cashierId,
        branchId: hqId,
      });
      const cCtx = await browser.newContext({ baseURL: BASE_URL });
      try {
        const cPage = await cCtx.newPage();
        await loginViaUi(cPage, "tpl-cashier@test.local", "Password123!");
        expect(
          (
            await apiRequest(cPage, "POST", "/api/print-templates", {
              documentType: "invoice",
              name: "Unauth Tpl",
            })
          ).status()
        ).toBe(403);
      } finally {
        await cCtx.close();
      }

      // T2-EF10-03 & T2-EF10-04: Email CRLF injection, bad email, empty subject, >20 recipients, bad params
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: "good@example.com",
            subject: "Inv\r\nBcc: attacker@evil.com",
            message: "hi",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: "good@example.com",
            subject: "Inv\nX-Injected: 1",
            message: "hi",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: "not-an-email",
            subject: "Valid",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: "good@example.com",
            subject: "   ",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: Array.from({ length: 21 }, (_, idx) => `u${idx}@example.com`),
            subject: "Too many",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", `/api/documents/invalid/${inv.id}/email`, {
            to: "good@example.com",
            subject: "Bad type",
          })
        ).status()
      ).toBe(400);
      expect(
        (
          await apiRequest(page, "POST", "/api/documents/invoice/bad-uuid/email", {
            to: "good@example.com",
            subject: "Bad id",
          })
        ).status()
      ).toBe(400);

      // T2-EF10-05: Cross-company document email & cross-company attachmentIds blocked
      const attRes = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv.id,
        fileName: "c1.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("Comp1"),
      });
      expect(attRes.status()).toBe(201);
      const attId = ((await attRes.json()) as { attachment: { id: string } }).attachment.id;
      uploadedIds.push(attId);

      const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Email Isolation" });
      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
      expect([403, 404]).toContain(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
            to: "good@example.com",
            subject: "Cross tenant",
          })
        ).status()
      );
      const hq2 = await getDefaultBranchId(page);
      const p2 = await createProductApi(page, { sku: "C2-EM", name: "C2 Item", branchId: hq2 });
      const c2 = await createCustomerApi(page, "C2 Cust");
      const i2 = await createInvoiceApi(page, { customerId: c2.id, branchId: hq2, productId: p2.id });
      expect([400, 403, 404]).toContain(
        (
          await apiRequest(page, "POST", `/api/documents/invoice/${i2.id}/email`, {
            to: "good@example.com",
            subject: "Cross attachment",
            attachmentIds: [attId],
          })
        ).status()
      );
      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    expect(pageErrors).toEqual([]);
  });
});

// ============================================================================
// TIER 3: CROSS-FEATURE PAIRWISE COMBINATIONS (12 CASES: T3-01 .. T3-12)
// ============================================================================

test.describe("Tier 3: Cross-Feature Pairwise Combinations (12 Cases)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("T3-01 (EF1 + EF2): Reload after switching company keeps <= 5 initial API GETs and activeCompanyId", async ({
    page,
  }) => {
    await signupFirstAdmin(page, { email: "t3-01@test.local" });
    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Pairwise Beta" });
    let switchDone = false;
    const postSwitchSettled = page
      .waitForResponse(
        (res) => switchDone && res.url().includes("/api/settings/company") && res.request().method() === "GET",
        { timeout: 5000 }
      )
      .catch(() => null);
    await switchCompanyViaUi(page, /COMP-02|Pairwise Beta/i);
    switchDone = true;
    await postSwitchSettled;

    const tracker = trackApiGets(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.waitForTimeout(600);
    expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);
    tracker.stop();

    const me = (await (await page.request.get("/api/auth/me")).json()) as { user: { activeCompanyId: string } };
    expect(me.user.activeCompanyId).toBe(comp2.id);
  });

  test("T3-02 (EF2 + EF3): Per-company Custom Role isolation dynamically swaps user permissions on company switch", async ({
    page,
    browser,
  }) => {
    await signupFirstAdmin(page, { email: "t3-02-admin@test.local" });
    const hq1 = await getDefaultBranchId(page);
    const adminPreset1 = await findPresetRoleId(page, "Admin");

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Role Beta" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const cashierPreset2 = await findPresetRoleId(page, "Cashier");
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });

    const dualUser = await createUserWithCustomRoleApi(page, {
      name: "Dual Role User",
      email: "dual@test.local",
      password: "Password123!",
      baseRole: "admin",
      customRoleId: adminPreset1,
      branchId: hq1,
    });
    const assignComp2 = await apiRequest(page, "POST", `/api/companies/${comp2.id}/members`, {
      userId: dualUser.id,
      customRoleId: cashierPreset2,
    });
    expect(assignComp2.ok()).toBe(true);

    const uCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const uPage = await uCtx.newPage();
      await loginViaUi(uPage, "dual@test.local", "Password123!");
      expect((await uPage.request.get("/api/users")).status()).toBe(200);

      await switchCompanyViaUi(uPage, /COMP-02|Role Beta/i);
      expect((await uPage.request.get("/api/users")).status()).toBe(403);

      await switchCompanyViaUi(uPage, /COMP-01|Count It Keep It/i);
      expect((await uPage.request.get("/api/users")).status()).toBe(200);
    } finally {
      await uCtx.close();
    }
  });

  test("T3-03 (EF2 + EF6): Multi-company audit log diff isolation", async ({ page }) => {
    await signupFirstAdmin(page, { email: "t3-03@test.local" });
    const hq1 = await getDefaultBranchId(page);
    const p1 = await createProductApi(page, { sku: "P1-DIFF", name: "C1 Diff", branchId: hq1, sellingPrice: 50 });
    await apiRequest(page, "PUT", `/api/products/${p1.id}`, { sellingPrice: 75 });

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Audit Beta" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const hq2 = await getDefaultBranchId(page);
    const p2 = await createProductApi(page, { sku: "P2-DIFF", name: "C2 Diff", branchId: hq2, sellingPrice: 80 });
    await apiRequest(page, "PUT", `/api/products/${p2.id}`, { sellingPrice: 95 });

    const c2Logs = (await (await page.request.get("/api/audit-logs?limit=25")).json()) as {
      entries: Array<{ entityId: string }>;
    };
    expect(c2Logs.entries.some((e) => e.entityId === p2.id)).toBe(true);
    expect(c2Logs.entries.some((e) => e.entityId === p1.id)).toBe(false);
  });

  test("T3-04 (EF2 + EF7): Company-scoped Ctrl+K search returns only active company entities", async ({
    page,
  }) => {
    await signupFirstAdmin(page, { email: "t3-04@test.local" });
    const hq1 = await getDefaultBranchId(page);
    await createProductApi(page, { sku: "UNIQ-C1", name: "Shared Brand Alpha", branchId: hq1 });

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Search Beta" });
    await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
    const hq2 = await getDefaultBranchId(page);
    await createProductApi(page, { sku: "UNIQ-C2", name: "Shared Brand Beta", branchId: hq2 });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.keyboard.press("Control+k");
    const cmdDialog = page.getByRole("dialog").last();
    await cmdDialog.locator('input[cmdk-input], input').first().fill("Shared Brand");
    await expect(cmdDialog.getByText(/Shared Brand Beta/i).first()).toBeVisible();
    await expect(cmdDialog.getByText(/Shared Brand Alpha/i)).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("T3-05 (EF2 + EF9): Company-scoped attachment upload/list/download", async ({ page }) => {
    const uploadedIds: string[] = [];
    try {
      await signupFirstAdmin(page, { email: "t3-05@test.local" });
      const hq1 = await getDefaultBranchId(page);
      const p1 = await createProductApi(page, { sku: "ATT-C1", name: "C1 Att", branchId: hq1 });
      const cust1 = await createCustomerApi(page, "C1 Cust");
      const inv1 = await createInvoiceApi(page, { customerId: cust1.id, branchId: hq1, productId: p1.id });

      const up = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv1.id,
        fileName: "c1-inv.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("C1 Invoice"),
      });
      expect(up.status()).toBe(201);
      const attId = ((await up.json()) as { attachment: { id: string } }).attachment.id;
      uploadedIds.push(attId);

      const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Att Beta" });
      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: comp2.id });
      expect([403, 404]).toContain((await page.request.get(`/api/attachments/${attId}/download`)).status());

      await apiRequest(page, "POST", "/api/auth/switch-company", { companyId: DEFAULT_COMPANY_ID });
      expect((await page.request.get(`/api/attachments/${attId}/download`)).status()).toBe(200);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }
  });

  test("T3-06 (EF3 + EF7): Permission-filtered Ctrl+K search omits unauthorized entities", async ({
    page,
    browser,
  }) => {
    await signupFirstAdmin(page, { email: "t3-06@test.local" });
    const hqId = await getDefaultBranchId(page);
    await createProductApi(page, { sku: "VIS-01", name: "Visible Scanner", branchId: hqId });
    await createManualJournalApi(page, { branchId: hqId, memo: "Visible Audit Ledger" });

    const cashierId = await findPresetRoleId(page, "Cashier");
    await createUserWithCustomRoleApi(page, {
      name: "Search Cashier",
      email: "t3-06-cashier@test.local",
      password: "Password123!",
      customRoleId: cashierId,
      branchId: hqId,
    });

    const cCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const cPage = await cCtx.newPage();
      await loginViaUi(cPage, "t3-06-cashier@test.local", "Password123!");
      const res = (await (await cPage.request.get("/api/search?q=Visible")).json()) as {
        results: Array<{ type: string; title: string }>;
      };
      expect(res.results.some((r) => r.type === "product")).toBe(true);
      expect(res.results.some((r) => r.type === "journal_entry")).toBe(false);
    } finally {
      await cCtx.close();
    }
  });

  test("T3-07 (EF3 + EF8): RBAC gating on server-side streaming CSV/XLSX exports", async ({ page, browser }) => {
    await signupFirstAdmin(page, { email: "t3-07@test.local" });
    const hqId = await getDefaultBranchId(page);
    await createProductApi(page, { sku: "EXP-P1", name: "Exportable Item", branchId: hqId });

    const prodOnlyRole = await apiRequest(page, "POST", "/api/custom-roles", {
      name: "Product Exporter",
      baseRole: "user",
      permissions: buildPermissionMap({ products: readOnlyAccess() }),
    });
    const roleId = ((await prodOnlyRole.json()) as { role: { id: string } }).role.id;
    await createUserWithCustomRoleApi(page, {
      name: "Exporter",
      email: "exporter@test.local",
      password: "Password123!",
      customRoleId: roleId,
      branchId: hqId,
    });

    const uCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const uPage = await uCtx.newPage();
      await loginViaUi(uPage, "exporter@test.local", "Password123!");
      expect((await uPage.request.get("/api/exports/products?format=csv")).status()).toBe(200);
      expect((await uPage.request.get("/api/exports/journal-entries?format=xlsx")).status()).toBe(403);
    } finally {
      await uCtx.close();
    }
  });

  test("T3-08 (EF3 + EF9): Read-only Accountant can download attachment (200) but upload/delete returns 403", async ({
    page,
    browser,
  }) => {
    const uploadedIds: string[] = [];
    try {
      await signupFirstAdmin(page, { email: "t3-08@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "RO-ATT", name: "RO Item", branchId: hqId });
      const cust = await createCustomerApi(page, "RO Cust");
      const inv = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

      const up = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv.id,
        fileName: "ro-inv.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("RO Invoice"),
      });
      expect(up.status()).toBe(201);
      const attId = ((await up.json()) as { attachment: { id: string } }).attachment.id;
      uploadedIds.push(attId);

      const accountantId = await findPresetRoleId(page, "Accountant");
      await createUserWithCustomRoleApi(page, {
        name: "RO Accountant",
        email: "ro-acc@test.local",
        password: "Password123!",
        customRoleId: accountantId,
        branchId: hqId,
      });

      const aCtx = await browser.newContext({ baseURL: BASE_URL });
      try {
        const aPage = await aCtx.newPage();
        await loginViaUi(aPage, "ro-acc@test.local", "Password123!");
        expect((await aPage.request.get(`/api/attachments/${attId}/download`)).status()).toBe(200);
        expect(
          (
            await uploadAttachmentApi(aPage, {
              entityType: "invoice",
              entityId: inv.id,
              fileName: "blocked.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("no"),
            })
          ).status()
        ).toBe(403);
        expect((await apiRequest(aPage, "DELETE", `/api/attachments/${attId}`)).status()).toBe(403);
      } finally {
        await aCtx.close();
      }
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }
  });

  test("T3-09 (EF4 + EF5): MFA enrollment + TOTP login on Context B + session revocation from Context A", async ({
    page,
    browser,
  }) => {
    const email = "t3-09@test.local";
    const password = "Password123!";
    await signupFirstAdmin(page, { email, password });
    const { secret } = await enrollAndVerifyMfaApi(page);

    const ctxB = await browser.newContext({ baseURL: BASE_URL, userAgent: "MFA-Device-B/1.0" });
    try {
      const pageB = await ctxB.newPage();
      await waitForSafeTotpWindow();
      await loginWithMfaChallengeUi(pageB, email, password, generateTotpCode(secret));

      const sessList = (await (await page.request.get("/api/auth/sessions")).json()) as {
        sessions: Array<{ id: string; isCurrent: boolean }>;
      };
      const other = sessList.sessions.find((s) => !s.isCurrent);
      expect(other).toBeTruthy();
      expect((await apiRequest(page, "DELETE", `/api/auth/sessions/${other!.id}`)).status()).toBe(200);
      expect((await pageB.request.get("/api/branches")).status()).toBe(401);
      expect((await page.request.get("/api/branches")).status()).toBe(200);
    } finally {
      await ctxB.close();
    }
  });

  test("T3-10 (EF4 + EF6): MFA lifecycle events in secret-scrubbed Audit Diffs", async ({ page }) => {
    const password = "Password123!";
    await signupFirstAdmin(page, { email: "t3-10@test.local", password });
    const { secret } = await enrollAndVerifyMfaApi(page);
    await apiRequest(page, "POST", "/api/auth/mfa/recovery-codes", { password });
    await apiRequest(page, "POST", "/api/auth/mfa/disable", { password });

    const logs = (await (await page.request.get("/api/audit-logs?limit=50")).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    const mfaEntries = logs.entries.filter((e) => JSON.stringify(e).toLowerCase().includes("mfa"));
    expect(mfaEntries.length).toBeGreaterThan(0);
    for (const entry of mfaEntries) {
      assertNoSecretsInAuditEntry(entry);
      expect(JSON.stringify(entry)).not.toContain(secret);
    }
  });

  test("T3-11 (EF8 + EF10): Saved View persistence + Print Template & Invoice Export coexistence", async ({
    page,
  }) => {
    await signupFirstAdmin(page, { email: "t3-11@test.local" });
    const hqId = await getDefaultBranchId(page);
    const prod = await createProductApi(page, { sku: "SV-PRT", name: "View Print Item", branchId: hqId });
    const cust = await createCustomerApi(page, "View Print Cust");
    await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

    expect(
      (
        await apiRequest(page, "POST", "/api/saved-views", {
          resource: "invoices",
          name: "Default Inv View",
          configJson: { pageSize: 50, sortDir: "desc" },
          isDefault: true,
        })
      ).status()
    ).toBe(201);

    expect(
      (
        await apiRequest(page, "POST", "/api/print-templates", {
          documentType: "invoice",
          name: "Inv Print Coexist",
          isDefault: true,
        })
      ).status()
    ).toBe(201);

    expect((await page.request.get("/api/exports/invoices?format=csv")).status()).toBe(200);
    await page.goto("/sales/invoices");
    await page.reload();
    const views = (await (await page.request.get("/api/saved-views?resource=invoices")).json()) as {
      views: Array<{ name: string; isDefault: boolean }>;
    };
    expect(views.views.some((v) => v.name === "Default Inv View" && v.isDefault)).toBe(true);
  });

  test("T3-12 (EF9 + EF10): Emailing Invoice with stored attachments & custom Print Template", async ({ page }) => {
    const uploadedIds: string[] = [];
    try {
      await signupFirstAdmin(page, { email: "t3-12@test.local" });
      const hqId = await getDefaultBranchId(page);
      const prod = await createProductApi(page, { sku: "EM-ATT", name: "Email Att Item", branchId: hqId });
      const cust = await createCustomerApi(page, "Email Att Cust", "buyer@example.com");
      const inv = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

      const attRes = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv.id,
        fileName: "po-ref.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("PO Reference"),
      });
      expect(attRes.status()).toBe(201);
      uploadedIds.push(((await attRes.json()) as { attachment: { id: string } }).attachment.id);

      const tplRes = await apiRequest(page, "POST", "/api/print-templates", {
        documentType: "invoice",
        name: "Email Template",
        isDefault: true,
      });
      const tplId = ((await tplRes.json()) as { template: { id: string } }).template.id;

      const emailRes = await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
        to: "buyer@example.com",
        subject: `Invoice ${inv.invoiceNumber}`,
        message: "Attached.",
        attachStoredFiles: true,
        templateId: tplId,
      });
      expect(emailRes.status()).toBe(200);
      const emailJson = (await emailRes.json()) as { attachmentCount: number };
      expect(emailJson.attachmentCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }
  });
});

// ============================================================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS (6 WORKFLOWS: T4-01 .. T4-06)
// ============================================================================

test.describe("Tier 4: Real-World Enterprise Scenarios (6 Workflows)", () => {
  test.beforeEach(async () => {
    await resetTestDatabase();
  });

  test("T4-01: Multi-Entity Subsidiary Onboarding & Tenant Isolation (EF1, EF2, EF3, EF6, EF7)", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const tracker = trackApiGets(page);
    await signupFirstAdmin(page, { email: "t4-01@test.local" });
    await page.waitForTimeout(500);
    expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);
    tracker.stop();

    const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Sub Europe GmbH", baseCurrency: "EUR" });
    await switchCompanyViaUi(page, /COMP-02|Sub Europe/i);

    const roleRes = await apiRequest(page, "POST", "/api/custom-roles", {
      name: "Branch Auditor",
      baseRole: "user",
      permissions: buildPermissionMap({
        products: readOnlyAccess(),
        sales: readOnlyAccess(),
        audit: readOnlyAccess(),
      }),
    });
    expect(roleRes.status()).toBe(201);

    const hq2 = await getDefaultBranchId(page);
    const prod2 = await createProductApi(page, { sku: "EUR-01", name: "Euro Terminal", branchId: hq2 });
    const cust2 = await createCustomerApi(page, "Berlin Retail");
    await createInvoiceApi(page, { customerId: cust2.id, branchId: hq2, productId: prod2.id });

    // Search via Ctrl+K finds Euro Terminal in COMP-02
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /dashboard/i })).toBeVisible();
    await page.keyboard.press("Control+k");
    const cmdDialog = page.getByRole("dialog").last();
    await cmdDialog.locator('input[cmdk-input], input').first().fill("Euro Terminal");
    await expect(cmdDialog.getByText(/Euro Terminal/i).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Audit log in COMP-02 shows Euro Terminal creation
    const c2Audit = (await (await page.request.get("/api/audit-logs?q=EUR-01")).json()) as {
      entries: Array<{ companyId?: string }>;
    };
    expect(c2Audit.entries.length).toBeGreaterThan(0);
    expect(c2Audit.entries.every((e) => !e.companyId || e.companyId === comp2.id)).toBe(true);

    // Switch back to COMP-01 -> zero COMP-02 records leak
    await switchCompanyViaUi(page, /COMP-01|Count It Keep It/i);
    const c1Prods = (await (await page.request.get("/api/products")).json()) as {
      products: Array<{ id: string }>;
    };
    expect(c1Prods.products.some((p) => p.id === prod2.id)).toBe(false);

    expect(pageErrors).toEqual([]);
  });

  test("T4-02: Enterprise Security Lifecycle — 2FA + Recovery + Session Hardening + Audit (EF4, EF5, EF6)", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const email = "t4-02@test.local";
    const password = "Password123!";
    await signupFirstAdmin(page, { email, password });

    const { secret, recoveryCodes } = await enrollAndVerifyMfaApi(page);

    const ctxB = await browser.newContext({ baseURL: BASE_URL, userAgent: "Sec-B/1.0" });
    const ctxC = await browser.newContext({ baseURL: BASE_URL, userAgent: "Sec-C/1.0" });
    try {
      const pageB = await ctxB.newPage();
      await waitForSafeTotpWindow();
      await loginWithMfaChallengeUi(pageB, email, password, generateTotpCode(secret));

      const pageC = await ctxC.newPage();
      await loginWithMfaChallengeUi(pageC, email, password, recoveryCodes[0]);

      // Confirm reused recovery code fails
      const chalRes = (await (
        await page.request.post("/api/auth/login", {
          headers: csrfHeaders(),
          data: { email, password },
        })
      ).json()) as { mfaChallengeToken: string };
      expect(
        (
          await apiRequest(page, "POST", "/api/auth/mfa/verify-login", {
            mfaChallengeToken: chalRes.mfaChallengeToken,
            code: recoveryCodes[0],
          })
        ).status()
      ).toBe(401);

      // Revoke other sessions from Context A
      expect((await apiRequest(page, "POST", "/api/auth/sessions/revoke-others", {})).status()).toBe(200);
      expect((await pageB.request.get("/api/branches")).status()).toBe(401);
      expect((await pageC.request.get("/api/branches")).status()).toBe(401);

      // Inspect Audit Diffs confirming zero secret exposure
      const logs = (await (await page.request.get("/api/audit-logs?limit=40")).json()) as {
        entries: Array<Record<string, unknown>>;
      };
      for (const entry of logs.entries) {
        assertNoSecretsInAuditEntry(entry);
        expect(JSON.stringify(entry)).not.toContain(secret);
      }

      // Disable 2FA cleanly
      expect((await apiRequest(page, "POST", "/api/auth/mfa/disable", { password })).status()).toBe(200);
    } finally {
      await ctxB.close();
      await ctxC.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T4-03: Least-Privilege Role Enforcement Across Routes & UI (EF1, EF3, EF7, EF8)", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t4-03-admin@test.local" });
    const hqId = await getDefaultBranchId(page);

    await createManualJournalApi(page, { branchId: hqId, memo: "Confidential Payroll JE" });
    const poRoleId = await findPresetRoleId(page, "Purchasing Officer");
    await createUserWithCustomRoleApi(page, {
      name: "PO Officer",
      email: "po-officer@test.local",
      password: "Password123!",
      baseRole: "user",
      customRoleId: poRoleId,
      branchId: hqId,
    });

    const uCtx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const uPage = await uCtx.newPage();
      const tracker = trackApiGets(uPage);
      await loginViaUi(uPage, "po-officer@test.local", "Password123!");
      await uPage.waitForTimeout(500);
      expect(tracker.getApiPaths.length).toBeLessThanOrEqual(5);
      tracker.stop();

      await expect(uPage.getByRole("link", { name: /^Users$/i })).toBeHidden();
      await uPage.goto("/accounting/journal-entries");
      const gated = await uPage
        .getByText(/access denied|forbidden|not authorized|permission/i)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (!gated) {
        await expect(uPage).not.toHaveURL(/\/accounting\/journal-entries$/);
      }

      const searchJson = (await (await uPage.request.get("/api/search?q=Payroll")).json()) as {
        results: Array<{ type: string }>;
      };
      expect(searchJson.results.some((r) => r.type === "journal_entry")).toBe(false);

      expect((await uPage.request.get("/api/exports/journal-entries?format=csv")).status()).toBe(403);
      expect((await uPage.request.get("/api/exports/purchase-orders?format=csv")).status()).toBe(200);
    } finally {
      await uCtx.close();
    }

    expect(pageErrors).toEqual([]);
  });

  test("T4-04: Order-to-Cash Document Pack — Invoice + Attachments + Print Template + Email (EF2, EF6, EF9, EF10)", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "t4-04@test.local" });
      const hqId = await getDefaultBranchId(page);

      const tplRes = await apiRequest(page, "POST", "/api/print-templates", {
        documentType: "invoice",
        name: "Modern Invoice",
        accentColor: "#0f766e",
        isDefault: true,
      });
      expect(tplRes.status()).toBe(201);
      const tplId = ((await tplRes.json()) as { template: { id: string } }).template.id;

      const prod = await createProductApi(page, { sku: "O2C-01", name: "O2C Hardware", branchId: hqId });
      const cust = await createCustomerApi(page, "O2C Buyer", "o2c@example.com");
      const inv = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

      const pdfBuf = buildMinimalPdfBuffer("O2C Signed Contract");
      const pngBuf = buildMinimalPngBuffer();

      const r1 = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv.id,
        fileName: "contract.pdf",
        mimeType: "application/pdf",
        buffer: pdfBuf,
      });
      expect(r1.status()).toBe(201);
      const a1 = ((await r1.json()) as { attachment: { id: string; sha256: string } }).attachment;
      uploadedIds.push(a1.id);

      const r2 = await uploadAttachmentApi(page, {
        entityType: "invoice",
        entityId: inv.id,
        fileName: "proof.png",
        mimeType: "image/png",
        buffer: pngBuf,
      });
      expect(r2.status()).toBe(201);
      uploadedIds.push(((await r2.json()) as { attachment: { id: string } }).attachment.id);

      const dl = await page.request.get(`/api/attachments/${a1.id}/download`);
      expect(dl.status()).toBe(200);
      expect(dl.headers()["content-disposition"] ?? "").toMatch(/attachment/i);
      expect((dl.headers()["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff");
      expect(sha256Hex(await dl.body())).toBe(a1.sha256);

      const emailRes = await apiRequest(page, "POST", `/api/documents/invoice/${inv.id}/email`, {
        to: "o2c@example.com",
        subject: `Order-to-Cash ${inv.invoiceNumber}`,
        message: "Documents attached.",
        attachStoredFiles: true,
        templateId: tplId,
      });
      expect(emailRes.status()).toBe(200);
      expect(((await emailRes.json()) as { attachmentCount: number }).attachmentCount).toBeGreaterThanOrEqual(2);

      const audit = (await (await page.request.get("/api/audit-logs?limit=25")).json()) as {
        entries: Array<{ entityId: string }>;
      };
      expect(audit.entries.length).toBeGreaterThan(0);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    expect(pageErrors).toEqual([]);
  });

  test("T4-05: Power-User Reporting & Table Workspace Workflow (EF1, EF7, EF8)", async ({ page }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, { email: "t4-05@test.local" });
    const hqId = await getDefaultBranchId(page);
    const prod = await createProductApi(page, { sku: "Q4-01", name: "Q4 Audit Item", branchId: hqId });
    const cust = await createCustomerApi(page, "Q4 Buyer");
    const inv = await createInvoiceApi(page, { customerId: cust.id, branchId: hqId, productId: prod.id });

    await page.goto("/sales/invoices");
    await expect(page.getByRole("heading", { level: 1, name: /invoices/i })).toBeVisible();

    const saveRes = await apiRequest(page, "POST", "/api/saved-views", {
      resource: "invoices",
      name: "Q4 Audit View",
      configJson: { columns: { invoiceNumber: true, total: true }, sortBy: "createdAt", sortDir: "desc", pageSize: 25 },
      isDefault: true,
    });
    expect(saveRes.status()).toBe(201);
    const viewId = ((await saveRes.json()) as { view: { id: string } }).view.id;

    await page.reload();
    const views = (await (await page.request.get("/api/saved-views?resource=invoices")).json()) as {
      views: Array<{ id: string; name: string }>;
    };
    expect(views.views.some((v) => v.id === viewId && v.name === "Q4 Audit View")).toBe(true);

    const csv = await page.request.get("/api/exports/invoices?format=csv");
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(inv.invoiceNumber);

    const xlsx = await page.request.get("/api/exports/invoices?format=xlsx");
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    // Jump via Ctrl+K to matching invoice
    await page.keyboard.press("Control+k");
    const cmdDialog = page.getByRole("dialog").last();
    await cmdDialog.locator('input[cmdk-input], input').first().fill(inv.invoiceNumber);
    await expect(cmdDialog.getByText(inv.invoiceNumber).first()).toBeVisible();
    await page.keyboard.press("Escape");

    expect((await apiRequest(page, "DELETE", `/api/saved-views/${viewId}`)).status()).toBe(200);
    expect(pageErrors).toEqual([]);
  });

  test("T4-06: Concurrent Dual-Tenant Accounting & Procure-to-Pay Close (EF2, EF6, EF8, EF9)", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    const uploadedIds: string[] = [];

    try {
      await signupFirstAdmin(page, { email: "t4-06@test.local" });
      const hq1 = await getDefaultBranchId(page);
      const p1 = await createProductApi(page, { sku: "P2P-C1", name: "Comp1 Supply", branchId: hq1 });
      const v1 = await createVendorApi(page, "Comp1 Vendor");
      const b1 = await createVendorBillApi(page, { vendorId: v1.id, branchId: hq1, productId: p1.id });
      const j1 = await createManualJournalApi(page, { branchId: hq1, memo: "Comp1 Close JE" });

      const att1 = await uploadAttachmentApi(page, {
        entityType: "vendor_bill",
        entityId: b1.id,
        fileName: "c1-bill.pdf",
        mimeType: "application/pdf",
        buffer: buildMinimalPdfBuffer("Comp1 Bill"),
      });
      expect(att1.status()).toBe(201);
      uploadedIds.push(((await att1.json()) as { attachment: { id: string } }).attachment.id);

      const comp2 = await createCompanyApi(page, { code: "COMP-02", name: "Close Beta", baseCurrency: "EUR" });
      expect(comp2.code).toBe("COMP-02");
      await switchCompanyViaUi(page, /COMP-02|Close Beta/i);
      const hq2 = await getDefaultBranchId(page);
      const p2 = await createProductApi(page, { sku: "P2P-C2", name: "Comp2 Supply", branchId: hq2 });
      const v2 = await createVendorApi(page, "Comp2 Vendor");
      const b2 = await createVendorBillApi(page, { vendorId: v2.id, branchId: hq2, productId: p2.id });
      const j2 = await createManualJournalApi(page, { branchId: hq2, memo: "Comp2 Close JE" });

      const att2 = await uploadAttachmentApi(page, {
        entityType: "journal_entry",
        entityId: j2.id,
        fileName: "c2-je.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("acc,amt\n1000,150\n"),
      });
      expect(att2.status()).toBe(201);
      uploadedIds.push(((await att2.json()) as { attachment: { id: string } }).attachment.id);

      // Export journal-entries XLSX & CSV per company, verifying strict partitioning
      const jeCsv2 = await (await page.request.get("/api/exports/journal-entries?format=csv")).text();
      expect(jeCsv2).toContain("Comp2 Close JE");
      expect(jeCsv2).not.toContain("Comp1 Close JE");

      const jeXlsx2 = await page.request.get("/api/exports/journal-entries?format=xlsx");
      expect(jeXlsx2.status()).toBe(200);
      expect((await jeXlsx2.body()).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

      // Verify reload preserves COMP-02 and vendor bill / JE isolation
      await page.reload();
      const bills2 = (await (await page.request.get("/api/vendor-bills")).json()) as {
        bills?: Array<{ id: string }>;
        items?: Array<{ id: string }>;
      };
      const billList2 = bills2.bills ?? bills2.items ?? [];
      expect(billList2.some((b) => b.id === b2.id)).toBe(true);
      expect(billList2.some((b) => b.id === b1.id)).toBe(false);

      // Switch back to COMP-01 and verify COMP-01 JE/CSV excludes COMP-02
      await switchCompanyViaUi(page, /COMP-01|Count It Keep It/i);
      const jeCsv1 = await (await page.request.get("/api/exports/journal-entries?format=csv")).text();
      expect(jeCsv1).toContain("Comp1 Close JE");
      expect(jeCsv1).not.toContain("Comp2 Close JE");
      expect(j1.id).not.toBe(j2.id);
    } finally {
      await cleanupAttachments(page, uploadedIds);
    }

    expect(pageErrors).toEqual([]);
  });
});
