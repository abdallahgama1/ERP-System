import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_COMPANY_ID, idempotencyKeys } from "../../drizzle/schema.ts";
import { getIdempotencyConfig } from "../config.ts";
import { AppError } from "../db/helpers.ts";
import { getDb, isDatabaseConfigured } from "../db/index.ts";

declare module "fastify" {
  interface FastifyRequest {
    idempotencyRecordId: string | null;
    idempotencyFinalized: boolean;
    idempotencyReplayed: boolean;
  }
}

const VALID_IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,128}$/;

/**
 * Auth, session, notification read-state, and transient verification POST routes
 * are excluded from idempotency caching (never cache credentials/cookies or harmless read-markers).
 */
const IDEMPOTENCY_EXCLUDED_PREFIXES = [
  "/api/auth/",
  "/api/pos/override/",
  "/api/pos/manager-override",
  "/api/pos/terminal/",
  "/api/notifications/",
];

const IDEMPOTENCY_EXCLUDED_EXACT = new Set(["/api/audit-logs"]);

/**
 * POST routes that create records (including auto-generated codes/numbers) or post financial/stock effects.
 * When IDEMPOTENCY_REQUIRED=true, these routes MUST include a valid Idempotency-Key header
 * (excluding dryRun=true import previews).
 */
const IDEMPOTENCY_REQUIRED_ROUTE_PATTERNS: readonly RegExp[] = [
  // Accounting & GL
  /^\/api\/accounting\/accounts$/,
  /^\/api\/accounting\/cost-centers$/,
  /^\/api\/accounting\/journal-entries$/,
  /^\/api\/accounting\/journal-entries\/[^/]+\/reverse$/,
  /^\/api\/accounting\/fiscal-years$/,
  /^\/api\/accounting\/fiscal-years\/[^/]+\/close$/,
  /^\/api\/accounting\/fiscal-years\/[^/]+\/reopen$/,
  /^\/api\/accounting\/fx-revaluation$/,
  /^\/api\/tax-codes$/,
  /^\/api\/currencies\/rates$/,
  // Approvals
  /^\/api\/approvals\/requests\/[^/]+\/decision$/,
  // Admin & Master Data Creates
  /^\/api\/branches$/,
  /^\/api\/companies$/,
  /^\/api\/companies\/[^/]+\/members$/,
  /^\/api\/custom-roles$/,
  /^\/api\/users$/,
  /^\/api\/taxonomy$/,
  /^\/api\/print-templates$/,
  /^\/api\/saved-views$/,
  /^\/api\/attachments$/,
  /^\/api\/documents\/[^/]+\/[^/]+\/email$/,
  // E-Invoicing
  /^\/api\/einvoicing\/submissions\/retry$/,
  /^\/api\/einvoicing\/submissions\/[^/]+\/retry$/,
  /^\/api\/einvoicing\/submissions\/process-now$/,
  // Expenses
  /^\/api\/expenses$/,
  /^\/api\/expenses\/[^/]+\/submit$/,
  /^\/api\/expenses\/[^/]+\/review$/,
  /^\/api\/expenses\/[^/]+\/pay$/,
  // Fixed Assets
  /^\/api\/fixed-assets$/,
  /^\/api\/fixed-assets\/depreciate$/,
  /^\/api\/fixed-assets\/[^/]+\/dispose$/,
  // Imports (dryRun=true previews are excluded dynamically)
  /^\/api\/imports\/opening-balances$/,
  /^\/api\/imports\/opening-balances\/reverse$/,
  /^\/api\/imports\/[^/]+$/,
  // Inventory & Stock
  /^\/api\/products$/,
  /^\/api\/branch-products\/adjust-level$/,
  /^\/api\/adjustments$/,
  /^\/api\/write-offs$/,
  /^\/api\/transfers$/,
  /^\/api\/transfers\/[^/]+\/dispatch$/,
  /^\/api\/transfers\/[^/]+\/receive$/,
  /^\/api\/transfers\/[^/]+\/cancel$/,
  // Stock-Take Sessions
  /^\/api\/sessions$/,
  /^\/api\/sessions\/[^/]+\/complete$/,
  // Manufacturing
  /^\/api\/manufacturing\/boms$/,
  /^\/api\/manufacturing\/work-orders$/,
  /^\/api\/manufacturing\/work-orders\/[^/]+\/issue$/,
  /^\/api\/manufacturing\/work-orders\/[^/]+\/complete$/,
  /^\/api\/manufacturing\/work-orders\/[^/]+\/cancel$/,
  // POS
  /^\/api\/pos\/terminals$/,
  /^\/api\/pos\/shifts\/open$/,
  /^\/api\/pos\/shifts\/[^/]+\/cash-movement$/,
  /^\/api\/pos\/shifts\/[^/]+\/close$/,
  /^\/api\/pos\/checkout$/,
  /^\/api\/pos\/sync$/,
  /^\/api\/pos\/returns$/,
  // Purchasing & Payables
  /^\/api\/vendors$/,
  /^\/api\/purchase-orders$/,
  /^\/api\/purchase-orders\/[^/]+\/issue$/,
  /^\/api\/purchase-receives$/,
  /^\/api\/vendor-bills$/,
  /^\/api\/vendor-bills\/[^/]+\/void$/,
  /^\/api\/payments-made$/,
  /^\/api\/payments-made\/[^/]+\/void$/,
  /^\/api\/purchase-returns$/,
  // Sales & Receivables
  /^\/api\/customers$/,
  /^\/api\/sales-orders$/,
  /^\/api\/sales-orders\/[^/]+\/confirm$/,
  /^\/api\/sales-orders\/[^/]+\/fulfill$/,
  /^\/api\/sales-orders\/[^/]+\/cancel$/,
  /^\/api\/sales-invoices$/,
  /^\/api\/sales-invoices\/[^/]+\/void$/,
  /^\/api\/received-payments$/,
  /^\/api\/received-payments\/[^/]+\/void$/,
  /^\/api\/sales-returns$/,
  /^\/api\/sales-returns\/[^/]+\/apply$/,
  /^\/api\/retainer-invoices$/,
  /^\/api\/retainer-invoices\/[^/]+\/cancel$/,
  /^\/api\/retainer-invoices\/[^/]+\/record-payment$/,
  /^\/api\/retainer-invoices\/[^/]+\/apply$/,
  // Treasury
  /^\/api\/treasury\/accounts$/,
  /^\/api\/treasury\/transfers$/,
  /^\/api\/treasury\/accounts\/[^/]+\/statements\/import-csv$/,
  /^\/api\/treasury\/statement-lines\/[^/]+\/reconcile$/,
  /^\/api\/treasury\/statement-lines\/[^/]+\/unreconcile$/,
];

const SENSITIVE_RESPONSE_KEY_RE =
  /^(password|passwordhash|token|rawtoken|resettoken|tokenhash|secret|totpsecret|totpsecretencrypted|recoverycodes|recoverycodeshashes|mfachallengetoken|mfaencryptionkey|authcookiesecret|smtppass|etaclientsecret|etasignertoken|s3secretaccesskey|backupencryptionkey|pinhash|pospin)$/i;

export function isIdempotencyExcludedPath(reqPath: string): boolean {
  if (IDEMPOTENCY_EXCLUDED_EXACT.has(reqPath)) return true;
  return IDEMPOTENCY_EXCLUDED_PREFIXES.some((prefix) => reqPath.startsWith(prefix));
}

export function isDryRunPreviewRequest(reqPath: string, body: unknown): boolean {
  if (!reqPath.startsWith("/api/imports/")) return false;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { dryRun?: unknown }).dryRun === true;
  }
  return false;
}

export function isIdempotencyRequiredForRoute(reqPath: string, body: unknown): boolean {
  if (isIdempotencyExcludedPath(reqPath)) return false;
  if (isDryRunPreviewRequest(reqPath, body)) return false;
  return IDEMPOTENCY_REQUIRED_ROUTE_PATTERNS.some((re) => re.test(reqPath));
}

function canonicalizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return value;
  if (depth >= 20) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      sorted[key] = canonicalizeValue(v, depth + 1);
    }
  }
  return sorted;
}

export function computeIdempotencyRequestHash(input: {
  method: string;
  path: string;
  query: unknown;
  body: unknown;
  isMultipart?: boolean;
  contentLength?: string | undefined;
}): string {
  const payload = input.isMultipart
    ? {
        method: input.method.toUpperCase(),
        path: input.path,
        query: canonicalizeValue(input.query ?? {}),
        multipart: true,
        contentLength: input.contentLength ?? "",
      }
    : {
        method: input.method.toUpperCase(),
        path: input.path,
        query: canonicalizeValue(input.query ?? {}),
        body: canonicalizeValue(input.body ?? null),
      };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function computeIdempotencyAdvisoryLockKey(scope: {
  companyId: string;
  userId: string;
  method: string;
  path: string;
  key: string;
}): string {
  const digest = createHash("sha256")
    .update(`idemp:${scope.companyId}:${scope.userId}:${scope.method}:${scope.path}:${scope.key}`, "utf8")
    .digest();
  // Signed 64-bit integer for pg_advisory_xact_lock(bigint)
  return digest.readBigInt64BE(0).toString();
}

export function scrubSecretsFromStoredResponse(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= 16) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretsFromStoredResponse(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_RESPONSE_KEY_RE.test(k)) {
      continue;
    }
    clean[k] = scrubSecretsFromStoredResponse(v, depth + 1);
  }
  return clean;
}

type ClaimOutcome =
  | { kind: "acquired"; recordId: string; recovered: boolean }
  | { kind: "replay"; statusCode: number; responseBody: unknown }
  | { kind: "wait" };

async function tryClaimIdempotencyKey(params: {
  companyId: string;
  userId: string;
  method: string;
  path: string;
  key: string;
  requestHash: string;
  ttlHours: number;
  inProgressTimeoutMs: number;
}): Promise<ClaimOutcome> {
  const db = getDb();
  const lockKey = computeIdempotencyAdvisoryLockKey(params);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + params.inProgressTimeoutMs);
  const expiresAt = new Date(now.getTime() + params.ttlHours * 3600 * 1000);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(lockKey)}::bigint)`);

    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.companyId, params.companyId),
          eq(idempotencyKeys.userId, params.userId),
          eq(idempotencyKeys.method, params.method),
          eq(idempotencyKeys.path, params.path),
          eq(idempotencyKeys.key, params.key)
        )
      )
      .limit(1);

    if (existing) {
      const isExpired = Boolean(existing.expiresAt && existing.expiresAt.getTime() <= now.getTime());
      if (isExpired) {
        await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      } else {
        if (existing.requestHash && existing.requestHash !== params.requestHash) {
          throw new AppError(
            422,
            "This Idempotency-Key was already used with a different request payload.",
            "IDEMPOTENCY_KEY_REUSE_MISMATCH",
            {
              key: params.key,
              messageEn: "This Idempotency-Key was already used with a different request payload.",
              messageAr: "تم استخدام مفتاح عدم التكرار (Idempotency-Key) مسبقاً مع بيانات مختلفة.",
            }
          );
        }

        if (existing.state === "completed") {
          return {
            kind: "replay" as const,
            statusCode: existing.statusCode ?? 200,
            responseBody: existing.responseBody ?? { ok: true },
          };
        }

        // state === 'in_progress'
        const isStale = Boolean(existing.lockedUntil && existing.lockedUntil.getTime() <= now.getTime());
        if (isStale) {
          await tx
            .update(idempotencyKeys)
            .set({
              requestHash: params.requestHash,
              lockedUntil,
              expiresAt,
              updatedAt: now,
            })
            .where(eq(idempotencyKeys.id, existing.id));
          return { kind: "acquired" as const, recordId: existing.id, recovered: true };
        }

        return { kind: "wait" as const };
      }
    }

    const [created] = await tx
      .insert(idempotencyKeys)
      .values({
        companyId: params.companyId,
        userId: params.userId,
        key: params.key,
        method: params.method,
        path: params.path,
        requestHash: params.requestHash,
        state: "in_progress",
        statusCode: null,
        responseBody: null,
        lockedUntil,
        expiresAt,
        updatedAt: now,
      })
      .returning({ id: idempotencyKeys.id });

    return { kind: "acquired" as const, recordId: created.id, recovered: false };
  });
}

async function releaseInProgressRecord(recordId: string): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    await getDb()
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.id, recordId), eq(idempotencyKeys.state, "in_progress")));
  } catch {
    // Best-effort cleanup; stale lockedUntil recovery guarantees eventual release
  }
}

export function registerIdempotencyHooks(app: FastifyInstance): void {
  app.addHook("onRequest", (req, _reply, done) => {
    req.idempotencyRecordId = null;
    req.idempotencyFinalized = false;
    req.idempotencyReplayed = false;
    done();
  });

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method.toUpperCase() !== "POST") return;
    if (!req.authUser || !isDatabaseConfigured()) return;

    const reqPath = req.url.split("?")[0] ?? "";
    if (isIdempotencyExcludedPath(reqPath)) return;

    const cfg = getIdempotencyConfig();
    const rawHeader = req.headers["idempotency-key"];
    const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const trimmedKey = typeof headerVal === "string" ? headerVal.trim() : "";

    if (!trimmedKey) {
      if (cfg.required && isIdempotencyRequiredForRoute(reqPath, req.body)) {
        throw new AppError(
          400,
          "Idempotency-Key header is required for this operation.",
          "IDEMPOTENCY_KEY_REQUIRED",
          {
            header: "Idempotency-Key",
            path: reqPath,
            messageEn: "Idempotency-Key header is required for this operation.",
            messageAr: "يلزم إرسال ترويسة Idempotency-Key لتنفيذ هذه العملية بأمان.",
          }
        );
      }
      return;
    }

    if (!VALID_IDEMPOTENCY_KEY_RE.test(trimmedKey)) {
      throw new AppError(
        400,
        "Idempotency-Key must be 1 to 128 visible ASCII characters.",
        "INVALID_IDEMPOTENCY_KEY"
      );
    }

    const companyId = req.authUser.activeCompanyId || DEFAULT_COMPANY_ID;
    const userId = req.authUser.id;
    const isMultipart = String(req.headers["content-type"] ?? "").toLowerCase().includes("multipart/form-data");
    const requestHash = computeIdempotencyRequestHash({
      method: "POST",
      path: reqPath,
      query: req.query,
      body: req.body,
      isMultipart,
      contentLength: typeof req.headers["content-length"] === "string" ? req.headers["content-length"] : undefined,
    });

    const deadline = Date.now() + cfg.waitTimeoutMs;
    let pollDelayMs = 40;

    while (true) {
      const outcome = await tryClaimIdempotencyKey({
        companyId,
        userId,
        method: "POST",
        path: reqPath,
        key: trimmedKey,
        requestHash,
        ttlHours: cfg.ttlHours,
        inProgressTimeoutMs: cfg.inProgressTimeoutMs,
      });

      if (outcome.kind === "acquired") {
        req.idempotencyRecordId = outcome.recordId;
        reply.header("idempotency-key", trimmedKey);
        return;
      }

      if (outcome.kind === "replay") {
        req.idempotencyReplayed = true;
        reply.header("idempotency-key", trimmedKey);
        reply.header("idempotency-replayed", "true");
        return reply.status(outcome.statusCode).send(outcome.responseBody);
      }

      if (Date.now() >= deadline) {
        throw new AppError(
          409,
          "A request with this Idempotency-Key is still in progress. Please retry shortly.",
          "IDEMPOTENCY_IN_PROGRESS",
          {
            key: trimmedKey,
            messageEn: "A request with this Idempotency-Key is still in progress. Please retry shortly.",
            messageAr: "لا تزال عملية بنفس مفتاح عدم التكرار قيد التنفيذ، يرجى المحاولة بعد قليل.",
          }
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      pollDelayMs = Math.min(150, Math.round(pollDelayMs * 1.4));
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const recordId = req.idempotencyRecordId;
    if (!recordId || req.idempotencyFinalized || req.idempotencyReplayed) {
      return payload;
    }
    req.idempotencyFinalized = true;

    const statusCode = reply.statusCode;
    // Never cache 5xx, auth/permission rejections (401/403), or transient timeout/rate-limit (408/429)
    if (statusCode >= 500 || statusCode === 401 || statusCode === 403 || statusCode === 408 || statusCode === 429) {
      await releaseInProgressRecord(recordId);
      return payload;
    }

    let parsedBody: unknown = null;
    if (typeof payload === "string") {
      try {
        parsedBody = JSON.parse(payload);
      } catch {
        parsedBody = { raw: payload };
      }
    } else if (Buffer.isBuffer(payload)) {
      try {
        parsedBody = JSON.parse(payload.toString("utf8"));
      } catch {
        parsedBody = { ok: statusCode < 400 };
      }
    } else if (payload !== undefined) {
      parsedBody = payload;
    }

    const scrubbedBody = scrubSecretsFromStoredResponse(parsedBody);
    const cfg = getIdempotencyConfig();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + cfg.ttlHours * 3600 * 1000);

    try {
      await getDb()
        .update(idempotencyKeys)
        .set({
          state: "completed",
          statusCode,
          responseBody: scrubbedBody,
          lockedUntil: null,
          expiresAt,
          updatedAt: now,
        })
        .where(eq(idempotencyKeys.id, recordId));
    } catch {
      // If storing the completed response fails, delete in_progress so it doesn't stay stuck
      await releaseInProgressRecord(recordId);
    }

    return payload;
  });

  app.addHook("onError", async (req, _reply, err) => {
    const recordId = req.idempotencyRecordId;
    if (!recordId || req.idempotencyFinalized) return;
    const statusCode =
      err instanceof AppError
        ? err.statusCode
        : typeof (err as { statusCode?: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
    if (statusCode >= 500 || statusCode === 401 || statusCode === 403 || statusCode === 408 || statusCode === 429) {
      req.idempotencyFinalized = true;
      await releaseInProgressRecord(recordId);
    }
  });

  app.addHook("onResponse", async (req) => {
    const recordId = req.idempotencyRecordId;
    if (recordId && !req.idempotencyFinalized) {
      req.idempotencyFinalized = true;
      await releaseInProgressRecord(recordId);
    }
  });
}
