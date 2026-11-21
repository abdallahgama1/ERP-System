import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";
import {
  initBackendSentry,
  isBackendSentryEnabled,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubUrl,
} from "../../src/observability/sentry.ts";

describe("CSRF protection, health split, Prometheus metrics & Sentry scrubbing", () => {
  let app: FastifyInstance;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMetricsToken = process.env.METRICS_TOKEN;
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  const originalAppBaseUrl = process.env.APP_BASE_URL;
  const originalSentryDsn = process.env.SENTRY_DSN;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalMetricsToken;

    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCorsOrigin;

    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalAppBaseUrl;

    if (originalSentryDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalSentryDsn;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("F9 — CSRF Origin / Referer / Sec-Fetch-Site protection", () => {
    it("blocks cookie-authenticated mutating methods with disallowed Origin, Origin: null, disallowed Referer, or Sec-Fetch-Site: cross-site", async () => {
      process.env.CORS_ORIGIN = "http://localhost:8080";
      process.env.APP_BASE_URL = "http://localhost:8080";

      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const badOriginRes = await app.inject({
          method,
          url: "/api/products",
          cookies: { erp_session: "fake-session" },
          headers: { origin: "https://evil.example" },
        });
        expect(badOriginRes.statusCode).toBe(403);
        expect(badOriginRes.json().code).toBe("CSRF_ORIGIN_FORBIDDEN");
      }

      const nullOriginRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: { origin: "null" },
      });
      expect(nullOriginRes.statusCode).toBe(403);
      expect(nullOriginRes.json().code).toBe("CSRF_ORIGIN_FORBIDDEN");

      const emptyOriginRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: { origin: "" },
      });
      expect(emptyOriginRes.statusCode).toBe(403);
      expect(emptyOriginRes.json().code).toBe("CSRF_ORIGIN_FORBIDDEN");

      const badRefererRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: { referer: "https://evil.example/form" },
      });
      expect(badRefererRes.statusCode).toBe(403);
      expect(badRefererRes.json().code).toBe("CSRF_ORIGIN_FORBIDDEN");

      const crossSiteRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: {
          origin: "http://localhost:8080",
          "sec-fetch-site": "Cross-Site",
        },
      });
      expect(crossSiteRes.statusCode).toBe(403);
      expect(crossSiteRes.json().code).toBe("CSRF_ORIGIN_FORBIDDEN");
    });

    it("allows safe methods, allowed Origin/Referer with same-origin, and headerless non-browser requests to proceed past CSRF", async () => {
      process.env.CORS_ORIGIN = "http://localhost:8080";
      process.env.APP_BASE_URL = "https://erp.example.com/app";

      const getRes = await app.inject({
        method: "GET",
        url: "/api/health/live",
        cookies: { erp_session: "fake-session" },
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      });
      expect(getRes.statusCode).toBe(200);

      const allowedOriginRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: {
          origin: "http://localhost:8080",
          "sec-fetch-site": "same-origin",
        },
      });
      // Passes CSRF and hits requireAuth -> 401
      expect(allowedOriginRes.statusCode).toBe(401);

      const allowedRefererRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: {
          referer: "https://erp.example.com/products",
        },
      });
      expect(allowedRefererRes.statusCode).toBe(401);

      const sameHostRes = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: "fake-session" },
        headers: {
          host: "127.0.0.1:3001",
          origin: "http://127.0.0.1:3001",
        },
      });
      expect(sameHostRes.statusCode).toBe(401);
    });
  });

  describe("F11 — Health split & Prometheus metrics", () => {
    it("serves /api/health/live without DB dependency and /api/health/ready + /api/health with unified contract", async () => {
      const liveRes = await app.inject({ method: "GET", url: "/api/health/live" });
      expect(liveRes.statusCode).toBe(200);
      const liveBody = liveRes.json();
      expect(liveBody.status).toBe("live");
      expect(liveBody.service).toBe("erp-api");
      expect(typeof liveBody.timestamp).toBe("string");

      for (const path of ["/api/health/ready", "/api/health"]) {
        const res = await app.inject({ method: "GET", url: path });
        expect([200, 503]).toContain(res.statusCode);
        const body = res.json();
        expect(typeof body.ok).toBe("boolean");
        expect(body.status).toBe(body.ok ? "ready" : "not_ready");
        expect(body.db).toBe(body.ok ? "ok" : "error");
        expect(body.service).toBe("erp-api");
        expect(typeof body.database?.configured).toBe("boolean");
        expect(typeof body.database?.connected).toBe("boolean");
      }
    });

    it("enforces production 404 when METRICS_TOKEN is unset, 401 on invalid/missing bearer, and 200 Prometheus exposition when authorized", async () => {
      process.env.NODE_ENV = "production";
      process.env.METRICS_TOKEN = "";
      const prodUnconfiguredRes = await app.inject({ method: "GET", url: "/api/metrics" });
      expect(prodUnconfiguredRes.statusCode).toBe(404);

      process.env.METRICS_TOKEN = "super-secret-metrics-token";
      const missingAuthRes = await app.inject({ method: "GET", url: "/api/metrics" });
      expect(missingAuthRes.statusCode).toBe(401);
      expect(missingAuthRes.headers["www-authenticate"]).toContain("Bearer");

      const wrongAuthRes = await app.inject({
        method: "GET",
        url: "/api/metrics",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrongAuthRes.statusCode).toBe(401);

      // Trigger a 404 route to verify cardinality coalescing under __unmatched__
      const unmatchedRes = await app.inject({ method: "GET", url: "/api/does-not-exist-12345" });
      expect(unmatchedRes.statusCode).toBe(404);

      const validRes = await app.inject({
        method: "GET",
        url: "/api/metrics",
        headers: { authorization: "Bearer super-secret-metrics-token" },
      });
      expect(validRes.statusCode).toBe(200);
      expect(validRes.headers["content-type"]).toContain("text/plain");
      expect(validRes.headers["cache-control"]).toBe("no-store");
      expect(validRes.body).toContain("http_requests_total");
      expect(validRes.body).toContain("http_request_duration_seconds");
      expect(validRes.body).toContain('route="__unmatched__"');
      expect(validRes.body).not.toContain("/api/does-not-exist-12345");
    });
  });

  describe("F12 — Backend Sentry optional init & scrubbing", () => {
    it("is a no-op when SENTRY_DSN is empty", () => {
      process.env.SENTRY_DSN = "";
      expect(initBackendSentry({ dsn: "" })).toBe(false);
      expect(isBackendSentryEnabled()).toBe(false);
    });

    it("scrubs URLs, credentials, PII, cookies, tokens, PINs, and JSON-stringified bodies while preserving safe ERP fields", () => {
      expect(scrubUrl("https://admin:Secret123@erp.example.com/reset-password?token=raw-123#frag")).toBe(
        "https://erp.example.com/reset-password"
      );
      expect(scrubUrl("/api/auth/reset?token=secret-abc#section")).toBe("/api/auth/reset");

      const breadcrumb = scrubSentryBreadcrumb({
        category: "http",
        message: "Failed with Bearer abc.def.ghi and postgresql://u:p@db.local:5432/erp",
        data: {
          url: "https://erp.example.com/api/auth?token=xyz",
          authorization: "Bearer secret-header",
          shippingAddress: "123 Main St",
        },
      });
      expect(breadcrumb.message).not.toContain("abc.def.ghi");
      expect(breadcrumb.message).not.toContain("u:p");
      expect(breadcrumb.data?.url).toBe("https://erp.example.com/api/auth");
      expect(breadcrumb.data?.authorization).toBe("[REDACTED]");
      expect(breadcrumb.data?.shippingAddress).toBe("123 Main St");

      const scrubbedEvent = scrubSentryEvent({
        type: undefined,
        message: "Error calling https://user:pass@api.local/cb?resetToken=tok-999",
        user: {
          id: "user-123",
          email: "cashier@example.com",
          ip_address: "10.0.0.5",
          username: "cashier",
        },
        request: {
          url: "https://erp.example.com/api/pos/checkout?secret=123",
          cookies: { erp_session: "cookie-secret" },
          query_string: "token=abc",
          headers: {
            authorization: "Bearer top-secret",
            cookie: "erp_session=cookie-secret",
            "set-cookie": "erp_session=cookie-secret",
            "x-request-id": "req-123",
          },
          data: JSON.stringify({
            password: "MyPassword123!",
            posPin: "4567",
            shippingAddress: "Cairo Warehouse 1",
            mapping: { accountId: "acc-1" },
          }),
        },
        extra: {
          pin: "9999",
          etaClientSecret: "eta-secret",
          openingBalance: 500,
        },
      });

      expect(scrubbedEvent.user).toEqual({ id: "user-123" });
      expect(scrubbedEvent.request?.url).toBe("https://erp.example.com/api/pos/checkout");
      expect(scrubbedEvent.request?.cookies).toBeUndefined();
      expect(scrubbedEvent.request?.query_string).toBeUndefined();
      expect(scrubbedEvent.request?.headers?.authorization).toBe("[REDACTED]");
      expect(scrubbedEvent.request?.headers?.cookie).toBe("[REDACTED]");
      expect(scrubbedEvent.request?.headers?.["set-cookie"]).toBe("[REDACTED]");
      expect(scrubbedEvent.request?.headers?.["x-request-id"]).toBe("req-123");

      const parsedBody = JSON.parse(String(scrubbedEvent.request?.data)) as Record<string, unknown>;
      expect(parsedBody.password).toBe("[REDACTED]");
      expect(parsedBody.posPin).toBe("[REDACTED]");
      expect(parsedBody.shippingAddress).toBe("Cairo Warehouse 1");
      expect(parsedBody.mapping).toEqual({ accountId: "acc-1" });

      expect(scrubbedEvent.extra?.pin).toBe("[REDACTED]");
      expect(scrubbedEvent.extra?.etaClientSecret).toBe("[REDACTED]");
      expect(scrubbedEvent.extra?.openingBalance).toBe(500);
      expect(scrubbedEvent.message).not.toContain("user:pass");
      expect(scrubbedEvent.message).not.toContain("tok-999");
    });
  });
});
