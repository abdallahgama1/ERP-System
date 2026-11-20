import type { FastifyInstance } from "fastify";
import {
  adjustBranchLevelSchema,
  adjustmentSchema,
  createProductSchema,
  createTransferSchema,
  receiveTransferSchema,
  updateProductSchema,
  writeOffSchema,
} from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  adjustBranchProductLevel,
  createProduct,
  deleteProduct,
  listProducts,
  updateProduct,
} from "../services/products.service.ts";
import { parseOrThrow } from "../services/stock-locks.ts";
import { createAdjustment, createWriteOff, listAdjustments, listMovements, listWriteOffs } from "../services/stock-ops.service.ts";
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  listTransfers,
  receiveTransfer,
} from "../services/transfers.service.ts";

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Products ----------------
  app.get("/api/products", { preHandler: requirePermission("products", "view") }, async (req) => {
    return listProducts(getDb(), req.authUser!);
  });

  app.post("/api/products", { preHandler: requirePermission("products", "create") }, async (req, reply) => {
    const data = parseOrThrow(createProductSchema, req.body, "Invalid product data");
    const product = await createProduct(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { productId: product.id });
    return reply.status(201).send({ product });
  });

  app.put("/api/products/:id", { preHandler: requirePermission("products", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(updateProductSchema, req.body, "Invalid product update");
    const product = await updateProduct(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { productId: product.id });
    return { product };
  });

  app.delete("/api/products/:id", { preHandler: requirePermission("products", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteProduct(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { productId: id });
    return { ok: true };
  });

  app.post("/api/branch-products/adjust-level", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const data = parseOrThrow(adjustBranchLevelSchema, req.body, "Invalid stock level payload");
    await adjustBranchProductLevel(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated");
    return { ok: true };
  });

  // ---------------- Movements ----------------
  app.get("/api/movements", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const query = req.query as { branchId?: string; productId?: string; limit?: string };
    const movements = await listMovements(getDb(), req.authUser!, query);
    return { movements };
  });

  // ---------------- Adjustments ----------------
  app.get("/api/adjustments", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const adjustments = await listAdjustments(getDb(), req.authUser!);
    return { adjustments };
  });

  app.post("/api/adjustments", { preHandler: requirePermission("inventory", "create") }, async (req, reply) => {
    const data = parseOrThrow(adjustmentSchema, req.body, "Invalid adjustment");
    const adjustment = await createAdjustment(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { adjustmentId: adjustment.id });
    return reply.status(201).send({ adjustment });
  });

  // ---------------- Write-Offs ----------------
  app.get("/api/write-offs", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const writeOffs = await listWriteOffs(getDb(), req.authUser!);
    return { writeOffs };
  });

  app.post("/api/write-offs", { preHandler: requirePermission("inventory", "create") }, async (req, reply) => {
    const data = parseOrThrow(writeOffSchema, req.body, "Invalid write-off");
    const writeOff = await createWriteOff(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { writeOffId: writeOff.id });
    return reply.status(201).send({ writeOff });
  });

  // ---------------- Transfers ----------------
  app.get("/api/transfers", { preHandler: requirePermission("inventory", "view") }, async (req) => {
    const transfers = await listTransfers(getDb(), req.authUser!);
    return { transfers };
  });

  app.post("/api/transfers", { preHandler: requirePermission("inventory", "create") }, async (req, reply) => {
    const data = parseOrThrow(createTransferSchema, req.body, "Invalid transfer payload");
    const transfer = await createTransfer(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { transferId: transfer.id });
    return reply.status(201).send({ transfer });
  });

  app.post("/api/transfers/:id/dispatch", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const transfer = await dispatchTransfer(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { transferId: id });
    return { transfer };
  });

  app.post("/api/transfers/:id/receive", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(receiveTransferSchema, req.body, "Invalid transfer receipt");
    const transfer = await receiveTransfer(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { transferId: id });
    return { transfer };
  });

  app.post("/api/transfers/:id/cancel", { preHandler: requirePermission("inventory", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const transfer = await cancelTransfer(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("inventory_updated", { transferId: id });
    return { transfer };
  });
}
