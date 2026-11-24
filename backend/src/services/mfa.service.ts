import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { MfaEnrollResponseDto, MfaStatusDto } from "@erp/shared";
import { eq, sql } from "drizzle-orm";
import { userMfa, users } from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { verifyPassword } from "../auth/password.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { env, resolveMfaKeyRing } from "../config.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_CHAR_TO_VAL = new Map<string, number>(
  BASE32_ALPHABET.split("").map((ch, idx) => [ch, idx])
);

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = "Count It Keep It ERP";
const MFA_CHALLENGE_TTL_SECONDS = 300;

const consumedChallengeJtis = new Map<string, number>();

function sweepExpiredChallengeJtis(nowSec: number): void {
  for (const [jti, exp] of consumedChallengeJtis.entries()) {
    if (exp <= nowSec) {
      consumedChallengeJtis.delete(jti);
    }
  }
}

export function resetConsumedMfaChallenges(): void {
  consumedChallengeJtis.clear();
}

export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input: string): Buffer {
  const cleaned = input.replace(/[\s-]+/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) {
    throw new AppError(400, "Base32 secret cannot be empty", "INVALID_BASE32");
  }
  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    throw new AppError(400, "Invalid Base32 character in TOTP secret", "INVALID_BASE32");
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const val = BASE32_CHAR_TO_VAL.get(cleaned[i]!);
    if (val === undefined) {
      throw new AppError(400, "Invalid Base32 character in TOTP secret", "INVALID_BASE32");
    }
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotp(
  secretBase32: string,
  timestampMs = Date.now(),
  stepOffset = 0
): string {
  const key = decodeBase32(secretBase32);
  const counter = BigInt(Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS) + stepOffset);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binaryCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binaryCode % Math.pow(10, TOTP_DIGITS);
  return String(otp).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  timestampMs = Date.now(),
  windowSteps = 1
): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return false;
  }

  const providedBuf = Buffer.from(trimmed, "utf8");
  let matched = false;

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidate = generateTotp(secretBase32, timestampMs, offset);
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length === providedBuf.length && timingSafeEqual(candidateBuf, providedBuf)) {
      matched = true;
    }
  }

  return matched;
}

export function buildOtpAuthUrl(email: string, secretBase32: string, issuer = TOTP_ISSUER): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secretBase32}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export function maskTotpSecret(secretBase32: string): string {
  if (secretBase32.length <= 8) {
    return "••••••••";
  }
  return `${secretBase32.slice(0, 4)}••••••••${secretBase32.slice(-4)}`;
}

export function encryptMfaSecretWithKey(plaintextSecret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextSecret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function encryptMfaSecretWithVersion(plaintextSecret: string): {
  ciphertext: string;
  keyVersion: number;
} {
  const ring = resolveMfaKeyRing();
  return {
    ciphertext: encryptMfaSecretWithKey(plaintextSecret, ring.currentKey),
    keyVersion: ring.currentVersion,
  };
}

export function encryptMfaSecret(plaintextSecret: string): string {
  return encryptMfaSecretWithVersion(plaintextSecret).ciphertext;
}

function decryptWithKey(iv: Buffer, tag: Buffer, ciphertext: Buffer, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

export function decryptMfaSecret(payload: string, keyVersion?: number): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new AppError(500, "Malformed encrypted MFA secret payload", "INVALID_MFA_CIPHERTEXT");
  }

  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ciphertext = Buffer.from(parts[3]!, "base64");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new AppError(500, "Invalid MFA ciphertext metadata", "INVALID_MFA_CIPHERTEXT");
  }

  const ring = resolveMfaKeyRing();

  if (keyVersion !== undefined) {
    const exactKey = ring.keys.get(keyVersion);
    if (!exactKey) {
      throw new AppError(
        500,
        `MFA encryption key version ${keyVersion} is not configured in the active key ring`,
        "MFA_KEY_VERSION_MISSING"
      );
    }
    try {
      return decryptWithKey(iv, tag, ciphertext, exactKey);
    } catch {
      throw new AppError(500, "Failed to decrypt MFA secret with configured key", "MFA_DECRYPTION_FAILED");
    }
  }

  // When no explicit keyVersion is provided, try current key first then any previous keys
  const orderedKeys: Buffer[] = [ring.currentKey];
  for (const [ver, key] of Array.from(ring.keys.entries()).sort((a, b) => b[0] - a[0])) {
    if (ver !== ring.currentVersion) {
      orderedKeys.push(key);
    }
  }

  for (const key of orderedKeys) {
    try {
      return decryptWithKey(iv, tag, ciphertext, key);
    } catch {
      // try next key in ring
    }
  }

  throw new AppError(500, "Failed to decrypt MFA secret with configured key ring", "MFA_DECRYPTION_FAILED");
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, "");
}

export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const raw = randomBytes(4).toString("hex").toUpperCase();
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return Array.from(codes);
}

export function verifyAndConsumeRecoveryCodeFromHashes(
  hashes: string[],
  code: string
): { matched: boolean; remainingHashes: string[] } {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 6) {
    return { matched: false, remainingHashes: hashes };
  }

  const candidateBuf = Buffer.from(hashRecoveryCode(normalized), "hex");
  let matchedIndex = -1;

  for (let i = 0; i < hashes.length; i++) {
    const storedHex = hashes[i];
    if (!storedHex || !/^[0-9a-f]{64}$/i.test(storedHex)) continue;
    const storedBuf = Buffer.from(storedHex, "hex");
    if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
      matchedIndex = i;
    }
  }

  if (matchedIndex === -1) {
    return { matched: false, remainingHashes: hashes };
  }

  return {
    matched: true,
    remainingHashes: hashes.filter((_, idx) => idx !== matchedIndex),
  };
}

function resolveChallengeSigningKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env.AUTH_COOKIE_SECRET, "utf8"),
      Buffer.from("count-it-keep-it-mfa-challenge-v1", "utf8"),
      Buffer.from("mfa-login-challenge", "utf8"),
      32
    )
  );
}

export interface MfaChallengePayload {
  sub: string;
  purpose: "mfa_login";
  jti: string;
  iat: number;
  exp: number;
}

export function createMfaChallengeToken(
  userId: string,
  ttlSeconds = MFA_CHALLENGE_TTL_SECONDS,
  nowMs = Date.now()
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: MfaChallengePayload = {
    sub: userId,
    purpose: "mfa_login",
    jti: randomUUID(),
    iat,
    exp: iat + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", resolveChallengeSigningKey())
    .update(encodedPayload, "utf8")
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyMfaChallengeToken(
  token: string,
  nowMs = Date.now()
): { userId: string; jti: string; exp: number } {
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(401, "Invalid MFA challenge token", "INVALID_MFA_CHALLENGE");
  }

  const [encodedPayload, providedSig] = parts;
  const expectedSig = createHmac("sha256", resolveChallengeSigningKey())
    .update(encodedPayload, "utf8")
    .digest("base64url");

  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    throw new AppError(401, "Invalid MFA challenge token", "INVALID_MFA_CHALLENGE");
  }

  let parsed: Partial<MfaChallengePayload>;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<MfaChallengePayload>;
  } catch {
    throw new AppError(401, "Malformed MFA challenge token", "INVALID_MFA_CHALLENGE");
  }

  if (
    parsed.purpose !== "mfa_login" ||
    typeof parsed.sub !== "string" ||
    typeof parsed.jti !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new AppError(401, "Invalid MFA challenge token claims", "INVALID_MFA_CHALLENGE");
  }

  const nowSec = Math.floor(nowMs / 1000);
  sweepExpiredChallengeJtis(nowSec);

  if (parsed.exp <= nowSec) {
    throw new AppError(401, "MFA challenge token has expired", "MFA_CHALLENGE_EXPIRED");
  }

  if (consumedChallengeJtis.has(parsed.jti)) {
    throw new AppError(401, "MFA challenge token has already been used", "MFA_CHALLENGE_USED");
  }

  return {
    userId: parsed.sub,
    jti: parsed.jti,
    exp: parsed.exp,
  };
}

export function consumeMfaChallengeJti(jti: string, exp: number, nowMs = Date.now()): void {
  sweepExpiredChallengeJtis(Math.floor(nowMs / 1000));
  consumedChallengeJtis.set(jti, exp);
}

export async function getMfaStatus(db: AppDatabase, userId: string): Promise<MfaStatusDto> {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  if (!row) {
    return {
      enabled: false,
      enrolledAt: null,
      verifiedAt: null,
      lastUsedAt: null,
      recoveryCodesRemaining: 0,
    };
  }
  return {
    enabled: row.isEnabled,
    enrolledAt: row.enrolledAt ? row.enrolledAt.toISOString() : null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    recoveryCodesRemaining: row.isEnabled ? row.recoveryCodesHashes.length : 0,
  };
}

export async function enrollMfa(
  db: AppDatabase,
  actor: AuthUser,
  ipAddress?: string
): Promise<MfaEnrollResponseDto> {
  const secretBase32 = encodeBase32(randomBytes(20));
  const { ciphertext: encryptedSecret, keyVersion } = encryptMfaSecretWithVersion(secretBase32);
  const recoveryCodes = generateRecoveryCodes(8);
  const recoveryCodesHashes = recoveryCodes.map(hashRecoveryCode);
  const now = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: userMfa.userId, isEnabled: userMfa.isEnabled })
      .from(userMfa)
      .where(eq(userMfa.userId, actor.id))
      .limit(1);

    if (existing?.isEnabled) {
      throw new AppError(409, "Two-factor authentication is already enabled", "MFA_ALREADY_ENABLED");
    }

    await tx
      .insert(userMfa)
      .values({
        userId: actor.id,
        isEnabled: false,
        totpSecretEncrypted: encryptedSecret,
        keyVersion,
        recoveryCodesHashes,
        enrolledAt: now,
        verifiedAt: null,
        lastUsedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: {
          isEnabled: false,
          totpSecretEncrypted: encryptedSecret,
          keyVersion,
          recoveryCodesHashes,
          enrolledAt: now,
          verifiedAt: null,
          lastUsedAt: null,
          updatedAt: now,
        },
      });

    await writeAuditLog(tx, {
      companyId: actor.activeCompanyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "auth.mfa_enrolled",
      entityType: "user_mfa",
      entityId: actor.id,
      entityLabel: actor.email,
      details: { enrolled: true, recoveryCodeCount: recoveryCodes.length },
      ipAddress,
    });
  });

  return {
    otpauthUrl: buildOtpAuthUrl(actor.email, secretBase32),
    secretMasked: maskTotpSecret(secretBase32),
    recoveryCodes,
  };
}

export async function verifyMfaEnrollment(
  db: AppDatabase,
  actor: AuthUser,
  code: string,
  ipAddress?: string
): Promise<{ enabled: true; verifiedAt: string }> {
  const now = new Date();

  await db.transaction(async (tx) => {
    const rows = await tx.execute<{
      user_id: string;
      is_enabled: boolean;
      totp_secret_encrypted: string;
      key_version: number;
    }>(sql`
      SELECT user_id, is_enabled, totp_secret_encrypted, key_version
      FROM user_mfa
      WHERE user_id = ${actor.id}
      FOR UPDATE
    `);

    const mfaRow = rows[0];
    if (!mfaRow) {
      throw new AppError(400, "MFA enrollment has not been initiated", "MFA_NOT_ENROLLED");
    }
    if (mfaRow.is_enabled) {
      throw new AppError(409, "Two-factor authentication is already verified", "MFA_ALREADY_ENABLED");
    }

    const secret = decryptMfaSecret(mfaRow.totp_secret_encrypted, Number(mfaRow.key_version));
    if (!verifyTotp(secret, code)) {
      throw new AppError(400, "Invalid TOTP verification code", "INVALID_MFA_CODE");
    }

    await tx
      .update(userMfa)
      .set({
        isEnabled: true,
        verifiedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(userMfa.userId, actor.id));

    await writeAuditLog(tx, {
      companyId: actor.activeCompanyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "auth.mfa_enabled",
      entityType: "user_mfa",
      entityId: actor.id,
      entityLabel: actor.email,
      before: { isEnabled: false },
      after: { isEnabled: true, verifiedAt: now.toISOString() },
      ipAddress,
    });
  });

  return {
    enabled: true,
    verifiedAt: now.toISOString(),
  };
}

export async function verifyMfaCodeOrRecovery(
  tx: DbOrTx,
  userId: string,
  code: string
): Promise<{ method: "totp" | "recovery_code"; recoveryCodesRemaining: number }> {
  const rows = await tx.execute<{
    user_id: string;
    is_enabled: boolean;
    totp_secret_encrypted: string;
    key_version: number;
    recovery_codes_hashes: string[];
  }>(sql`
    SELECT user_id, is_enabled, totp_secret_encrypted, key_version, recovery_codes_hashes
    FROM user_mfa
    WHERE user_id = ${userId}
    FOR UPDATE
  `);

  const mfaRow = rows[0];
  if (!mfaRow || !mfaRow.is_enabled) {
    throw new AppError(400, "Two-factor authentication is not enabled for this account", "MFA_NOT_ENABLED");
  }

  const secret = decryptMfaSecret(mfaRow.totp_secret_encrypted, Number(mfaRow.key_version));
  const now = new Date();
  const trimmed = code.trim();

  if (/^\d{6}$/.test(trimmed) && verifyTotp(secret, trimmed)) {
    await tx
      .update(userMfa)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(userMfa.userId, userId));
    return {
      method: "totp",
      recoveryCodesRemaining: Array.isArray(mfaRow.recovery_codes_hashes)
        ? mfaRow.recovery_codes_hashes.length
        : 0,
    };
  }

  const hashes = Array.isArray(mfaRow.recovery_codes_hashes) ? mfaRow.recovery_codes_hashes : [];
  const recoveryCheck = verifyAndConsumeRecoveryCodeFromHashes(hashes, trimmed);
  if (recoveryCheck.matched) {
    await tx
      .update(userMfa)
      .set({
        recoveryCodesHashes: recoveryCheck.remainingHashes,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(userMfa.userId, userId));
    return {
      method: "recovery_code",
      recoveryCodesRemaining: recoveryCheck.remainingHashes.length,
    };
  }

  throw new AppError(401, "Invalid verification or recovery code", "INVALID_MFA_CODE");
}

export async function disableMfa(
  db: AppDatabase,
  actor: AuthUser,
  input: { password: string; code?: string },
  ipAddress?: string
): Promise<{ enabled: false }> {
  await db.transaction(async (tx) => {
    const [userRow] = await tx
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    if (!userRow) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }

    const passwordOk = await verifyPassword(input.password, userRow.passwordHash);
    if (!passwordOk) {
      throw new AppError(401, "Current password is incorrect", "INVALID_PASSWORD");
    }

    const rows = await tx.execute<{
      user_id: string;
      is_enabled: boolean;
      totp_secret_encrypted: string;
      recovery_codes_hashes: string[];
    }>(sql`
      SELECT user_id, is_enabled, totp_secret_encrypted, recovery_codes_hashes
      FROM user_mfa
      WHERE user_id = ${actor.id}
      FOR UPDATE
    `);

    const mfaRow = rows[0];
    if (!mfaRow || !mfaRow.is_enabled) {
      throw new AppError(400, "Two-factor authentication is not currently enabled", "MFA_NOT_ENABLED");
    }

    if (input.code) {
      await verifyMfaCodeOrRecovery(tx, actor.id, input.code);
    }

    await tx.delete(userMfa).where(eq(userMfa.userId, actor.id));

    await writeAuditLog(tx, {
      companyId: actor.activeCompanyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "auth.mfa_disabled",
      entityType: "user_mfa",
      entityId: actor.id,
      entityLabel: actor.email,
      before: { isEnabled: true },
      after: { isEnabled: false },
      ipAddress,
    });
  });

  return { enabled: false };
}

export async function regenerateMfaRecoveryCodes(
  db: AppDatabase,
  actor: AuthUser,
  input: { password?: string; code?: string },
  ipAddress?: string
): Promise<{ recoveryCodes: string[] }> {
  if (!input.password && !input.code) {
    throw new AppError(400, "Current password or verification code is required.", "VALIDATION_ERROR");
  }

  const recoveryCodes = generateRecoveryCodes(8);
  const recoveryCodesHashes = recoveryCodes.map(hashRecoveryCode);
  const now = new Date();

  await db.transaction(async (tx) => {
    const [userRow] = await tx
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    if (!userRow) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }

    if (input.password) {
      const passwordOk = await verifyPassword(input.password, userRow.passwordHash);
      if (!passwordOk) {
        throw new AppError(401, "Current password is incorrect", "INVALID_PASSWORD");
      }
    }

    const rows = await tx.execute<{
      user_id: string;
      is_enabled: boolean;
      totp_secret_encrypted: string;
      recovery_codes_hashes: string[];
    }>(sql`
      SELECT user_id, is_enabled, totp_secret_encrypted, recovery_codes_hashes
      FROM user_mfa
      WHERE user_id = ${actor.id}
      FOR UPDATE
    `);

    const mfaRow = rows[0];
    if (!mfaRow || !mfaRow.is_enabled) {
      throw new AppError(400, "Two-factor authentication must be enabled first", "MFA_NOT_ENABLED");
    }

    if (input.code) {
      await verifyMfaCodeOrRecovery(tx, actor.id, input.code);
    }

    await tx
      .update(userMfa)
      .set({
        recoveryCodesHashes,
        updatedAt: now,
      })
      .where(eq(userMfa.userId, actor.id));

    await writeAuditLog(tx, {
      companyId: actor.activeCompanyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "auth.mfa_recovery_codes_regenerated",
      entityType: "user_mfa",
      entityId: actor.id,
      entityLabel: actor.email,
      details: { recoveryCodeCount: recoveryCodes.length },
      ipAddress,
    });
  });

  return { recoveryCodes };
}

export interface MfaKeyRotationResult {
  targetVersion: number;
  scanned: number;
  rotated: number;
  skipped: number;
  dryRun: boolean;
}

/**
 * Re-encrypts all user_mfa rows whose key_version differs from the active
 * MFA_ENCRYPTION_KEY_VERSION using the current MFA_ENCRYPTION_KEY.
 * Requires the previous key versions to be configured via MFA_ENCRYPTION_PREVIOUS_KEYS.
 */
export async function rotateMfaEncryptionKeys(
  db: AppDatabase,
  options: { dryRun?: boolean } = {}
): Promise<MfaKeyRotationResult> {
  const dryRun = Boolean(options.dryRun);
  const ring = resolveMfaKeyRing();
  const targetVersion = ring.currentVersion;
  const now = new Date();

  return db.transaction(async (tx) => {
    const rows = await tx.execute<{
      user_id: string;
      totp_secret_encrypted: string;
      key_version: number;
    }>(sql`
      SELECT user_id, totp_secret_encrypted, key_version
      FROM user_mfa
      FOR UPDATE
    `);

    let rotated = 0;
    let skipped = 0;

    for (const row of rows) {
      const rowVersion = Number(row.key_version);
      if (rowVersion === targetVersion) {
        skipped += 1;
        continue;
      }

      const plaintext = decryptMfaSecret(row.totp_secret_encrypted, rowVersion);
      if (!dryRun) {
        const reEncrypted = encryptMfaSecretWithKey(plaintext, ring.currentKey);
        await tx
          .update(userMfa)
          .set({
            totpSecretEncrypted: reEncrypted,
            keyVersion: targetVersion,
            updatedAt: now,
          })
          .where(eq(userMfa.userId, row.user_id));
      }
      rotated += 1;
    }

    return {
      targetVersion,
      scanned: rows.length,
      rotated,
      skipped,
      dryRun,
    };
  });
}
