import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { notifications, notificationUserStates } from "../../drizzle/schema.ts";
import { AppError } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";

const batchReadSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notifications", { preHandler: requireAuth }, async (req) => {
    const actor = req.authUser!;
    const db = getDb();

    const branchFilter =
      actor.role === "admin" || actor.branchScopeMode === "all"
        ? undefined
        : actor.branchIds.length > 0
          ? or(isNull(notifications.branchId), inArray(notifications.branchId, actor.branchIds))
          : isNull(notifications.branchId);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          or(isNull(notifications.userId), eq(notifications.userId, actor.id)),
          branchFilter
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(100);

    const states = await db
      .select()
      .from(notificationUserStates)
      .where(eq(notificationUserStates.userId, actor.id));

    const stateMap = new Map(states.map((s) => [s.notificationId, s]));

    return {
      notifications: rows
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
        })),
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

    const ids = parsed.success && parsed.data.ids?.length
      ? parsed.data.ids
      : (
          await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(or(isNull(notifications.userId), eq(notifications.userId, actor.id)))
            .limit(100)
        ).map((n) => n.id);

    for (const notificationId of ids) {
      await db
        .insert(notificationUserStates)
        .values({ notificationId, userId: actor.id, readAt: now })
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
