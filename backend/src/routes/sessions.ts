import type { FastifyInstance } from "fastify";
import { createSessionSchema, patchSessionSchema, upsertSessionItemsSchema } from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  cancelSession,
  completeSession,
  createSession,
  deleteSession,
  listSessions,
  removeSessionItem,
  updateSession,
  upsertSessionItems,
} from "../services/sessions.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sessions", { preHandler: requirePermission("sessions", "view") }, async (req) => {
    const sessions = await listSessions(getDb(), req.authUser!);
    return { sessions };
  });

  app.post("/api/sessions", { preHandler: requirePermission("sessions", "create") }, async (req, reply) => {
    const data = parseOrThrow(createSessionSchema, req.body, "Invalid session payload");
    const session = await createSession(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: session.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ session });
  });

  app.patch("/api/sessions/:id", { preHandler: requirePermission("sessions", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(patchSessionSchema, req.body, "Invalid session update");
    const session = await updateSession(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, actorCompanyId(req.authUser!));
    return { session };
  });

  app.delete("/api/sessions/:id/items/:productId", { preHandler: requirePermission("sessions", "edit") }, async (req) => {
    const { id, productId } = req.params as { id: string; productId: string };
    await removeSessionItem(getDb(), req.authUser!, id, productId);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, actorCompanyId(req.authUser!));
    return { ok: true };
  });

  app.put("/api/sessions/:id/items", { preHandler: requirePermission("sessions", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(upsertSessionItemsSchema, req.body, "Invalid session item counts");
    await upsertSessionItems(getDb(), req.authUser!, id, data);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, actorCompanyId(req.authUser!));
    return { ok: true };
  });

  app.post("/api/sessions/:id/complete", { preHandler: requirePermission("sessions", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const session = await completeSession(getDb(), req.authUser!, id, req.ip);
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { sessionId: id }, companyId);
    return { session };
  });

  app.post("/api/sessions/:id/cancel", { preHandler: requirePermission("sessions", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const session = await cancelSession(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, actorCompanyId(req.authUser!));
    return { session };
  });

  app.delete("/api/sessions/:id", { preHandler: requirePermission("sessions", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteSession(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sessions_updated", { sessionId: id }, actorCompanyId(req.authUser!));
    return { ok: true };
  });
}
