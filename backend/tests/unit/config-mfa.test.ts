import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
  AUTH_COOKIE_SECRET: process.env.AUTH_COOKIE_SECRET,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR,
};

function restoreEnv(): void {
  for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

async function loadFreshConfig(overrides: Partial<Record<keyof typeof ORIGINAL_ENV, string>>) {
  vi.resetModules();
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined) {
      process.env[key] = val;
    }
  }
  return import("../../src/config.ts");
}

describe("config.ts — resolveMfaEncryptionKey & storage configuration", () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it("accepts a valid 64-character hex key and canonical 32-byte base64 key", async () => {
    const rawKey = crypto.randomBytes(32);
    const hexKey = rawKey.toString("hex");
    const b64Key = rawKey.toString("base64");

    const hexCfg = await loadFreshConfig({ MFA_ENCRYPTION_KEY: hexKey, STORAGE_DRIVER: "local" });
    expect(hexCfg.resolveMfaEncryptionKey()).toEqual(rawKey);

    const b64Cfg = await loadFreshConfig({ MFA_ENCRYPTION_KEY: b64Key, STORAGE_DRIVER: "local" });
    expect(b64Cfg.resolveMfaEncryptionKey()).toEqual(rawKey);
  });

  it("rejects 43-char truncated hex, corrupted base64 with invalid chars, non-canonical padding, and wrong-length keys", async () => {
    const truncatedHex43 = "0123456789abcdef".repeat(2) + "0123456789a";
    expect(truncatedHex43).toHaveLength(43);

    const validB64 = crypto.randomBytes(32).toString("base64");
    const corruptedB64 = `${validB64.slice(0, 20)}!!@@##${validB64.slice(20)}`;
    const nonCanonicalB64 = `${"A".repeat(42)}B=`;
    const shortB64 = crypto.randomBytes(16).toString("base64");

    for (const invalidKey of [truncatedHex43, corruptedB64, nonCanonicalB64, shortB64, "not-a-valid-key"]) {
      const cfg = await loadFreshConfig({ MFA_ENCRYPTION_KEY: invalidKey, STORAGE_DRIVER: "local" });
      expect(() => cfg.resolveMfaEncryptionKey()).toThrow(
        /MFA_ENCRYPTION_KEY must be a 64-character hex string or base64-encoded 32-byte key/
      );
    }
  });

  it("derives deterministic 32-byte HKDF key in dev/test and throws in production when unset", async () => {
    const devCfgA = await loadFreshConfig({
      NODE_ENV: "development",
      MFA_ENCRYPTION_KEY: "",
      AUTH_COOKIE_SECRET: "secret-alpha",
      STORAGE_DRIVER: "local",
    });
    const devKeyA1 = devCfgA.resolveMfaEncryptionKey();
    const devKeyA2 = devCfgA.resolveMfaEncryptionKey();
    expect(devKeyA1).toHaveLength(32);
    expect(devKeyA1).toEqual(devKeyA2);

    const testCfgA = await loadFreshConfig({
      NODE_ENV: "test",
      MFA_ENCRYPTION_KEY: "",
      AUTH_COOKIE_SECRET: "secret-alpha",
      STORAGE_DRIVER: "local",
    });
    expect(testCfgA.resolveMfaEncryptionKey()).toEqual(devKeyA1);

    const devCfgB = await loadFreshConfig({
      NODE_ENV: "development",
      MFA_ENCRYPTION_KEY: "",
      AUTH_COOKIE_SECRET: "secret-beta",
      STORAGE_DRIVER: "local",
    });
    expect(devCfgB.resolveMfaEncryptionKey()).not.toEqual(devKeyA1);

    const prodCfg = await loadFreshConfig({
      NODE_ENV: "production",
      MFA_ENCRYPTION_KEY: "",
      STORAGE_DRIVER: "local",
    });
    expect(() => prodCfg.resolveMfaEncryptionKey()).toThrow(
      /MFA_ENCRYPTION_KEY must be a 32-byte hex or base64 key when NODE_ENV=production/
    );
  });

  it("handles STORAGE_DRIVER fallback, trimming, invalid values, and STORAGE_LOCAL_DIR defaults/resolution", async () => {
    const emptyDriverCfg = await loadFreshConfig({
      NODE_ENV: "test",
      STORAGE_DRIVER: "",
      STORAGE_LOCAL_DIR: "",
    });
    expect(emptyDriverCfg.env.STORAGE_DRIVER).toBe("local");
    expect(emptyDriverCfg.env.STORAGE_LOCAL_DIR).toBe(path.resolve(backendRootDir, "uploads"));

    const s3DriverCfg = await loadFreshConfig({
      NODE_ENV: "production",
      STORAGE_DRIVER: "  S3  ",
      STORAGE_LOCAL_DIR: "",
    });
    expect(s3DriverCfg.env.STORAGE_DRIVER).toBe("s3");
    expect(s3DriverCfg.env.STORAGE_LOCAL_DIR).toBe("/app/uploads");

    const customDirCfg = await loadFreshConfig({
      NODE_ENV: "development",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: "  ./custom-uploads  ",
    });
    expect(customDirCfg.env.STORAGE_LOCAL_DIR).toBe(path.resolve("./custom-uploads"));

    await expect(
      loadFreshConfig({
        NODE_ENV: "test",
        STORAGE_DRIVER: "minio",
      })
    ).rejects.toThrow(/Invalid STORAGE_DRIVER "minio"/);
  });
});
