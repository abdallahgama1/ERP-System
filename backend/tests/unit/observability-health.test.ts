import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
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
});
