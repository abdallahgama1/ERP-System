import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { runGlobalSearch } from "../services/search.service.ts";

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/search", { preHandler: requireAuth }, async (req) => {
    return runGlobalSearch(getDb(), req.authUser!, req.query);
  });
}
