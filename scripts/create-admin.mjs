#!/usr/bin/env node
/**
 * Create a new Admin user, promote an existing user to Admin, or reset an Admin's password.
 *
 * Works safely on both a brand-new empty database (runs ensureSeededDefaults inside a transaction)
 * and an existing production/development database, while keeping the tamper-evident audit hash chain valid.
 *
 * Usage:
 *   npm run admin:create -- --email admin@co.eg
 *   npm run admin:create -- --email admin@co.eg --name "Mohamed" --password "StrongPassword123!"
 *   npm run admin:create -- --email existing@co.eg --promote
 *   npm run admin:create -- --email admin@co.eg --reset-password
 *   npm run admin:create -- --env-file /opt/count-it-keep-it/.env --email admin@co.eg --json
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        opts[k] = true;
      } else {
        opts[k] = next;
        i += 1;
      }
    }
  }
  return opts;
}

export async function createOrPromoteAdmin(
  db,
  {
    email,
    name = "",
    password = "",
    resetPassword = false,
  } = {}
) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("A valid --email address is required (e.g. --email admin@company.com).");
  }

  const { and, eq, isNull } = await import("drizzle-orm");
  const { SMOKE_MONITOR_ROLE_NAME } = await import("../packages/shared/src/permissions.ts");
  const {
    DEFAULT_COMPANY_ID,
    customRoles,
    userBranchScopes,
    userBranches,
    userCompanies,
    userRoles,
    users,
    userSessions,
  } = await import("../backend/drizzle/schema.ts");
  const { hashPassword } = await import("../backend/src/auth/password.ts");
  const { ensureSeededDefaults } = await import("../backend/src/auth/permissions.ts");
  const { writeAuditLog } = await import("../backend/src/db/helpers.ts");

  const explicitPassword = String(password ?? "");
  if (explicitPassword && explicitPassword.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  if (explicitPassword.length > 128) {
    throw new Error("Password must be at most 128 characters long.");
  }

  const resolvedName = String(name ?? "").trim() || normalizedEmail.split("@")[0] || "Administrator";

  return db.transaction(async (tx) => {
    const defaultBranchId = await ensureSeededDefaults(tx);

    const [adminCustomRole] = await tx
      .select({ id: customRoles.id })
      .from(customRoles)
      .where(and(eq(customRoles.companyId, DEFAULT_COMPANY_ID), eq(customRoles.name, "Admin")))
      .limit(1);
    const adminCustomRoleId = adminCustomRole?.id ?? null;

    const [existingUser] = await tx
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    let userId;
    let action;
    let passwordChanged = false;
    let finalPassword = null;
    let effectiveName = resolvedName;

    if (existingUser) {
      // Refuse to elevate the dedicated read-only Smoke Monitor service account
      const [existingRole] = await tx
        .select({
          role: userRoles.role,
          customRoleName: customRoles.name,
        })
        .from(userRoles)
        .leftJoin(customRoles, eq(customRoles.id, userRoles.customRoleId))
        .where(eq(userRoles.userId, existingUser.id))
        .limit(1);

      if (existingRole?.customRoleName === SMOKE_MONITOR_ROLE_NAME) {
        throw new Error(
          `Refusing to promote dedicated read-only '${SMOKE_MONITOR_ROLE_NAME}' account '${normalizedEmail}' to admin.`
        );
      }

      userId = existingUser.id;
      effectiveName = String(name ?? "").trim() || existingUser.name;
      const shouldSetPassword = Boolean(explicitPassword || resetPassword);

      if (shouldSetPassword) {
        finalPassword = explicitPassword || randomBytes(18).toString("base64url");
        const passwordHash = await hashPassword(finalPassword);
        await tx
          .update(users)
          .set({
            name: effectiveName,
            passwordHash,
            isActive: true,
            emailVerified: true,
            defaultBranchId: existingUser.defaultBranchId ?? defaultBranchId,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        // Revoke existing sessions on password reset for security
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
        passwordChanged = true;
        action = existingRole?.role === "admin" ? "admin.password_reset" : "admin.promoted";
      } else {
        await tx
          .update(users)
          .set({
            name: effectiveName,
            isActive: true,
            emailVerified: true,
            defaultBranchId: existingUser.defaultBranchId ?? defaultBranchId,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        action = existingRole?.role === "admin" ? "admin.verified" : "admin.promoted";
      }
    } else {
      finalPassword = explicitPassword || randomBytes(18).toString("base64url");
      const passwordHash = await hashPassword(finalPassword);
      const [created] = await tx
        .insert(users)
        .values({
          name: effectiveName,
          email: normalizedEmail,
          passwordHash,
          emailVerified: true,
          isActive: true,
          defaultBranchId,
        })
        .returning({ id: users.id });
      userId = created.id;
      passwordChanged = true;
      action = "admin.created";
    }

    const now = new Date();
    await tx
      .insert(userRoles)
      .values({ userId, role: "admin", customRoleId: adminCustomRoleId })
      .onConflictDoUpdate({
        target: userRoles.userId,
        set: { role: "admin", customRoleId: adminCustomRoleId, updatedAt: now },
      });

    await tx
      .insert(userCompanies)
      .values({
        userId,
        companyId: DEFAULT_COMPANY_ID,
        role: "admin",
        customRoleId: adminCustomRoleId,
        isDefault: true,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [userCompanies.userId, userCompanies.companyId],
        set: {
          role: "admin",
          customRoleId: adminCustomRoleId,
          isActive: true,
          updatedAt: now,
        },
      });

    await tx
      .insert(userBranchScopes)
      .values({ userId, scopeMode: "all" })
      .onConflictDoUpdate({
        target: userBranchScopes.userId,
        set: { scopeMode: "all", updatedAt: now },
      });

    await tx
      .insert(userBranches)
      .values({
        userId,
        branchId: defaultBranchId,
        isDefault: true,
      })
      .onConflictDoNothing();

    await writeAuditLog(tx, {
      companyId: DEFAULT_COMPANY_ID,
      userId,
      userName: "system:admin-create",
      userRole: "system",
      action,
      entityType: "user",
      entityId: userId,
      entityLabel: normalizedEmail,
      details: {
        role: "admin",
        branchScopeMode: "all",
        passwordChanged,
      },
    });

    return {
      userId,
      name: effectiveName,
      email: normalizedEmail,
      role: "admin",
      branchScopeMode: "all",
      action,
      passwordChanged,
      password: passwordChanged ? finalPassword : null,
    };
  });
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.email) {
    console.log(`Usage:
  npm run admin:create -- --email <email> [--name <name>] [--password <pass>] [--reset-password] [--env-file <path>] [--json]

Examples:
  # Create a new admin with an auto-generated strong password:
  npm run admin:create -- --email admin@company.com --name "Company Admin"

  # Promote an existing user to admin (keeps their current password):
  npm run admin:create -- --email existing@company.com

  # Reset an admin's password (revokes active sessions):
  npm run admin:create -- --email admin@company.com --reset-password`);
    process.exit(opts.help ? 0 : 1);
  }

  if (opts["env-file"]) {
    dotenv.config({ path: path.resolve(process.cwd(), opts["env-file"]) });
  } else {
    const backendEnv = path.resolve(repoRoot, "backend/.env");
    const rootEnv = path.resolve(repoRoot, ".env");
    if (fs.existsSync(backendEnv)) dotenv.config({ path: backendEnv });
    else if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
  }

  const unregisterTsx = register();
  (async () => {
    const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
    try {
      const result = await createOrPromoteAdmin(getDb(), {
        email: opts.email,
        name: opts.name ?? "",
        password: opts.password ?? "",
        resetPassword: Boolean(opts["reset-password"]),
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        console.log(`Admin account ready (${result.action}):`);
        console.log(`  User ID:      ${result.userId}`);
        console.log(`  Name:         ${result.name}`);
        console.log(`  Email:        ${result.email}`);
        console.log(`  Role:         ${result.role} (all branches)`);
        if (result.password) {
          console.log(`  Password:     ${result.password}`);
          console.log("");
          console.log("Log in at /login with this email & password, then enable 2FA in Security Settings.");
        } else {
          console.log("  Password:     (unchanged; pass --reset-password to generate a new password)");
        }
      }
    } finally {
      await closeDatabase().catch(() => {});
      unregisterTsx();
    }
  })().catch((err) => {
    console.error(`[admin:create] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
