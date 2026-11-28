import { randomUUID } from "node:crypto";
import { expect, type APIResponse, type Page } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:4173";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function csrfHeaders(origin = BASE_URL): Record<string, string> {
  return { Origin: origin, "Idempotency-Key": randomUUID() };
}

export interface AdminSignupOptions {
  name?: string;
  email?: string;
  password?: string;
}

export async function signupFirstAdmin(
  page: Page,
  opts: AdminSignupOptions = {}
): Promise<{ name: string; email: string; password: string }> {
  const name = opts.name ?? "E2E Admin";
  const email = opts.email ?? "e2e-admin@test.local";
  const password = opts.password ?? "Password123!";

  await page.goto("/signup");
  await page.locator("#name").fill(name);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("#confirmPassword").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();

  return { name, email, password };
}

export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL("/", { timeout: 20_000 });
}

export async function apiRequest(
  page: Page,
  method: HttpMethod,
  path: string,
  data?: unknown,
  headers?: Record<string, string>
): Promise<APIResponse> {
  const isMutating = method !== "GET";
  const hasExplicitKey = Object.keys(headers ?? {}).some((k) => k.toLowerCase() === "idempotency-key");
  const baseHeaders = isMutating
    ? { Origin: BASE_URL, ...(method === "POST" && !hasExplicitKey ? { "Idempotency-Key": randomUUID() } : {}) }
    : {};
  const mergedHeaders = isMutating
    ? { ...baseHeaders, ...(headers ?? {}) }
    : headers;

  const options: {
    method: HttpMethod;
    data?: unknown;
    headers?: Record<string, string>;
  } = { method };

  if (mergedHeaders && Object.keys(mergedHeaders).length > 0) {
    options.headers = mergedHeaders;
  }
  if (data !== undefined) {
    options.data = data;
  }

  return page.request.fetch(path, options);
}

export function attachPageErrorTracker(page: Page): string[] {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  return pageErrors;
}
