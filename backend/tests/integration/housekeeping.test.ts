import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

describe.skipIf(!testDbUrl)("F10 — PostgreSQL advisory-locked housekeeping job", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    app = await buildApp({ logger: false });
    await app.ready();

    const expectedDb = new URL(testDbUrl!).pathname.replace(/^\//, "");
    const { getDb } = await import("../../src/db/index.ts");
    const check = await getDb().execute(sql`SELECT current_database() AS db`);
    const activeDb = (check[0] as { db?: string } | undefined)?.db;
    if (activeDb !== expectedDb) {
      throw new Error(
        `Refusing to run destructive integration tests against '${activeDb}' instead of '${expectedDb}'`
      );
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("purges expired/old-revoked sessions, expired/used reset tokens, and expired idempotency keys while preserving active & null-expiry rows, enforces admin RBAC, and skips when advisory lock is held", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const { auditLogs, idempotencyKeys, passwordResetTokens, userSessions } = await import(
      "../../drizzle/schema.ts"
    );
    const { HOUSEKEEPING_LOCK_KEY, runHousekeeping } = await import(
      "../../src/services/housekeeping.service.ts"
    );

    const db = getDb();

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);

    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Housekeeping Admin", email: "hk-admin@test.local", password: "Password123!" },
    });
    expect(adminSignup.statusCode).toBe(201);
    const adminId = adminSignup.json().user.id as string;
    const adminCookie = adminSignup.cookies.find((c) => c.name === "erp_session")!.value;

    const userSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Housekeeping User", email: "hk-user@test.local", password: "Password123!" },
    });
    expect(userSignup.statusCode).toBe(201);
    const regularUserId = userSignup.json().user.id as string;
    const regularCookie = userSignup.cookies.find((c) => c.name === "erp_session")!.value;

    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const daysAhead = (days: number) => new Date(now.getTime() + days * 86_400_000);

    // Seed sessions: 1 expired, 1 old-revoked (>7d), 1 recent-revoked (<7d)
    const [expiredSess, oldRevokedSess, recentRevokedSess] = await db
      .insert(userSessions)
      .values([
        {
          userId: regularUserId,
          tokenHash: "hk-expired-sess",
          expiresAt: daysAgo(1),
        },
        {
          userId: regularUserId,
          tokenHash: "hk-old-revoked-sess",
          expiresAt: daysAhead(10),
          revokedAt: daysAgo(10),
        },
        {
          userId: regularUserId,
          tokenHash: "hk-recent-revoked-sess",
          expiresAt: daysAhead(10),
          revokedAt: daysAgo(2),
        },
      ])
      .returning({ id: userSessions.id });

    // Seed password reset tokens: 1 expired, 1 used, 1 active unused
    const [expiredToken, usedToken, activeToken] = await db
      .insert(passwordResetTokens)
      .values([
        {
          userId: regularUserId,
          tokenHash: "hk-expired-reset",
          expiresAt: daysAgo(1),
        },
        {
          userId: regularUserId,
          tokenHash: "hk-used-reset",
          expiresAt: daysAhead(1),
          usedAt: daysAgo(0.1),
        },
        {
          userId: regularUserId,
          tokenHash: "hk-active-reset",
          expiresAt: daysAhead(1),
        },
      ])
      .returning({ id: passwordResetTokens.id });

    // Seed idempotency keys: 1 expired, 1 active, 1 null expiresAt
    const [expiredIdem, activeIdem, nullExpiryIdem] = await db
      .insert(idempotencyKeys)
      .values([
        {
          userId: regularUserId,
          key: "hk-expired-idem",
          method: "POST",
          path: "/api/pos/checkout",
          statusCode: 201,
          responseBody: { ok: true },
          expiresAt: daysAgo(1),
        },
        {
          userId: regularUserId,
          key: "hk-active-idem",
          method: "POST",
          path: "/api/pos/checkout",
          statusCode: 201,
          responseBody: { ok: true },
          expiresAt: daysAhead(5),
        },
        {
          userId: regularUserId,
          key: "hk-null-idem",
          method: "POST",
          path: "/api/pos/checkout",
          statusCode: 201,
          responseBody: { ok: true },
          expiresAt: null,
        },
      ])
      .returning({ id: idempotencyKeys.id });

    // Non-admin must get 403
    const forbiddenRes = await app.inject({
      method: "POST",
      url: "/api/admin/jobs/housekeeping",
      cookies: { erp_session: regularCookie },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // Admin endpoint execution
    const adminRes = await app.inject({
      method: "POST",
      url: "/api/admin/jobs/housekeeping",
      cookies: { erp_session: adminCookie },
    });
    expect(adminRes.statusCode).toBe(200);
    const body = adminRes.json();
    expect(body.skipped).toBe(false);
    expect(body.deletedSessions).toBe(2);
    expect(body.deletedResetTokens).toBe(2);
    expect(body.deletedIdempotencyKeys).toBe(1);
    expect(body.totalDeleted).toBe(5);

    const remainingSessions = await db.select({ id: userSessions.id }).from(userSessions);
    const remainingSessionIds = new Set(remainingSessions.map((r) => r.id));
    expect(remainingSessionIds.has(expiredSess.id)).toBe(false);
    expect(remainingSessionIds.has(oldRevokedSess.id)).toBe(false);
    expect(remainingSessionIds.has(recentRevokedSess.id)).toBe(true);
    expect(remainingSessions.length).toBe(3); // admin + regular active + recentRevoked

    const remainingTokens = await db.select({ id: passwordResetTokens.id }).from(passwordResetTokens);
    expect(remainingTokens.map((r) => r.id)).toEqual([activeToken.id]);
    expect(remainingTokens.some((r) => r.id === expiredToken.id || r.id === usedToken.id)).toBe(false);

    const remainingIdem = await db.select({ id: idempotencyKeys.id }).from(idempotencyKeys);
    const remainingIdemIds = new Set(remainingIdem.map((r) => r.id));
    expect(remainingIdemIds.has(expiredIdem.id)).toBe(false);
    expect(remainingIdemIds.has(activeIdem.id)).toBe(true);
    expect(remainingIdemIds.has(nullExpiryIdem.id)).toBe(true);

    const hkAudit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "system.housekeeping"));
    expect(hkAudit).toHaveLength(1);
    expect(hkAudit[0]?.userId).toBe(adminId);

    // Advisory lock contention: hold lock 910301 in a concurrent tx and confirm runHousekeeping skips cleanly
    let releaseLock!: () => void;
    let notifyLocked!: () => void;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const holdLockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockHolderTx = db.transaction(async (tx) => {
      const res = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${HOUSEKEEPING_LOCK_KEY}) AS acquired`
      );
      expect(res[0]?.acquired).toBe(true);
      notifyLocked();
      await holdLockPromise;
    });

    await lockAcquiredPromise;
    const skippedResult = await runHousekeeping(db);
    releaseLock();
    await lockHolderTx;

    expect(skippedResult.skipped).toBe(true);
    expect(skippedResult.totalDeleted).toBe(0);
  });
});
