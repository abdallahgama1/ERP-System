import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { auditLogs } from "../../drizzle/schema.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";

const createAuditSchema = z.object({
  module: z.string().trim().min(1).max(60),
  action: z.string().trim().min(1).max(160),
  entity: z.string().trim().max(160).optional(),
  entityId: z.string().trim().max(120).optional(),
  branchId: z.string().uuid().nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/audit-logs", { preHandler: requirePermission("reports", "view") }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; module?: string };
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "250", 10) || 250));
    const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
    const actor = req.authUser!;
    const db = getDb();

    const conditions = [];
    if (query.module && query.module !== "all") {
      conditions.push(eq(auditLogs.entityType, query.module));
    }

    if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
      if (actor.branchIds.length === 0) {
        conditions.push(isNull(auditLogs.branchId));
      } else {
        conditions.push(or(isNull(auditLogs.branchId), inArray(auditLogs.branchId, actor.branchIds)));
      }
    }

    const rows = await db
      .select()
      .from(auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      entries: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        actorUserId: r.userId ?? undefined,
        module: r.entityType,
        action: r.action,
        entity: r.entityLabel ?? undefined,
        entityId: r.entityId,
        user: r.userName,
        branchId: r.branchId ?? undefined,
        meta: r.details,
      })),
    };
  });

  app.post("/api/audit-logs", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createAuditSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid audit log entry", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const db = getDb();
    await writeAuditLog(db, {
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
