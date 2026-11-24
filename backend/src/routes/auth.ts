import type { FastifyInstance } from "fastify";
import {
  mfaDisableSchema,
  mfaRegenerateRecoveryCodesSchema,
  mfaVerifyEnrollSchema,
  mfaVerifyLoginSchema,
  sessionIdParamSchema,
  switchCompanySchema,
  type ActiveSessionDto,
} from "@erp/shared";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_COMPANY_ID,
  branches,
  companies,
  customRoles,
  passwordResetTokens,
  posTerminals,
  userBranches,
  userBranchScopes,
  userCompanies,
  userMfa,
  userRoles,
  users,
  userSessions,
} from "../../drizzle/schema.ts";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { ensureSeededDefaults } from "../auth/permissions.ts";
import {
  clearSessionCookie,
  createSessionRecord,
  generateOpaqueToken,
  hashToken,
  loadAuthUserById,
  resolvePrimaryCompanyIdForUser,
  revokeSessionByToken,
  setSessionCookie,
} from "../auth/sessions.ts";
import { env } from "../config.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { sendPasswordResetEmail } from "../services/email.service.ts";
import {
  consumeMfaChallengeJti,
  createMfaChallengeToken,
  disableMfa,
  enrollMfa,
  getMfaStatus,
  regenerateMfaRecoveryCodes,
  verifyMfaChallengeToken,
  verifyMfaCodeOrRecovery,
  verifyMfaEnrollment,
} from "../services/mfa.service.ts";
import { parseOrThrow } from "../services/stock-locks.ts";

// Dummy hash used to equalize login response timing when user email does not exist
const DUMMY_PASSWORD_HASH =
  "scrypt$N=16384,r=8,p=1$00000000000000000000000000000000$" + "0".repeat(128);

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Valid email is required"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Valid email is required"),
  password: z.string().min(1, "Password is required").max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email("Valid email is required"),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10, "Reset token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const authRateLimit =
    env.NODE_ENV !== "test" && !env.DISABLE_RATE_LIMIT
      ? { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }
      : {};

  app.get("/api/auth/me", async (req) => {
    if (!req.authUser) {
      return { user: null };
    }
    return {
      user: req.authUser,
      posSession: {
        terminalId: req.posTerminalId,
        isLocked: req.isTerminalLocked,
        terminalOwnerId: req.terminalSessionOwnerId,
      },
    };
  });

  app.post("/api/auth/signup", authRateLimit, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid signup input", "VALIDATION_ERROR");
    }

    const { name, email, password } = parsed.data;
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      // Serialize concurrent signups so exactly one account bootstraps admin role
      await tx.execute(sql`SELECT pg_advisory_xact_lock(749201)`);

      const defaultBranchId = await ensureSeededDefaults(tx);

      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing.length > 0) {
        throw new AppError(409, "An account with this email already exists", "EMAIL_EXISTS");
      }

      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
      const isFirstUser = count === 0;
      const role = isFirstUser ? "admin" : "user";
      const scopeMode = isFirstUser ? "all" : "selected";

      let adminCustomRoleId: string | null = null;
      if (isFirstUser) {
        const [adminCustomRole] = await tx
          .select({ id: customRoles.id })
          .from(customRoles)
          .where(and(eq(customRoles.companyId, DEFAULT_COMPANY_ID), eq(customRoles.name, "Admin")))
          .limit(1);
        adminCustomRoleId = adminCustomRole?.id ?? null;
      }

      const passwordHash = await hashPassword(password);

      const [createdUser] = await tx
        .insert(users)
        .values({
          name,
          email,
          passwordHash,
          emailVerified: isFirstUser,
          isActive: true,
          defaultBranchId: isFirstUser ? defaultBranchId : null,
        })
        .returning();

      await tx.insert(userRoles).values({
        userId: createdUser.id,
        role,
        customRoleId: adminCustomRoleId,
      });

      await tx.insert(userCompanies).values({
        userId: createdUser.id,
        companyId: DEFAULT_COMPANY_ID,
        role,
        customRoleId: adminCustomRoleId,
        isDefault: true,
        isActive: true,
      });

      await tx.insert(userBranchScopes).values({
        userId: createdUser.id,
        scopeMode,
      });

      if (isFirstUser) {
        await tx
          .insert(userBranches)
          .values({
            userId: createdUser.id,
            branchId: defaultBranchId,
            isDefault: true,
          })
          .onConflictDoNothing();
      }

      const session = await createSessionRecord(tx, {
        userId: createdUser.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        activeCompanyId: DEFAULT_COMPANY_ID,
      });

      await writeAuditLog(tx, {
        companyId: DEFAULT_COMPANY_ID,
        userId: createdUser.id,
        userName: name,
        userRole: role,
        action: "auth.signup",
        entityType: "user",
        entityId: createdUser.id,
        entityLabel: email,
        details: { firstUserBootstrap: isFirstUser },
        after: {
          id: createdUser.id,
          name,
          email,
          role,
          customRoleId: adminCustomRoleId,
          companyId: DEFAULT_COMPANY_ID,
        },
        ipAddress: req.ip,
      });

      const authUser = await loadAuthUserById(tx, createdUser.id, DEFAULT_COMPANY_ID);
      if (!authUser) {
        throw new AppError(500, "Failed to load newly created user", "INTERNAL_ERROR");
      }

      return { authUser, rawToken: session.rawToken };
    });

    setSessionCookie(reply, result.rawToken);
    return reply.status(201).send({
      user: result.authUser,
      needsConfirmation: false,
    });
  });

  app.post("/api/auth/login", authRateLimit, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid credentials", "VALIDATION_ERROR");
    }

    const { email, password } = parsed.data;
    const db = getDb();

    const [userRow] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const valid = userRow
      ? await verifyPassword(password, userRow.passwordHash)
      : await verifyPassword(password, DUMMY_PASSWORD_HASH).then(() => false);

    if (!userRow || !valid) {
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    if (!userRow.isActive) {
      throw new AppError(403, "This account has been deactivated. Please contact an administrator.", "ACCOUNT_DISABLED");
    }

    const [mfaRow] = await db
      .select({ isEnabled: userMfa.isEnabled })
      .from(userMfa)
      .where(eq(userMfa.userId, userRow.id))
      .limit(1);

    if (mfaRow?.isEnabled) {
      const mfaChallengeToken = createMfaChallengeToken(userRow.id);
      return {
        mfaRequired: true as const,
        mfaChallengeToken,
      };
    }

    const { authUser, rawToken } = await db.transaction(async (tx) => {
      await ensureSeededDefaults(tx);
      const primaryCompanyId =
        (await resolvePrimaryCompanyIdForUser(tx, userRow.id)) ?? DEFAULT_COMPANY_ID;
      const loadedUser = await loadAuthUserById(tx, userRow.id, primaryCompanyId);
      if (!loadedUser) {
        throw new AppError(403, "Account inactive or unavailable", "ACCOUNT_DISABLED");
      }
      const session = await createSessionRecord(tx, {
        userId: userRow.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        activeCompanyId: loadedUser.activeCompanyId,
      });
      await writeAuditLog(tx, {
        companyId: loadedUser.activeCompanyId,
        userId: loadedUser.id,
        userName: loadedUser.name,
        userRole: loadedUser.role,
        action: "auth.login",
        entityType: "user",
        entityId: loadedUser.id,
        entityLabel: loadedUser.email,
        ipAddress: req.ip,
      });
      return { authUser: loadedUser, rawToken: session.rawToken };
    });

    setSessionCookie(reply, rawToken);
    return { user: authUser };
  });

  app.post("/api/auth/mfa/verify-login", authRateLimit, async (req, reply) => {
    const parsed = parseOrThrow(mfaVerifyLoginSchema, req.body, "Invalid MFA verification payload");
    const challenge = verifyMfaChallengeToken(parsed.mfaChallengeToken);
    const db = getDb();

    const { authUser, rawToken } = await db.transaction(async (tx) => {
      const [userRow] = await tx
        .select()
        .from(users)
        .where(eq(users.id, challenge.userId))
        .limit(1);

      if (!userRow || !userRow.isActive) {
        throw new AppError(403, "Account inactive or unavailable", "ACCOUNT_DISABLED");
      }

      const mfaResult = await verifyMfaCodeOrRecovery(tx, userRow.id, parsed.code);
      consumeMfaChallengeJti(challenge.jti, challenge.exp);

      await ensureSeededDefaults(tx);
      const primaryCompanyId =
        (await resolvePrimaryCompanyIdForUser(tx, userRow.id)) ?? DEFAULT_COMPANY_ID;
      const loadedUser = await loadAuthUserById(tx, userRow.id, primaryCompanyId);
      if (!loadedUser) {
        throw new AppError(403, "Account inactive or unavailable", "ACCOUNT_DISABLED");
      }

      const session = await createSessionRecord(tx, {
        userId: userRow.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        activeCompanyId: loadedUser.activeCompanyId,
      });

      await writeAuditLog(tx, {
        companyId: loadedUser.activeCompanyId,
        userId: loadedUser.id,
        userName: loadedUser.name,
        userRole: loadedUser.role,
        action: "auth.login",
        entityType: "user",
        entityId: loadedUser.id,
        entityLabel: loadedUser.email,
        details: { mfaMethod: mfaResult.method },
        ipAddress: req.ip,
      });

      return { authUser: loadedUser, rawToken: session.rawToken };
    });

    setSessionCookie(reply, rawToken);
    return { user: authUser };
  });

  app.get("/api/auth/mfa/status", { preHandler: requireAuth }, async (req) => {
    return getMfaStatus(getDb(), req.authUser!.id);
  });

  app.post("/api/auth/mfa/enroll", { preHandler: requireAuth }, async (req) => {
    return enrollMfa(getDb(), req.authUser!, req.ip);
  });

  app.post("/api/auth/mfa/verify", { preHandler: requireAuth }, async (req) => {
    const parsed = parseOrThrow(mfaVerifyEnrollSchema, req.body, "Invalid TOTP verification code");
    return verifyMfaEnrollment(getDb(), req.authUser!, parsed.code, req.ip);
  });

  app.post("/api/auth/mfa/disable", { preHandler: requireAuth }, async (req) => {
    const parsed = parseOrThrow(mfaDisableSchema, req.body, "Invalid MFA disable payload");
    return disableMfa(getDb(), req.authUser!, parsed, req.ip);
  });

  app.post("/api/auth/mfa/recovery-codes", { preHandler: requireAuth }, async (req) => {
    const parsed = parseOrThrow(
      mfaRegenerateRecoveryCodesSchema,
      req.body,
      "Current password or verification code is required."
    );
    return regenerateMfaRecoveryCodes(getDb(), req.authUser!, parsed, req.ip);
  });

  app.post("/api/auth/switch-company", { preHandler: requireAuth }, async (req) => {
    const parsed = parseOrThrow(switchCompanySchema, req.body, "Invalid company switch request");
    const actor = req.authUser!;
    const db = getDb();

    const updatedUser = await db.transaction(async (tx) => {
      const [targetCompany] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, parsed.companyId))
        .limit(1);

      if (!targetCompany) {
        throw new AppError(404, "Company not found", "COMPANY_NOT_FOUND");
      }
      if (!targetCompany.isActive) {
        throw new AppError(400, "Target company is inactive", "COMPANY_INACTIVE");
      }

      const [membership] = await tx
        .select({ id: userCompanies.id })
        .from(userCompanies)
        .where(
          and(
            eq(userCompanies.userId, actor.id),
            eq(userCompanies.companyId, parsed.companyId),
            eq(userCompanies.isActive, true)
          )
        )
        .limit(1);

      const [globalRoleRow] = await tx
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, actor.id))
        .limit(1);

      if (!membership && globalRoleRow?.role !== "admin") {
        throw new AppError(403, "You do not have access to this company", "FORBIDDEN");
      }

      if (req.authSessionId) {
        let shouldClearTerminal = false;
        if (req.posTerminalId) {
          const [termBranch] = await tx
            .select({ companyId: branches.companyId })
            .from(posTerminals)
            .innerJoin(branches, eq(branches.id, posTerminals.branchId))
            .where(eq(posTerminals.id, req.posTerminalId))
            .limit(1);
          if (!termBranch || termBranch.companyId !== parsed.companyId) {
            shouldClearTerminal = true;
          }
        }

        await tx
          .update(userSessions)
          .set({
            activeCompanyId: parsed.companyId,
            lastActivityAt: new Date(),
            ...(shouldClearTerminal
              ? { posTerminalId: null, activeCashierId: null, isTerminalLocked: false }
              : {}),
          })
          .where(eq(userSessions.id, req.authSessionId));
      }

      await writeAuditLog(tx, {
        companyId: parsed.companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "auth.company_switched",
        entityType: "company",
        entityId: parsed.companyId,
        entityLabel: targetCompany.code,
        before: { activeCompanyId: actor.activeCompanyId },
        after: { activeCompanyId: parsed.companyId },
        ipAddress: req.ip,
      });

      const reloaded = await loadAuthUserById(tx, actor.id, parsed.companyId);
      if (!reloaded) {
        throw new AppError(500, "Failed to reload switched company context", "INTERNAL_ERROR");
      }
      return reloaded;
    });

    return { user: updatedUser };
  });

  app.get("/api/auth/sessions", { preHandler: requireAuth }, async (req) => {
    const actor = req.authUser!;
    const db = getDb();
    const now = new Date();

    const rows = await db
      .select({
        id: userSessions.id,
        ipAddress: userSessions.ipAddress,
        userAgent: userSessions.userAgent,
        activeCompanyId: userSessions.activeCompanyId,
        lastActivityAt: userSessions.lastActivityAt,
        createdAt: userSessions.createdAt,
        expiresAt: userSessions.expiresAt,
        posTerminalId: userSessions.posTerminalId,
      })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, actor.id),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now)
        )
      )
      .orderBy(desc(userSessions.lastActivityAt));

    const sessions: ActiveSessionDto[] = rows.map((row) => ({
      id: row.id,
      ipAddress: row.ipAddress ?? null,
      userAgent: row.userAgent ?? null,
      activeCompanyId: row.activeCompanyId ?? null,
      lastActivityAt: row.lastActivityAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: row.id === req.authSessionId,
      isTerminalBound: Boolean(row.posTerminalId),
    }));

    return { sessions };
  });

  app.delete("/api/auth/sessions/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = parseOrThrow(sessionIdParamSchema, req.params, "Invalid session ID");
    const actor = req.authUser!;
    const db = getDb();
    const now = new Date();

    await db.transaction(async (tx) => {
      const revoked = await tx
        .update(userSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(userSessions.id, id),
            eq(userSessions.userId, actor.id),
            isNull(userSessions.revokedAt)
          )
        )
        .returning({ id: userSessions.id });

      if (revoked.length === 0) {
        throw new AppError(404, "Session not found", "SESSION_NOT_FOUND");
      }

      await writeAuditLog(tx, {
        companyId: actor.activeCompanyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "auth.session_revoked",
        entityType: "user_session",
        entityId: id,
        details: { revokedCurrent: id === req.authSessionId },
        ipAddress: req.ip,
      });
    });

    const revokedCurrent = id === req.authSessionId;
    if (revokedCurrent) {
      clearSessionCookie(reply);
    }

    return { ok: true, revokedCurrent };
  });

  app.post("/api/auth/sessions/revoke-others", { preHandler: requireAuth }, async (req) => {
    const actor = req.authUser!;
    const db = getDb();

    if (!req.authSessionId) {
      return { ok: true, revokedCount: 0 };
    }

    const revokedCount = await db.transaction(async (tx) => {
      const revoked = await tx
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(userSessions.userId, actor.id),
            ne(userSessions.id, req.authSessionId!),
            isNull(userSessions.revokedAt)
          )
        )
        .returning({ id: userSessions.id });

      await writeAuditLog(tx, {
        companyId: actor.activeCompanyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "auth.other_sessions_revoked",
        entityType: "user_session",
        entityId: req.authSessionId!,
        details: { revokedCount: revoked.length },
        ipAddress: req.ip,
      });

      return revoked.length;
    });

    return { ok: true, revokedCount };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.[env.SESSION_COOKIE_NAME];
    await revokeSessionByToken(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/change-password", { preHandler: requireAuth }, async (req) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid password payload", "VALIDATION_ERROR");
    }

    const authUser = req.authUser!;
    const db = getDb();

    await db.transaction(async (tx) => {
      const [userRow] = await tx.select().from(users).where(eq(users.id, authUser.id)).limit(1);
      if (!userRow) {
        throw new AppError(404, "User account not found", "NOT_FOUND");
      }

      const ok = await verifyPassword(parsed.data.currentPassword, userRow.passwordHash);
      if (!ok) {
        throw new AppError(400, "Current password is incorrect", "INVALID_PASSWORD");
      }

      const newHash = await hashPassword(parsed.data.newPassword);
      await tx
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, authUser.id));

      if (req.authSessionId) {
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(userSessions.userId, authUser.id),
              ne(userSessions.id, req.authSessionId),
              isNull(userSessions.revokedAt)
            )
          );
      }

      await writeAuditLog(tx, {
        companyId: authUser.activeCompanyId,
        userId: authUser.id,
        userName: authUser.name,
        userRole: authUser.role,
        action: "auth.password_changed",
        entityType: "user",
        entityId: authUser.id,
        entityLabel: authUser.email,
        ipAddress: req.ip,
      });
    });

    return { ok: true };
  });

  app.post("/api/auth/forgot-password", authRateLimit, async (req) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Valid email is required", "VALIDATION_ERROR");
    }

    const db = getDb();
    const [userRow] = await db
      .select({ id: users.id, email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);

    if (userRow && userRow.isActive) {
      const rawToken = generateOpaqueToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await db.insert(passwordResetTokens).values({
        userId: userRow.id,
        tokenHash,
        expiresAt,
      });

      const emailRes = await sendPasswordResetEmail(userRow.email, rawToken);
      req.log.info(
        { userId: userRow.id, emailSent: emailRes.sent, skippedReason: emailRes.skippedReason ?? null },
        "auth.password_reset_requested"
      );
    }

    return {
      ok: true,
      message: "If an active account exists for that email, a password reset token has been generated.",
    };
  });

  app.post("/api/auth/reset-password", authRateLimit, async (req) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid reset request", "VALIDATION_ERROR");
    }

    const db = getDb();
    const tokenHash = hashToken(parsed.data.token);

    await db.transaction(async (tx) => {
      const [tokenRow] = await tx
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!tokenRow) {
        throw new AppError(400, "Reset token is invalid or has expired", "INVALID_RESET_TOKEN");
      }

      const [userRow] = await tx.select().from(users).where(eq(users.id, tokenRow.userId)).limit(1);
      if (!userRow) {
        throw new AppError(404, "User account not found", "NOT_FOUND");
      }

      const newHash = await hashPassword(parsed.data.newPassword);
      await tx
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, userRow.id));

      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, tokenRow.id));

      await tx
        .update(userSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(userSessions.userId, userRow.id), isNull(userSessions.revokedAt)));

      await writeAuditLog(tx, {
        userId: userRow.id,
        userName: userRow.name,
        action: "auth.password_reset",
        entityType: "user",
        entityId: userRow.id,
        entityLabel: userRow.email,
        ipAddress: req.ip,
      });
    });

    return { ok: true };
  });
}
