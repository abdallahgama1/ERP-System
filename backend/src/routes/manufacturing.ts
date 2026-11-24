import {
  cancelWorkOrderSchema,
  completeWorkOrderSchema,
  createBomSchema,
  createWorkOrderSchema,
  issueWorkOrderSchema,
  updateBomSchema,
} from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  cancelWorkOrder,
  completeWorkOrder,
  createBom,
  createWorkOrder,
  issueWorkOrderMaterials,
  listBoms,
  listWorkOrders,
  updateBom,
} from "../services/manufacturing.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

export async function manufacturingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/manufacturing/boms", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const boms = await listBoms(getDb(), req.authUser!);
    return { boms };
  });

  app.post("/api/manufacturing/boms", { preHandler: requirePermission("inventory", "create") }, async (req, reply) => {
    const data = parseOrThrow(createBomSchema, req.body);
    const bom = await createBom(getDb(), req.authUser!, data, req.ip);
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("manufacturing_updated", { bomId: bom.id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { productId: bom.productId }, companyId);
    return reply.status(201).send({ bom });
  });

  app.put("/api/manufacturing/boms/:id", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(updateBomSchema, req.body);
    const bom = await updateBom(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("manufacturing_updated", { bomId: bom.id }, actorCompanyId(req.authUser!));
    return { bom };
  });

  app.get("/api/manufacturing/work-orders", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const workOrders = await listWorkOrders(getDb(), req.authUser!);
    return { workOrders };
  });

  app.post("/api/manufacturing/work-orders", { preHandler: requirePermission("inventory", "create") }, async (req, reply) => {
    const data = parseOrThrow(createWorkOrderSchema, req.body);
    const workOrder = await createWorkOrder(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("manufacturing_updated", { workOrderId: workOrder.id }, actorCompanyId(req.authUser!));
    return reply.status(201).send({ workOrder });
  });

  app.post("/api/manufacturing/work-orders/:id/issue", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(issueWorkOrderSchema, req.body ?? {});
    const workOrder = await issueWorkOrderMaterials(getDb(), req.authUser!, id, data, req.ip);
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("manufacturing_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("tracking_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("accounting_updated", { workOrderId: id }, companyId);
    return { workOrder };
  });

  app.post("/api/manufacturing/work-orders/:id/complete", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(completeWorkOrderSchema, req.body);
    const workOrder = await completeWorkOrder(getDb(), req.authUser!, id, data, req.ip);
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("manufacturing_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("tracking_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("accounting_updated", { workOrderId: id }, companyId);
    return { workOrder };
  });

  app.post("/api/manufacturing/work-orders/:id/cancel", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(cancelWorkOrderSchema, req.body ?? {});
    const workOrder = await cancelWorkOrder(getDb(), req.authUser!, id, data, req.ip);
    const companyId = actorCompanyId(req.authUser!);
    eventBroadcaster.broadcast("manufacturing_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("inventory_updated", { workOrderId: id }, companyId);
    eventBroadcaster.broadcast("accounting_updated", { workOrderId: id }, companyId);
    return { workOrder };
  });
}
