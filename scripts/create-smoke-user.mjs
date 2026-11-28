#!/usr/bin/env node
/**
 * Provision (or rotate password for) the dedicated least-privilege "Smoke Monitor" user.
 *
 * Why a dedicated smoke user instead of an admin account:
 *   1. Least privilege: baseRole = "user", custom role = "Smoke Monitor" with ZERO
 *      create/edit/delete/approve permissions on all 21 modules, zero branch access
 *      (branchScopeMode = "selected", 0 branches), and middleware-enforced HTTP read-only
 *      (every POST/PUT/PATCH/DELETE except POST /api/auth/logout returns 403 SMOKE_USER_READ_ONLY).
 *   2. Safe MFA exemption: human admin accounts should have TOTP MFA enabled, which breaks
 *      headless POST /api/auth/login automation. Because this service account cannot mutate
 *      any ERP data, cannot manage users/roles/settings/imports, and is still protected by
 *      login rate-limiting, DB-backed lockout, and a high-entropy 32-byte random password
 *      stored in chmod-600 .env, omitting MFA on this read-only monitor account is safe.
 *
 * Usage:
 *   npm run smoke:create-user
 *   npm run smoke:create-user -- --email smoke-monitor@co.eg
 *   npm run smoke:create-user -- --email smoke-monitor@co.eg --rotate-password
 *   npm run smoke:create-user -- --env-file /opt/count-it-keep-it/.env --json
 */
import { randomBytes } from "node:crypto";
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

export async function provisionSmokeUser(
  db,
  {
    email = "smoke-monitor@internal.local",
    name = "Smoke Monitor",
    password = "",
    rotatePassword = false,
  } = {}
) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new Error("A valid email address is required for the smoke monitor user.");
  }

  const { and, eq } = await import("drizzle-orm");
  const { PERMISSION_MODULES, SMOKE_MONITOR_PERMISSIONS, SMOKE_MONITOR_ROLE_NAME } = await import(
    "../packages/shared/src/permissions.ts"
  );
  const {
    DEFAULT_COMPANY_ID,
    customRolePermissions,
    customRoles,
    userBranchScopes,
    userBranches,
    userCompanies,
    userMfa,
    userRoles,
    users,
    userSessions,
  } = await import("../backend/drizzle/schema.ts");
  const { hashPassword } = await import("../backend/src/auth/password.ts");
  const { ensureSeededDefaults } = await import("../backend/src/auth/permissions.ts");
  const { writeAuditLog } = await import("../backend/src/db/helpers.ts");

  const generatedPassword = password ? String(password) : randomBytes(32).toString("base64url");
  if (generatedPassword.length < 16) {
    throw new Error("Smoke monitor password must be at least 16 characters long.");
  }

  return db.transaction(async (tx) => {
    await ensureSeededDefaults(tx);

    // 1. Ensure the dedicated system custom role "Smoke Monitor" exists with strictly read-only perms
    let [smokeRole] = await tx
      .select()
      .from(customRoles)
      .where(
        and(
          eq(customRoles.companyId, DEFAULT_COMPANY_ID),
          eq(customRoles.name, SMOKE_MONITOR_ROLE_NAME)
        )
      )
      .limit(1);

    if (!smokeRole) {
      [smokeRole] = await tx
        .insert(customRoles)
        .values({
          companyId: DEFAULT_COMPANY_ID,
          name: SMOKE_MONITOR_ROLE_NAME,
          description:
            "Least-privilege strictly read-only service role for post-deploy smoke verification (reconciliation, setup health, audit chain, backup freshness). MFA-exempt by design; all mutating API methods are blocked.",
          baseRole: "user",
          isSystem: true,
          isActive: true,
        })
        .returning();
    } else {
      await tx
        .update(customRoles)
        .set({
          baseRole: "user",
          isSystem: true,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(customRoles.id, smokeRole.id));
    }

    for (const mod of PERMISSION_MODULES) {
      const perm = SMOKE_MONITOR_PERMISSIONS[mod];
      await tx
        .insert(customRolePermissions)
        .values({
          customRoleId: smokeRole.id,
          module: mod,
          canView: perm.view,
          canCreate: false,
          canEdit: false,
          canDelete: false,
          canApprove: false,
        })
        .onConflictDoUpdate({
          target: [customRolePermissions.customRoleId, customRolePermissions.module],
          set: {
            canView: perm.view,
            canCreate: false,
            canEdit: false,
            canDelete: false,
            canApprove: false,
          },
        });
    }

    // 2. Check existing user and refuse to hijack an admin or manager account
    const [existingUser] = await tx
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    let userId;
    let action;
    let passwordChanged = false;

    if (existingUser) {
      const [existingGlobalRole] = await tx
        .select({ role: userRoles.role, customRoleId: userRoles.customRoleId })
        .from(userRoles)
        .where(eq(userRoles.userId, existingUser.id))
        .limit(1);
      if (existingGlobalRole?.role === "admin") {
        throw new Error(
          `Refusing to convert existing admin account '${normalizedEmail}' into a smoke user. Choose a dedicated email such as smoke-monitor@internal.local.`
        );
      }
      userId = existingUser.id;
      const shouldUpdatePassword = Boolean(rotatePassword || password);
      if (shouldUpdatePassword) {
        const passwordHash = await hashPassword(generatedPassword);
        await tx
          .update(users)
          .set({
            name,
            passwordHash,
            isActive: true,
            emailVerified: true,
            defaultBranchId: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        await tx
          .update(userSessions)
          .set({ revokedAt: new Date() })
          .where(eq(userSessions.userId, userId));
        passwordChanged = true;
        action = "smoke_user.password_rotated";
      } else {
        await tx
          .update(users)
          .set({
            name,
            isActive: true,
            emailVerified: true,
            defaultBranchId: null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        action = "smoke_user.verified";
      }
    } else {
      const passwordHash = await hashPassword(generatedPassword);
      const [created] = await tx
        .insert(users)
        .values({
          name,
          email: normalizedEmail,
          passwordHash,
          emailVerified: true,
          isActive: true,
          defaultBranchId: null,
        })
        .returning({ id: users.id });
      userId = created.id;
      passwordChanged = true;
      action = "smoke_user.created";
    }

    // 3. Enforce strict least-privilege bindings: user role + Smoke Monitor custom role + zero branches + MFA disabled
    await tx
      .insert(userRoles)
      .values({ userId, role: "user", customRoleId: smokeRole.id })
      .onConflictDoUpdate({
        target: userRoles.userId,
        set: { role: "user", customRoleId: smokeRole.id, updatedAt: new Date() },
      });

    await tx
      .insert(userCompanies)
      .values({
        userId,
        companyId: DEFAULT_COMPANY_ID,
        role: "user",
        customRoleId: smokeRole.id,
        isDefault: true,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [userCompanies.userId, userCompanies.companyId],
        set: {
          role: "user",
          customRoleId: smokeRole.id,
          isDefault: true,
          isActive: true,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(userBranchScopes)
      .values({ userId, scopeMode: "selected" })
      .onConflictDoUpdate({
        target: userBranchScopes.userId,
        set: { scopeMode: "selected", updatedAt: new Date() },
      });

    await tx.delete(userBranches).where(eq(userBranches.userId, userId));
    await tx.delete(userMfa).where(eq(userMfa.userId, userId));

    await writeAuditLog(tx, {
      companyId: DEFAULT_COMPANY_ID,
      userId,
      userName: "system:create-smoke-user",
      userRole: "system",
      action,
      entityType: "user",
      entityId: userId,
      entityLabel: normalizedEmail,
      details: {
        customRole: SMOKE_MONITOR_ROLE_NAME,
        baseRole: "user",
        readOnly: true,
        mfaExempt: true,
        passwordChanged,
      },
    });

    return {
      userId,
      email: normalizedEmail,
      role: "user",
      customRoleId: smokeRole.id,
      customRoleName: SMOKE_MONITOR_ROLE_NAME,
      action,
      passwordChanged,
      password: passwordChanged ? generatedPassword : null,
    };
  });
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage:
  npm run smoke:create-user -- [--email <email>] [--password <pass>] [--rotate-password] [--env-file <path>] [--json]`);
    process.exit(0);
  }

  const envPath = opts["env-file"]
    ? path.resolve(process.cwd(), opts["env-file"])
    : path.resolve(repoRoot, "backend/.env");
  dotenv.config({ path: envPath });

  const unregisterTsx = register();
  (async () => {
    const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
    try {
      const result = await provisionSmokeUser(getDb(), {
        email: opts.email ?? process.env.SMOKE_USER_EMAIL ?? "smoke-monitor@internal.local",
        password: opts.password ?? process.env.SMOKE_USER_PASSWORD ?? "",
        rotatePassword: Boolean(opts["rotate-password"]),
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        console.log(`Smoke monitor user ready (${result.action}):`);
        console.log(`  User ID:     ${result.userId}`);
        console.log(`  Email:       ${result.email}`);
        console.log(`  Role:        ${result.role} (${result.customRoleName}, strictly read-only, MFA-exempt)`);
        if (result.password) {
          console.log("");
          console.log("Add these lines to your chmod-600 .env file (not committed to git):");
          console.log(`  SMOKE_USER_EMAIL=${result.email}`);
          console.log(`  SMOKE_USER_PASSWORD=${result.password}`);
        } else {
          console.log("  Password:    (unchanged; pass --rotate-password to generate a new password)");
        }
      }
    } finally {
      await closeDatabase().catch(() => {});
      unregisterTsx();
    }
  })().catch((err) => {
    console.error(`[create-smoke-user] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
