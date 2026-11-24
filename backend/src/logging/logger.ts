import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DestinationStream } from "pino";
import pino from "pino";
import { env } from "../config.ts";

export interface RequestLogContext {
  reqId: string;
  userId?: string;
  branchId?: string | null;
  terminalId?: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestLogContext>();

export function getRequestContext(): RequestLogContext | undefined {
  return requestContext.getStore();
}

const VALID_REQ_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Validates incoming x-request-id against strict alphanumeric pattern to prevent log/CRLF injection.
 */
export function sanitizeRequestId(rawHeader: string | string[] | undefined): string {
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof candidate === "string" && VALID_REQ_ID_RE.test(candidate.trim())) {
    return candidate.trim();
  }
  return randomUUID();
}

export const LOG_REDACT_PATHS: string[] = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "password",
  "currentPassword",
  "newPassword",
  "passwordHash",
  "pin",
  "posPin",
  "pinHash",
  "token",
  "rawToken",
  "resetToken",
  "tokenHash",
  "etaClientSecret",
  "secret",
  "totpSecret",
  "totpCode",
  "recoveryCode",
  "recoveryCodes",
  "mfaChallengeToken",
  "s3SecretAccessKey",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.passwordHash",
  "*.pin",
  "*.posPin",
  "*.pinHash",
  "*.token",
  "*.rawToken",
  "*.resetToken",
  "*.tokenHash",
  "*.etaClientSecret",
  "*.secret",
  "*.totpSecret",
  "*.totpCode",
  "*.recoveryCode",
  "*.recoveryCodes",
  "*.mfaChallengeToken",
  "*.s3SecretAccessKey",
  "body.password",
  "body.pin",
  "body.posPin",
  "body.totpCode",
  "body.recoveryCode",
];

function redactConnectionStrings(input: string): string {
  return input.replace(/(postgres(?:ql)?:\/\/)([^:@\s]+):([^@\s]+)@/gi, "$1[REDACTED]:[REDACTED]@");
}

export function sanitizeErrorForLog(err: unknown): {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
} {
  if (!(err instanceof Error)) {
    return { type: "Error", message: redactConnectionStrings(String(err)), stack: "" };
  }
  const errObj = err as Error & {
    code?: string;
    statusCode?: number;
    detail?: string;
  };
  return {
    type: err.name || "Error",
    message: redactConnectionStrings(err.message),
    stack: env.NODE_ENV !== "production" && err.stack ? redactConnectionStrings(err.stack) : "",
    ...(errObj.code ? { code: errObj.code } : {}),
    ...(errObj.statusCode ? { statusCode: errObj.statusCode } : {}),
  };
}

export function buildPinoOptions(options: { level?: string; stream?: DestinationStream } = {}) {
  const level = options.level ?? env.LOG_LEVEL;
  return {
    level,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      err: sanitizeErrorForLog,
    },
    ...(options.stream ? { stream: options.stream } : {}),
  };
}

export const rootLogger = pino(
  {
    level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      err: sanitizeErrorForLog,
    },
  }
);

export function createModuleLogger(moduleName: string) {
  return rootLogger.child({ module: moduleName });
}
