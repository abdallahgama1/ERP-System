import type { FastifyInstance } from "fastify";
import {
  billSchema,
  paymentMadeSchema,
  poSchema,
  purchaseReturnSchema,
  receiveSchema,
  vendorSchema,
} from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  createPaymentMade,
  createPurchaseReturn,
  createVendorBill,
  listPaymentsMade,
  listPurchaseReturns,
  listVendorBills,
  voidPaymentMade,
  voidVendorBill,
} from "../services/payables.service.ts";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  createPurchaseReceive,
  createVendor,
  deletePurchaseOrder,
  deleteVendor,
  issuePurchaseOrder,
  listPurchaseOrders,
  listPurchaseReceives,
  listVendors,
  updatePurchaseOrder,
  updateVendor,
} from "../services/purchasing.service.ts";
import { normalizeVoidReason } from "../services/query-helpers.ts";
import { parseOrThrow } from "../services/stock-locks.ts";

export async function purchaseRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Vendors ----------------
  app.get("/api/vendors", { preHandler: requirePermission("purchases", "view") }, async () => {
    return { vendors: await listVendors(getDb()) };
  });

  app.post("/api/vendors", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(vendorSchema, req.body, "Invalid vendor payload");
    const vendor = await createVendor(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { vendorId: vendor.id });
    return reply.status(201).send({ vendor });
  });

  app.put("/api/vendors/:id", { preHandler: requirePermission("purchases", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(vendorSchema.partial(), req.body, "Invalid vendor update");
    const vendor = await updateVendor(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { vendorId: id });
    return { vendor };
  });

  app.delete("/api/vendors/:id", { preHandler: requirePermission("purchases", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteVendor(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { vendorId: id });
    return { ok: true };
  });

  // ---------------- Purchase Orders ----------------
  app.get("/api/purchase-orders", { preHandler: requirePermission("purchases", "view") }, async (req) => {
    return { purchaseOrders: await listPurchaseOrders(getDb(), req.authUser!) };
  });

  app.post("/api/purchase-orders", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(poSchema, req.body, "Invalid PO payload");
    const purchaseOrder = await createPurchaseOrder(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { poId: purchaseOrder.id });
    return reply.status(201).send({ purchaseOrder });
  });

  app.put("/api/purchase-orders/:id", { preHandler: requirePermission("purchases", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(poSchema, req.body, "Invalid PO update");
    const purchaseOrder = await updatePurchaseOrder(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { poId: id });
    return { purchaseOrder };
  });

  app.post("/api/purchase-orders/:id/issue", { preHandler: requirePermission("purchases", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const purchaseOrder = await issuePurchaseOrder(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { poId: id });
    return { purchaseOrder };
  });

  app.post("/api/purchase-orders/:id/cancel", { preHandler: requirePermission("purchases", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const purchaseOrder = await cancelPurchaseOrder(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { poId: id });
    return { purchaseOrder };
  });

  app.delete("/api/purchase-orders/:id", { preHandler: requirePermission("purchases", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deletePurchaseOrder(getDb(), req.authUser!, id);
    eventBroadcaster.broadcast("purchases_updated", { poId: id });
    return { ok: true };
  });

  // ---------------- Purchase Receives ----------------
  app.get("/api/purchase-receives", { preHandler: requirePermission("purchases", "view") }, async (req) => {
    return { receives: await listPurchaseReceives(getDb(), req.authUser!) };
  });

  app.post("/api/purchase-receives", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(receiveSchema, req.body, "Invalid receive payload");
    const receive = await createPurchaseReceive(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { receiveId: receive.id });
    eventBroadcaster.broadcast("inventory_updated", { receiveId: receive.id });
    return reply.status(201).send({ receive });
  });

  // ---------------- Vendor Bills ----------------
  app.get("/api/vendor-bills", { preHandler: requirePermission("purchases", "view") }, async (req) => {
    return { bills: await listVendorBills(getDb(), req.authUser!) };
  });

  app.post("/api/vendor-bills", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(billSchema, req.body, "Invalid bill payload");
    const bill = await createVendorBill(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { billId: bill.id });
    return reply.status(201).send({ bill });
  });

  app.post("/api/vendor-bills/:id/void", { preHandler: requirePermission("purchases", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const bill = await voidVendorBill(getDb(), req.authUser!, id, normalizeVoidReason(req.body), req.ip);
    eventBroadcaster.broadcast("purchases_updated", { billId: id });
    return { bill };
  });

  // ---------------- Payments Made ----------------
  app.get("/api/payments-made", { preHandler: requirePermission("purchases", "view") }, async () => {
    return { payments: await listPaymentsMade(getDb()) };
  });

  app.post("/api/payments-made", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(paymentMadeSchema, req.body, "Invalid payment payload");
    const payment = await createPaymentMade(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { paymentId: payment.id });
    return reply.status(201).send({ payment });
  });

  app.post("/api/payments-made/:id/void", { preHandler: requirePermission("purchases", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const payment = await voidPaymentMade(getDb(), req.authUser!, id, normalizeVoidReason(req.body), req.ip);
    eventBroadcaster.broadcast("purchases_updated", { paymentId: id });
    return { payment };
  });

  // ---------------- Purchase Returns ----------------
  app.get("/api/purchase-returns", { preHandler: requirePermission("purchases", "view") }, async (req) => {
    return { returns: await listPurchaseReturns(getDb(), req.authUser!) };
  });

  app.post("/api/purchase-returns", { preHandler: requirePermission("purchases", "create") }, async (req, reply) => {
    const data = parseOrThrow(purchaseReturnSchema, req.body, "Invalid purchase return");
    const purchaseReturn = await createPurchaseReturn(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("purchases_updated", { returnId: purchaseReturn.id });
    eventBroadcaster.broadcast("inventory_updated", { returnId: purchaseReturn.id });
    return reply.status(201).send({ purchaseReturn });
  });
}
