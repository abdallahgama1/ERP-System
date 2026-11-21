import { expect, request as playwrightRequest, test } from "@playwright/test";
import {
  apiRequest,
  attachPageErrorTracker,
  BASE_URL,
  csrfHeaders,
  loginViaUi,
  signupFirstAdmin,
} from "./helpers/auth";
import { resetTestDatabase } from "./helpers/db";

test.describe.serial("R3 Security & Observability E2E (Health Split, Metrics, CSRF & Housekeeping)", () => {
  const adminEmail = "sec-admin@test.local";
  const adminPassword = "Password123!";

  test.beforeAll(async () => {
    await resetTestDatabase();
  });

  test("serves /api/health/live, /api/health/ready, and /api/health split contracts", async ({
    request,
  }) => {
    const liveRes = await request.get("/api/health/live");
    expect(liveRes.status()).toBe(200);
    const liveJson = (await liveRes.json()) as { status?: string; timestamp?: string };
    expect(liveJson.status).toBe("live");
    expect(typeof liveJson.timestamp).toBe("string");
    expect(Number.isFinite(Date.parse(liveJson.timestamp ?? ""))).toBe(true);

    const readyRes = await request.get("/api/health/ready");
    expect(readyRes.status()).toBe(200);
    const readyJson = (await readyRes.json()) as { status?: string; db?: string };
    expect(readyJson.status).toBe("ready");
    expect(readyJson.db).toBe("ok");

    const aliasRes = await request.get("/api/health");
    expect(aliasRes.status()).toBe(200);
    const aliasJson = (await aliasRes.json()) as { status?: string; ok?: boolean };
    expect(aliasJson.status === "ready" || aliasJson.ok === true).toBe(true);
  });

  test("gates /api/metrics against unauthenticated or invalid bearer token requests", async ({
    request,
  }) => {
    const unauthRes = await request.get("/api/metrics");
    expect([401, 404]).toContain(unauthRes.status());
    const unauthText = await unauthRes.text();
    expect(unauthText).not.toContain("# TYPE");
    expect(unauthText).not.toContain("process_cpu");

    const invalidRes = await request.get("/api/metrics", {
      headers: { Authorization: "Bearer invalid-metrics-token-000" },
    });
    expect([401, 404]).toContain(invalidRes.status());
    const invalidText = await invalidRes.text();
    expect(invalidText).not.toContain("# TYPE");

    const configuredToken = process.env.METRICS_TOKEN?.trim() ?? "";
    if (configuredToken) {
      expect(invalidRes.status()).toBe(401);
      const validRes = await request.get("/api/metrics", {
        headers: { Authorization: `Bearer ${configuredToken}` },
      });
      expect(validRes.status()).toBe(200);
      const metricsText = await validRes.text();
      expect(metricsText).toContain("# TYPE");
    }
  });

  test("rejects cross-origin CSRF mutations with 403 CSRF_ORIGIN_FORBIDDEN while allowing same-origin", async ({
    page,
  }) => {
    const pageErrors = attachPageErrorTracker(page);
    await signupFirstAdmin(page, {
      name: "Security Admin",
      email: adminEmail,
      password: adminPassword,
    });

    // Same-origin API mutation succeeds
    const sameOriginRes = await apiRequest(page, "POST", "/api/customers", {
      name: "Same Origin Customer",
    });
    expect(sameOriginRes.status()).toBe(201);

    // Real browser-context fetch (automatic Origin + Sec-Fetch-Site: same-origin) succeeds
    const browserFetchStatus = await page.evaluate(async () => {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Browser Same Origin Customer" }),
      });
      return res.status;
    });
    expect(browserFetchStatus).toBe(201);

    // Safe GET remains allowed even with cross-site fetch metadata
    const safeGetRes = await page.request.get("/api/customers", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(safeGetRes.status()).toBe(200);

    // Negative CSRF 1: evil Origin on POST
    const evilOriginPost = await page.request.post("/api/customers", {
      headers: { Origin: "https://evil.example" },
      data: { name: "Evil Origin Customer" },
    });
    expect(evilOriginPost.status()).toBe(403);
    const evilOriginJson = (await evilOriginPost.json()) as { code?: string };
    expect(evilOriginJson.code).toBe("CSRF_ORIGIN_FORBIDDEN");

    // Negative CSRF 2: evil Origin on PUT
    const evilOriginPut = await page.request.put("/api/settings/company", {
      headers: { Origin: "https://evil.example" },
      data: { companyName: "Hijacked Corp" },
    });
    expect(evilOriginPut.status()).toBe(403);
    const evilPutJson = (await evilOriginPut.json()) as { code?: string };
    expect(evilPutJson.code).toBe("CSRF_ORIGIN_FORBIDDEN");

    // Negative CSRF 3: spoofed Referer with omitted Origin
    const evilRefererPost = await page.request.post("/api/customers", {
      headers: { Referer: "https://evil.example/attack" },
      data: { name: "Evil Referer Customer" },
    });
    expect(evilRefererPost.status()).toBe(403);
    const evilRefererJson = (await evilRefererPost.json()) as { code?: string };
    expect(evilRefererJson.code).toBe("CSRF_ORIGIN_FORBIDDEN");

    // Negative CSRF 4: Sec-Fetch-Site: cross-site
    const crossSitePost = await page.request.post("/api/customers", {
      headers: {
        ...csrfHeaders(),
        "Sec-Fetch-Site": "cross-site",
      },
      data: { name: "Evil Cross Site Customer" },
    });
    expect(crossSitePost.status()).toBe(403);
    const crossSiteJson = (await crossSitePost.json()) as { code?: string };
    expect(crossSiteJson.code).toBe("CSRF_ORIGIN_FORBIDDEN");

    // Confirm none of the rejected payloads persisted
    const custListRes = await page.request.get("/api/customers");
    expect(custListRes.ok()).toBe(true);
    const custListJson = (await custListRes.json()) as { customers: Array<{ name: string }> };
    const names = custListJson.customers.map((c) => c.name);
    expect(names).toContain("Same Origin Customer");
    expect(names).toContain("Browser Same Origin Customer");
    expect(names).not.toContain("Evil Origin Customer");
    expect(names).not.toContain("Evil Referer Customer");
    expect(names).not.toContain("Evil Cross Site Customer");

    expect(pageErrors).toEqual([]);
  });

  test("executes admin housekeeping job for admin and blocks unauthenticated and standard user roles", async ({
    page,
    browser,
  }) => {
    const pageErrors = attachPageErrorTracker(page);

    // 1. Unauthenticated call -> 401
    const anonCtx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      const anonRes = await anonCtx.post("/api/admin/jobs/housekeeping", {
        headers: csrfHeaders(),
      });
      expect(anonRes.status()).toBe(401);
    } finally {
      await anonCtx.dispose();
    }

    // 2. Admin call -> 200
    await loginViaUi(page, adminEmail, adminPassword);
    const adminJobRes = await apiRequest(page, "POST", "/api/admin/jobs/housekeeping");
    expect(adminJobRes.status()).toBe(200);
    const jobResult = (await adminJobRes.json()) as Record<string, unknown>;
    expect(jobResult).toBeTruthy();

    // 3. Create standard user and verify 403 Forbidden
    const branchesRes = await page.request.get("/api/branches");
    expect(branchesRes.ok()).toBe(true);
    const hqId = ((await branchesRes.json()) as { branches: Array<{ id: string }> }).branches[0].id;

    const stdEmail = "sec-standard-user@test.local";
    const stdPassword = "Password123!";
    const createUserRes = await apiRequest(page, "POST", "/api/users", {
      name: "Standard User",
      email: stdEmail,
      password: stdPassword,
      role: "user",
      branchScopeMode: "selected",
      branchIds: [hqId],
      defaultBranchId: hqId,
    });
    expect(createUserRes.status()).toBe(201);

    const userContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      const userPage = await userContext.newPage();
      await loginViaUi(userPage, stdEmail, stdPassword);
      const userJobRes = await apiRequest(userPage, "POST", "/api/admin/jobs/housekeeping");
      expect(userJobRes.status()).toBe(403);
    } finally {
      await userContext.close();
    }

    expect(pageErrors).toEqual([]);
  });
});
