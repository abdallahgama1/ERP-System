import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  passwordResetTokens,
  userBranches,
  userBranchScopes,
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
  revokeSessionByToken,
  setSessionCookie,
} from "../auth/sessions.ts";
import { env } from "../config.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";

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
  app.get("/api/auth/me", async (req) => {
    return { user: req.authUser ?? null };
  });

  app.post("/api/auth/signup", async (req, reply) => {
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
      });

      await writeAuditLog(tx, {
        userId: createdUser.id,
        userName: name,
        userRole: role,
        action: "auth.signup",
        entityType: "user",
        entityId: createdUser.id,
        entityLabel: email,
        details: { firstUserBootstrap: isFirstUser },
        ipAddress: req.ip,
      });

      const authUser = await loadAuthUserById(tx, createdUser.id);
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

  app.post("/api/auth/login", async (req, reply) => {
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

    const { authUser, rawToken } = await db.transaction(async (tx) => {
      await ensureSeededDefaults(tx);
      const loadedUser = await loadAuthUserById(tx, userRow.id);
      if (!loadedUser) {
        throw new AppError(403, "Account inactive or unavailable", "ACCOUNT_DISABLED");
      }
      const session = await createSessionRecord(tx, {
        userId: userRow.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
      await writeAuditLog(tx, {
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

  app.post("/api/auth/forgot-password", async (req) => {
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

      if (env.NODE_ENV !== "production") {
        app.log.info(`[AUTH] Password reset URL for ${userRow.email}: /reset-password?token=${rawToken}`);
      }
    }

    return {
      ok: true,
      message: "If an active account exists for that email, a password reset token has been generated.",
    };
  });

  app.post("/api/auth/reset-password", async (req) => {
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
