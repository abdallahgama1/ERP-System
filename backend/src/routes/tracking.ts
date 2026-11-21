import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { requirePermission } from "../middleware/auth.ts";
import { getSerialTrace, listLots, listSerials } from "../services/lots-serials.service.ts";

export async function trackingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tracking/lots", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const query = req.query as {
      branchId?: string;
      productId?: string;
      includeZero?: string;
      page?: string;
      pageSize?: string;
    };
    const { items, pageInfo } = await listLots(getDb(), req.authUser!, query);
    return { lots: items, items, pageInfo };
  });

  app.get("/api/tracking/serials", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const query = req.query as {
      branchId?: string;
      productId?: string;
      status?: string;
      search?: string;
      q?: string;
      page?: string;
      pageSize?: string;
    };
    const { items, pageInfo } = await listSerials(getDb(), req.authUser!, query);
    return { serials: items, items, pageInfo };
  });

  app.get("/api/tracking/serials/:id/trace", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const { id } = req.params as { id: string };
    return getSerialTrace(getDb(), req.authUser!, id);
  });
}
