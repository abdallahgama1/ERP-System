import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import {
  captureBackendException,
  flushBackendSentry,
  initBackendSentry,
  isBackendSentryEnabled,
  scrubSentryEvent,
} from "../../src/observability/sentry.ts";
import {
  checkStorageHealth,
  setS3ClientOverrideForTests,
  setStorageConfigOverrideForTests,
} from "../../src/services/storage.service.ts";

describe("Observability: /health, /ready storage checks, structured request logs & Sentry hook", () => {
  afterEach(async () => {
    setS3ClientOverrideForTests(null);
    setStorageConfigOverrideForTests(null);
    await flushBackendSentry(100);
  });

  it("serves /health liveness and emits structured request log with reqId and scrubbed secrets", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString("utf8"));
        cb();
      },
    });

    const app = await buildApp({ loggerStream: sink, logLevel: "debug" });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          "x-request-id": "obs-req-12345678",
          authorization: "Bearer super-secret-jwt-token",
          cookie: "erp_session=super-secret-cookie",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toBe("obs-req-12345678");
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe("ok");
      expect(typeof body.uptimeSeconds).toBe("number");

      // Log a synthetic entry containing sensitive fields to verify Pino redaction
      app.log.info(
        {
          reqId: "obs-req-12345678",
          password: "my-secret-password",
          mfaEncryptionKey: "deadbeef".repeat(8),
          smtpPass: "smtp-secret-123",
        },
        "test.secret_redaction"
      );

      const combined = lines.join("\n");
      expect(combined).toContain("obs-req-12345678");
      expect(combined).not.toContain("my-secret-password");
      expect(combined).not.toContain("deadbeef".repeat(8));
      expect(combined).not.toContain("smtp-secret-123");
      expect(combined).not.toContain("super-secret-jwt-token");
      expect(combined).not.toContain("super-secret-cookie");
    } finally {
      await app.close();
    }
  });

  it("verifies local and S3 storage reachability in checkStorageHealth()", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-storage-health-"));
    try {
      setStorageConfigOverrideForTests({ driver: "local", localDir: tmpDir });
      const localOk = await checkStorageHealth();
      expect(localOk).toEqual({ driver: "local", ok: true });

      // S3 healthy mock
      setStorageConfigOverrideForTests({ driver: "s3" });
      setS3ClientOverrideForTests({
        send: async () => ({ $metadata: { httpStatusCode: 200 } }),
      });
      const s3Ok = await checkStorageHealth();
      expect(s3Ok).toEqual({ driver: "s3", ok: true });

      // S3 unreachable mock
      setS3ClientOverrideForTests({
        send: async () => {
          throw new Error("NoSuchBucket");
        },
      });
      const s3Fail = await checkStorageHealth();
      expect(s3Fail.driver).toBe("s3");
      expect(s3Fail.ok).toBe(false);
      expect(s3Fail.error).toContain("NoSuchBucket");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps Sentry error-reporting hook disabled unless SENTRY_DSN is set and scrubs sensitive fields", () => {
    const origDsn = process.env.SENTRY_DSN;
    try {
      delete process.env.SENTRY_DSN;
      const initialized = initBackendSentry({ dsn: "" });
      expect(initialized).toBe(false);
      expect(isBackendSentryEnabled()).toBe(false);
      // Must be a safe no-op when disabled
      expect(() =>
        captureBackendException(new Error("test error"), { reqId: "req-1", route: "/api/test" })
      ).not.toThrow();

      const scrubbed = scrubSentryEvent({
        message: "Failed with Bearer secret-token-123 and postgresql://admin:pw123@host:5432/db",
        extra: {
          mfaEncryptionKey: "a".repeat(64),
          recoveryCodes: ["AAAA-BBBB"],
          smtpPass: "mail-secret",
          safeField: "visible",
        },
        request: {
          url: "https://erp.example.com/api/auth/reset?token=secret-tok",
          cookies: { erp_session: "raw-cookie" },
          headers: { authorization: "Bearer another-secret" },
        },
      });

      expect(scrubbed.message).not.toContain("secret-token-123");
      expect(scrubbed.message).not.toContain("pw123");
      expect((scrubbed.extra as Record<string, unknown>).mfaEncryptionKey).toBe("[REDACTED]");
      expect((scrubbed.extra as Record<string, unknown>).recoveryCodes).toBe("[REDACTED]");
      expect((scrubbed.extra as Record<string, unknown>).smtpPass).toBe("[REDACTED]");
      expect((scrubbed.extra as Record<string, unknown>).safeField).toBe("visible");
      expect(scrubbed.request?.cookies).toBeUndefined();
      expect(scrubbed.request?.url).toBe("https://erp.example.com/api/auth/reset");
      expect((scrubbed.request?.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
    } finally {
      if (origDsn === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = origDsn;
    }
  });

  it("enforces token authentication, 404 when unconfigured, and per-IP rate limiting on GET /api/status", async () => {
    const origToken = process.env.UPTIME_STATUS_TOKEN;
    const origMax = process.env.UPTIME_STATUS_RATE_LIMIT_MAX;
    const origWin = process.env.UPTIME_STATUS_RATE_LIMIT_WINDOW_MS;
    try {
      delete process.env.UPTIME_STATUS_TOKEN;
      process.env.UPTIME_STATUS_RATE_LIMIT_MAX = "3";
      process.env.UPTIME_STATUS_RATE_LIMIT_WINDOW_MS = "60000";

      const app = await buildApp({ logger: false, enableRateLimit: true });
      try {
        // Unconfigured -> 404
        const unconfigured = await app.inject({ method: "GET", url: "/api/status" });
        expect(unconfigured.statusCode).toBe(404);

        // Configure token -> missing/invalid token returns 401 and counts toward rate limit
        process.env.UPTIME_STATUS_TOKEN = "unit-test-status-token-0123456789";

        const noToken = await app.inject({ method: "GET", url: "/api/status" });
        expect(noToken.statusCode).toBe(401);
        expect(noToken.headers["www-authenticate"]).toContain("Bearer");

        const badToken = await app.inject({
          method: "GET",
          url: "/api/status",
          headers: { authorization: "Bearer wrong-token-00000000000000000000" },
        });
        expect(badToken.statusCode).toBe(401);

        // 4th request within window triggers 429 rate limit (1 unconfigured + 2 unauthorized = 3)
        const rateLimited = await app.inject({
          method: "GET",
          url: "/api/status",
          headers: { authorization: "Bearer unit-test-status-token-0123456789" },
        });
        expect(rateLimited.statusCode).toBe(429);
      } finally {
        await app.close();
      }
    } finally {
      if (origToken === undefined) delete process.env.UPTIME_STATUS_TOKEN;
      else process.env.UPTIME_STATUS_TOKEN = origToken;
      if (origMax === undefined) delete process.env.UPTIME_STATUS_RATE_LIMIT_MAX;
      else process.env.UPTIME_STATUS_RATE_LIMIT_MAX = origMax;
      if (origWin === undefined) delete process.env.UPTIME_STATUS_RATE_LIMIT_WINDOW_MS;
      else process.env.UPTIME_STATUS_RATE_LIMIT_WINDOW_MS = origWin;
    }
  });

  it("pings healthchecks.io-compatible URL on success and /fail with redacted errors on failure", async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const helperUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/lib/healthcheck-ping.mjs")).href;
    const { pingHealthcheck, normalizeHealthcheckUrl, redactSensitiveText } = (await import(helperUrl)) as {
      pingHealthcheck: (opts: {
        url: string;
        ok: boolean;
        body?: string;
        retries?: number;
      }) => Promise<{ skipped: boolean; sent: boolean; ok: boolean; targetUrl: string | null; status: number | null }>;
      normalizeHealthcheckUrl: (raw: string) => string | null;
      redactSensitiveText: (raw: string) => string;
    };

    expect(normalizeHealthcheckUrl("https://hc-ping.com/abc-123/")).toBe("https://hc-ping.com/abc-123");
    expect(normalizeHealthcheckUrl("ftp://invalid.example.com")).toBeNull();
    expect(redactSensitiveText("pg_dump postgresql://erp:SuperSecret@db:5432/erp failed")).not.toContain(
      "SuperSecret"
    );

    const received: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200);
      res.end("OK");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const basePingUrl = `http://127.0.0.1:${port}/ping/test-uuid`;

    try {
      const skipped = await pingHealthcheck({ url: "", ok: true, body: "noop" });
      expect(skipped.skipped).toBe(true);

      const okRes = await pingHealthcheck({ url: `${basePingUrl}/`, ok: true, body: "backup ok: 123 bytes" });
      expect(okRes.sent).toBe(true);
      expect(okRes.targetUrl).toBe(basePingUrl);

      const failRes = await pingHealthcheck({
        url: basePingUrl,
        ok: false,
        body: "pg_dump failed for postgresql://erp:TopSecret99@host:5432/erp with Bearer tok-secret-xyz",
      });
      expect(failRes.sent).toBe(true);
      expect(failRes.targetUrl).toBe(`${basePingUrl}/fail`);

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ method: "POST", url: "/ping/test-uuid", body: "backup ok: 123 bytes" });
      expect(received[1]?.method).toBe("POST");
      expect(received[1]?.url).toBe("/ping/test-uuid/fail");
      expect(received[1]?.body).not.toContain("TopSecret99");
      expect(received[1]?.body).not.toContain("tok-secret-xyz");
      expect(received[1]?.body).toContain("[REDACTED]");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
