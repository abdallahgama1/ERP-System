import {
  roundCurrency,
  type PickingStrategyShared,
  type SerialStatusShared,
  type TrackingModeShared,
} from "@erp/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  branches,
  branchLotBalances,
  products,
  stockLots,
  stockMovementAllocations,
  stockMovements,
  stockSerials,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num, toNumeric } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import type { RequestActor } from "./stock-locks.ts";

export interface TrackedProductMeta {
  id: string;
  name: string;
  sku: string;
  trackingMode: TrackingModeShared;
  trackLots: boolean;
  trackSerials: boolean;
  requiresExpiry: boolean;
  shelfLifeDays: number | null;
  pickingStrategy: PickingStrategyShared;
}

export interface LotAllocationRequest {
  lotId?: string;
  lotNumber?: string;
  quantity: number;
}

export interface ConsumedAllocation {
  lotId?: string | null;
  lotNumber?: string | null;
  serialId?: string | null;
  serialNumber?: string | null;
  quantity: number;
  unitCost: number;
}

export function resolveProductTrackingMode(prod: {
  trackingMode?: TrackingModeShared | null;
  trackLots?: boolean;
  trackSerials?: boolean;
}): TrackingModeShared {
  if (prod.trackingMode && prod.trackingMode !== "none") return prod.trackingMode;
  if (prod.trackSerials) return "serial";
  if (prod.trackLots) return "lot";
  return "none";
}

export async function receiveTrackedStock(
  tx: DbOrTx,
  input: {
    product: TrackedProductMeta;
    branchId: string;
    quantity: number;
    unitCost: number;
    movementId: string;
    lotNumber?: string;
    manufactureDate?: string | null;
    expiryDate?: string | null;
    serialNumbers?: string[];
    vendorId?: string | null;
    receivedFromType?: string;
    receivedFromId?: string;
    workOrderId?: string | null;
    notes?: string;
  }
): Promise<void> {
  const mode = resolveProductTrackingMode(input.product);
  if (mode === "none" || input.quantity <= 0) return;

  if (mode === "lot") {
    const lotNumber = input.lotNumber?.trim();
    if (!lotNumber) {
      throw new AppError(
        400,
        `Lot number is required when receiving lot-tracked product ${input.product.name} (${input.product.sku})`,
        "LOT_REQUIRED"
      );
    }

    const mfgDate = input.manufactureDate ? new Date(input.manufactureDate) : null;
    let expDate = input.expiryDate ? new Date(input.expiryDate) : null;
    if (!expDate && input.product.shelfLifeDays && input.product.shelfLifeDays > 0) {
      const base = mfgDate ?? new Date();
      expDate = new Date(base.getTime() + input.product.shelfLifeDays * 24 * 60 * 60 * 1000);
    }
    if (input.product.requiresExpiry && !expDate) {
      throw new AppError(
        400,
        `Expiry date is required for lot '${lotNumber}' of ${input.product.name}`,
        "EXPIRY_DATE_REQUIRED"
      );
    }

    const existing = await tx
      .select()
      .from(stockLots)
      .where(and(eq(stockLots.productId, input.product.id), eq(stockLots.lotNumber, lotNumber)))
      .limit(1);

    let lotId: string;
    if (existing.length > 0) {
      lotId = existing[0].id;
    } else {
      const [inserted] = await tx
        .insert(stockLots)
        .values({
          productId: input.product.id,
          lotNumber,
          manufactureDate: mfgDate,
          expiryDate: expDate,
          unitCost: toNumeric(input.unitCost, 4),
          vendorId: input.vendorId ?? null,
          notes: input.notes ?? "",
        })
        .returning();
      lotId = inserted.id;
    }

    await tx
      .insert(branchLotBalances)
      .values({
        branchId: input.branchId,
        lotId,
        productId: input.product.id,
        qtyOnHand: "0",
        qtyReserved: "0",
      })
      .onConflictDoNothing();

    const balRows = await tx.execute<{ id: string; qty_on_hand: string }>(sql`
      SELECT id, qty_on_hand
      FROM branch_lot_balances
      WHERE branch_id = ${input.branchId} AND lot_id = ${lotId}
      FOR UPDATE
    `);
    const bal = balRows[0];
    const nextQty = roundCurrency(num(bal.qty_on_hand) + input.quantity, 4);

    await tx
      .update(branchLotBalances)
      .set({ qtyOnHand: toNumeric(nextQty, 4), updatedAt: new Date() })
      .where(eq(branchLotBalances.id, bal.id));

    await tx.insert(stockMovementAllocations).values({
      movementId: input.movementId,
      lotId,
      quantity: toNumeric(input.quantity, 4),
      unitCost: toNumeric(input.unitCost, 4),
    });
    return;
  }

  // Serial tracking
  if (!Number.isInteger(input.quantity)) {
    throw new AppError(
      400,
      `Serial-tracked product ${input.product.name} requires an integer quantity (got ${input.quantity})`,
      "SERIAL_INTEGER_REQUIRED"
    );
  }
  const serials = (input.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean);
  const uniqueSerials = Array.from(new Set(serials));
  if (uniqueSerials.length !== input.quantity || serials.length !== input.quantity) {
    throw new AppError(
      400,
      `Expected ${input.quantity} unique serial numbers for ${input.product.name} (${input.product.sku}), received ${uniqueSerials.length}`,
      "SERIALS_REQUIRED"
    );
  }

  const dupRows = await tx
    .select({ serialNumber: stockSerials.serialNumber })
    .from(stockSerials)
    .where(and(eq(stockSerials.productId, input.product.id), inArray(stockSerials.serialNumber, uniqueSerials)));

  if (dupRows.length > 0) {
    throw new AppError(
      409,
      `Serial number '${dupRows[0].serialNumber}' already exists for ${input.product.name}`,
      "DUPLICATE_SERIAL"
    );
  }

  const insertedSerials = await tx
    .insert(stockSerials)
    .values(
      uniqueSerials.map((sn) => ({
        productId: input.product.id,
        serialNumber: sn,
        branchId: input.branchId,
        status: "in_stock" as const,
        unitCost: toNumeric(input.unitCost, 4),
        receivedFromType: input.receivedFromType ?? null,
        receivedFromId: input.receivedFromId ?? null,
        workOrderId: input.workOrderId ?? null,
        notes: input.notes ?? "",
      }))
    )
    .returning();

  await tx.insert(stockMovementAllocations).values(
    insertedSerials.map((s) => ({
      movementId: input.movementId,
      serialId: s.id,
      quantity: "1.0000",
      unitCost: toNumeric(input.unitCost, 4),
    }))
  );
}

export async function consumeTrackedStock(
  tx: DbOrTx,
  input: {
    product: TrackedProductMeta;
    branchId: string;
    quantity: number;
    lotAllocations?: LotAllocationRequest[];
    serialNumbers?: string[];
    allowExpired?: boolean;
    serialNextStatus?: SerialStatusShared;
    soldInvoiceId?: string | null;
    workOrderId?: string | null;
  }
): Promise<{
  tracked: boolean;
  totalCost: number;
  unitCost: number;
  allocations: ConsumedAllocation[];
}> {
  const mode = resolveProductTrackingMode(input.product);
  if (mode === "none" || input.quantity <= 0) {
    return { tracked: false, totalCost: 0, unitCost: 0, allocations: [] };
  }

  const now = new Date();

  if (mode === "lot") {
    const consumed: ConsumedAllocation[] = [];
    let totalCost = 0;

    if (input.lotAllocations && input.lotAllocations.length > 0) {
      const requestedSum = roundCurrency(
        input.lotAllocations.reduce((s, a) => s + a.quantity, 0),
        4
      );
      if (Math.abs(requestedSum - input.quantity) > 0.0001) {
        throw new AppError(
          400,
          `Explicit lot allocation total (${requestedSum}) does not match requested quantity (${input.quantity}) for ${input.product.name}`,
          "LOT_QUANTITY_MISMATCH"
        );
      }

      for (const req of input.lotAllocations) {
        let targetLotId = req.lotId;
        if (!targetLotId && req.lotNumber) {
          const [found] = await tx
            .select({ id: stockLots.id })
            .from(stockLots)
            .where(and(eq(stockLots.productId, input.product.id), eq(stockLots.lotNumber, req.lotNumber.trim())))
            .limit(1);
          targetLotId = found?.id;
        }
        if (!targetLotId) {
          throw new AppError(404, `Lot '${req.lotNumber ?? req.lotId}' not found for ${input.product.name}`, "LOT_NOT_FOUND");
        }

        const rows = await tx.execute<{
          bal_id: string;
          qty_on_hand: string;
          lot_number: string;
          expiry_date: Date | null;
          unit_cost: string;
        }>(sql`
          SELECT blb.id AS bal_id, blb.qty_on_hand, sl.lot_number, sl.expiry_date, sl.unit_cost
          FROM branch_lot_balances blb
          INNER JOIN stock_lots sl ON sl.id = blb.lot_id
          WHERE blb.branch_id = ${input.branchId} AND blb.lot_id = ${targetLotId}
          FOR UPDATE OF blb
        `);
        const row = rows[0];
        if (!row) {
          throw new AppError(400, `Lot '${req.lotNumber ?? targetLotId}' has no stock at this branch`, "INSUFFICIENT_LOT_STOCK");
        }
        if (!input.allowExpired && row.expiry_date && new Date(row.expiry_date).getTime() < now.getTime()) {
          throw new AppError(
            400,
            `Lot '${row.lot_number}' for ${input.product.name} expired on ${new Date(row.expiry_date).toISOString().slice(0, 10)}`,
            "LOT_EXPIRED"
          );
        }
        const avail = num(row.qty_on_hand);
        if (avail + 0.0001 < req.quantity) {
          throw new AppError(
            400,
            `Insufficient stock in lot '${row.lot_number}': available ${avail}, requested ${req.quantity}`,
            "INSUFFICIENT_LOT_STOCK"
          );
        }
        const nextQty = Math.max(0, roundCurrency(avail - req.quantity, 4));
        await tx
          .update(branchLotBalances)
          .set({ qtyOnHand: toNumeric(nextQty, 4), updatedAt: now })
          .where(eq(branchLotBalances.id, row.bal_id));

        const uc = num(row.unit_cost);
        totalCost = roundCurrency(totalCost + req.quantity * uc, 4);
        consumed.push({
          lotId: targetLotId,
          lotNumber: row.lot_number,
          quantity: req.quantity,
          unitCost: uc,
        });
      }
    } else {
      // Auto-pick by product pickingStrategy (FEFO / FIFO / LIFO)
      const strategy = input.product.pickingStrategy ?? "FEFO";
      const orderClause =
        strategy === "FIFO"
          ? sql`sl.created_at ASC, sl.id ASC`
          : strategy === "LIFO"
            ? sql`sl.created_at DESC, sl.id DESC`
            : sql`sl.expiry_date ASC NULLS LAST, sl.created_at ASC, sl.id ASC`;

      const candidates = await tx.execute<{
        bal_id: string;
        lot_id: string;
        lot_number: string;
        qty_on_hand: string;
        expiry_date: Date | null;
        unit_cost: string;
      }>(sql`
        SELECT blb.id AS bal_id, blb.lot_id, sl.lot_number, blb.qty_on_hand, sl.expiry_date, sl.unit_cost
        FROM branch_lot_balances blb
        INNER JOIN stock_lots sl ON sl.id = blb.lot_id
        WHERE blb.branch_id = ${input.branchId}
          AND blb.product_id = ${input.product.id}
          AND blb.qty_on_hand > 0
        ORDER BY ${orderClause}
        FOR UPDATE OF blb
      `);

      let remaining = input.quantity;
      let skippedExpiredQty = 0;

      for (const row of candidates) {
        if (remaining <= 0.0001) break;
        const avail = num(row.qty_on_hand);
        if (avail <= 0.0001) continue;
        const isExpired = Boolean(row.expiry_date && new Date(row.expiry_date).getTime() < now.getTime());
        if (isExpired && !input.allowExpired) {
          skippedExpiredQty += avail;
          continue;
        }
        const take = Math.min(remaining, avail);
        const nextQty = Math.max(0, roundCurrency(avail - take, 4));
        await tx
          .update(branchLotBalances)
          .set({ qtyOnHand: toNumeric(nextQty, 4), updatedAt: now })
          .where(eq(branchLotBalances.id, row.bal_id));

        const uc = num(row.unit_cost);
        totalCost = roundCurrency(totalCost + take * uc, 4);
        consumed.push({
          lotId: row.lot_id,
          lotNumber: row.lot_number,
          quantity: take,
          unitCost: uc,
        });
        remaining = roundCurrency(remaining - take, 4);
      }

      if (remaining > 0.0001) {
        if (skippedExpiredQty > 0) {
          throw new AppError(
            400,
            `Insufficient non-expired lot stock for ${input.product.name} (${skippedExpiredQty} expired units excluded)`,
            "LOT_EXPIRED"
          );
        }
        throw new AppError(
          400,
          `Insufficient lot stock for ${input.product.name}: shortfall ${remaining}`,
          "INSUFFICIENT_LOT_STOCK"
        );
      }
    }

    const unitCost = input.quantity > 0 ? roundCurrency(totalCost / input.quantity, 4) : 0;
    return { tracked: true, totalCost, unitCost, allocations: consumed };
  }

  // Serial tracking consume
  if (!Number.isInteger(input.quantity)) {
    throw new AppError(
      400,
      `Serial-tracked product ${input.product.name} requires an integer quantity`,
      "SERIAL_INTEGER_REQUIRED"
    );
  }
  const serials = (input.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean);
  const uniqueSerials = Array.from(new Set(serials));
  if (uniqueSerials.length !== input.quantity || serials.length !== input.quantity) {
    throw new AppError(
      400,
      `Please provide ${input.quantity} unique serial numbers for ${input.product.name}`,
      "SERIALS_REQUIRED"
    );
  }

  const foundRows = await tx
    .select()
    .from(stockSerials)
    .where(
      and(
        eq(stockSerials.productId, input.product.id),
        eq(stockSerials.branchId, input.branchId),
        eq(stockSerials.status, "in_stock"),
        inArray(stockSerials.serialNumber, uniqueSerials)
      )
    );

  if (foundRows.length !== uniqueSerials.length) {
    const foundSet = new Set(foundRows.map((r) => r.serialNumber));
    const missing = uniqueSerials.find((s) => !foundSet.has(s));
    throw new AppError(
      400,
      `Serial '${missing}' is not in_stock at this branch for ${input.product.name}`,
      "INVALID_SERIAL"
    );
  }

  const nextStatus = input.serialNextStatus ?? "sold";
  let totalCost = 0;
  const consumed: ConsumedAllocation[] = [];

  for (const row of foundRows) {
    const uc = num(row.unitCost);
    totalCost = roundCurrency(totalCost + uc, 4);
    await tx
      .update(stockSerials)
      .set({
        status: nextStatus,
        ...(input.soldInvoiceId ? { soldInvoiceId: input.soldInvoiceId } : {}),
        ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
        updatedAt: now,
      })
      .where(eq(stockSerials.id, row.id));

    consumed.push({
      serialId: row.id,
      serialNumber: row.serialNumber,
      quantity: 1,
      unitCost: uc,
    });
  }

  const unitCost = input.quantity > 0 ? roundCurrency(totalCost / input.quantity, 4) : 0;
  return { tracked: true, totalCost, unitCost, allocations: consumed };
}

export async function linkConsumedAllocations(
  tx: DbOrTx,
  movementId: string,
  allocations: ConsumedAllocation[]
): Promise<void> {
  if (allocations.length === 0) return;
  await tx.insert(stockMovementAllocations).values(
    allocations.map((a) => ({
      movementId,
      lotId: a.lotId ?? null,
      serialId: a.serialId ?? null,
      quantity: toNumeric(-Math.abs(a.quantity), 4),
      unitCost: toNumeric(a.unitCost, 4),
    }))
  );
}

/**
 * Re-homes in-transit lots/serials from a dispatched transfer into the destination branch on receipt.
 */
export async function receiveTransferredTrackedStock(
  tx: DbOrTx,
  input: {
    transferId: string;
    product: TrackedProductMeta;
    toBranchId: string;
    qtyReceived: number;
    movementId: string;
    unitCost: number;
  }
): Promise<void> {
  const mode = resolveProductTrackingMode(input.product);
  if (mode === "none" || input.qtyReceived <= 0) return;

  const outMovements = await tx
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.referenceType, "transfer"),
        eq(stockMovements.referenceId, input.transferId),
        eq(stockMovements.productId, input.product.id),
        eq(stockMovements.movementType, "transfer_out")
      )
    );
  if (outMovements.length === 0) return;

  const outAllocs = await tx
    .select()
    .from(stockMovementAllocations)
    .where(inArray(stockMovementAllocations.movementId, outMovements.map((m) => m.id)));

  if (mode === "lot") {
    let remaining = input.qtyReceived;
    for (const a of outAllocs) {
      if (!a.lotId || remaining <= 0.0001) continue;
      const shippedQty = Math.abs(num(a.quantity));
      const take = Math.min(remaining, shippedQty);
      if (take <= 0.0001) continue;

      await tx
        .insert(branchLotBalances)
        .values({
          branchId: input.toBranchId,
          lotId: a.lotId,
          productId: input.product.id,
          qtyOnHand: "0",
          qtyReserved: "0",
        })
        .onConflictDoNothing();

      const balRows = await tx.execute<{ id: string; qty_on_hand: string }>(sql`
        SELECT id, qty_on_hand FROM branch_lot_balances
        WHERE branch_id = ${input.toBranchId} AND lot_id = ${a.lotId}
        FOR UPDATE
      `);
      const bal = balRows[0];
      await tx
        .update(branchLotBalances)
        .set({ qtyOnHand: toNumeric(roundCurrency(num(bal.qty_on_hand) + take, 4), 4), updatedAt: new Date() })
        .where(eq(branchLotBalances.id, bal.id));

      await tx.insert(stockMovementAllocations).values({
        movementId: input.movementId,
        lotId: a.lotId,
        quantity: toNumeric(take, 4),
        unitCost: toNumeric(num(a.unitCost) || input.unitCost, 4),
      });
      remaining = roundCurrency(remaining - take, 4);
    }
    return;
  }

  // Serial transfer receive: move in_transit serials to in_stock at destination branch
  const serialIds = outAllocs.map((a) => a.serialId).filter((s): s is string => Boolean(s));
  if (serialIds.length === 0) return;

  const inTransitSerials = await tx
    .select()
    .from(stockSerials)
    .where(and(inArray(stockSerials.id, serialIds), eq(stockSerials.status, "in_transit")));

  const toReceive = inTransitSerials.slice(0, Math.round(input.qtyReceived));
  for (const s of toReceive) {
    await tx
      .update(stockSerials)
      .set({
        branchId: input.toBranchId,
        status: "in_stock",
        updatedAt: new Date(),
      })
      .where(eq(stockSerials.id, s.id));

    await tx.insert(stockMovementAllocations).values({
      movementId: input.movementId,
      serialId: s.id,
      quantity: "1.0000",
      unitCost: s.unitCost,
    });
  }
}

export async function listLots(
  db: AppDatabase,
  actor: RequestActor,
  query: { branchId?: string; productId?: string; includeZero?: string }
) {
  const conditions = [];
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    conditions.push(eq(branchLotBalances.branchId, query.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length === 0) return [];
    conditions.push(inArray(branchLotBalances.branchId, actor.branchIds));
  }
  if (query.productId) {
    conditions.push(eq(branchLotBalances.productId, query.productId));
  }

  const rows = await db
    .select({
      balanceId: branchLotBalances.id,
      branchId: branchLotBalances.branchId,
      branchName: branches.name,
      lotId: stockLots.id,
      lotNumber: stockLots.lotNumber,
      productId: products.id,
      productName: products.name,
      productSku: products.sku,
      manufactureDate: stockLots.manufactureDate,
      expiryDate: stockLots.expiryDate,
      unitCost: stockLots.unitCost,
      qtyOnHand: branchLotBalances.qtyOnHand,
      qtyReserved: branchLotBalances.qtyReserved,
      createdAt: stockLots.createdAt,
    })
    .from(branchLotBalances)
    .innerJoin(stockLots, eq(stockLots.id, branchLotBalances.lotId))
    .innerJoin(products, eq(products.id, branchLotBalances.productId))
    .innerJoin(branches, eq(branches.id, branchLotBalances.branchId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(stockLots.expiryDate), asc(stockLots.createdAt));

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const includeZero = query.includeZero === "true";

  return rows
    .filter((r) => includeZero || num(r.qtyOnHand) > 0.0001)
    .map((r) => {
      const expMs = r.expiryDate ? r.expiryDate.getTime() : null;
      let expiryStatus: "valid" | "expiring_soon" | "expired" | "no_expiry" = "no_expiry";
      if (expMs !== null) {
        if (expMs < now) expiryStatus = "expired";
        else if (expMs - now <= thirtyDaysMs) expiryStatus = "expiring_soon";
        else expiryStatus = "valid";
      }
      return {
        id: r.balanceId,
        lotId: r.lotId,
        lotNumber: r.lotNumber,
        branchId: r.branchId,
        branchName: r.branchName,
        productId: r.productId,
        productName: r.productName,
        productSku: r.productSku,
        manufactureDate: r.manufactureDate?.toISOString() ?? null,
        expiryDate: r.expiryDate?.toISOString() ?? null,
        expiryStatus,
        unitCost: num(r.unitCost),
        qtyOnHand: num(r.qtyOnHand),
        qtyReserved: num(r.qtyReserved),
        createdAt: r.createdAt.toISOString(),
      };
    });
}

export async function listSerials(
  db: AppDatabase,
  actor: RequestActor,
  query: { branchId?: string; productId?: string; status?: string; search?: string }
) {
  const conditions = [];
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    conditions.push(eq(stockSerials.branchId, query.branchId));
  } else if (actor.role !== "admin" && actor.branchScopeMode === "selected") {
    if (actor.branchIds.length === 0) return [];
    conditions.push(inArray(stockSerials.branchId, actor.branchIds));
  }
  if (query.productId) conditions.push(eq(stockSerials.productId, query.productId));
  if (query.status) conditions.push(eq(stockSerials.status, query.status as SerialStatusShared));

  const rows = await db
    .select({
      id: stockSerials.id,
      serialNumber: stockSerials.serialNumber,
      productId: stockSerials.productId,
      productName: products.name,
      productSku: products.sku,
      branchId: stockSerials.branchId,
      branchName: branches.name,
      status: stockSerials.status,
      unitCost: stockSerials.unitCost,
      receivedFromType: stockSerials.receivedFromType,
      receivedFromId: stockSerials.receivedFromId,
      soldInvoiceId: stockSerials.soldInvoiceId,
      workOrderId: stockSerials.workOrderId,
      createdAt: stockSerials.createdAt,
      updatedAt: stockSerials.updatedAt,
    })
    .from(stockSerials)
    .innerJoin(products, eq(products.id, stockSerials.productId))
    .leftJoin(branches, eq(branches.id, stockSerials.branchId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(stockSerials.updatedAt))
    .limit(500);

  const search = query.search?.trim().toLowerCase();
  const filtered = search
    ? rows.filter(
        (r) =>
          r.serialNumber.toLowerCase().includes(search) ||
          r.productSku.toLowerCase().includes(search) ||
          r.productName.toLowerCase().includes(search)
      )
    : rows;

  return filtered.map((r) => ({
    id: r.id,
    serialNumber: r.serialNumber,
    productId: r.productId,
    productName: r.productName,
    productSku: r.productSku,
    branchId: r.branchId,
    branchName: r.branchName ?? "",
    status: r.status,
    unitCost: num(r.unitCost),
    receivedFromType: r.receivedFromType,
    receivedFromId: r.receivedFromId,
    soldInvoiceId: r.soldInvoiceId,
    workOrderId: r.workOrderId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getSerialTrace(db: AppDatabase, actor: RequestActor, serialId: string) {
  const [serial] = await db
    .select({
      id: stockSerials.id,
      serialNumber: stockSerials.serialNumber,
      productId: stockSerials.productId,
      productName: products.name,
      productSku: products.sku,
      branchId: stockSerials.branchId,
      status: stockSerials.status,
      unitCost: stockSerials.unitCost,
      createdAt: stockSerials.createdAt,
    })
    .from(stockSerials)
    .innerJoin(products, eq(products.id, stockSerials.productId))
    .where(eq(stockSerials.id, serialId))
    .limit(1);

  if (!serial) throw new AppError(404, "Serial number not found", "NOT_FOUND");
  if (serial.branchId) assertBranchAccess(actor, serial.branchId);

  const history = await db
    .select({
      allocationId: stockMovementAllocations.id,
      movementId: stockMovements.id,
      movementType: stockMovements.movementType,
      branchId: stockMovements.branchId,
      branchName: branches.name,
      qtyDelta: stockMovementAllocations.quantity,
      unitCost: stockMovementAllocations.unitCost,
      referenceType: stockMovements.referenceType,
      referenceNumber: stockMovements.referenceNumber,
      notes: stockMovements.notes,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovementAllocations)
    .innerJoin(stockMovements, eq(stockMovements.id, stockMovementAllocations.movementId))
    .leftJoin(branches, eq(branches.id, stockMovements.branchId))
    .where(eq(stockMovementAllocations.serialId, serialId))
    .orderBy(asc(stockMovements.createdAt));

  return {
    serial: {
      ...serial,
      unitCost: num(serial.unitCost),
      createdAt: serial.createdAt.toISOString(),
    },
    history: history.map((h) => ({
      ...h,
      qtyDelta: num(h.qtyDelta),
      unitCost: num(h.unitCost),
      createdAt: h.createdAt.toISOString(),
    })),
  };
}
