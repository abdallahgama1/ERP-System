import { encodeCursor, type SortDirection } from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditLogs } from "../../drizzle/schema.ts";
import { AppError, verifyAuditLogChain, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { assertBranchAccess, requireAdminOrSmokeMonitor, requireAuth, requirePermission } from "../middleware/auth.ts";
import { buildKeysetCondition, parseCursorOrThrow } from "../services/query-helpers.ts";

export const CLIENT_AUDIT_ALLOWED_ACTIONS = [
  "ui.export_downloaded",
  "ui.document_printed",
  "ui.report_viewed",
  "ui.barcode_scanned",
  "pos.receipt_reprinted",
  "pos.drawer_opened",
] as const;

export type ClientAuditAllowedAction = (typeof CLIENT_AUDIT_ALLOWED_ACTIONS)[number];

const CLIENT_AUDIT_ALLOWED_ACTION_SET = new Set<string>(CLIENT_AUDIT_ALLOWED_ACTIONS);

const createAuditSchema = z.object({
  module: z.string().trim().min(1).max(60),
  action: z.string().trim().min(1).max(160),
  entity: z.string().trim().max(160).optional(),
  entityId: z.string().trim().max(120).optional(),
  branchId: z.string().uuid().nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/audit-logs/verify", { preHandler: requireAdminOrSmokeMonitor() }, async (req) => {
    const actor = req.authUser!;
    return verifyAuditLogChain(getDb(), actor.activeCompanyId);
  });

  app.get("/api/audit-logs", { preHandler: requirePermission("audit", "view") }, async (req) => {
    const query = req.query as {
      cursor?: string;
      limit?: string;
      offset?: string;
      sortDir?: string;
      module?: string;
      branchId?: string;
      userId?: string;
      action?: string;
      fromDate?: string;
      toDate?: string;
      q?: string;
    };
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? "50", 10) || 50));
    const offset = query.cursor ? 0 : Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
    const sortDir: SortDirection = query.sortDir === "asc" ? "asc" : "desc";
    const cursor = parseCursorOrThrow(query.cursor);
    const actor = req.authUser!;
    const db = getDb();

    const conditions: SQL[] = [eq(auditLogs.companyId, actor.activeCompanyId)];
    if (query.module && query.module !== "all") {
      conditions.push(eq(auditLogs.entityType, query.module));
    }
    if (query.branchId) {
      assertBranchAccess(actor, query.branchId);
      conditions.push(eq(auditLogs.branchId, query.branchId));
    } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
      if (actor.branchIds.length === 0) {
        conditions.push(isNull(auditLogs.branchId));
      } else {
        conditions.push(or(isNull(auditLogs.branchId), inArray(auditLogs.branchId, actor.branchIds))!);
      }
    }
    if (query.userId) conditions.push(eq(auditLogs.userId, query.userId));
    if (query.action) conditions.push(ilike(auditLogs.action, `%${query.action.trim()}%`));
    if (query.fromDate) conditions.push(gte(auditLogs.createdAt, new Date(query.fromDate)));
    if (query.toDate) conditions.push(lte(auditLogs.createdAt, new Date(query.toDate)));
    if (query.q?.trim()) {
      const pattern = `%${query.q.trim()}%`;
      conditions.push(
        or(
          ilike(auditLogs.action, pattern),
          ilike(auditLogs.entityLabel, pattern),
          ilike(auditLogs.userName, pattern),
          ilike(auditLogs.entityType, pattern)
        )!
      );
    }
    if (cursor) {
      conditions.push(buildKeysetCondition(auditLogs.createdAt, auditLogs.id, cursor, sortDir));
    }

    const orderDir = sortDir === "asc" ? asc : desc;
    const rawRows = await db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(orderDir(auditLogs.createdAt), orderDir(auditLogs.id))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rawRows.length > limit;
    const rows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const last = rows[rows.length - 1];

    const entries = rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      at: r.createdAt.toISOString(),
      actorUserId: r.userId ?? null,
      module: r.entityType,
      action: r.action,
      entity: r.entityLabel ?? r.entityId,
      entityId: r.entityId,
      user: r.userName,
      userRole: r.userRole ?? null,
      branchId: r.branchId ?? null,
      meta: r.details,
      beforeJson: r.beforeJson ?? null,
      afterJson: r.afterJson ?? null,
      changedFields: r.changedFields ?? [],
    }));

    return {
      entries,
      items: entries,
      pageInfo: {
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
        limit,
      },
    };
  });

  app.post("/api/audit-logs", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createAuditSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid audit log entry", "VALIDATION_ERROR");
    }

    if (!CLIENT_AUDIT_ALLOWED_ACTION_SET.has(parsed.data.action)) {
      throw new AppError(
        400,
        `Client audit action '${parsed.data.action}' is not allowed`,
        "AUDIT_ACTION_NOT_ALLOWED"
      );
    }

    const actor = req.authUser!;
    if (parsed.data.branchId) {
      assertBranchAccess(actor, parsed.data.branchId);
    }

    const db = getDb();
    await writeAuditLog(db, {
      companyId: actor.activeCompanyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: parsed.data.branchId ?? null,
      action: parsed.data.action,
      entityType: parsed.data.module,
      entityId: parsed.data.entityId ?? parsed.data.module,
      entityLabel: parsed.data.entity ?? null,
      details: parsed.data.meta ?? {},
      ipAddress: req.ip,
    });

    return reply.status(201).send({ ok: true });
  });
}
