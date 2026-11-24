import net from "node:net";
import { env } from "../config.ts";
import { AppError } from "../db/helpers.ts";

export interface VirusScanMetadata {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface VirusScanResult {
  clean: boolean;
  threat?: string;
  scanner: string;
}

export type VirusScannerFn = (
  buffer: Buffer,
  meta: VirusScanMetadata
) => Promise<VirusScanResult>;

let testScannerOverride: VirusScannerFn | null = null;
let testEnabledOverride: boolean | null = null;

export function setVirusScannerForTests(scanner: VirusScannerFn | null): void {
  testScannerOverride = scanner;
}

export function setVirusScanEnabledForTests(enabled: boolean | null): void {
  testEnabledOverride = enabled;
}

export function isVirusScanEnabled(): boolean {
  if (testEnabledOverride !== null) {
    return testEnabledOverride;
  }
  const raw = process.env.ATTACHMENT_VIRUS_SCAN_ENABLED;
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return env.ATTACHMENT_VIRUS_SCAN_ENABLED;
}

/**
 * Streams a buffer to a ClamAV clamd daemon using the standard `zINSTREAM\0` protocol.
 */
export async function scanBufferWithClamd(
  buffer: Buffer,
  options: { host?: string; port?: number; timeoutMs?: number } = {}
): Promise<VirusScanResult> {
  const host = options.host ?? env.ATTACHMENT_VIRUS_SCAN_CLAMAV_HOST;
  const port = options.port ?? env.ATTACHMENT_VIRUS_SCAN_CLAMAV_PORT;
  const timeoutMs = options.timeoutMs ?? env.ATTACHMENT_VIRUS_SCAN_TIMEOUT_MS;

  return new Promise<VirusScanResult>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err: Error | null, res?: VirusScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(res!);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(new Error(`ClamAV scan timed out after ${timeoutMs}ms`));
    });

    socket.on("error", (err) => {
      finish(err);
    });

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const slice = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(slice.length, 0);
        socket.write(lenBuf);
        socket.write(slice);
      }
      const endBuf = Buffer.alloc(4);
      endBuf.writeUInt32BE(0, 0);
      socket.write(endBuf);
    });

    socket.on("data", (data) => {
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
      if (/^stream:\s*OK$/i.test(response)) {
        finish(null, { clean: true, scanner: "clamav" });
        return;
      }
      const foundMatch = response.match(/^stream:\s*(.+?)\s+FOUND$/i);
      if (foundMatch) {
        finish(null, { clean: false, threat: foundMatch[1], scanner: "clamav" });
        return;
      }
      finish(new Error(`Unexpected ClamAV response: ${response || "(empty)"}`));
    });
  });
}

export async function scanAttachmentBuffer(
  buffer: Buffer,
  meta: VirusScanMetadata
): Promise<VirusScanResult> {
  if (!isVirusScanEnabled()) {
    return { clean: true, scanner: "disabled" };
  }

  const scanner = testScannerOverride ?? ((buf) => scanBufferWithClamd(buf));
  try {
    return await scanner(buffer, meta);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (env.ATTACHMENT_VIRUS_SCAN_FAIL_CLOSED) {
      throw new AppError(
        503,
        "Attachment virus scanning service is unavailable. Upload rejected.",
        "VIRUS_SCAN_UNAVAILABLE"
      );
    }
    return { clean: true, scanner: "error_bypassed" };
  }
}
