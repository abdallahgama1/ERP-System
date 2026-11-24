import { createHash, createHmac } from "node:crypto";
import { expect, type APIResponse, type Locator, type Page } from "@playwright/test";
import { apiRequest, BASE_URL, csrfHeaders } from "./auth";

export const DEFAULT_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_COMPANY_CODE = "COMP-01";

export const PERMISSION_MODULES = [
  "products",
  "branches",
  "sessions",
  "inventory",
  "manufacturing",
  "sales",
  "pos",
  "purchases",
  "accounting",
  "treasury",
  "expenses",
  "fixed_assets",
  "reports",
  "taxonomy",
  "approvals",
  "einvoicing",
  "audit",
  "companies",
  "roles",
  "users",
  "settings",
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve";
export type ModulePermission = Record<PermissionAction, boolean>;
export type PermissionMap = Record<PermissionModule, ModulePermission>;

export const SYSTEM_ROLE_PRESET_NAMES = [
  "Admin",
  "Finance Manager",
  "Accountant",
  "Warehouse Manager",
  "Purchasing Officer",
  "Sales Manager",
  "Branch Manager",
  "Cashier",
] as const;

export const AUDIT_SENSITIVE_FIELDS = [
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "token",
  "rawToken",
  "resetToken",
  "tokenHash",
  "secret",
  "totpSecret",
  "totpSecretEncrypted",
  "recoveryCode",
  "recoveryCodes",
  "recoveryCodesHashes",
  "mfaChallengeToken",
  "pin",
  "posPin",
  "pinHash",
  "etaClientSecret",
  "s3SecretAccessKey",
  "smtpPass",
] as const;

export const noAccess = (): ModulePermission => ({
  view: false,
  create: false,
  edit: false,
  delete: false,
  approve: false,
});

export const readOnlyAccess = (): ModulePermission => ({
  view: true,
  create: false,
  edit: false,
  delete: false,
  approve: false,
});

export const fullAccess = (): ModulePermission => ({
  view: true,
  create: true,
  edit: true,
  delete: true,
  approve: true,
});

export function buildPermissionMap(
  overrides: Partial<PermissionMap> = {},
  fallback: () => ModulePermission = noAccess
): PermissionMap {
  const map = {} as PermissionMap;
  for (const mod of PERMISSION_MODULES) {
    const entry = overrides[mod] ?? fallback();
    map[mod] = { ...entry };
  }
  return map;
}

// ============================================================================
// Pure node:crypto RFC 6238 TOTP & Hashing Helpers
// ============================================================================

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function extractSecretFromOtpauthUrl(otpauthUrl: string): string {
  const url = new URL(otpauthUrl);
  const secret = url.searchParams.get("secret");
  if (!secret) {
    throw new Error(`otpauthUrl missing secret parameter: ${otpauthUrl}`);
  }
  return secret;
}

export async function waitForSafeTotpWindow(minRemainingSeconds = 3): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remaining = 30 - (nowSeconds % 30);
  if (remaining < minRemainingSeconds) {
    await new Promise((resolve) => setTimeout(resolve, (remaining + 0.5) * 1000));
  }
}

export function generateTotpCode(
  base32Secret: string,
  opts: { timestampMs?: number; stepOffset?: number; periodSeconds?: number; digits?: number } = {}
): string {
  const period = opts.periodSeconds ?? 30;
  const digits = opts.digits ?? 6;
  const nowMs = opts.timestampMs ?? Date.now();
  const counter = Math.floor(nowMs / 1000 / period) + (opts.stepOffset ?? 0);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const key = decodeBase32(base32Secret);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binaryCode % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ============================================================================
// Sample Binary Payloads & Multipart Upload Helpers
// ============================================================================

export function buildMinimalPdfBuffer(label = "Enterprise E2E Test PDF"): Buffer {
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

export function buildMinimalPngBuffer(): Buffer {
  // 1x1 transparent PNG
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );
}

export function buildMinimalZipPayload(marker = "test"): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, "utf8")]);
}

export interface UploadAttachmentOptions {
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  origin?: string;
}

export async function uploadAttachmentApi(
  page: Page,
  opts: UploadAttachmentOptions
): Promise<APIResponse> {
  return page.request.post("/api/attachments", {
    headers: csrfHeaders(opts.origin ?? BASE_URL),
    multipart: {
      entityType: opts.entityType,
      entityId: opts.entityId,
      file: {
        name: opts.fileName,
        mimeType: opts.mimeType,
        buffer: opts.buffer,
      },
    },
  });
}

export async function cleanupAttachments(page: Page, attachmentIds: string[]): Promise<void> {
  for (const id of attachmentIds) {
    try {
      await apiRequest(page, "DELETE", `/api/attachments/${id}`);
    } catch {
      // Best-effort cleanup if DB already reset or attachment already deleted
    }
  }
}

// ============================================================================
// UI & Request Telemetry Helpers
// ============================================================================

export interface ApiRequestTracker {
  getApiPaths: string[];
  allUrls: string[];
  reset: () => void;
  stop: () => void;
}

export function trackApiGets(page: Page): ApiRequestTracker {
  const getApiPaths: string[] = [];
  const allUrls: string[] = [];

  const handler = (req: { method: () => string; url: () => string }) => {
    const urlStr = req.url();
    allUrls.push(urlStr);
    if (req.method() === "GET") {
      try {
        const parsed = new URL(urlStr);
        if (parsed.pathname.startsWith("/api/") && parsed.pathname !== "/api/events") {
          getApiPaths.push(parsed.pathname);
        }
      } catch {
        // Ignore non-URL schemes
      }
    }
  };

  page.on("request", handler);

  return {
    getApiPaths,
    allUrls,
    reset: () => {
      getApiPaths.length = 0;
      allUrls.length = 0;
    },
    stop: () => {
      page.off("request", handler);
    },
  };
}

export async function selectRadixOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp
): Promise<void> {
  await trigger.click();
  const option = page.getByRole("option", { name: optionName }).first();
  await expect(option).toBeVisible();
  await option.click();
}

export async function switchCompanyViaUi(
  page: Page,
  companyMatcher: string | RegExp
): Promise<void> {
  const companyTrigger = page
    .getByTestId("company-switcher-select")
    .or(page.getByRole("combobox", { name: /company|active company|switch company/i }))
    .first();

  await expect(companyTrigger).toBeVisible();
  await companyTrigger.click();

  const option = page.getByRole("option", { name: companyMatcher }).first();
  await expect(option).toBeVisible();

  const switchPromise = page.waitForResponse(
    (res) => res.url().includes("/api/auth/switch-company") && res.request().method() === "POST"
  );
  await option.click();
  const switchRes = await switchPromise;
  expect(switchRes.status()).toBe(200);
}

export async function loginWithMfaChallengeUi(
  page: Page,
  email: string,
  password: string,
  code: string
): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);

  const loginResPromise = page.waitForResponse(
    (res) => res.url().includes("/api/auth/login") && res.request().method() === "POST"
  );
  await page.locator('button[type="submit"]').click();
  const loginRes = await loginResPromise;
  expect(loginRes.status()).toBe(200);
  const loginJson = (await loginRes.json()) as { mfaRequired?: boolean };
  expect(loginJson.mfaRequired).toBe(true);

  const codeInput = page
    .getByLabel(/verification code|totp|authenticator|recovery|2fa|code/i)
    .or(page.getByPlaceholder(/000000|code|recovery/i))
    .or(page.locator('input[inputmode="numeric"], input[name*="code" i], input[id*="mfa" i], input[id*="totp" i]'))
    .first();
  await expect(codeInput).toBeVisible({ timeout: 10_000 });
  await codeInput.fill(code);

  const verifyPromise = page.waitForResponse(
    (res) => res.url().includes("/api/auth/mfa/verify-login") && res.request().method() === "POST"
  );
  await page
    .getByRole("button", { name: /verify|continue|sign in|submit|confirm/i })
    .first()
    .click();
  const verifyRes = await verifyPromise;
  expect(verifyRes.status()).toBe(200);
  await page.waitForURL("/", { timeout: 20_000 });
}

export async function logoutViaApi(page: Page): Promise<void> {
  const res = await apiRequest(page, "POST", "/api/auth/logout");
  expect(res.ok()).toBe(true);
}

// ============================================================================
// Domain Setup & Audit Inspection Helpers
// ============================================================================

export async function getDefaultBranchId(page: Page): Promise<string> {
  const res = await page.request.get("/api/branches");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { branches: Array<{ id: string; isDefault?: boolean }> };
  const branch = body.branches.find((b) => b.isDefault) ?? body.branches[0];
  if (!branch) {
    throw new Error("Expected at least one branch in active company");
  }
  return branch.id;
}

export async function createProductApi(
  page: Page,
  opts: {
    sku: string;
    name: string;
    branchId: string;
    costPrice?: number;
    sellingPrice?: number;
    quantity?: number;
  }
): Promise<{ id: string; sku: string; name: string; sellingPrice: number }> {
  const res = await apiRequest(page, "POST", "/api/products", {
    sku: opts.sku,
    name: opts.name,
    costPrice: opts.costPrice ?? 25,
    sellingPrice: opts.sellingPrice ?? 100,
    initialStock: [{ branchId: opts.branchId, quantity: opts.quantity ?? 20, unitCost: opts.costPrice ?? 25 }],
  });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as {
    product: { id: string; sku: string; name: string; sellingPrice: number };
  };
  return data.product;
}

export async function createCustomerApi(
  page: Page,
  name: string,
  email?: string
): Promise<{ id: string; name: string }> {
  const res = await apiRequest(page, "POST", "/api/customers", {
    name,
    email: email ?? "",
    creditLimit: 10000,
  });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as { customer: { id: string; name: string } };
  return data.customer;
}

export async function createVendorApi(
  page: Page,
  name: string
): Promise<{ id: string; name: string }> {
  const res = await apiRequest(page, "POST", "/api/vendors", { name });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as { vendor: { id: string; name: string } };
  return data.vendor;
}

export async function createInvoiceApi(
  page: Page,
  opts: { customerId: string; branchId: string; productId: string; quantity?: number; unitPrice?: number }
): Promise<{ id: string; invoiceNumber: string }> {
  const res = await apiRequest(page, "POST", "/api/sales-invoices", {
    customerId: opts.customerId,
    branchId: opts.branchId,
    status: "Sent",
    dueDate: "2027-12-31",
    lines: [
      {
        productId: opts.productId,
        quantity: opts.quantity ?? 2,
        unitPrice: opts.unitPrice ?? 100,
        taxRate: 0,
      },
    ],
  });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as { invoice: { id: string; invoiceNumber: string } };
  return data.invoice;
}

export async function createVendorBillApi(
  page: Page,
  opts: { vendorId: string; branchId: string; productId: string; quantity?: number; unitCost?: number }
): Promise<{ id: string; billNumber: string }> {
  const res = await apiRequest(page, "POST", "/api/vendor-bills", {
    vendorId: opts.vendorId,
    branchId: opts.branchId,
    dueDate: "2027-12-31",
    lines: [
      {
        productId: opts.productId,
        quantity: opts.quantity ?? 3,
        unitCost: opts.unitCost ?? 25,
        taxRate: 0,
      },
    ],
  });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as { bill?: { id: string; billNumber: string }; vendorBill?: { id: string; billNumber: string } };
  const bill = data.bill ?? data.vendorBill;
  if (!bill) {
    throw new Error("Expected vendor bill payload from POST /api/vendor-bills");
  }
  return bill;
}

export async function createManualJournalApi(
  page: Page,
  opts: { branchId: string; memo: string; amount?: number }
): Promise<{ id: string; entryNumber?: string }> {
  const accRes = await page.request.get("/api/accounting/accounts");
  expect(accRes.ok()).toBe(true);
  const accJson = (await accRes.json()) as {
    accounts: Array<{ id: string; code: string; isActive?: boolean }>;
  };
  const activeAccounts = accJson.accounts.filter((a) => a.isActive !== false);
  if (activeAccounts.length < 2) {
    throw new Error("Expected at least 2 active accounts in Chart of Accounts");
  }
  const amount = opts.amount ?? 150;
  const res = await apiRequest(page, "POST", "/api/accounting/journal-entries", {
    branchId: opts.branchId,
    memo: opts.memo,
    lines: [
      { accountId: activeAccounts[0].id, branchId: opts.branchId, debit: amount, credit: 0 },
      { accountId: activeAccounts[1].id, branchId: opts.branchId, debit: 0, credit: amount },
    ],
  });
  expect(res.status()).toBe(201);
  const data = (await res.json()) as { entry: { id: string; entryNumber?: string } };
  return data.entry;
}

export async function findPresetRoleId(page: Page, presetName: string): Promise<string> {
  const res = await page.request.get("/api/custom-roles");
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as {
    roles: Array<{ id: string; name: string; isSystem: boolean }>;
  };
  const match = data.roles.find((r) => r.name.toLowerCase() === presetName.toLowerCase());
  if (!match) {
    throw new Error(`Custom role preset '${presetName}' not found`);
  }
  return match.id;
}

export async function createUserWithCustomRoleApi(
  page: Page,
  opts: {
    name: string;
    email: string;
    password: string;
    baseRole?: "admin" | "manager" | "user";
    customRoleId: string;
    branchId: string;
    branchScopeMode?: "all" | "selected";
    companyId?: string;
  }
): Promise<{ id: string; email: string }> {
  const createRes = await apiRequest(page, "POST", "/api/users", {
    name: opts.name,
    email: opts.email,
    password: opts.password,
    role: opts.baseRole ?? "user",
    branchScopeMode: opts.branchScopeMode ?? "selected",
    branchIds: [opts.branchId],
    defaultBranchId: opts.branchId,
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as { user: { id: string; email: string } };

  const assignRes = await apiRequest(page, "PUT", `/api/users/${created.user.id}/custom-role`, {
    customRoleId: opts.customRoleId,
    ...(opts.companyId ? { companyId: opts.companyId } : {}),
  });
  expect(assignRes.ok()).toBe(true);

  return created.user;
}

export function assertNoSecretsInAuditEntry(entry: Record<string, unknown>): void {
  const serialized = JSON.stringify(entry);
  for (const field of AUDIT_SENSITIVE_FIELDS) {
    const keyPattern = new RegExp(`"${field}"\\s*:\\s*"(?!\\[REDACTED\\])[^"]+"`, "i");
    expect(serialized).not.toMatch(keyPattern);
  }
}
