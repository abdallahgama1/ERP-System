#!/usr/bin/env node
/**
 * MFA Encryption Key Rotation CLI
 *
 * Re-encrypts all `user_mfa` TOTP secrets from older key versions to the active
 * MFA_ENCRYPTION_KEY / MFA_ENCRYPTION_KEY_VERSION inside a single transaction.
 *
 * Required env vars:
 *   DATABASE_URL                  PostgreSQL connection string (or backend/.env)
 *   MFA_ENCRYPTION_KEY            New 32-byte hex or base64 key
 *   MFA_ENCRYPTION_KEY_VERSION    New integer key version (e.g. 2)
 *   MFA_ENCRYPTION_PREVIOUS_KEYS  Previous key(s) as '1:<hex>' or JSON '{"1":"<hex>"}'
 *
 * Usage:
 *   npm run mfa:rotate-key -- --dry-run
 *   npm run mfa:rotate-key
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

dotenv.config({ path: path.resolve(repoRoot, "backend/.env") });

const dryRun = process.argv.includes("--dry-run");
const unregisterTsx = register();

async function main() {
  const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
  const { rotateMfaEncryptionKeys } = await import("../backend/src/services/mfa.service.ts");

  try {
    const db = getDb();
    const result = await rotateMfaEncryptionKeys(db, { dryRun });
    console.log(
      JSON.stringify({
        ok: true,
        ...result,
      })
    );
  } finally {
    await closeDatabase().catch(() => {});
    unregisterTsx();
  }
}

main().catch((err) => {
  console.error("MFA key rotation failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
