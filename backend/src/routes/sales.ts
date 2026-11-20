import type { FastifyInstance } from "fastify";
import {
  applyAmountSchema,
  customerSchema,
  fulfillSalesOrderSchema,
  invoiceSchema,
  receivedPaymentSchema,
  retainerSchema,
  salesOrderSchema,
  salesReturnSchema,
} from "@erp/shared";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  createSalesInvoice,
  listSalesInvoices,
  sendSalesInvoice,
  voidSalesInvoice,
} from "../services/invoices.service.ts";
import { normalizeVoidReason } from "../services/query-helpers.ts";
import {
  applyRetainer,
  applySalesReturnCredit,
  cancelRetainerInvoice,
  createReceivedPayment,
  createRetainerInvoice,
  createSalesReturn,
  deleteRetainerInvoice,
  listReceivedPayments,
  listRetainerInvoices,
  listSalesReturns,
  recordRetainerPayment,
  sendRetainerInvoice,
  voidReceivedPayment,
} from "../services/receivables.service.ts";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
  deleteCustomer,
  deleteSalesOrder,
  fulfillSalesOrder,
  listCustomers,
  listSalesOrders,
  updateCustomer,
  updateSalesOrder,
} from "../services/sales-orders.service.ts";
import { parseOrThrow } from "../services/stock-locks.ts";

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Customers ----------------
  app.get("/api/customers", { preHandler: requirePermission("sales", "view") }, async () => {
    return { customers: await listCustomers(getDb()) };
  });

  app.post("/api/customers", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(customerSchema, req.body, "Invalid customer payload");
    const customer = await createCustomer(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { customerId: customer.id });
    return reply.status(201).send({ customer });
  });

  app.put("/api/customers/:id", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(customerSchema.partial(), req.body, "Invalid customer update");
    const customer = await updateCustomer(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { customerId: id });
    return { customer };
  });

  app.delete("/api/customers/:id", { preHandler: requirePermission("sales", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteCustomer(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { customerId: id });
    return { ok: true };
  });

  // ---------------- Sales Orders ----------------
  app.get("/api/sales-orders", { preHandler: requirePermission("sales", "view") }, async (req) => {
    return { salesOrders: await listSalesOrders(getDb(), req.authUser!) };
  });

  app.post("/api/sales-orders", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(salesOrderSchema, req.body, "Invalid sales order payload");
    const salesOrder = await createSalesOrder(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { soId: salesOrder.id });
    return reply.status(201).send({ salesOrder });
  });

  app.put("/api/sales-orders/:id", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(salesOrderSchema, req.body, "Invalid sales order update");
    const salesOrder = await updateSalesOrder(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { soId: id });
    return { salesOrder };
  });

  app.post("/api/sales-orders/:id/confirm", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const salesOrder = await confirmSalesOrder(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { soId: id });
    return { salesOrder };
  });

  app.post("/api/sales-orders/:id/fulfill", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(fulfillSalesOrderSchema, req.body, "Invalid fulfillment payload");
    const salesOrder = await fulfillSalesOrder(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { soId: id });
    eventBroadcaster.broadcast("inventory_updated", { soId: id });
    return { salesOrder };
  });

  app.post("/api/sales-orders/:id/cancel", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const salesOrder = await cancelSalesOrder(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { soId: id });
    return { salesOrder };
  });

  app.delete("/api/sales-orders/:id", { preHandler: requirePermission("sales", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteSalesOrder(getDb(), req.authUser!, id);
    eventBroadcaster.broadcast("sales_updated", { soId: id });
    return { ok: true };
  });

  // ---------------- Sales Invoices ----------------
  app.get("/api/sales-invoices", { preHandler: requirePermission("sales", "view") }, async (req) => {
    return { invoices: await listSalesInvoices(getDb(), req.authUser!) };
  });

  app.post("/api/sales-invoices", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(invoiceSchema, req.body, "Invalid invoice payload");
    const invoice = await createSalesInvoice(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { invoiceId: invoice.id });
    eventBroadcaster.broadcast("inventory_updated", { invoiceId: invoice.id });
    return reply.status(201).send({ invoice });
  });

  app.post("/api/sales-invoices/:id/send", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const invoice = await sendSalesInvoice(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { invoiceId: id });
    eventBroadcaster.broadcast("inventory_updated", { invoiceId: id });
    return { invoice };
  });

  app.post("/api/sales-invoices/:id/void", { preHandler: requirePermission("sales", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const invoice = await voidSalesInvoice(getDb(), req.authUser!, id, normalizeVoidReason(req.body), req.ip);
    eventBroadcaster.broadcast("sales_updated", { invoiceId: id });
    eventBroadcaster.broadcast("inventory_updated", { invoiceId: id });
    return { invoice };
  });

  // ---------------- Received Payments ----------------
  app.get("/api/received-payments", { preHandler: requirePermission("sales", "view") }, async () => {
    return { payments: await listReceivedPayments(getDb()) };
  });

  app.post("/api/received-payments", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(receivedPaymentSchema, req.body, "Invalid payment payload");
    const payment = await createReceivedPayment(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { paymentId: payment.id });
    return reply.status(201).send({ payment });
  });

  app.post("/api/received-payments/:id/void", { preHandler: requirePermission("sales", "approve") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const payment = await voidReceivedPayment(getDb(), req.authUser!, id, normalizeVoidReason(req.body), req.ip);
    eventBroadcaster.broadcast("sales_updated", { paymentId: id });
    return { payment };
  });

  // ---------------- Sales Returns & Credit Notes ----------------
  app.get("/api/sales-returns", { preHandler: requirePermission("sales", "view") }, async (req) => {
    return { returns: await listSalesReturns(getDb(), req.authUser!) };
  });

  app.post("/api/sales-returns", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(salesReturnSchema, req.body, "Invalid sales return");
    const salesReturn = await createSalesReturn(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { returnId: salesReturn.id });
    eventBroadcaster.broadcast("inventory_updated", { returnId: salesReturn.id });
    return reply.status(201).send({ salesReturn });
  });

  app.post("/api/sales-returns/:id/apply", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(applyAmountSchema, req.body, "Invalid credit application amount");
    await applySalesReturnCredit(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { returnId: id });
    return { ok: true };
  });

  // ---------------- Retainer Invoices ----------------
  app.get("/api/retainer-invoices", { preHandler: requirePermission("sales", "view") }, async () => {
    return { retainers: await listRetainerInvoices(getDb()) };
  });

  app.post("/api/retainer-invoices", { preHandler: requirePermission("sales", "create") }, async (req, reply) => {
    const data = parseOrThrow(retainerSchema, req.body, "Invalid retainer payload");
    const retainer = await createRetainerInvoice(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: retainer.id });
    return reply.status(201).send({ retainer });
  });

  app.post("/api/retainer-invoices/:id/send", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const retainer = await sendRetainerInvoice(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: id });
    return { retainer };
  });

  app.post("/api/retainer-invoices/:id/cancel", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const retainer = await cancelRetainerInvoice(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: id });
    return { retainer };
  });

  app.delete("/api/retainer-invoices/:id", { preHandler: requirePermission("sales", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteRetainerInvoice(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: id });
    return { ok: true };
  });

  app.post("/api/retainer-invoices/:id/record-payment", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const retainer = await recordRetainerPayment(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: id });
    return { retainer };
  });

  app.post("/api/retainer-invoices/:id/apply", { preHandler: requirePermission("sales", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const data = parseOrThrow(applyAmountSchema, req.body, "Invalid retainer application");
    await applyRetainer(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("sales_updated", { retainerId: id });
    return { ok: true };
  });
}
