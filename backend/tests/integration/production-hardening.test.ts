import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../../src/db/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const testDbUrl = (process.env.TEST_DATABASE_URL ?? "").trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

function extractCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const match = list.find((c) => c.startsWith("erp_session="));
  return match ? match.split(";")[0]! : "";
}

function buildMultipartPayload(fields: Record<string, string>, file: { fileName: string; mimeType: string; content: Buffer }) {
  const boundary = `----ErpHardeningBoundary${crypto.randomBytes(6).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8"
    )
  );
  chunks.push(file.content);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks),
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describeWithDb("Production hardening integration suite", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminCookie = "";
  let userCookie = "";
  let adminEmail = "";
  let adminPassword = "";

  const ORIG_ENV = {
    AUTH_LOCKOUT_MAX_ATTEMPTS: process.env.AUTH_LOCKOUT_MAX_ATTEMPTS,
    AUTH_LOCKOUT_WINDOW_MS: process.env.AUTH_LOCKOUT_WINDOW_MS,
    AUTH_LOCKOUT_DURATION_MS: process.env.AUTH_LOCKOUT_DURATION_MS,
    AUTH_RATE_LIMIT_MAX: process.env.AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS: process.env.AUTH_RATE_LIMIT_WINDOW_MS,
    MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
    MFA_ENCRYPTION_KEY_VERSION: process.env.MFA_ENCRYPTION_KEY_VERSION,
    MFA_ENCRYPTION_PREVIOUS_KEYS: process.env.MFA_ENCRYPTION_PREVIOUS_KEYS,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
  };

  function restoreEnv(): void {
    for (const [k, v] of Object.entries(ORIG_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName, resetTestDatabase } = await import("../helpers/db-reset.ts");

    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    await resetTestDatabase(db);
    app = await buildApp({ logger: false });

    adminEmail = "hardening-admin@test.local";
    adminPassword = "AdminPassword123!";
    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Hardening Admin", email: adminEmail, password: adminPassword },
    });
    expect(adminSignup.statusCode).toBe(201);
    adminCookie = extractCookie(adminSignup);

    const userSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Regular User", email: "hardening-user@test.local", password: "UserPassword123!" },
    });
    expect(userSignup.statusCode).toBe(201);
    userCookie = extractCookie(userSignup);
  });

  afterEach(async () => {
    restoreEnv();
    const { setVirusScanEnabledForTests, setVirusScannerForTests } = await import(
      "../../src/services/virus-scan.service.ts"
    );
    setVirusScanEnabledForTests(null);
    setVirusScannerForTests(null);
  });

  afterAll(async () => {
    restoreEnv();
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("1. enforces configurable temporary lockouts on login, MFA verify-login, and password reset, plus route rate limits", async () => {
    process.env.AUTH_LOCKOUT_MAX_ATTEMPTS = "3";
    process.env.AUTH_LOCKOUT_WINDOW_MS = "60000";
    process.env.AUTH_LOCKOUT_DURATION_MS = "60000";

    const targetEmail = "lockout-victim@test.local";
    const targetPassword = "GoodPassword123!";
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Lockout Victim", email: targetEmail, password: targetPassword },
    });
    expect(signup.statusCode).toBe(201);

    // 3 failed logins lock the account
    for (let i = 0; i < 3; i++) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: targetEmail, password: "WrongPassword!" },
      });
      expect(bad.statusCode).toBe(401);
    }

    const lockedRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: targetEmail, password: targetPassword },
    });
    expect(lockedRes.statusCode).toBe(429);
    expect(lockedRes.json().code).toBe("ACCOUNT_LOCKED");
    expect(Number(lockedRes.headers["retry-after"])).toBeGreaterThan(0);

    // Clear login lockout and verify password-reset lockout
    const { clearAuthLockout } = await import("../../src/services/auth-lockout.service.ts");
    await clearAuthLockout(db, "login", targetEmail);

    for (let i = 0; i < 3; i++) {
      const badReset = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token: "invalid-reset-token-123456", newPassword: "NewPassword123!" },
      });
      expect(badReset.statusCode).toBe(400);
    }

    const lockedReset = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "invalid-reset-token-123456", newPassword: "NewPassword123!" },
    });
    expect(lockedReset.statusCode).toBe(429);
    expect(lockedReset.json().code).toBe("ACCOUNT_LOCKED");

    // Verify real Fastify route rate-limiting honors AUTH_RATE_LIMIT_MAX
    process.env.AUTH_RATE_LIMIT_MAX = "3";
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.AUTH_LOCKOUT_MAX_ATTEMPTS = "50";
    const { buildApp } = await import("../../src/app.ts");
    const rateLimitedApp = await buildApp({ logger: false, enableRateLimit: true });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await rateLimitedApp.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "nobody@test.local", password: "WrongPassword!" },
        });
        expect(res.statusCode).toBe(401);
      }
      const throttled = await rateLimitedApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@test.local", password: "WrongPassword!" },
      });
      expect(throttled.statusCode).toBe(429);
    } finally {
      await rateLimitedApp.close();
    }
  });

  it("2. rotates MFA encryption keys across versions without locking users out and enforces MFA lockout", async () => {
    const keyV1 = crypto.randomBytes(32).toString("hex");
    const keyV2 = crypto.randomBytes(32).toString("hex");
    process.env.MFA_ENCRYPTION_KEY = keyV1;
    process.env.MFA_ENCRYPTION_KEY_VERSION = "1";
    delete process.env.MFA_ENCRYPTION_PREVIOUS_KEYS;
    process.env.AUTH_LOCKOUT_MAX_ATTEMPTS = "3";
    process.env.AUTH_LOCKOUT_DURATION_MS = "60000";

    const mfaEmail = "mfa-rotate@test.local";
    const mfaPassword = "MfaPassword123!";
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "MFA User", email: mfaEmail, password: mfaPassword },
    });
    expect(signup.statusCode).toBe(201);
    const mfaCookie = extractCookie(signup);
    const mfaUserId = signup.json().user.id as string;

    // Enroll & verify under key v1
    const enrollRes = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll",
      headers: { cookie: mfaCookie },
    });
    expect(enrollRes.statusCode).toBe(200);
    const otpauthUrl = enrollRes.json().otpauthUrl as string;
    const secretBase32 = new URL(otpauthUrl).searchParams.get("secret")!;
    expect(secretBase32).toBeTruthy();

    const { generateTotp, rotateMfaEncryptionKeys } = await import("../../src/services/mfa.service.ts");
    const { userMfa } = await import("../../drizzle/schema.ts");

    const verifyRes = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers: { cookie: mfaCookie },
      payload: { code: generateTotp(secretBase32) },
    });
    expect(verifyRes.statusCode).toBe(200);

    const [rowBefore] = await db.select().from(userMfa).where(eq(userMfa.userId, mfaUserId)).limit(1);
    expect(rowBefore?.keyVersion).toBe(1);

    // Switch primary key to v2 while keeping v1 in previous keys
    process.env.MFA_ENCRYPTION_KEY = keyV2;
    process.env.MFA_ENCRYPTION_KEY_VERSION = "2";
    process.env.MFA_ENCRYPTION_PREVIOUS_KEYS = `1:${keyV1}`;

    // User can STILL log in with TOTP before rotation runs
    const loginStep1 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: mfaEmail, password: mfaPassword },
    });
    expect(loginStep1.statusCode).toBe(200);
    expect(loginStep1.json().mfaRequired).toBe(true);
    const challenge1 = loginStep1.json().mfaChallengeToken as string;

    const loginStep2 = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify-login",
      payload: { mfaChallengeToken: challenge1, code: generateTotp(secretBase32) },
    });
    expect(loginStep2.statusCode).toBe(200);

    // Dry-run rotation leaves key_version at 1
    const dryRun = await rotateMfaEncryptionKeys(db, { dryRun: true });
    expect(dryRun.targetVersion).toBe(2);
    expect(dryRun.rotated).toBeGreaterThanOrEqual(1);
    const [rowAfterDry] = await db.select().from(userMfa).where(eq(userMfa.userId, mfaUserId)).limit(1);
    expect(rowAfterDry?.keyVersion).toBe(1);

    // Real rotation re-encrypts to key_version = 2
    const rotated = await rotateMfaEncryptionKeys(db);
    expect(rotated.targetVersion).toBe(2);
    expect(rotated.rotated).toBeGreaterThanOrEqual(1);
    const [rowAfter] = await db.select().from(userMfa).where(eq(userMfa.userId, mfaUserId)).limit(1);
    expect(rowAfter?.keyVersion).toBe(2);

    // Remove v1 completely; user still verifies TOTP using v2!
    delete process.env.MFA_ENCRYPTION_PREVIOUS_KEYS;
    const login2Step1 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: mfaEmail, password: mfaPassword },
    });
    const challenge2 = login2Step1.json().mfaChallengeToken as string;

    // Also prove 3 failed MFA attempts trigger temporary lockout
    for (let i = 0; i < 3; i++) {
      const badMfa = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        payload: { mfaChallengeToken: challenge2, code: "000000" },
      });
      expect(badMfa.statusCode).toBe(401);
    }
    const lockedMfa = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify-login",
      payload: { mfaChallengeToken: challenge2, code: generateTotp(secretBase32) },
    });
    expect(lockedMfa.statusCode).toBe(429);
    expect(lockedMfa.json().code).toBe("ACCOUNT_LOCKED");

    // Clear MFA lockout and confirm v2 TOTP succeeds without v1 key
    const { clearAuthLockout } = await import("../../src/services/auth-lockout.service.ts");
    await clearAuthLockout(db, "mfa_login", mfaUserId);
    const login2Step2 = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify-login",
      payload: { mfaChallengeToken: challenge2, code: generateTotp(secretBase32) },
    });
    expect(login2Step2.statusCode).toBe(200);
  });

  it("3. hardens uploads with magic-byte checks, randomized storage keys, and virus-scan hook", async () => {
    // Create a customer to attach files to
    const custRes = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { cookie: adminCookie },
      payload: { name: "Upload Test Customer" },
    });
    expect(custRes.statusCode).toBe(201);
    const customerId = custRes.json().customer.id as string;

    // Spoofed PNG (actually EXE MZ bytes) must be rejected
    const spoofed = buildMultipartPayload(
      { entityType: "customer", entityId: customerId },
      { fileName: "spoof.png", mimeType: "image/png", content: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]) }
    );
    const spoofRes = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: adminCookie, "content-type": spoofed.contentType },
      payload: spoofed.payload,
    });
    expect(spoofRes.statusCode).toBe(400);
    expect(spoofRes.json().code).toBe("INVALID_FILE_SIGNATURE");

    // Valid PDF succeeds (virus scan off by default) and uses an opaque randomized storage key
    const validPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
    const okForm = buildMultipartPayload(
      { entityType: "customer", entityId: customerId },
      { fileName: "sensitive-contract.pdf", mimeType: "application/pdf", content: validPdf }
    );
    const okRes = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: adminCookie, "content-type": okForm.contentType },
      payload: okForm.payload,
    });
    expect(okRes.statusCode).toBe(201);
    const attachmentId = okRes.json().attachment.id as string;

    const { documentAttachments } = await import("../../drizzle/schema.ts");
    const [attRow] = await db
      .select({ storageKey: documentAttachments.storageKey })
      .from(documentAttachments)
      .where(eq(documentAttachments.id, attachmentId))
      .limit(1);
    expect(attRow?.storageKey).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{48}$/);
    expect(attRow?.storageKey).not.toContain("sensitive-contract");
    expect(attRow?.storageKey).not.toContain(customerId);

    // Enable virus-scan hook and verify malware rejection + audit event
    const { setVirusScanEnabledForTests, setVirusScannerForTests } = await import(
      "../../src/services/virus-scan.service.ts"
    );
    setVirusScanEnabledForTests(true);
    setVirusScannerForTests(async () => ({
      clean: false,
      threat: "EICAR-Test-Signature",
      scanner: "mock-clamav",
    }));

    const infectedForm = buildMultipartPayload(
      { entityType: "customer", entityId: customerId },
      { fileName: "infected.pdf", mimeType: "application/pdf", content: validPdf }
    );
    const infectedRes = await app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { cookie: adminCookie, "content-type": infectedForm.contentType },
      payload: infectedForm.payload,
    });
    expect(infectedRes.statusCode).toBe(422);
    expect(infectedRes.json().code).toBe("MALWARE_DETECTED");
  });

  it("4. maintains unbroken audit-log hash chain under concurrency and detects SQL tampering via admin verify endpoint", async () => {
    const { writeAuditLog } = await import("../../src/db/helpers.ts");

    // 15 concurrent audit writes must serialize cleanly without breaking the chain
    await Promise.all(
      Array.from({ length: 15 }, (_, idx) =>
        writeAuditLog(db, {
          userName: "Concurrency Tester",
          userRole: "admin",
          action: "test.concurrent_write",
          entityType: "system",
          entityId: `concurrent-${idx}`,
          details: { idx, marker: `m-${idx}` },
        })
      )
    );

    // Non-admin is forbidden from verify endpoint
    const userVerify = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify",
      headers: { cookie: userCookie },
    });
    expect(userVerify.statusCode).toBe(403);

    // Admin verifies intact chain
    const okVerify = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify",
      headers: { cookie: adminCookie },
    });
    expect(okVerify.statusCode).toBe(200);
    const okBody = okVerify.json();
    expect(okBody.valid).toBe(true);
    expect(okBody.totalChainedRows).toBeGreaterThanOrEqual(15);
    expect(okBody.firstBrokenId).toBeNull();

    // Tamper directly with a row in PostgreSQL and verify detection
    const targetSeq = Math.max(1, okBody.totalChainedRows - 3);
    const [tamperedRow] = await db.execute<{ id: string }>(sql`
      UPDATE audit_logs
      SET details = jsonb_set(details, '{tampered}', 'true'::jsonb)
      WHERE chain_seq = ${targetSeq}
      RETURNING id
    `);
    expect(tamperedRow?.id).toBeTruthy();

    const brokenVerify = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify",
      headers: { cookie: adminCookie },
    });
    expect(brokenVerify.statusCode).toBe(200);
    const brokenBody = brokenVerify.json();
    expect(brokenBody.valid).toBe(false);
    expect(brokenBody.firstBrokenSeq).toBe(targetSeq);
    expect(brokenBody.firstBrokenId).toBe(tamperedRow!.id);
    expect(brokenBody.reason).toMatch(/tampered|mismatch/i);
  });

  it("5. emits hardened security headers, enforces CORS allow-list, and sets HttpOnly/SameSite/Secure session cookies", async () => {
    process.env.COOKIE_SECURE = "true";
    const { buildApp } = await import("../../src/app.ts");
    const hardenedApp = await buildApp({
      logger: false,
      corsOrigin: "https://erp.example.com,https://admin.example.com",
    });

    try {
      // Allowed origin gets exact CORS header + security headers
      const allowedRes = await hardenedApp.inject({
        method: "GET",
        url: "/api/health/live",
        headers: { origin: "https://erp.example.com" },
      });
      expect(allowedRes.statusCode).toBe(200);
      expect(allowedRes.headers["access-control-allow-origin"]).toBe("https://erp.example.com");
      expect(allowedRes.headers["access-control-allow-credentials"]).toBe("true");
      expect(allowedRes.headers["x-content-type-options"]).toBe("nosniff");
      expect(allowedRes.headers["x-frame-options"]).toBe("DENY");
      expect(allowedRes.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(String(allowedRes.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(String(allowedRes.headers["permissions-policy"])).toContain("camera=()");

      // Disallowed origin does NOT get Access-Control-Allow-Origin
      const blockedRes = await hardenedApp.inject({
        method: "GET",
        url: "/api/health/live",
        headers: { origin: "https://evil.example.com" },
      });
      expect(blockedRes.statusCode).toBe(200);
      expect(blockedRes.headers["access-control-allow-origin"]).toBeUndefined();

      // Login sets Secure, HttpOnly, SameSite=Lax cookie and Cache-Control: no-store
      const loginRes = await hardenedApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: adminEmail, password: adminPassword },
      });
      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.headers["cache-control"]).toBe("no-store");
      const rawCookies = loginRes.headers["set-cookie"];
      const cookieHeader = Array.isArray(rawCookies) ? rawCookies.join("; ") : String(rawCookies ?? "");
      expect(cookieHeader).toContain("erp_session=");
      expect(cookieHeader).toMatch(/HttpOnly/i);
      expect(cookieHeader).toMatch(/SameSite=Lax/i);
      expect(cookieHeader).toMatch(/Secure/i);
    } finally {
      await hardenedApp.close();
    }
  });

  it("6. serves /health (liveness) and /ready (DB + storage reachability, returning 503 when storage fails)", async () => {
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().ok).toBe(true);
    expect(healthRes.json().status).toBe("ok");

    const readyOk = await app.inject({ method: "GET", url: "/ready" });
    expect(readyOk.statusCode).toBe(200);
    const readyBody = readyOk.json();
    expect(readyBody.ok).toBe(true);
    expect(readyBody.db).toBe("ok");
    expect(readyBody.storage).toBe("ok");
    expect(readyBody.storageCheck?.ok).toBe(true);

    const { setS3ClientOverrideForTests, setStorageConfigOverrideForTests } = await import(
      "../../src/services/storage.service.ts"
    );
    try {
      setStorageConfigOverrideForTests({ driver: "s3" });
      setS3ClientOverrideForTests({
        send: async () => {
          throw new Error("Simulated S3 outage");
        },
      });
      const readyFail = await app.inject({ method: "GET", url: "/ready" });
      expect(readyFail.statusCode).toBe(503);
      const failBody = readyFail.json();
      expect(failBody.ok).toBe(false);
      expect(failBody.db).toBe("ok");
      expect(failBody.storage).toBe("error");
      expect(failBody.storageCheck?.error).toContain("Simulated S3 outage");
    } finally {
      setS3ClientOverrideForTests(null);
      setStorageConfigOverrideForTests(null);
    }
  });
});
