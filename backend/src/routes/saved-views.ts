import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import {
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView,
} from "../services/saved-views.service.ts";

export async function savedViewsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/saved-views", { preHandler: requireAuth }, async (req) => {
    const views = await listSavedViews(getDb(), req.authUser!, req.query);
    return { views };
  });

  app.post("/api/saved-views", { preHandler: requireAuth }, async (req, reply) => {
    const view = await createSavedView(getDb(), req.authUser!, req.body);
    return reply.status(201).send({ view });
  });

  app.put("/api/saved-views/:id", { preHandler: requireAuth }, async (req) => {
    const id = (req.params as { id: string }).id;
    const view = await updateSavedView(getDb(), req.authUser!, id, req.body);
    return { view };
  });

  app.delete("/api/saved-views/:id", { preHandler: requireAuth }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteSavedView(getDb(), req.authUser!, id);
    return { ok: true };
  });
}
