import crypto from "node:crypto";
import { AUDIT_SENSITIVE_FIELDS } from "@erp/shared";
import { describe, expect, it, vi } from "vitest";
import { computeAuditDiff, scrubSensitiveAuditData } from "../../src/db/helpers.ts";
import {
  buildOtpAuthUrl,
  consumeMfaChallengeJti,
  createMfaChallengeToken,
  decodeBase32,
  decryptMfaSecret,
  encodeBase32,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotp,
  hashRecoveryCode,
  maskTotpSecret,
  resetConsumedMfaChallenges,
  verifyAndConsumeRecoveryCodeFromHashes,
  verifyMfaChallengeToken,
  verifyTotp,
} from "../../src/services/mfa.service.ts";

describe("Pure node:crypto RFC 6238 TOTP, AES-256-GCM, Recovery Codes & Audit Scrubbing", () => {
  it("encodes and decodes Base32 buffers cleanly and rejects invalid characters", () => {
    for (const byteLen of [20, 32]) {
      const raw = crypto.randomBytes(byteLen);
      const b32 = encodeBase32(raw);
      expect(b32).toMatch(/^[A-Z2-7]+$/);
      expect(decodeBase32(b32)).toEqual(raw);
      expect(decodeBase32(` ${b32.toLowerCase()}==== `)).toEqual(raw);
    }

    expect(() => decodeBase32("")).toThrow(/empty/i);
    for (const invalid of ["ABC0DEF", "ABC1DEF", "ABC8DEF", "ABC9DEF", "ABC$DEF"]) {
      expect(() => decodeBase32(invalid)).toThrow(/Invalid Base32/i);
    }
  });

  it("matches official RFC 6238 SHA-1 TOTP test vectors", () => {
    // RFC 6238 Appendix B ASCII secret "12345678901234567890" -> Base32
    const secretBase32 = encodeBase32(Buffer.from("12345678901234567890", "ascii"));
    expect(secretBase32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];

    for (const [epochSeconds, expectedCode] of vectors) {
      expect(generateTotp(secretBase32, epochSeconds * 1000)).toBe(expectedCode);
    }
  });

  it("enforces +/-1 time step skew tolerance and rejects malformed codes", () => {
    const secret = encodeBase32(crypto.randomBytes(20));
    const baseMs = 1_700_000_010_000;

    const current = generateTotp(secret, baseMs, 0);
    const prevStep = generateTotp(secret, baseMs, -1);
    const nextStep = generateTotp(secret, baseMs, 1);
    const minusTwo = generateTotp(secret, baseMs, -2);
    const plusTwo = generateTotp(secret, baseMs, 2);

    expect(verifyTotp(secret, current, baseMs)).toBe(true);
    expect(verifyTotp(secret, prevStep, baseMs)).toBe(true);
    expect(verifyTotp(secret, nextStep, baseMs)).toBe(true);
    expect(verifyTotp(secret, minusTwo, baseMs)).toBe(false);
    expect(verifyTotp(secret, plusTwo, baseMs)).toBe(false);

    for (const malformed of ["", "12345", "1234567", "12ab56", "abcdef"]) {
      expect(verifyTotp(secret, malformed, baseMs)).toBe(false);
    }
  });

  it("formats otpauth:// URI and masks TOTP secrets cleanly", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const uri = buildOtpAuthUrl("finance+ops@acme.test", secret, "Count It Keep It ERP");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("finance%2Bops%40acme.test");
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");

    const masked = maskTotpSecret(secret);
    expect(masked.startsWith("JBSW")).toBe(true);
    expect(masked.endsWith("3PXP")).toBe(true);
    expect(masked).not.toBe(secret);
  });

  it("encrypts and decrypts TOTP secrets via AES-256-GCM and rejects tampering", async () => {
    const secret = encodeBase32(crypto.randomBytes(20));
    const encA = encryptMfaSecret(secret);
    const encB = encryptMfaSecret(secret);
    expect(encA).not.toBe(encB); // random 12-byte IV per encryption

    expect(decryptMfaSecret(encA)).toBe(secret);
    expect(decryptMfaSecret(encB)).toBe(secret);

    const parts = encA.split(":");
    const badTagBuf = Buffer.from(parts[2]!, "base64");
    badTagBuf[0] = (badTagBuf[0]! ^ 0xff) & 0xff;
    const tamperedTag = `${parts[0]}:${parts[1]}:${badTagBuf.toString("base64")}:${parts[3]}`;
    expect(() => decryptMfaSecret(tamperedTag)).toThrow();

    const badCtBuf = Buffer.from(parts[3]!, "base64");
    badCtBuf[0] = (badCtBuf[0]! ^ 0x01) & 0xff;
    const tamperedCt = `${parts[0]}:${parts[1]}:${parts[2]}:${badCtBuf.toString("base64")}`;
    expect(() => decryptMfaSecret(tamperedCt)).toThrow();

    // Wrong key rejection
    const origKey = process.env.MFA_ENCRYPTION_KEY;
    try {
      process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
      vi.resetModules();
      const freshMfa = await import("../../src/services/mfa.service.ts");
      expect(() => freshMfa.decryptMfaSecret(encA)).toThrow();
    } finally {
      if (origKey === undefined) {
        delete process.env.MFA_ENCRYPTION_KEY;
      } else {
        process.env.MFA_ENCRYPTION_KEY = origKey;
      }
      vi.resetModules();
    }
  });

  it("generates 8 unique recovery codes, hashes deterministically, and consumes single-use codes", () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) {
      expect(c).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    }

    const sample = codes[0]!;
    const h1 = hashRecoveryCode(sample);
    const h2 = hashRecoveryCode(sample.toLowerCase().replace("-", " "));
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);

    const hashes = codes.map(hashRecoveryCode);
    const firstUse = verifyAndConsumeRecoveryCodeFromHashes(hashes, sample.toLowerCase().replace("-", ""));
    expect(firstUse.matched).toBe(true);
    expect(firstUse.remainingHashes).toHaveLength(7);

    // Reusing the same recovery code must fail
    const secondUse = verifyAndConsumeRecoveryCodeFromHashes(firstUse.remainingHashes, sample);
    expect(secondUse.matched).toBe(false);
    expect(secondUse.remainingHashes).toHaveLength(7);

    // Unknown code fails
    const unknown = verifyAndConsumeRecoveryCodeFromHashes(firstUse.remainingHashes, "DEAD-BEEF");
    expect(unknown.matched).toBe(false);
  });

  it("issues, verifies, expires, and prevents replay of HMAC MFA challenge tokens", () => {
    resetConsumedMfaChallenges();
    const userId = crypto.randomUUID();
    const nowMs = 1_700_000_000_000;
    const token = createMfaChallengeToken(userId, 300, nowMs);

    const verified = verifyMfaChallengeToken(token, nowMs + 10_000);
    expect(verified.userId).toBe(userId);

    // Tampered token fails
    const [payload, sig] = token.split(".");
    const tampered = `${payload}.${sig!.slice(0, -2)}AA`;
    expect(() => verifyMfaChallengeToken(tampered, nowMs + 10_000)).toThrow();

    // Expired token fails
    expect(() => verifyMfaChallengeToken(token, nowMs + 301_000)).toThrow(/expired/i);

    // Replay after consumption fails
    consumeMfaChallengeJti(verified.jti, verified.exp, nowMs + 10_000);
    expect(() => verifyMfaChallengeToken(token, nowMs + 20_000)).toThrow(/already been used/i);
  });

  it("recursively scrubs all AUDIT_SENSITIVE_FIELDS and computes clean before/after diffs", () => {
    const rawBefore: Record<string, unknown> = {
      name: "Acme Corp",
      shippingAddress: "100 Main St",
      baseCurrency: "USD",
      nested: {
        smtpPass: "super-smtp-secret",
        items: [{ pin: "1234", code: "ITEM-1" }],
      },
    };
    const rawAfter: Record<string, unknown> = {
      name: "Acme Holding",
      shippingAddress: "100 Main St",
      baseCurrency: "USD",
      nested: {
        smtpPass: "new-smtp-secret",
        items: [{ pin: "5678", code: "ITEM-1" }],
      },
    };

    for (const sensitiveField of AUDIT_SENSITIVE_FIELDS) {
      rawAfter[sensitiveField] = `raw-value-${sensitiveField}`;
    }
    rawAfter.password_hash = "scrypt$secret";
    rawAfter.customAccessToken = "tok-xyz";

    const scrubbed = scrubSensitiveAuditData(rawAfter) as Record<string, unknown>;
    for (const sensitiveField of AUDIT_SENSITIVE_FIELDS) {
      expect(scrubbed[sensitiveField]).toBe("[REDACTED]");
    }
    expect(scrubbed.password_hash).toBe("[REDACTED]");
    expect(scrubbed.customAccessToken).toBe("[REDACTED]");
    expect(scrubbed.name).toBe("Acme Holding");
    expect(scrubbed.shippingAddress).toBe("100 Main St");
    expect((scrubbed.nested as Record<string, unknown>).smtpPass).toBe("[REDACTED]");
    expect(
      (((scrubbed.nested as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]!).pin
    ).toBe("[REDACTED]");
    expect(
      (((scrubbed.nested as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]!).code
    ).toBe("ITEM-1");

    const diff = computeAuditDiff(rawBefore, rawAfter);
    expect(diff.beforeJson).not.toBeNull();
    expect(diff.afterJson).not.toBeNull();
    expect(JSON.stringify(diff)).not.toContain("super-smtp-secret");
    expect(JSON.stringify(diff)).not.toContain("new-smtp-secret");
    expect(JSON.stringify(diff)).not.toContain("raw-value-");
    expect(JSON.stringify(diff)).not.toContain("scrypt$secret");
    expect(diff.changedFields).toContain("name");
    expect(diff.changedFields).toContain("nested");
    expect(diff.changedFields).toContain("passwordHash");
    expect(diff.changedFields).not.toContain("shippingAddress");
    expect(diff.changedFields).not.toContain("baseCurrency");

    // Identical objects with different key order produce empty changedFields
    const noChange = computeAuditDiff(
      { a: 1, b: { x: true, y: false } },
      { b: { y: false, x: true }, a: 1 }
    );
    expect(noChange.changedFields).toEqual([]);
  });
});
