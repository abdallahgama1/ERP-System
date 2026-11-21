import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  bindTerminalSchema,
  closeShiftSchema,
  createPosTerminalSchema,
  openShiftSchema,
  pinSwitchSchema,
  posCheckoutSchema,
  posManagerOverrideSchema,
  posSyncBatchSchema,
  setCashierPinSchema,
  shiftCashMovementSchema,
  updatePosTerminalSchema,
} from "@erp/shared";
import { env } from "../config.ts";
import { AppError } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  bindSessionToTerminal,
  lockTerminalSession,
  setUserPosPin,
  switchCashierByPin,
  verifyManagerPinOverride,
} from "../services/pos-auth.service.ts";
import {
  closePosShift,
  createPosCheckout,
  createPosReturn,
  createPosTerminal,
  getActiveShift,
  getPosCatalog,
  getPosReceiptDetail,
  listPosCashiers,
  listPosReceipts,
  listPosTerminals,
  openPosShift,
  recordShiftCashMovement,
  updatePosTerminal,
} from "../services/pos.service.ts";
import { syncOfflinePosBatch } from "../services/pos-sync.service.ts";
import { parseOrThrow } from "../services/stock-locks.ts";

export async function posRoutes(app: FastifyInstance): Promise<void> {
  const pinRateLimit =
    env.NODE_ENV !== "test" && !env.DISABLE_RATE_LIMIT
      ? { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }
      : {};

  // ---------------- Terminals ----------------
  app.get("/api/pos/terminals", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const query = req.query as { branchId?: string };
    const terminals = await listPosTerminals(getDb(), req.authUser!, query.branchId);
    return { terminals };
  });

  app.post("/api/pos/terminals", { preHandler: requirePermission("pos", "edit") }, async (req, reply) => {
    const data = parseOrThrow(createPosTerminalSchema, req.body, "Invalid POS terminal payload");
    const terminal = await createPosTerminal(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { terminalId: terminal.id });
    return reply.status(201).send({ terminal });
  });

  app.put("/api/pos/terminals/:id", { preHandler: requirePermission("pos", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(updatePosTerminalSchema, req.body, "Invalid POS terminal update");
    const terminal = await updatePosTerminal(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { terminalId: id });
    return { terminal };
  });

  // ---------------- Catalog & Cashiers ----------------
  app.get("/api/pos/catalog", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const query = req.query as { branchId?: string };
    const branchId = query.branchId || req.authUser!.defaultBranchId || req.authUser!.branchIds[0];
    if (!branchId) {
      throw new AppError(400, "A branchId is required to load POS catalog", "BRANCH_REQUIRED");
    }
    return getPosCatalog(getDb(), req.authUser!, branchId);
  });

  app.get("/api/pos/cashiers", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const query = req.query as { branchId?: string };
    const cashiers = await listPosCashiers(getDb(), req.authUser!, query.branchId);
    return { cashiers };
  });

  // ---------------- Hybrid PIN & Terminal Lock ----------------
  app.put("/api/users/:id/pos-pin", { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(setCashierPinSchema, req.body, "Invalid POS PIN");
    return setUserPosPin(getDb(), req.authUser!, id, data.pin, req.ip);
  });

  app.post("/api/pos/terminal/bind", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const data = parseOrThrow(bindTerminalSchema, req.body, "Invalid terminal bind payload");
    if (!req.authSessionId) throw new AppError(401, "Session not found", "UNAUTHORIZED");
    const bound = await bindSessionToTerminal(getDb(), req.authSessionId, req.authUser!, data.terminalId, req.ip);
    return { terminal: bound };
  });

  app.post("/api/pos/terminal/lock", { preHandler: requireAuth }, async (req) => {
    if (!req.authSessionId) throw new AppError(401, "Session not found", "UNAUTHORIZED");
    return lockTerminalSession(getDb(), req.authSessionId, req.authUser!, req.posTerminalId, req.ip);
  });

  app.post(
    "/api/pos/terminal/pin-switch",
    { ...pinRateLimit, preHandler: requireAuth },
    async (req) => {
      if (!req.authSessionId) throw new AppError(401, "Session not found", "UNAUTHORIZED");
      const data = parseOrThrow(pinSwitchSchema, req.body, "Invalid PIN payload");
      const targetTerminalId = data.terminalId ?? req.posTerminalId;
      return switchCashierByPin(getDb(), {
        sessionId: req.authSessionId,
        terminalId: targetTerminalId,
        pin: data.pin,
        cashierId: data.userId,
        ipAddress: req.ip,
      });
    }
  );

  // ---------------- Shifts ----------------
  app.get("/api/pos/shifts/active", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const query = req.query as { terminalId?: string };
    const terminalId = query.terminalId || req.posTerminalId;
    if (!terminalId) {
      throw new AppError(400, "terminalId is required", "TERMINAL_REQUIRED");
    }
    const shift = await getActiveShift(getDb(), req.authUser!, terminalId);
    return { shift };
  });

  app.post("/api/pos/shifts/open", { preHandler: requirePermission("pos", "create") }, async (req, reply) => {
    const data = parseOrThrow(openShiftSchema, req.body, "Invalid shift open payload");
    const shift = await openPosShift(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { shiftId: shift.id });
    return reply.status(201).send({ shift });
  });

  app.post("/api/pos/shifts/:id/cash-movement", { preHandler: requirePermission("pos", "create") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(shiftCashMovementSchema, req.body, "Invalid cash movement payload");
    const movement = await recordShiftCashMovement(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { shiftId: id });
    return reply.status(201).send({ movement });
  });

  app.post("/api/pos/shifts/:id/close", { preHandler: requirePermission("pos", "create") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parseOrThrow(closeShiftSchema, req.body, "Invalid shift close payload");
    const shift = await closePosShift(getDb(), req.authUser!, id, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { shiftId: id });
    eventBroadcaster.broadcast("accounting_updated", { shiftId: id });
    return { shift };
  });

  // ---------------- Checkout & Offline Sync ----------------
  app.post("/api/pos/checkout", { preHandler: requirePermission("pos", "create") }, async (req, reply) => {
    const data = parseOrThrow(posCheckoutSchema, req.body, "Invalid POS checkout payload");
    const receipt = await createPosCheckout(getDb(), req.authUser!, data, req.ip);
    eventBroadcaster.broadcast("pos_updated", { invoiceId: receipt.id });
    eventBroadcaster.broadcast("sales_updated", { invoiceId: receipt.id });
    eventBroadcaster.broadcast("inventory_updated", { invoiceId: receipt.id });
    eventBroadcaster.broadcast("accounting_updated", { invoiceId: receipt.id });
    return reply.status(201).send({ receipt });
  });

  app.post("/api/pos/sync", { preHandler: requirePermission("pos", "create") }, async (req) => {
    const data = parseOrThrow(posSyncBatchSchema, req.body, "Invalid POS sync batch payload");
    const response = await syncOfflinePosBatch(getDb(), req.authUser!, data, req.ip);
    const syncedCount = response.results.filter(
      (r) => r.status === "synced" || r.status === "reconciled_conflict"
    ).length;
    if (syncedCount > 0) {
      eventBroadcaster.broadcast("pos_updated", { syncedCount });
      eventBroadcaster.broadcast("sales_updated", { syncedCount });
      eventBroadcaster.broadcast("inventory_updated", { syncedCount });
      eventBroadcaster.broadcast("accounting_updated", { syncedCount });
      eventBroadcaster.broadcast("notifications_updated", { syncedCount });
    }
    return response;
  });

  // ---------------- Manager Override Verification ----------------
  const handleVerifyOverride = async (req: FastifyRequest) => {
    const data = parseOrThrow(posManagerOverrideSchema, req.body, "Invalid manager override payload");
    const actor = req.authUser!;
    return verifyManagerPinOverride(getDb(), {
      pin: data.pin,
      managerUserId: data.managerUserId,
      terminalId: data.terminalId ?? req.posTerminalId ?? undefined,
      action: data.action,
      reason: data.reason,
      requestedByUserId: actor.id,
      requestedByName: actor.name,
      requestedByRole: actor.role,
      branchIds: actor.branchIds,
      hasAllBranchScope: actor.role === "admin" || actor.branchScopeMode === "all",
      ipAddress: req.ip,
    });
  };

  app.post(
    "/api/pos/override/verify",
    { ...pinRateLimit, preHandler: requirePermission("pos", "view") },
    handleVerifyOverride
  );

  app.post(
    "/api/pos/manager-override",
    { ...pinRateLimit, preHandler: requirePermission("pos", "view") },
    handleVerifyOverride
  );

  // ---------------- Receipts & Returns ----------------
  app.get("/api/pos/receipts", { preHandler: requirePermission("pos", "view") }, async (req) => {
    return listPosReceipts(getDb(), req.authUser!, req.query);
  });

  app.get("/api/pos/receipts/:id", { preHandler: requirePermission("pos", "view") }, async (req) => {
    const { id } = req.params as { id: string };
    return getPosReceiptDetail(getDb(), req.authUser!, id);
  });

  app.post("/api/pos/returns", { preHandler: requirePermission("pos", "create") }, async (req, reply) => {
    const result = await createPosReturn(getDb(), req.authUser!, req.body, req.ip);
    eventBroadcaster.broadcast("pos_updated", { posReturnId: result.posReturn.id });
    eventBroadcaster.broadcast("sales_updated", { posReturnId: result.posReturn.id });
    eventBroadcaster.broadcast("inventory_updated", { posReturnId: result.posReturn.id });
    eventBroadcaster.broadcast("accounting_updated", { posReturnId: result.posReturn.id });
    return reply.status(201).send(result);
  });
}
