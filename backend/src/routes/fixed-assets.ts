import {
  createFixedAssetSchema,
  disposeFixedAssetSchema,
  runDepreciationSchema,
} from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requirePermission } from "../middleware/auth.ts";
import {
  createFixedAsset,
  disposeFixedAsset,
  getFixedAssetSchedule,
  listFixedAssets,
  runMonthlyDepreciation,
} from "../services/fixed-assets.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function fixedAssetsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/fixed-assets", { preHandler: requirePermission("fixed_assets", "view") }, async (req) => {
    const assets = await listFixedAssets(getDb(), req.authUser!);
    return { assets };
  });

  app.get(
    "/api/fixed-assets/:id/schedule",
    { preHandler: requirePermission("fixed_assets", "view") },
    async (req) => {
      const { id } = req.params as { id: string };
      return getFixedAssetSchedule(getDb(), req.authUser!, id);
    }
  );

  app.post(
    "/api/fixed-assets",
    { preHandler: requirePermission("fixed_assets", "create") },
    async (req, reply) => {
      const data = parseOrThrow(createFixedAssetSchema, req.body, "Invalid fixed asset payload");
      if (data.branchId) assertBranchAccess(req.authUser!, data.branchId);
      const asset = await createFixedAsset(getDb(), req.authUser!, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("fixed_assets_updated", { assetId: asset.id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return reply.status(201).send({ asset });
    }
  );

  app.post(
    "/api/fixed-assets/depreciate",
    { preHandler: requirePermission("fixed_assets", "approve") },
    async (req) => {
      const data = parseOrThrow(runDepreciationSchema, req.body, "Invalid depreciation run payload");
      const result = await runMonthlyDepreciation(getDb(), req.authUser!, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("fixed_assets_updated", { periodKey: data.periodKey }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return result;
    }
  );

  app.post(
    "/api/fixed-assets/:id/dispose",
    { preHandler: requirePermission("fixed_assets", "approve") },
    async (req) => {
      const { id } = req.params as { id: string };
      const data = parseOrThrow(disposeFixedAssetSchema, req.body, "Invalid asset disposal payload");
      const asset = await disposeFixedAsset(getDb(), req.authUser!, id, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("fixed_assets_updated", { assetId: id }, companyId);
      eventBroadcaster.broadcast("accounting_updated", {}, companyId);
      return { asset };
    }
  );
}
