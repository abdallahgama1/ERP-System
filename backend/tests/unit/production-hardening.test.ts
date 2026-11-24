import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseCorsAllowList } from "../../src/app.ts";
import { shouldUseSecureCookie } from "../../src/auth/sessions.ts";
import { resolveMfaKeyRing } from "../../src/config.ts";
import { AUDIT_CHAIN_GENESIS_HASH, computeAuditEntryHash } from "../../src/db/helpers.ts";
import { detectBinaryMagicKind, validateAttachmentBinary } from "../../src/services/attachments.service.ts";
import {
  decryptMfaSecret,
  encryptMfaSecretWithVersion,
} from "../../src/services/mfa.service.ts";
import { buildStorageKey } from "../../src/services/storage.service.ts";
import {
  isVirusScanEnabled,
  scanAttachmentBuffer,
  setVirusScanEnabledForTests,
  setVirusScannerForTests,
} from "../../src/services/virus-scan.service.ts";

const ORIG_MFA_ENV = {
  MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
  MFA_ENCRYPTION_KEY_VERSION: process.env.MFA_ENCRYPTION_KEY_VERSION,
  MFA_ENCRYPTION_PREVIOUS_KEYS: process.env.MFA_ENCRYPTION_PREVIOUS_KEYS,
};

function restoreMfaEnv(): void {
  for (const [k, v] of Object.entries(ORIG_MFA_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("Production hardening unit tests", () => {
  afterEach(() => {
    restoreMfaEnv();
    setVirusScannerForTests(null);
    setVirusScanEnabledForTests(null);
  });

  it("parses CORS allow-list strictly and drops wildcards and trailing slashes", () => {
    expect(
      parseCorsAllowList(" https://erp.example.com/ , https://admin.example.com , * , , https://erp.example.com ")
    ).toEqual(["https://erp.example.com", "https://admin.example.com"]);
    expect(parseCorsAllowList("*")).toEqual([]);
  });

  it("resolves Secure cookie flag correctly across explicit and auto modes", () => {
    expect(shouldUseSecureCookie({ cookieSecure: "true", nodeEnv: "development", corsOrigin: "http://localhost:8080" })).toBe(true);
    expect(shouldUseSecureCookie({ cookieSecure: "false", nodeEnv: "production", corsOrigin: "https://erp.example.com" })).toBe(false);
    expect(shouldUseSecureCookie({ cookieSecure: "auto", nodeEnv: "production", corsOrigin: "https://erp.example.com" })).toBe(true);
    expect(shouldUseSecureCookie({ cookieSecure: "auto", nodeEnv: "production", corsOrigin: "http://localhost:8080", appBaseUrl: "http://localhost:8080", requestProtocol: "http" })).toBe(false);
    expect(shouldUseSecureCookie({ cookieSecure: "auto", nodeEnv: "production", corsOrigin: "http://localhost:8080", appBaseUrl: "http://localhost:8080", requestProtocol: "https" })).toBe(true);
    expect(shouldUseSecureCookie({ cookieSecure: "auto", nodeEnv: "development", corsOrigin: "https://erp.example.com" })).toBe(false);
  });

  it("supports versioned MFA key ring encryption and rotation decryption", () => {
    const keyV1 = crypto.randomBytes(32).toString("hex");
    const keyV2 = crypto.randomBytes(32).toString("hex");

    process.env.MFA_ENCRYPTION_KEY = keyV1;
    process.env.MFA_ENCRYPTION_KEY_VERSION = "1";
    delete process.env.MFA_ENCRYPTION_PREVIOUS_KEYS;

    const { ciphertext: encV1, keyVersion: ver1 } = encryptMfaSecretWithVersion("JBSWY3DPEHPK3PXP");
    expect(ver1).toBe(1);

    // Rotate to v2 while retaining v1 in MFA_ENCRYPTION_PREVIOUS_KEYS
    process.env.MFA_ENCRYPTION_KEY = keyV2;
    process.env.MFA_ENCRYPTION_KEY_VERSION = "2";
    process.env.MFA_ENCRYPTION_PREVIOUS_KEYS = `1:${keyV1}`;

    const ring = resolveMfaKeyRing();
    expect(ring.currentVersion).toBe(2);
    expect(ring.keys.has(1)).toBe(true);
    expect(ring.keys.has(2)).toBe(true);

    // Existing v1 secret decrypts cleanly with explicit version or fallback
    expect(decryptMfaSecret(encV1, 1)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptMfaSecret(encV1)).toBe("JBSWY3DPEHPK3PXP");

    // New enrollments use v2
    const { ciphertext: encV2, keyVersion: ver2 } = encryptMfaSecretWithVersion("GEZDGNBVGY3TQOJQ");
    expect(ver2).toBe(2);
    expect(decryptMfaSecret(encV2, 2)).toBe("GEZDGNBVGY3TQOJQ");

    // JSON format for previous keys also works
    process.env.MFA_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify({ "1": keyV1 });
    expect(decryptMfaSecret(encV1, 1)).toBe("JBSWY3DPEHPK3PXP");

    // Missing key version throws cleanly
    delete process.env.MFA_ENCRYPTION_PREVIOUS_KEYS;
    expect(() => decryptMfaSecret(encV1, 1)).toThrow(/key version 1 is not configured/i);
  });

  it("verifies magic bytes against declared MIME types and randomizes storage keys", () => {
    const pdfBuf = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const elfBuf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    const badUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);

    expect(detectBinaryMagicKind(pdfBuf)).toBe("application/pdf");
    expect(detectBinaryMagicKind(pngBuf)).toBe("image/png");
    expect(detectBinaryMagicKind(exeBuf)).toBe("application/x-msdownload");
    expect(detectBinaryMagicKind(elfBuf)).toBe("application/x-elf");

    expect(validateAttachmentBinary("doc.pdf", "application/pdf", pdfBuf).normalizedMime).toBe("application/pdf");
    expect(validateAttachmentBinary("img.png", "image/png", pngBuf).normalizedMime).toBe("image/png");
    expect(validateAttachmentBinary("data.csv", "text/csv", Buffer.from("a,b\n1,2\n", "utf8")).normalizedMime).toBe("text/csv");

    expect(() => validateAttachmentBinary("fake.png", "image/png", pdfBuf)).toThrow(/PNG header signature/);
    expect(() => validateAttachmentBinary("fake.pdf", "application/pdf", exeBuf)).toThrow(/PDF header signature/);
    expect(() => validateAttachmentBinary("evil.csv", "text/csv", Buffer.from("MZhello", "ascii"))).toThrow(/disallowed binary signature/);
    expect(() => validateAttachmentBinary("bad.txt", "text/plain", badUtf8)).toThrow(/valid UTF-8/);

    const key1 = buildStorageKey("comp-1", "sales_invoice", "inv-123", "secret-payroll.pdf");
    const key2 = buildStorageKey("comp-1", "sales_invoice", "inv-123", "secret-payroll.pdf");
    expect(key1).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{48}$/);
    expect(key1).not.toBe(key2);
    expect(key1).not.toContain("comp-1");
    expect(key1).not.toContain("inv-123");
    expect(key1).not.toContain("payroll");
    expect(key1).not.toContain(".pdf");
  });

  it("keeps virus-scan hook off by default and blocks infected uploads when enabled", async () => {
    expect(isVirusScanEnabled()).toBe(false);
    const disabledRes = await scanAttachmentBuffer(Buffer.from("hello"), {
      fileName: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    expect(disabledRes).toEqual({ clean: true, scanner: "disabled" });

    setVirusScanEnabledForTests(true);
    setVirusScannerForTests(async () => ({ clean: false, threat: "EICAR-Test-Signature", scanner: "mock-av" }));
    const infectedRes = await scanAttachmentBuffer(Buffer.from("X5O!P%@AP"), {
      fileName: "eicar.txt",
      mimeType: "text/plain",
      sizeBytes: 9,
    });
    expect(infectedRes).toEqual({ clean: false, threat: "EICAR-Test-Signature", scanner: "mock-av" });

    setVirusScannerForTests(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      scanAttachmentBuffer(Buffer.from("hello"), {
        fileName: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      })
    ).rejects.toThrow(/virus scanning service is unavailable/i);
  });

  it("computes canonical audit entry hashes invariant to JSON key order and sensitive to tampering", () => {
    const ts = new Date("2026-11-24T12:00:00.000Z");
    const base = {
      chainSeq: 1,
      prevHash: AUDIT_CHAIN_GENESIS_HASH,
      companyId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000099",
      userName: "Admin",
      userRole: "admin",
      branchId: null,
      action: "invoice.posted",
      entityType: "sales_invoice",
      entityId: "inv-1",
      entityLabel: "INV-0001",
      details: { a: 1, b: { z: true, y: false } },
      beforeJson: null,
      afterJson: { total: 100, status: "posted" },
      changedFields: ["status", "total"],
      ipAddress: "127.0.0.1",
      createdAt: ts,
    };

    const h1 = computeAuditEntryHash(base);
    const h2 = computeAuditEntryHash({
      ...base,
      details: { b: { y: false, z: true }, a: 1 },
      afterJson: { status: "posted", total: 100 },
    });
    const hTampered = computeAuditEntryHash({
      ...base,
      afterJson: { total: 999, status: "posted" },
    });

    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(hTampered);
  });
});
