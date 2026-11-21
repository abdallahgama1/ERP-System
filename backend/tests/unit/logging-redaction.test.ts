import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.ts";
import { AppError } from "../../src/db/helpers.ts";
import { sanitizeErrorForLog, sanitizeRequestId } from "../../src/logging/logger.ts";

describe("Structured Pino logging, correlation IDs & PII/credential redaction", () => {
  const logChunks: string[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    const captureStream = new Writable({
      write(chunk, _enc, cb) {
        logChunks.push(chunk.toString("utf8"));
        cb();
      },
    });
    app = await buildApp({ loggerStream: captureStream, logLevel: "debug" });
    app.get("/api/test-500-app-error", async () => {
      throw new AppError(500, "Simulated DB error postgresql://admin:SuperSecretPass123@db.local:5432/erp", "DB_FAILURE");
    });
    app.post("/api/test-secret-log", async (req) => {
      req.log.info(
        {
          reqId: req.id,
          body: req.body,
          rawToken: "secret-reset-token-xyz",
          pin: "4829",
        },
        "test.secret_event"
      );
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("sanitizes incoming x-request-id against log injection and echoes valid correlation IDs", async () => {
    expect(sanitizeRequestId("req_valid_123456")).toBe("req_valid_123456");
    const injected = sanitizeRequestId("bad\r\nid\ninjection");
    expect(injected).not.toContain("\n");
    expect(injected).toMatch(/^[0-9a-f-]{36}$/i);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { "x-request-id": "corr-id-987654321" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("corr-id-987654321");
  });

  it("redacts passwords, PINs, tokens, and Postgres credentials from JSON logs and logs 5xx AppErrors", async () => {
    logChunks.length = 0;

    const secretRes = await app.inject({
      method: "POST",
      url: "/api/test-secret-log",
      headers: { cookie: "erp_session=raw-cookie-secret-999" },
      payload: { password: "MyTopSecretPassword!", pin: "9988" },
    });
    expect(secretRes.statusCode).toBe(200);

    const errRes = await app.inject({
      method: "GET",
      url: "/api/test-500-app-error",
    });
    expect(errRes.statusCode).toBe(500);
    expect(errRes.json().reqId).toBeTruthy();

    const combined = logChunks.join("");
    expect(combined).not.toContain("MyTopSecretPassword!");
    expect(combined).not.toContain("secret-reset-token-xyz");
    expect(combined).not.toContain("SuperSecretPass123");
    expect(combined).not.toContain("raw-cookie-secret-999");
    expect(combined).toContain("[REDACTED]");

    const lines = combined
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.msg === "app.error" && l.statusCode === 500 && Boolean(l.reqId))).toBe(true);

    const serialized = sanitizeErrorForLog(new Error("connect postgresql://u:p@host:5432/db"));
    expect(String(serialized.message)).not.toContain("u:p");
  });
});
