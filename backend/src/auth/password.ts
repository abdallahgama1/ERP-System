import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    return false;
  }
  const [, , salt, hashHex] = parts;
  if (!salt || !hashHex) {
    return false;
  }
  const expectedBuffer = Buffer.from(hashHex, "hex");
  const derivedBuffer = (await scrypt(password, salt, expectedBuffer.length)) as Buffer;
  if (derivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(derivedBuffer, expectedBuffer);
}
