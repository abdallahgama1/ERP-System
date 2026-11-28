#!/usr/bin/env node
/**
 * Create a new Admin user, promote an existing user to Admin, or reset an Admin's password.
 *
 * Security invariants:
 * - NEVER accepts --password on the command line (argv leaks to `ps` and shell history).
 *   Password is supplied via interactive hidden TTY prompt, --password-stdin, or ADMIN_PASSWORD env var.
 * - Refuses to run against a production or non-local DATABASE_URL unless --allow-production is passed.
 * - Records every change inside the tamper-evident SHA-256 `audit_logs` hash chain.
 * - NEVER prints any password, hash, token, or database credential to stdout/stderr.
 *
 * Usage:
 *   npm run admin:create -- --email admin@co.eg --name "Mohamed"
 *   printf '%s\n' "$SECRET" | npm run admin:create -- --email admin@co.eg --password-stdin
 *   npm run admin:create -- --email existing@co.eg
 *   npm run admin:create -- --email admin@co.eg --reset-password
 *   npm run admin:create -- --env-file /opt/count-it-keep-it/.env --allow-production --email admin@co.eg
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a.startsWith("--password=")) {
      opts.unsafeCliPassword = true;
    } else if (a === "--password") {
      opts.unsafeCliPassword = true;
    } else if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      if (eqIdx > 2) {
        opts[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else {
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
  }
  return opts;
}

export function isProductionOrRemoteDbUrl(databaseUrl, nodeEnv = process.env.NODE_ENV) {
  if (String(nodeEnv ?? "").toLowerCase() === "production") return true;
  if (!databaseUrl) return false;
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname.toLowerCase();
    const isLocalHost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "postgres" ||
      host === "db";
    return !isLocalHost;
  } catch {
    return true;
  }
}

export function assertSafeDatabaseTarget({
  databaseUrl = process.env.DATABASE_URL ?? "",
  allowProduction = false,
  nodeEnv = process.env.NODE_ENV ?? "",
} = {}) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (configure backend/.env or pass --env-file <path>).");
  }
  if (isProductionOrRemoteDbUrl(databaseUrl, nodeEnv) && !allowProduction) {
    throw new Error(
      "Refusing to run admin:create against a production or non-local DATABASE_URL without --allow-production. " +
        "Verify the target database and re-run with --allow-production."
    );
  }
}

export function assertNoUnsafeCliPassword(opts) {
  if (opts?.unsafeCliPassword) {
    throw new Error(
      "Passing --password on the command line is unsafe (it leaks to shell history and process listings). " +
        "Provide the password via interactive TTY prompt, --password-stdin, or the ADMIN_PASSWORD environment variable."
    );
  }
}

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  return firstLine;
}

async function promptHiddenPassword(label) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Interactive password prompt requires a TTY. In non-interactive shells, pipe the password with --password-stdin or set ADMIN_PASSWORD."
    );
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stderr = process.stderr;
    stderr.write(label);
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
    };

    const onData = (buf) => {
      const str = buf.toString("utf8");
      for (const ch of str) {
        if (ch === "\u0003") {
          cleanup();
          stderr.write("\n");
          reject(new Error("Aborted by user."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function resolveInteractiveOrStdinPassword({ passwordStdin = false, envPassword = "" } = {}) {
  if (passwordStdin) {
    const stdinPw = await readPasswordFromStdin();
    if (!stdinPw) {
      throw new Error("--password-stdin was specified, but stdin was empty.");
    }
    return stdinPw;
  }
  if (envPassword) {
    return envPassword;
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const first = await promptHiddenPassword("Enter admin password (min 8 chars): ");
    const confirm = await promptHiddenPassword("Confirm admin password: ");
    if (first !== confirm) {
      throw new Error("Passwords do not match.");
    }
    return first;
  }
  return "";
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
        if (!explicitPassword) {
          throw new Error(
            "A password is required for --reset-password. Supply it via interactive prompt, --password-stdin, or ADMIN_PASSWORD."
          );
        }
        const passwordHash = await hashPassword(explicitPassword);
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
      if (!explicitPassword) {
        throw new Error(
          "A password is required when creating a new admin account. Supply it via interactive prompt, --password-stdin, or ADMIN_PASSWORD."
        );
      }
      const passwordHash = await hashPassword(explicitPassword);
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

    // Never return passwords, hashes, or secrets from this helper
    return {
      userId,
      name: effectiveName,
      email: normalizedEmail,
      role: "admin",
      branchScopeMode: "all",
      action,
      passwordChanged,
    };
  });
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.email && !opts.unsafeCliPassword)) {
    console.log(`Usage:
  npm run admin:create -- --email <email> [--name <name>] [--reset-password] [--password-stdin] [--allow-production] [--env-file <path>] [--json]

Password input (never passed via --password CLI flag):
  - Interactive TTY: prompts securely with masked input
  - Non-interactive: pipe password via --password-stdin or set ADMIN_PASSWORD env var
  - Promoting an existing user without --reset-password keeps their existing password

Examples:
  # Interactive hidden password prompt (local DB):
  npm run admin:create -- --email admin@company.com --name "Company Admin"

  # Pipe password safely via stdin on production VPS:
  printf '%s\\n' "$ADMIN_SECRET" | npm run admin:create -- --env-file /opt/count-it-keep-it/.env --allow-production --email admin@company.com --password-stdin

  # Promote an existing user to admin (keeps their current password):
  npm run admin:create -- --env-file /opt/count-it-keep-it/.env --allow-production --email existing@company.com

  # Reset an admin's password (revokes active sessions):
  npm run admin:create -- --env-file /opt/count-it-keep-it/.env --allow-production --email admin@company.com --reset-password`);
    process.exit(opts.help ? 0 : 1);
  }

  try {
    assertNoUnsafeCliPassword(opts);
  } catch (err) {
    console.error(`[admin:create] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (opts["env-file"]) {
    dotenv.config({ path: path.resolve(process.cwd(), opts["env-file"]) });
  } else if (!process.env.DATABASE_URL) {
    const backendEnv = path.resolve(repoRoot, "backend/.env");
    const rootEnv = path.resolve(repoRoot, ".env");
    if (fs.existsSync(backendEnv)) dotenv.config({ path: backendEnv });
    else if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
  }

  try {
    assertSafeDatabaseTarget({
      databaseUrl: process.env.DATABASE_URL ?? "",
      allowProduction: Boolean(opts["allow-production"]),
      nodeEnv: process.env.NODE_ENV ?? "",
    });
  } catch (err) {
    console.error(`[admin:create] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const unregisterTsx = register();
  (async () => {
    const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
    const { eq } = await import("drizzle-orm");
    const { users } = await import("../backend/drizzle/schema.ts");
    try {
      const normalizedEmail = String(opts.email ?? "").trim().toLowerCase();
      const db = getDb();
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      const needsPassword = !existing || Boolean(opts["reset-password"]) || Boolean(opts["password-stdin"]);
      const suppliedPassword = needsPassword
        ? await resolveInteractiveOrStdinPassword({
            passwordStdin: Boolean(opts["password-stdin"]),
            envPassword: process.env.ADMIN_PASSWORD ?? "",
          })
        : "";

      const result = await createOrPromoteAdmin(db, {
        email: normalizedEmail,
        name: opts.name ?? "",
        password: suppliedPassword,
        resetPassword: Boolean(opts["reset-password"]),
      });

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        console.log(`Admin account ready (${result.action}):`);
        console.log(`  User ID:          ${result.userId}`);
        console.log(`  Name:             ${result.name}`);
        console.log(`  Email:            ${result.email}`);
        console.log(`  Role:             ${result.role} (all branches)`);
        console.log(`  Password updated: ${result.passwordChanged ? "yes (not printed for security)" : "no (unchanged)"}`);
        console.log("");
        console.log("Log in at /login and enable 2FA in Security Settings.");
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
