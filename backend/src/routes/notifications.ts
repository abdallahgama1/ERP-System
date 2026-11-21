import { encodeCursor } from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { notifications, notificationUserStates } from "../../drizzle/schema.ts";
import { AppError } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { buildKeysetCondition, parseCursorOrThrow } from "../services/query-helpers.ts";

const batchReadSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications", { preHandler: requireAuth }, async (req) => {
    const actor = req.authUser!;
    const db = getDb();
    const query = req.query as { cursor?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit ?? "100", 10) || 100));
    const cursor = parseCursorOrThrow(query.cursor);

    const branchFilter =
      actor.role === "admin" || actor.branchScopeMode === "all"
        ? undefined
        : actor.branchIds.length > 0
          ? or(isNull(notifications.branchId), inArray(notifications.branchId, actor.branchIds))
          : isNull(notifications.branchId);

    const conds: SQL[] = [or(isNull(notifications.userId), eq(notifications.userId, actor.id))!];
    if (branchFilter) conds.push(branchFilter);
    if (cursor) conds.push(buildKeysetCondition(notifications.createdAt, notifications.id, cursor, "desc"));

    const rawRows = await db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    const hasMore = rawRows.length > limit;
    const rows = hasMore ? rawRows.slice(0, limit) : rawRows;
    const last = rows[rows.length - 1];

    const states =
      rows.length > 0
        ? await db
            .select()
            .from(notificationUserStates)
            .where(
              and(
                eq(notificationUserStates.userId, actor.id),
                inArray(notificationUserStates.notificationId, rows.map((r) => r.id))
              )
            )
        : [];

    const stateMap = new Map(states.map((s) => [s.notificationId, s]));

    const items = rows
      .filter((n) => !stateMap.get(n.id)?.dismissedAt)
      .map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        branchId: n.branchId,
        entityType: n.entityType,
        entityId: n.entityId,
        createdAt: n.createdAt.toISOString(),
        readAt: stateMap.get(n.id)?.readAt?.toISOString() ?? null,
      }));

    return {
      notifications: items,
      items,
      pageInfo: {
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
        limit,
      },
    };
  });

  app.post("/api/notifications/:id/read", { preHandler: requireAuth }, async (req) => {
    const id = (req.params as { id: string }).id;
    const actor = req.authUser!;
    const db = getDb();
    const now = new Date();

    const [exists] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id)).limit(1);
    if (!exists) throw new AppError(404, "Notification not found", "NOT_FOUND");

    await db
      .insert(notificationUserStates)
      .values({ notificationId: id, userId: actor.id, readAt: now })
      .onConflictDoUpdate({
        target: [notificationUserStates.notificationId, notificationUserStates.userId],
        set: { readAt: now },
      });

    return { ok: true };
  });

  app.post("/api/notifications/read-all", { preHandler: requireAuth }, async (req) => {
    const parsed = batchReadSchema.safeParse(req.body ?? {});
    const actor = req.authUser!;
    const db = getDb();
    const now = new Date();

    const ids =
      parsed.success && parsed.data.ids?.length
        ? parsed.data.ids
        : (
            await db
              .select({ id: notifications.id })
              .from(notifications)
              .where(or(isNull(notifications.userId), eq(notifications.userId, actor.id)))
              .limit(200)
          ).map((n) => n.id);

    if (ids.length > 0) {
      await db
        .insert(notificationUserStates)
        .values(ids.map((notificationId) => ({ notificationId, userId: actor.id, readAt: now })))
        .onConflictDoUpdate({
          target: [notificationUserStates.notificationId, notificationUserStates.userId],
          set: { readAt: now },
        });
    }

    return { ok: true };
  });

  app.post("/api/notifications/:id/dismiss", { preHandler: requireAuth }, async (req) => {
    const id = (req.params as { id: string }).id;
    const actor = req.authUser!;
    const db = getDb();
    const now = new Date();

    await db
      .insert(notificationUserStates)
      .values({ notificationId: id, userId: actor.id, dismissedAt: now })
      .onConflictDoUpdate({
        target: [notificationUserStates.notificationId, notificationUserStates.userId],
        set: { dismissedAt: now },
      });

    return { ok: true };
  });
}
