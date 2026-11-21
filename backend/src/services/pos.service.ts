import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  buildOffsetPageInfo,
  calculateLineAmounts,
  posReceiptsQuerySchema,
  posReturnSchema,
  roundCurrency,
  type PosReturnInput,
  type closeShiftSchema,
  type createPosTerminalSchema,
  type openShiftSchema,
  type posCheckoutSchema,
  type shiftCashMovementSchema,
  type updatePosTerminalSchema,
} from "@erp/shared";
import {
  branches,
  branchLotBalances,
  branchProducts,
  companySettings,
  customers,
  notifications,
  posReturnLines,
  posReturns,
  posShiftCashMovements,
  posShifts,
  posTenders,
  posTerminals,
  products,
  salesInvoiceLines,
  salesInvoices,
  stockLots,
  stockMovementAllocations,
  stockMovements,
  stockSerials,
  taxCodes,
  userBranches,
  userBranchScopes,
  userPosPins,
  userRoles,
  users,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { applyInvoiceEInvoiceMetadata, applyPosReturnEInvoiceMetadata } from "./einvoicing.service.ts";
import { postMappedJournal, type MappedLineSpec } from "./gl.service.ts";
import {
  consumeTrackedStock,
  linkConsumedAllocations,
  resolveProductTrackingMode,
} from "./lots-serials.service.ts";
import { verifyManagerPinOverride } from "./pos-auth.service.ts";
import { buildBranchScopeCondition, groupByKey } from "./query-helpers.ts";
import { applyBranchStockMovement, parseOrThrow, type RequestActor } from "./stock-locks.ts";

export interface PosReceiptDto {
  id: string;
  invoiceNumber: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  customerId: string;
  customerName: string;
  cashierUserId: string;
  cashierName: string;
  invoiceDate: string;
  currency: string;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  paidAmount: number;
  totalChangeGiven: number;
  syncStatus: "synced" | "reconciled_conflict";
  offlineClientTxId: string | null;
  icv: number | null;
  qrTlv: string | null;
  etaDocumentUuid: string | null;
  etaReceiptStatus: string;
  eInvoiceStatus: string;
  lines: Array<{
    id?: string;
    productId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRate: number;
    taxAmount: number;
    lineTotal: number;
    returnedQuantity?: number;
    remainingReturnableQuantity?: number;
  }>;
  tenders: Array<{
    method: "cash" | "card" | "mobile_wallet";
    amount: number;
    tenderedAmount: number;
    changeGiven: number;
    reference: string;
  }>;
}

export async function listPosTerminals(db: AppDatabase, actor: RequestActor, branchId?: string) {
  if (branchId) assertBranchAccess(actor, branchId);
  const scopeCond = buildBranchScopeCondition(posTerminals.branchId, actor, branchId);
  if (scopeCond === "EMPTY") return [];

  const rows = await db
    .select({
      terminal: posTerminals,
      branchName: branches.name,
      branchCode: branches.code,
    })
    .from(posTerminals)
    .innerJoin(branches, eq(branches.id, posTerminals.branchId))
    .where(scopeCond ?? undefined)
    .orderBy(asc(posTerminals.code));

  const terminalIds = rows.map((r) => r.terminal.id);
  const openShifts =
    terminalIds.length > 0
      ? await db
          .select()
          .from(posShifts)
          .where(and(inArray(posShifts.terminalId, terminalIds), eq(posShifts.status, "open")))
      : [];
  const openShiftByTerminal = new Map(openShifts.map((s) => [s.terminalId, s]));

  return rows.map(({ terminal, branchName, branchCode }) => {
    const activeShift = openShiftByTerminal.get(terminal.id);
    return {
      ...terminal,
      branchName,
      branchCode,
      createdAt: terminal.createdAt.toISOString(),
      updatedAt: terminal.updatedAt.toISOString(),
      activeShift: activeShift ? formatShift(activeShift) : null,
    };
  });
}

export async function createPosTerminal(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createPosTerminalSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: posTerminals.id })
      .from(posTerminals)
      .where(eq(posTerminals.code, data.code.toUpperCase()))
      .limit(1);
    if (existing) {
      throw new AppError(409, `Terminal code '${data.code}' already exists`, "DUPLICATE_TERMINAL_CODE");
    }

    let defaultCustomerId = data.defaultCustomerId ?? null;
    if (!defaultCustomerId) {
      const [walkIn] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.isWalkIn, true))
        .limit(1);
      defaultCustomerId = walkIn?.id ?? null;
    }

    const [created] = await tx
      .insert(posTerminals)
      .values({
        branchId: data.branchId,
        code: data.code.toUpperCase(),
        name: data.name,
        isActive: data.isActive,
        defaultCustomerId,
        etaPosSerial: data.etaPosSerial ?? "",
        etaPosOsVersion: data.etaPosOsVersion ?? "",
      })
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: created.branchId,
      action: "pos.terminal_created",
      entityType: "pos_terminal",
      entityId: created.id,
      entityLabel: created.code,
      ipAddress,
    });

    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  });
}

export async function updatePosTerminal(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updatePosTerminalSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(posTerminals).where(eq(posTerminals.id, id)).limit(1);
    if (!existing) throw new AppError(404, "POS terminal not found", "NOT_FOUND");
    assertBranchAccess(actor, existing.branchId);

    const [updated] = await tx
      .update(posTerminals)
      .set({
        ...(data.code !== undefined ? { code: data.code.toUpperCase() } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.defaultCustomerId !== undefined ? { defaultCustomerId: data.defaultCustomerId } : {}),
        ...(data.etaPosSerial !== undefined ? { etaPosSerial: data.etaPosSerial ?? "" } : {}),
        ...(data.etaPosOsVersion !== undefined ? { etaPosOsVersion: data.etaPosOsVersion ?? "" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(posTerminals.id, id))
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: updated.branchId,
      action: "pos.terminal_updated",
      entityType: "pos_terminal",
      entityId: updated.id,
      entityLabel: updated.code,
      ipAddress,
    });

    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

export async function listPosCashiers(db: AppDatabase, actor: RequestActor, branchId?: string) {
  if (branchId) assertBranchAccess(actor, branchId);

  const [allUsers, roleRows, scopeRows, branchRows, pinRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.name)),
    db.select().from(userRoles),
    db.select().from(userBranchScopes),
    db.select().from(userBranches),
    db.select({ userId: userPosPins.userId }).from(userPosPins),
  ]);

  const roleMap = new Map(roleRows.map((r) => [r.userId, r.role]));
  const scopeMap = new Map(scopeRows.map((s) => [s.userId, s.scopeMode]));
  const pinSet = new Set(pinRows.map((p) => p.userId));
  const branchSetByUser = new Map<string, Set<string>>();
  for (const ub of branchRows) {
    const set = branchSetByUser.get(ub.userId) ?? new Set<string>();
    set.add(ub.branchId);
    branchSetByUser.set(ub.userId, set);
  }

  return allUsers
    .filter((u) => {
      if (!branchId) return true;
      const role = roleMap.get(u.id) ?? "user";
      const scope = role === "admin" ? "all" : (scopeMap.get(u.id) ?? "selected");
      if (scope === "all") return true;
      return branchSetByUser.get(u.id)?.has(branchId) ?? false;
    })
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: roleMap.get(u.id) ?? "user",
      hasPin: pinSet.has(u.id),
    }));
}

export async function getPosCatalog(db: AppDatabase, actor: RequestActor, branchId: string) {
  assertBranchAccess(actor, branchId);

  const [prodRows, bpRows, taxRows, custRows, companyRow] = await Promise.all([
    db.select().from(products).where(eq(products.isActive, true)).orderBy(asc(products.name)),
    db.select().from(branchProducts).where(eq(branchProducts.branchId, branchId)),
    db.select().from(taxCodes).where(eq(taxCodes.isActive, true)),
    db.select().from(customers).where(eq(customers.isActive, true)).orderBy(desc(customers.isWalkIn), asc(customers.name)),
    db.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1),
  ]);

  const bpByProduct = new Map(bpRows.map((bp) => [bp.productId, bp]));
  const taxById = new Map(taxRows.map((t) => [t.id, t]));
  const defaultTax = taxRows.find((t) => t.isDefault) ?? taxRows[0];

  const catalogProducts = prodRows.map((p) => {
    const bp = bpByProduct.get(p.id);
    const tc = (p.taxCodeId ? taxById.get(p.taxCodeId) : undefined) ?? defaultTax;
    const sellingPrice = num(p.sellingPrice);
    return {
      id: p.id,
      sku: p.sku,
      barcode: p.barcode,
      name: p.name,
      nameAr: p.nameAr,
      category: p.category,
      unit: p.unit,
      sellingPrice,
      costPrice: bp && num(bp.avgCost) > 0 ? num(bp.avgCost) : num(p.costPrice),
      qtyOnHand: bp ? num(bp.qtyOnHand) : 0,
      itemType: p.itemType,
      trackingMode: p.trackingMode,
      taxRate: tc ? num(tc.rate) : 0,
      isTaxInclusive: tc ? tc.isInclusive : false,
    };
  });

  const catalogCustomers = custRows.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    phone: c.phone,
    taxNumber: c.taxNumber,
    isWalkIn: c.isWalkIn,
  }));

  const company = companyRow[0];
  return {
    branchId,
    currency: company?.baseCurrency ?? "USD",
    einvoicingMode: company?.einvoicingMode ?? "none",
    companyName: company?.companyName ?? "Count It Keep It",
    taxRegistrationNumber: company?.taxRegistrationNumber ?? "",
    syncedAt: new Date().toISOString(),
    products: catalogProducts,
    customers: catalogCustomers,
  };
}

function formatShift(s: typeof posShifts.$inferSelect) {
  return {
    id: s.id,
    shiftNumber: s.shiftNumber,
    terminalId: s.terminalId,
    branchId: s.branchId,
    openedByUserId: s.openedByUserId,
    closedByUserId: s.closedByUserId,
    status: s.status,
    openingFloat: num(s.openingFloat),
    expectedCash: num(s.expectedCash),
    countedCash: s.countedCash !== null ? num(s.countedCash) : null,
    cashVariance: s.cashVariance !== null ? num(s.cashVariance) : null,
    totalCashSales: num(s.totalCashSales),
    totalCardSales: num(s.totalCardSales),
    totalWalletSales: num(s.totalWalletSales),
    totalSalesCount: s.totalSalesCount,
    totalCashRefunds: num(s.totalCashRefunds),
    totalCardRefunds: num(s.totalCardRefunds),
    totalWalletRefunds: num(s.totalWalletRefunds),
    totalRefundsCount: s.totalRefundsCount,
    notes: s.notes,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
  };
}

export async function getActiveShift(db: AppDatabase, actor: RequestActor, terminalId: string) {
  const [terminal] = await db.select().from(posTerminals).where(eq(posTerminals.id, terminalId)).limit(1);
  if (!terminal) throw new AppError(404, "POS terminal not found", "TERMINAL_NOT_FOUND");
  assertBranchAccess(actor, terminal.branchId);

  const [shift] = await db
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.terminalId, terminalId), eq(posShifts.status, "open")))
    .limit(1);

  if (!shift) return null;

  const movements = await db
    .select()
    .from(posShiftCashMovements)
    .where(eq(posShiftCashMovements.shiftId, shift.id))
    .orderBy(desc(posShiftCashMovements.createdAt));

  return {
    ...formatShift(shift),
    cashMovements: movements.map((m) => ({
      id: m.id,
      type: m.type,
      amount: num(m.amount),
      reason: m.reason,
      performedByUserId: m.performedByUserId,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function openPosShift(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof openShiftSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [terminal] = await tx
      .select()
      .from(posTerminals)
      .where(and(eq(posTerminals.id, data.terminalId), eq(posTerminals.isActive, true)))
      .limit(1);
    if (!terminal) throw new AppError(404, "POS terminal not found or inactive", "TERMINAL_NOT_FOUND");
    assertBranchAccess(actor, terminal.branchId);

    const existingOpen = await tx
      .select({ id: posShifts.id })
      .from(posShifts)
      .where(and(eq(posShifts.terminalId, terminal.id), eq(posShifts.status, "open")))
      .limit(1);
    if (existingOpen.length > 0) {
      throw new AppError(409, "An open shift already exists on this terminal", "SHIFT_ALREADY_OPEN");
    }

    const shiftNumber = await nextDocNumber(tx, "SHIFT", "SHF-");
    const [created] = await tx
      .insert(posShifts)
      .values({
        shiftNumber,
        terminalId: terminal.id,
        branchId: terminal.branchId,
        openedByUserId: actor.id,
        status: "open",
        openingFloat: toNumeric(data.openingFloat, 4),
        expectedCash: toNumeric(data.openingFloat, 4),
        notes: data.notes,
      })
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: terminal.branchId,
      action: "pos.shift_opened",
      entityType: "pos_shift",
      entityId: created.id,
      entityLabel: created.shiftNumber,
      details: { terminalId: terminal.id, openingFloat: data.openingFloat },
      ipAddress,
    });

    return formatShift(created);
  });
}

export async function recordShiftCashMovement(
  db: AppDatabase,
  actor: RequestActor,
  shiftId: string,
  data: z.infer<typeof shiftCashMovementSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const shiftRows = await tx.execute<{
      id: string;
      shift_number: string;
      branch_id: string;
      status: string;
      expected_cash: string;
    }>(sql`SELECT id, shift_number, branch_id, status, expected_cash FROM pos_shifts WHERE id = ${shiftId} FOR UPDATE`);
    const shift = shiftRows[0];
    if (!shift) throw new AppError(404, "POS shift not found", "SHIFT_NOT_FOUND");
    assertBranchAccess(actor, shift.branch_id);
    if (shift.status !== "open") {
      throw new AppError(400, "Cannot record cash movement on a closed shift", "SHIFT_CLOSED");
    }

    const [movement] = await tx
      .insert(posShiftCashMovements)
      .values({
        shiftId,
        type: data.movementType,
        amount: toNumeric(data.amount, 4),
        reason: data.reason,
        performedByUserId: actor.id,
      })
      .returning();

    const delta = data.movementType === "pay_in" ? data.amount : -data.amount;
    const nextExpected = roundCurrency(num(shift.expected_cash) + delta, 4);

    await tx
      .update(posShifts)
      .set({ expectedCash: toNumeric(nextExpected, 4) })
      .where(eq(posShifts.id, shiftId));

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: shift.branch_id,
      action: `pos.shift_${data.movementType}`,
      entityType: "pos_shift",
      entityId: shiftId,
      entityLabel: shift.shift_number,
      details: { movementType: data.movementType, amount: data.amount, reason: data.reason },
      ipAddress,
    });

    return {
      id: movement.id,
      shiftId,
      type: movement.type,
      amount: num(movement.amount),
      reason: movement.reason,
      expectedCash: nextExpected,
      createdAt: movement.createdAt.toISOString(),
    };
  });
}

export async function closePosShift(
  db: AppDatabase,
  actor: RequestActor,
  shiftId: string,
  data: z.infer<typeof closeShiftSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const shiftRows = await tx.execute<{
      id: string;
      shift_number: string;
      terminal_id: string;
      branch_id: string;
      status: string;
      opening_float: string;
      total_cash_sales: string;
      total_cash_refunds: string;
    }>(sql`
      SELECT id, shift_number, terminal_id, branch_id, status, opening_float, total_cash_sales, total_cash_refunds
      FROM pos_shifts WHERE id = ${shiftId} FOR UPDATE
    `);
    const shift = shiftRows[0];
    if (!shift) throw new AppError(404, "POS shift not found", "SHIFT_NOT_FOUND");
    assertBranchAccess(actor, shift.branch_id);
    if (shift.status !== "open") {
      throw new AppError(400, "Shift is already closed", "SHIFT_ALREADY_CLOSED");
    }

    const cashMovs = await tx
      .select()
      .from(posShiftCashMovements)
      .where(eq(posShiftCashMovements.shiftId, shiftId));

    let netMovements = 0;
    for (const m of cashMovs) {
      netMovements += m.type === "pay_in" ? num(m.amount) : -num(m.amount);
    }

    const expectedCash = roundCurrency(
      num(shift.opening_float) + num(shift.total_cash_sales) - num(shift.total_cash_refunds) + netMovements,
      4
    );
    const cashVariance = roundCurrency(data.countedCash - expectedCash, 4);
    const closedAt = new Date();

    const [updated] = await tx
      .update(posShifts)
      .set({
        status: "closed",
        closedByUserId: actor.id,
        expectedCash: toNumeric(expectedCash, 4),
        countedCash: toNumeric(data.countedCash, 4),
        cashVariance: toNumeric(cashVariance, 4),
        notes: data.notes || undefined,
        closedAt,
      })
      .where(eq(posShifts.id, shiftId))
      .returning();

    if (Math.abs(cashVariance) > 0.005) {
      const absVar = Math.abs(cashVariance);
      await postMappedJournal(tx, {
        branchId: shift.branch_id,
        entryDate: closedAt,
        sourceType: "pos_shift_close",
        sourceId: shift.id,
        referenceNumber: shift.shift_number,
        memo:
          cashVariance > 0
            ? `POS shift ${shift.shift_number} cash overage`
            : `POS shift ${shift.shift_number} cash shortage`,
        createdBy: actor.id,
        lines:
          cashVariance > 0
            ? [
                { mappingKey: "pos_cash_drawer", debit: absVar },
                { mappingKey: "cash_over_short", credit: absVar },
              ]
            : [
                { mappingKey: "cash_over_short", debit: absVar },
                { mappingKey: "pos_cash_drawer", credit: absVar },
              ],
      });
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: shift.branch_id,
      action: "pos.shift_closed",
      entityType: "pos_shift",
      entityId: shift.id,
      entityLabel: shift.shift_number,
      details: {
        expectedCash,
        countedCash: data.countedCash,
        cashVariance,
      },
      ipAddress,
    });

    return formatShift(updated);
  });
}

export async function executePosCheckoutTx(
  tx: DbOrTx,
  actor: RequestActor,
  data: z.infer<typeof posCheckoutSchema>,
  options: {
    allowOfflineNegativeStock?: boolean;
    allowClosedShiftReconcile?: boolean;
    ipAddress?: string;
  } = {}
): Promise<PosReceiptDto> {
  const [terminal] = await tx
    .select()
    .from(posTerminals)
    .where(eq(posTerminals.id, data.terminalId))
    .limit(1);
  if (!terminal) throw new AppError(404, "POS terminal not found", "TERMINAL_NOT_FOUND");
  assertBranchAccess(actor, terminal.branchId);

  let targetShiftId = data.shiftId;
  let syncStatus: "synced" | "reconciled_conflict" = "synced";
  const conflictReasons: string[] = [];

  const shiftRows = await tx.execute<{
    id: string;
    shift_number: string;
    terminal_id: string;
    branch_id: string;
    status: string;
    expected_cash: string;
    total_cash_sales: string;
    total_card_sales: string;
    total_wallet_sales: string;
    total_sales_count: number;
  }>(sql`
    SELECT id, shift_number, terminal_id, branch_id, status, expected_cash,
           total_cash_sales, total_card_sales, total_wallet_sales, total_sales_count
    FROM pos_shifts WHERE id = ${data.shiftId} FOR UPDATE
  `);
  let shift = shiftRows[0];
  if (!shift || shift.terminal_id !== terminal.id) {
    throw new AppError(404, "POS shift not found for this terminal", "SHIFT_NOT_FOUND");
  }

  if (shift.status !== "open") {
    if (!options.allowClosedShiftReconcile) {
      throw new AppError(400, "Cannot checkout on a closed POS shift", "SHIFT_CLOSED");
    }
    const openRows = await tx.execute<{
      id: string;
      shift_number: string;
      terminal_id: string;
      branch_id: string;
      status: string;
      expected_cash: string;
      total_cash_sales: string;
      total_card_sales: string;
      total_wallet_sales: string;
      total_sales_count: number;
    }>(sql`
      SELECT id, shift_number, terminal_id, branch_id, status, expected_cash,
             total_cash_sales, total_card_sales, total_wallet_sales, total_sales_count
      FROM pos_shifts
      WHERE terminal_id = ${terminal.id} AND status = 'open'
      LIMIT 1
      FOR UPDATE
    `);
    syncStatus = "reconciled_conflict";
    if (openRows[0]) {
      conflictReasons.push(`Original shift ${shift.shift_number} was closed; attached to ${openRows[0].shift_number}`);
      shift = openRows[0];
      targetShiftId = shift.id;
    } else {
      conflictReasons.push(`Original shift ${shift.shift_number} was already closed before offline sync`);
    }
  }

  // Resolve customer (default to terminal default customer or seeded WALK-IN)
  let customerId = data.customerId ?? terminal.defaultCustomerId ?? null;
  let customerName = "Walk-in Customer";
  if (customerId) {
    const [cust] = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    if (!cust) throw new AppError(404, "Selected customer not found", "NOT_FOUND");
    customerName = cust.name;
  } else {
    const [walkIn] = await tx
      .select()
      .from(customers)
      .where(eq(customers.isWalkIn, true))
      .limit(1);
    if (!walkIn) throw new AppError(400, "Default walk-in customer is not configured", "WALK_IN_MISSING");
    customerId = walkIn.id;
    customerName = walkIn.name;
  }

  const [company] = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
  const currency = company?.baseCurrency ?? "USD";

  // Deterministic line math (handles inclusive & exclusive VAT)
  let subtotal = 0;
  let taxTotal = 0;
  const computedLines = data.lines.map((line) => {
    const calc = calculateLineAmounts(
      {
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        taxRate: line.taxRate,
        isTaxInclusive: line.isTaxInclusive,
      },
      4
    );
    subtotal = roundCurrency(subtotal + calc.taxable, 4);
    taxTotal = roundCurrency(taxTotal + calc.taxAmount, 4);
    return {
      ...line,
      taxAmount: calc.taxAmount,
      lineTotal: calc.lineTotal,
    };
  });
  const grandTotal = roundCurrency(subtotal + taxTotal, 4);

  // Allocate tenders cleanly so GL always balances to grandTotal while preserving changeGiven
  let remainingDue = grandTotal;
  let netCashApplied = 0;
  let cardApplied = 0;
  let walletApplied = 0;
  let totalChangeGiven = 0;

  const computedTenders = data.tenders.map((t) => {
    const grossTendered = Math.max(t.tenderedAmount ?? t.amount, t.amount);
    const applied = roundCurrency(Math.min(Math.max(0, remainingDue), t.amount), 4);
    remainingDue = roundCurrency(Math.max(0, remainingDue - applied), 4);
    const changeGiven =
      t.method === "cash" ? roundCurrency(Math.max(0, grossTendered - applied), 4) : 0;

    if (t.method === "cash") netCashApplied = roundCurrency(netCashApplied + applied, 4);
    else if (t.method === "card") cardApplied = roundCurrency(cardApplied + applied, 4);
    else walletApplied = roundCurrency(walletApplied + applied, 4);

    totalChangeGiven = roundCurrency(totalChangeGiven + changeGiven, 4);
    return {
      method: t.method,
      amount: applied,
      tenderedAmount: grossTendered,
      changeGiven,
      reference: t.reference ?? "",
    };
  });

  if (remainingDue > 0.01) {
    throw new AppError(400, "Tendered amount is less than the POS cart grand total", "INSUFFICIENT_TENDER");
  }

  const invoiceNumber = await nextDocNumber(tx, "POS", "POS-");
  const invoiceDate = data.offlineCreatedAt ? new Date(data.offlineCreatedAt) : new Date();

  const [inv] = await tx
    .insert(salesInvoices)
    .values({
      invoiceNumber,
      customerId,
      branchId: terminal.branchId,
      status: "Paid",
      invoiceDate,
      dueDate: invoiceDate,
      currency,
      fxRate: "1.000000",
      subtotal: toNumeric(subtotal, 4),
      taxTotal: toNumeric(taxTotal, 4),
      totalAmount: toNumeric(grandTotal, 4),
      paidAmount: toNumeric(grandTotal, 4),
      sourceChannel: "pos",
      posTerminalId: terminal.id,
      posShiftId: targetShiftId,
      cashierUserId: actor.id,
      offlineClientTxId: data.offlineClientTxId ?? null,
      syncStatus,
      notes: data.notes,
      createdBy: actor.id,
    })
    .returning();

  // Deduct stock in deterministic productId order to avoid deadlocks
  const sortedLines = [...computedLines].sort((a, b) => a.productId.localeCompare(b.productId));
  let totalCogsVal = 0;

  for (const line of sortedLines) {
    const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
    if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

    let unitCostSnapshot = 0;
    const isStockItem = prod.itemType !== "non_stock" && prod.itemType !== "service";
    if (isStockItem) {
      let tracked: {
        tracked: boolean;
        totalCost: number;
        unitCost: number;
        allocations: Awaited<ReturnType<typeof consumeTrackedStock>>["allocations"];
      } = { tracked: false, totalCost: 0, unitCost: 0, allocations: [] };

      try {
        tracked = await consumeTrackedStock(tx, {
          product: prod,
          branchId: terminal.branchId,
          quantity: line.quantity,
          lotAllocations: line.lotAllocations,
          serialNumbers: line.serialNumbers,
          serialNextStatus: "sold",
          soldInvoiceId: inv.id,
        });
      } catch (err) {
        if (options.allowOfflineNegativeStock) {
          syncStatus = "reconciled_conflict";
          conflictReasons.push(`Tracking conflict for ${prod.sku}: ${err instanceof Error ? err.message : "shortfall"}`);
        } else {
          throw err;
        }
      }

      const moved = await applyBranchStockMovement(tx, {
        branchId: terminal.branchId,
        productId: line.productId,
        qtyDelta: -line.quantity,
        fallbackCost: num(prod.costPrice),
        rejectNegative: !options.allowOfflineNegativeStock,
        movementType: "sales_invoice",
        movementUnitCost: tracked.tracked ? tracked.unitCost : undefined,
        referenceType: "pos_sale",
        referenceId: inv.id,
        referenceNumber: inv.invoiceNumber,
        insufficientStockMessage: `Insufficient stock for ${prod.name}: requested ${line.quantity}`,
        notes: `POS sale ${inv.invoiceNumber}`,
        actorId: actor.id,
      });

      if (moved.rawNewQty < -0.0001) {
        syncStatus = "reconciled_conflict";
        conflictReasons.push(
          `Offline stock shortfall on ${prod.sku}: available ${moved.previousQty}, sold ${line.quantity}`
        );
      }

      if (tracked.tracked) {
        await linkConsumedAllocations(tx, moved.movementId, tracked.allocations);
      }
      unitCostSnapshot = tracked.tracked ? tracked.unitCost : moved.movementCost;
      totalCogsVal = roundCurrency(
        totalCogsVal + (tracked.tracked ? tracked.totalCost : Math.abs(moved.totalValueDelta)),
        4
      );
    }

    const [insertedLine] = await tx
      .insert(salesInvoiceLines)
      .values({
        invoiceId: inv.id,
        productId: line.productId,
        description: line.description || prod.name,
        quantity: toNumeric(line.quantity, 4),
        unitPrice: toNumeric(line.unitPrice, 4),
        unitCostSnapshot: toNumeric(unitCostSnapshot, 4),
        discount: toNumeric(line.discount, 4),
        taxRate: toNumeric(line.taxRate, 4),
        taxAmount: toNumeric(line.taxAmount, 4),
        lineTotal: toNumeric(line.lineTotal, 4),
      })
      .returning({ id: salesInvoiceLines.id });
    (line as { id?: string; description: string }).id = insertedLine.id;
    line.description = line.description || prod.name;
  }

  if (syncStatus === "reconciled_conflict") {
    await tx
      .update(salesInvoices)
      .set({ syncStatus: "reconciled_conflict", updatedAt: new Date() })
      .where(eq(salesInvoices.id, inv.id));

    await tx.insert(notifications).values({
      branchId: terminal.branchId,
      type: "pos_sync_conflict",
      title: `POS Offline Sync Conflict (${inv.invoiceNumber})`,
      message: conflictReasons.join("; "),
      entityType: "sales_invoice",
      entityId: inv.id,
    });
  }

  // Record tenders
  await tx.insert(posTenders).values(
    computedTenders.map((t) => ({
      invoiceId: inv.id,
      shiftId: targetShiftId,
      method: t.method,
      amount: toNumeric(t.amount, 4),
      tenderedAmount: toNumeric(t.tenderedAmount, 4),
      changeGiven: toNumeric(t.changeGiven, 4),
      reference: t.reference,
    }))
  );

  // Update shift running totals
  await tx
    .update(posShifts)
    .set({
      totalCashSales: toNumeric(roundCurrency(num(shift.total_cash_sales) + netCashApplied, 4), 4),
      totalCardSales: toNumeric(roundCurrency(num(shift.total_card_sales) + cardApplied, 4), 4),
      totalWalletSales: toNumeric(roundCurrency(num(shift.total_wallet_sales) + walletApplied, 4), 4),
      expectedCash: toNumeric(roundCurrency(num(shift.expected_cash) + netCashApplied, 4), 4),
      totalSalesCount: shift.total_sales_count + 1,
    })
    .where(eq(posShifts.id, targetShiftId));

  // Post POS revenue + clearing GL journal
  const glLines: MappedLineSpec[] = [];
  if (netCashApplied > 0.0001) {
    glLines.push({ mappingKey: "pos_cash_drawer", debit: netCashApplied, currency, fxRate: 1 });
  }
  const nonCashTotal = roundCurrency(cardApplied + walletApplied, 4);
  if (nonCashTotal > 0.0001) {
    glLines.push({ mappingKey: "card_clearing", debit: nonCashTotal, currency, fxRate: 1 });
  }
  if (subtotal > 0.0001) {
    glLines.push({ mappingKey: "sales_revenue", credit: subtotal, currency, fxRate: 1 });
  }
  if (taxTotal > 0.0001) {
    glLines.push({ mappingKey: "output_vat", credit: taxTotal, currency, fxRate: 1 });
  }

  if (glLines.length >= 2) {
    await postMappedJournal(tx, {
      branchId: terminal.branchId,
      entryDate: invoiceDate,
      sourceType: "pos_sale",
      sourceId: inv.id,
      referenceNumber: inv.invoiceNumber,
      memo: `POS sale ${inv.invoiceNumber}`,
      createdBy: actor.id,
      lines: glLines,
    });
  }

  if (totalCogsVal > 0.0001) {
    await postMappedJournal(tx, {
      branchId: terminal.branchId,
      entryDate: invoiceDate,
      sourceType: "pos_sale",
      sourceId: inv.id,
      referenceNumber: inv.invoiceNumber,
      memo: `POS sale COGS ${inv.invoiceNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "cogs", debit: totalCogsVal },
        { mappingKey: "inventory_asset", credit: totalCogsVal },
      ],
    });
  }

  const einv = await applyInvoiceEInvoiceMetadata(tx, inv.id);

  await writeAuditLog(tx, {
    userId: actor.id,
    userName: actor.name,
    userRole: actor.role,
    branchId: terminal.branchId,
    action: "pos.checkout_completed",
    entityType: "sales",
    entityId: inv.id,
    entityLabel: inv.invoiceNumber,
    details: {
      terminalId: terminal.id,
      shiftId: targetShiftId,
      grandTotal,
      syncStatus,
    },
    ipAddress: options.ipAddress,
  });

  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    branchId: terminal.branchId,
    terminalId: terminal.id,
    shiftId: targetShiftId,
    customerId,
    customerName,
    cashierUserId: actor.id,
    cashierName: actor.name,
    invoiceDate: invoiceDate.toISOString(),
    currency,
    subtotal,
    taxTotal,
    totalAmount: grandTotal,
    paidAmount: grandTotal,
    totalChangeGiven,
    syncStatus,
    offlineClientTxId: data.offlineClientTxId ?? null,
    icv: einv.icv,
    qrTlv: einv.qrTlv,
    etaDocumentUuid: einv.etaDocumentUuid,
    etaReceiptStatus: einv.etaReceiptStatus,
    eInvoiceStatus: einv.eInvoiceStatus,
    lines: computedLines.map((l) => ({
      id: (l as { id?: string }).id,
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxRate: l.taxRate,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
      returnedQuantity: 0,
      remainingReturnableQuantity: l.quantity,
    })),
    tenders: computedTenders,
  };
}

export async function createPosCheckout(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof posCheckoutSchema>,
  ipAddress?: string
): Promise<PosReceiptDto> {
  return db.transaction(async (tx) =>
    executePosCheckoutTx(tx, actor, data, {
      allowOfflineNegativeStock: false,
      allowClosedShiftReconcile: false,
      ipAddress,
    })
  );
}

export async function listPosReceipts(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery: unknown
) {
  const query = parseOrThrow(posReceiptsQuerySchema, rawQuery ?? {}, "Invalid POS receipts query");
  const page = query.page ?? 1;
  const pageSize = query.limit ?? query.pageSize ?? 50;

  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
  }
  const scopeCond = buildBranchScopeCondition(salesInvoices.branchId, actor, query.branchId);
  if (scopeCond === "EMPTY") {
    return {
      items: [],
      receipts: [],
      pageInfo: buildOffsetPageInfo(page, pageSize, 0),
    };
  }

  const conditions: SQL[] = [eq(salesInvoices.sourceChannel, "pos")];
  if (scopeCond) conditions.push(scopeCond);
  if (query.terminalId) conditions.push(eq(salesInvoices.posTerminalId, query.terminalId));
  if (query.shiftId) conditions.push(eq(salesInvoices.posShiftId, query.shiftId));
  if (query.fromDate) conditions.push(gte(salesInvoices.invoiceDate, new Date(query.fromDate)));
  if (query.toDate) conditions.push(lte(salesInvoices.invoiceDate, new Date(query.toDate)));

  const searchTerm = (query.q ?? query.search)?.trim();
  if (searchTerm) {
    const pattern = `%${searchTerm}%`;
    conditions.push(
      or(
        ilike(salesInvoices.invoiceNumber, pattern),
        ilike(salesInvoices.offlineClientTxId, pattern),
        ilike(customers.name, pattern)
      )!
    );
  }

  const whereClause = and(...conditions);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(salesInvoices)
    .leftJoin(customers, eq(customers.id, salesInvoices.customerId))
    .where(whereClause);

  const pageInfo = buildOffsetPageInfo(page, pageSize, total);
  if (total === 0) {
    return { items: [], receipts: [], pageInfo };
  }

  const rows = await db
    .select({
      inv: salesInvoices,
      customerName: customers.name,
      cashierName: users.name,
    })
    .from(salesInvoices)
    .leftJoin(customers, eq(customers.id, salesInvoices.customerId))
    .leftJoin(users, eq(users.id, salesInvoices.cashierUserId))
    .where(whereClause)
    .orderBy(desc(salesInvoices.createdAt), desc(salesInvoices.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  if (rows.length === 0) {
    return { items: [], receipts: [], pageInfo };
  }

  const invoiceIds = rows.map((r) => r.inv.id);
  const [lineRows, tenderRows, returnRows] = await Promise.all([
    db.select().from(salesInvoiceLines).where(inArray(salesInvoiceLines.invoiceId, invoiceIds)),
    db.select().from(posTenders).where(inArray(posTenders.invoiceId, invoiceIds)),
    db.select().from(posReturns).where(inArray(posReturns.originalInvoiceId, invoiceIds)),
  ]);

  const returnIds = returnRows.map((r) => r.id);
  const returnLineRows =
    returnIds.length > 0
      ? await db.select().from(posReturnLines).where(inArray(posReturnLines.posReturnId, returnIds))
      : [];

  const returnedQtyByLineId = new Map<string, number>();
  for (const rl of returnLineRows) {
    const prev = returnedQtyByLineId.get(rl.originalInvoiceLineId) ?? 0;
    returnedQtyByLineId.set(rl.originalInvoiceLineId, roundCurrency(prev + num(rl.quantity), 4));
  }

  const linesByInv = groupByKey(lineRows, (l) => l.invoiceId);
  const tendersByInv = groupByKey(tenderRows, (t) => t.invoiceId);
  const returnsByInv = groupByKey(returnRows, (r) => r.originalInvoiceId);

  const items = rows.map(({ inv, customerName, cashierName }) => {
    const invLines = linesByInv.get(inv.id) ?? [];
    const invTenders = tendersByInv.get(inv.id) ?? [];
    const invReturns = returnsByInv.get(inv.id) ?? [];

    let totalSoldQty = 0;
    let totalReturnedQty = 0;
    const formattedLines = invLines.map((l) => {
      const soldQty = num(l.quantity);
      const retQty = returnedQtyByLineId.get(l.id) ?? 0;
      const remQty = Math.max(0, roundCurrency(soldQty - retQty, 4));
      totalSoldQty = roundCurrency(totalSoldQty + soldQty, 4);
      totalReturnedQty = roundCurrency(totalReturnedQty + retQty, 4);
      return {
        id: l.id,
        productId: l.productId,
        description: l.description,
        quantity: soldQty,
        unitPrice: num(l.unitPrice),
        discount: num(l.discount),
        taxRate: num(l.taxRate),
        taxAmount: num(l.taxAmount),
        lineTotal: num(l.lineTotal),
        returnedQuantity: retQty,
        remainingReturnableQuantity: remQty,
      };
    });

    const formattedTenders = invTenders.map((t) => ({
      method: t.method,
      amount: num(t.amount),
      tenderedAmount: num(t.tenderedAmount),
      changeGiven: num(t.changeGiven),
      reference: t.reference,
    }));
    const totalChangeGiven = formattedTenders.reduce(
      (sum, t) => roundCurrency(sum + t.changeGiven, 4),
      0
    );
    const returnedTotalAmount = invReturns.reduce(
      (sum, r) => roundCurrency(sum + num(r.totalAmount), 4),
      0
    );

    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      branchId: inv.branchId,
      terminalId: inv.posTerminalId ?? "",
      shiftId: inv.posShiftId ?? "",
      customerId: inv.customerId,
      customerName: customerName ?? "Walk-in Customer",
      cashierUserId: inv.cashierUserId ?? "",
      cashierName: cashierName ?? "Cashier",
      invoiceDate: inv.invoiceDate.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      currency: inv.currency,
      subtotal: num(inv.subtotal),
      taxTotal: num(inv.taxTotal),
      totalAmount: num(inv.totalAmount),
      paidAmount: num(inv.paidAmount),
      totalChangeGiven,
      syncStatus: inv.syncStatus,
      offlineClientTxId: inv.offlineClientTxId,
      icv: inv.icv,
      qrTlv: inv.qrTlv,
      etaDocumentUuid: inv.etaDocumentUuid,
      etaReceiptStatus: inv.etaReceiptStatus,
      eInvoiceStatus: inv.eInvoiceStatus,
      returnCount: invReturns.length,
      returnedTotalAmount,
      totalSoldQty,
      totalReturnedQty,
      remainingReturnableQty: Math.max(0, roundCurrency(totalSoldQty - totalReturnedQty, 4)),
      lines: formattedLines,
      tenders: formattedTenders,
    };
  });

  return {
    items,
    receipts: items,
    pageInfo,
  };
}

export async function getPosReceiptDetail(
  db: AppDatabase,
  actor: RequestActor,
  invoiceId: string
) {
  const [row] = await db
    .select({
      inv: salesInvoices,
      customerName: customers.name,
      cashierName: users.name,
    })
    .from(salesInvoices)
    .leftJoin(customers, eq(customers.id, salesInvoices.customerId))
    .leftJoin(users, eq(users.id, salesInvoices.cashierUserId))
    .where(and(eq(salesInvoices.id, invoiceId), eq(salesInvoices.sourceChannel, "pos")))
    .limit(1);

  if (!row) {
    throw new AppError(404, "POS receipt not found", "RECEIPT_NOT_FOUND");
  }
  assertBranchAccess(actor, row.inv.branchId);

  const [invLines, tenderRows, returnRows] = await Promise.all([
    db.select().from(salesInvoiceLines).where(eq(salesInvoiceLines.invoiceId, row.inv.id)),
    db.select().from(posTenders).where(eq(posTenders.invoiceId, row.inv.id)),
    db
      .select()
      .from(posReturns)
      .where(eq(posReturns.originalInvoiceId, row.inv.id))
      .orderBy(desc(posReturns.createdAt)),
  ]);

  const returnIds = returnRows.map((r) => r.id);
  const returnLineRows =
    returnIds.length > 0
      ? await db.select().from(posReturnLines).where(inArray(posReturnLines.posReturnId, returnIds))
      : [];

  const returnedQtyByLineId = new Map<string, number>();
  for (const rl of returnLineRows) {
    const prev = returnedQtyByLineId.get(rl.originalInvoiceLineId) ?? 0;
    returnedQtyByLineId.set(rl.originalInvoiceLineId, roundCurrency(prev + num(rl.quantity), 4));
  }
  const returnLinesByReturnId = groupByKey(returnLineRows, (rl) => rl.posReturnId);

  const lines = invLines.map((l) => {
    const soldQty = num(l.quantity);
    const retQty = returnedQtyByLineId.get(l.id) ?? 0;
    return {
      id: l.id,
      productId: l.productId,
      description: l.description,
      quantity: soldQty,
      unitPrice: num(l.unitPrice),
      discount: num(l.discount),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
      lineTotal: num(l.lineTotal),
      returnedQuantity: retQty,
      remainingReturnableQuantity: Math.max(0, roundCurrency(soldQty - retQty, 4)),
    };
  });

  const tenders = tenderRows.map((t) => ({
    id: t.id,
    method: t.method,
    amount: num(t.amount),
    tenderedAmount: num(t.tenderedAmount),
    changeGiven: num(t.changeGiven),
    reference: t.reference,
  }));
  const totalChangeGiven = tenders.reduce((sum, t) => roundCurrency(sum + t.changeGiven, 4), 0);

  const returns = returnRows.map((r) => ({
    id: r.id,
    returnNumber: r.returnNumber,
    originalInvoiceId: r.originalInvoiceId,
    branchId: r.branchId,
    terminalId: r.terminalId,
    shiftId: r.shiftId,
    cashierUserId: r.cashierUserId,
    approvedByUserId: r.approvedByUserId,
    refundMethod: r.refundMethod,
    restockItems: r.restockItems,
    reason: r.reason,
    subtotal: num(r.subtotal),
    taxAmount: num(r.taxAmount),
    totalAmount: num(r.totalAmount),
    etaDocumentUuid: r.etaDocumentUuid,
    etaReceiptStatus: r.etaReceiptStatus,
    createdAt: r.createdAt.toISOString(),
    lines: (returnLinesByReturnId.get(r.id) ?? []).map((rl) => ({
      id: rl.id,
      originalInvoiceLineId: rl.originalInvoiceLineId,
      productId: rl.productId,
      quantity: num(rl.quantity),
      unitPrice: num(rl.unitPrice),
      taxRate: num(rl.taxRate),
      taxAmount: num(rl.taxAmount),
      lineTotal: num(rl.lineTotal),
      restockedQty: num(rl.restockedQty),
    })),
  }));

  return {
    receipt: {
      id: row.inv.id,
      invoiceNumber: row.inv.invoiceNumber,
      branchId: row.inv.branchId,
      terminalId: row.inv.posTerminalId ?? "",
      shiftId: row.inv.posShiftId ?? "",
      customerId: row.inv.customerId,
      customerName: row.customerName ?? "Walk-in Customer",
      cashierUserId: row.inv.cashierUserId ?? "",
      cashierName: row.cashierName ?? "Cashier",
      invoiceDate: row.inv.invoiceDate.toISOString(),
      createdAt: row.inv.createdAt.toISOString(),
      currency: row.inv.currency,
      subtotal: num(row.inv.subtotal),
      taxTotal: num(row.inv.taxTotal),
      totalAmount: num(row.inv.totalAmount),
      paidAmount: num(row.inv.paidAmount),
      totalChangeGiven,
      syncStatus: row.inv.syncStatus,
      offlineClientTxId: row.inv.offlineClientTxId,
      icv: row.inv.icv,
      qrTlv: row.inv.qrTlv,
      etaDocumentUuid: row.inv.etaDocumentUuid,
      etaReceiptStatus: row.inv.etaReceiptStatus,
      eInvoiceStatus: row.inv.eInvoiceStatus,
      returnCount: returns.length,
      returnedTotalAmount: returns.reduce((sum, r) => roundCurrency(sum + r.totalAmount, 4), 0),
      lines,
      tenders,
      returns,
    },
  };
}

async function restoreTrackedStockForPosReturn(
  tx: DbOrTx,
  input: {
    originalInvoiceId: string;
    branchId: string;
    product: typeof products.$inferSelect;
    quantity: number;
    unitCost: number;
    movementId: string;
    lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
    serialNumbers?: string[];
  }
): Promise<void> {
  const mode = resolveProductTrackingMode(input.product);
  if (mode === "none" || input.quantity <= 0) return;

  if (mode === "lot") {
    if (input.lotAllocations && input.lotAllocations.length > 0) {
      for (const alloc of input.lotAllocations) {
        let lotId = alloc.lotId;
        if (!lotId && alloc.lotNumber) {
          const [found] = await tx
            .select({ id: stockLots.id })
            .from(stockLots)
            .where(and(eq(stockLots.productId, input.product.id), eq(stockLots.lotNumber, alloc.lotNumber.trim())))
            .limit(1);
          lotId = found?.id;
        }
        if (!lotId) continue;

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
          SELECT id, qty_on_hand FROM branch_lot_balances
          WHERE branch_id = ${input.branchId} AND lot_id = ${lotId}
          FOR UPDATE
        `);
        const bal = balRows[0];
        if (bal) {
          await tx
            .update(branchLotBalances)
            .set({
              qtyOnHand: toNumeric(roundCurrency(num(bal.qty_on_hand) + alloc.quantity, 4), 4),
              updatedAt: new Date(),
            })
            .where(eq(branchLotBalances.id, bal.id));
        }
        await tx.insert(stockMovementAllocations).values({
          movementId: input.movementId,
          lotId,
          quantity: toNumeric(alloc.quantity, 4),
          unitCost: toNumeric(input.unitCost, 4),
        });
      }
      return;
    }

    // Fallback: restore into lots consumed by original POS sale
    const saleMovements = await tx
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.referenceType, "pos_sale"),
          eq(stockMovements.referenceId, input.originalInvoiceId),
          eq(stockMovements.productId, input.product.id)
        )
      );
    if (saleMovements.length === 0) return;

    const saleAllocs = await tx
      .select()
      .from(stockMovementAllocations)
      .where(inArray(stockMovementAllocations.movementId, saleMovements.map((m) => m.id)));

    let remaining = input.quantity;
    for (const a of saleAllocs) {
      if (!a.lotId || remaining <= 0.0001) continue;
      const take = Math.min(remaining, Math.abs(num(a.quantity)));
      if (take <= 0.0001) continue;

      const balRows = await tx.execute<{ id: string; qty_on_hand: string }>(sql`
        SELECT id, qty_on_hand FROM branch_lot_balances
        WHERE branch_id = ${input.branchId} AND lot_id = ${a.lotId}
        FOR UPDATE
      `);
      const bal = balRows[0];
      if (bal) {
        await tx
          .update(branchLotBalances)
          .set({
            qtyOnHand: toNumeric(roundCurrency(num(bal.qty_on_hand) + take, 4), 4),
            updatedAt: new Date(),
          })
          .where(eq(branchLotBalances.id, bal.id));
      }
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

  // Serial tracking restoration
  const targetSerials =
    input.serialNumbers && input.serialNumbers.length > 0
      ? await tx
          .select()
          .from(stockSerials)
          .where(
            and(
              eq(stockSerials.productId, input.product.id),
              inArray(stockSerials.serialNumber, input.serialNumbers)
            )
          )
      : await tx
          .select()
          .from(stockSerials)
          .where(
            and(
              eq(stockSerials.productId, input.product.id),
              eq(stockSerials.soldInvoiceId, input.originalInvoiceId),
              eq(stockSerials.status, "sold")
            )
          )
          .limit(Math.round(input.quantity));

  for (const s of targetSerials) {
    await tx
      .update(stockSerials)
      .set({
        status: "in_stock",
        branchId: input.branchId,
        soldInvoiceId: null,
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

export async function executePosReturnTx(
  tx: DbOrTx,
  actor: RequestActor,
  input: PosReturnInput,
  options: {
    approvedByUserId?: string | null;
    ipAddress?: string;
  } = {}
) {
  let approvedByUserId = options.approvedByUserId ?? null;
  if (!approvedByUserId) {
    const canApproveDirectly =
      actor.role === "admin" ||
      actor.role === "manager" ||
      Boolean((actor as AuthUser).permissions?.pos?.approve);

    if (input.managerOverridePin) {
      const overrideRes = await verifyManagerPinOverride(tx, {
        pin: input.managerOverridePin,
        terminalId: input.terminalId,
        action: "refund",
        reason: input.reason,
        requestedByUserId: actor.id,
        requestedByName: actor.name,
        requestedByRole: actor.role,
        branchIds: actor.branchIds,
        hasAllBranchScope: actor.role === "admin" || actor.branchScopeMode === "all",
        ipAddress: options.ipAddress,
      });
      approvedByUserId = overrideRes.approver.id;
    } else if (!canApproveDirectly) {
      throw new AppError(
        403,
        "Manager override PIN is required to process a POS return",
        "POS_OVERRIDE_REQUIRED"
      );
    } else {
      approvedByUserId = input.approvedByUserId ?? actor.id;
    }
  }

  const invRows = await tx.execute<{
    id: string;
    invoice_number: string;
    branch_id: string;
    customer_id: string;
    source_channel: string;
    currency: string;
    eta_document_uuid: string | null;
  }>(sql`
    SELECT id, invoice_number, branch_id, customer_id, source_channel, currency, eta_document_uuid
    FROM sales_invoices
    WHERE id = ${input.originalInvoiceId}
    FOR UPDATE
  `);
  const origInv = invRows[0];
  if (!origInv || origInv.source_channel !== "pos") {
    throw new AppError(404, "Original POS receipt not found", "RECEIPT_NOT_FOUND");
  }
  assertBranchAccess(actor, origInv.branch_id);

  const [terminal] = await tx
    .select()
    .from(posTerminals)
    .where(eq(posTerminals.id, input.terminalId))
    .limit(1);
  if (!terminal || terminal.branchId !== origInv.branch_id) {
    throw new AppError(400, "POS terminal does not match receipt branch", "TERMINAL_BRANCH_MISMATCH");
  }

  const shiftRows = await tx.execute<{
    id: string;
    shift_number: string;
    terminal_id: string;
    branch_id: string;
    status: string;
    expected_cash: string;
    total_cash_refunds: string;
    total_card_refunds: string;
    total_wallet_refunds: string;
    total_refunds_count: number;
  }>(sql`
    SELECT id, shift_number, terminal_id, branch_id, status, expected_cash,
           total_cash_refunds, total_card_refunds, total_wallet_refunds, total_refunds_count
    FROM pos_shifts
    WHERE id = ${input.shiftId}
    FOR UPDATE
  `);
  const shift = shiftRows[0];
  if (!shift || shift.terminal_id !== terminal.id || shift.branch_id !== terminal.branchId) {
    throw new AppError(404, "POS shift not found for this terminal", "SHIFT_NOT_FOUND");
  }
  if (shift.status !== "open") {
    throw new AppError(400, "Cannot process a POS return on a closed shift", "SHIFT_CLOSED");
  }

  const origLines = await tx
    .select()
    .from(salesInvoiceLines)
    .where(eq(salesInvoiceLines.invoiceId, origInv.id));
  const origLineById = new Map(origLines.map((l) => [l.id, l]));

  const existingReturnRows = await tx
    .select({
      originalInvoiceLineId: posReturnLines.originalInvoiceLineId,
      quantity: posReturnLines.quantity,
    })
    .from(posReturnLines)
    .innerJoin(posReturns, eq(posReturns.id, posReturnLines.posReturnId))
    .where(eq(posReturns.originalInvoiceId, origInv.id));

  const alreadyReturnedByLine = new Map<string, number>();
  for (const r of existingReturnRows) {
    const prev = alreadyReturnedByLine.get(r.originalInvoiceLineId) ?? 0;
    alreadyReturnedByLine.set(r.originalInvoiceLineId, roundCurrency(prev + num(r.quantity), 4));
  }

  const requestedByLine = new Map<string, number>();
  for (const reqLine of input.lines) {
    const origLine = origLineById.get(reqLine.originalInvoiceLineId);
    if (!origLine) {
      throw new AppError(400, "Original invoice line not found on this receipt", "INVALID_RETURN_LINE");
    }
    if (origLine.productId && origLine.productId !== reqLine.productId) {
      throw new AppError(400, "Product mismatch for original invoice line", "INVALID_RETURN_LINE");
    }
    const nextReq = roundCurrency((requestedByLine.get(origLine.id) ?? 0) + reqLine.quantity, 4);
    requestedByLine.set(origLine.id, nextReq);

    const soldQty = num(origLine.quantity);
    const alreadyReturnedQty = alreadyReturnedByLine.get(origLine.id) ?? 0;
    const remainingQty = Math.max(0, roundCurrency(soldQty - alreadyReturnedQty, 4));
    if (nextReq > remainingQty + 0.0001) {
      throw new AppError(
        400,
        `Return quantity (${nextReq}) exceeds remaining returnable quantity (${remainingQty}) for ${origLine.description}`,
        "RETURN_QTY_EXCEEDED"
      );
    }
  }

  let returnSubtotal = 0;
  let returnTaxTotal = 0;
  const computedReturnLines = input.lines.map((reqLine) => {
    const origLine = origLineById.get(reqLine.originalInvoiceLineId)!;
    const soldQty = num(origLine.quantity);
    const origLineTotal = num(origLine.lineTotal);
    const origTaxAmount = num(origLine.taxAmount);
    const origSubtotal = roundCurrency(origLineTotal - origTaxAmount, 4);

    let lineSubtotal: number;
    let lineTaxAmount: number;
    let lineTotal: number;
    if (Math.abs(reqLine.quantity - soldQty) < 0.0001) {
      lineSubtotal = origSubtotal;
      lineTaxAmount = origTaxAmount;
      lineTotal = origLineTotal;
    } else {
      const ratio = reqLine.quantity / soldQty;
      lineTotal = roundCurrency(origLineTotal * ratio, 4);
      lineTaxAmount = roundCurrency(origTaxAmount * ratio, 4);
      lineSubtotal = roundCurrency(lineTotal - lineTaxAmount, 4);
    }

    returnSubtotal = roundCurrency(returnSubtotal + lineSubtotal, 4);
    returnTaxTotal = roundCurrency(returnTaxTotal + lineTaxAmount, 4);

    return {
      ...reqLine,
      origLine,
      unitPrice: num(origLine.unitPrice),
      taxRate: num(origLine.taxRate),
      taxAmount: lineTaxAmount,
      lineTotal,
    };
  });
  const returnGrandTotal = roundCurrency(returnSubtotal + returnTaxTotal, 4);

  const returnNumber = await nextDocNumber(tx, "POSR", "POSR-");
  const restockFlag = input.restockItems ?? true;

  const [createdReturn] = await tx
    .insert(posReturns)
    .values({
      returnNumber,
      originalInvoiceId: origInv.id,
      branchId: origInv.branch_id,
      terminalId: terminal.id,
      shiftId: shift.id,
      cashierUserId: actor.id,
      approvedByUserId,
      refundMethod: input.refundMethod,
      restockItems: restockFlag,
      reason: input.reason.trim(),
      subtotal: toNumeric(returnSubtotal, 4),
      taxAmount: toNumeric(returnTaxTotal, 4),
      totalAmount: toNumeric(returnGrandTotal, 4),
    })
    .returning();

  const sortedLines = [...computedReturnLines].sort((a, b) => a.productId.localeCompare(b.productId));
  let totalRestockCostVal = 0;
  const insertedReturnLines: Array<typeof posReturnLines.$inferSelect> = [];

  for (const line of sortedLines) {
    const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
    if (!prod) throw new AppError(404, `Product ${line.productId} not found`, "NOT_FOUND");

    const origUnitCost = num(line.origLine.unitCostSnapshot);
    let unitCostSnapshot = origUnitCost > 0 ? origUnitCost : num(prod.costPrice);
    const isStockItem = prod.itemType !== "non_stock" && prod.itemType !== "service";
    const shouldRestock = restockFlag && isStockItem;
    let restockedQty = 0;

    if (shouldRestock) {
      const moved = await applyBranchStockMovement(tx, {
        branchId: origInv.branch_id,
        productId: line.productId,
        qtyDelta: line.quantity,
        unitCostForWmac: unitCostSnapshot,
        fallbackCost: unitCostSnapshot,
        recomputeAvgCost: true,
        rejectNegative: false,
        movementType: "sales_return",
        movementUnitCost: unitCostSnapshot,
        referenceType: "pos_return",
        referenceId: createdReturn.id,
        referenceNumber: createdReturn.returnNumber,
        notes: `POS return ${createdReturn.returnNumber} (orig ${origInv.invoice_number})`,
        actorId: actor.id,
      });

      await restoreTrackedStockForPosReturn(tx, {
        originalInvoiceId: origInv.id,
        branchId: origInv.branch_id,
        product: prod,
        quantity: line.quantity,
        unitCost: unitCostSnapshot,
        movementId: moved.movementId,
        lotAllocations: line.lotAllocations,
        serialNumbers: line.serialNumbers,
      });

      restockedQty = line.quantity;
      unitCostSnapshot = moved.movementCost;
      totalRestockCostVal = roundCurrency(totalRestockCostVal + Math.abs(moved.totalValueDelta), 4);
    }

    const [insertedLine] = await tx
      .insert(posReturnLines)
      .values({
        posReturnId: createdReturn.id,
        originalInvoiceLineId: line.originalInvoiceLineId,
        productId: line.productId,
        quantity: toNumeric(line.quantity, 4),
        unitPrice: toNumeric(line.unitPrice, 4),
        taxRate: toNumeric(line.taxRate, 4),
        taxAmount: toNumeric(line.taxAmount, 4),
        lineTotal: toNumeric(line.lineTotal, 4),
        restockedQty: toNumeric(restockedQty, 4),
        unitCostSnapshot: toNumeric(unitCostSnapshot, 4),
      })
      .returning();
    insertedReturnLines.push(insertedLine);
  }

  // Update shift refund accumulators & expectedCash
  const nextCashRefunds =
    input.refundMethod === "cash"
      ? roundCurrency(num(shift.total_cash_refunds) + returnGrandTotal, 4)
      : num(shift.total_cash_refunds);
  const nextCardRefunds =
    input.refundMethod === "card"
      ? roundCurrency(num(shift.total_card_refunds) + returnGrandTotal, 4)
      : num(shift.total_card_refunds);
  const nextWalletRefunds =
    input.refundMethod === "mobile_wallet"
      ? roundCurrency(num(shift.total_wallet_refunds) + returnGrandTotal, 4)
      : num(shift.total_wallet_refunds);
  const nextExpectedCash =
    input.refundMethod === "cash"
      ? roundCurrency(num(shift.expected_cash) - returnGrandTotal, 4)
      : num(shift.expected_cash);

  await tx
    .update(posShifts)
    .set({
      totalCashRefunds: toNumeric(nextCashRefunds, 4),
      totalCardRefunds: toNumeric(nextCardRefunds, 4),
      totalWalletRefunds: toNumeric(nextWalletRefunds, 4),
      totalRefundsCount: shift.total_refunds_count + 1,
      expectedCash: toNumeric(nextExpectedCash, 4),
    })
    .where(eq(posShifts.id, shift.id));

  // Post balanced reversing GL journal entries
  const currency = origInv.currency || "USD";
  const refundClearingKey: MappedLineSpec["mappingKey"] =
    input.refundMethod === "cash" ? "pos_cash_drawer" : "card_clearing";
  const glLines: MappedLineSpec[] = [];
  if (returnSubtotal > 0.0001) {
    glLines.push({ mappingKey: "sales_revenue", debit: returnSubtotal, currency, fxRate: 1 });
  }
  if (returnTaxTotal > 0.0001) {
    glLines.push({ mappingKey: "output_vat", debit: returnTaxTotal, currency, fxRate: 1 });
  }
  if (returnGrandTotal > 0.0001) {
    glLines.push({ mappingKey: refundClearingKey, credit: returnGrandTotal, currency, fxRate: 1 });
  }

  if (glLines.length >= 2) {
    await postMappedJournal(tx, {
      branchId: origInv.branch_id,
      entryDate: createdReturn.createdAt,
      sourceType: "pos_return",
      sourceId: createdReturn.id,
      referenceNumber: createdReturn.returnNumber,
      memo: `POS return ${createdReturn.returnNumber} for ${origInv.invoice_number}`,
      createdBy: actor.id,
      lines: glLines,
    });
  }

  if (restockFlag && totalRestockCostVal > 0.0001) {
    await postMappedJournal(tx, {
      branchId: origInv.branch_id,
      entryDate: createdReturn.createdAt,
      sourceType: "pos_return",
      sourceId: createdReturn.id,
      referenceNumber: createdReturn.returnNumber,
      memo: `POS return restock ${createdReturn.returnNumber}`,
      createdBy: actor.id,
      lines: [
        { mappingKey: "inventory_asset", debit: totalRestockCostVal, currency, fxRate: 1 },
        { mappingKey: "cogs", credit: totalRestockCostVal, currency, fxRate: 1 },
      ],
    });
  }

  const einv = await applyPosReturnEInvoiceMetadata(tx, createdReturn.id);

  await writeAuditLog(tx, {
    userId: actor.id,
    userName: actor.name,
    userRole: actor.role,
    branchId: origInv.branch_id,
    action: "pos.return_completed",
    entityType: "pos_return",
    entityId: createdReturn.id,
    entityLabel: createdReturn.returnNumber,
    details: {
      originalInvoiceId: origInv.id,
      originalInvoiceNumber: origInv.invoice_number,
      terminalId: terminal.id,
      shiftId: shift.id,
      refundMethod: input.refundMethod,
      restockItems: restockFlag,
      totalAmount: returnGrandTotal,
      approvedByUserId,
    },
    ipAddress: options.ipAddress,
  });

  const formattedReturn = {
    id: createdReturn.id,
    returnNumber: createdReturn.returnNumber,
    originalInvoiceId: createdReturn.originalInvoiceId,
    originalInvoiceNumber: origInv.invoice_number,
    branchId: createdReturn.branchId,
    terminalId: createdReturn.terminalId,
    shiftId: createdReturn.shiftId,
    cashierUserId: createdReturn.cashierUserId,
    approvedByUserId: createdReturn.approvedByUserId,
    refundMethod: createdReturn.refundMethod,
    restockItems: createdReturn.restockItems,
    reason: createdReturn.reason,
    subtotal: returnSubtotal,
    taxAmount: returnTaxTotal,
    totalAmount: returnGrandTotal,
    etaDocumentUuid: einv.etaDocumentUuid,
    etaReceiptStatus: einv.etaReceiptStatus,
    qrTlv: einv.qrTlv,
    createdAt: createdReturn.createdAt.toISOString(),
    lines: insertedReturnLines.map((rl) => ({
      id: rl.id,
      originalInvoiceLineId: rl.originalInvoiceLineId,
      productId: rl.productId,
      quantity: num(rl.quantity),
      unitPrice: num(rl.unitPrice),
      taxRate: num(rl.taxRate),
      taxAmount: num(rl.taxAmount),
      lineTotal: num(rl.lineTotal),
      restockedQty: num(rl.restockedQty),
      unitCostSnapshot: num(rl.unitCostSnapshot),
    })),
  };

  return {
    posReturn: formattedReturn,
    returnRecord: formattedReturn,
  };
}

export async function createPosReturn(
  db: AppDatabase,
  actor: RequestActor,
  rawInput: unknown,
  ipAddress?: string
) {
  const input = parseOrThrow(posReturnSchema, rawInput, "Invalid POS return payload");
  const canApproveDirectly =
    actor.role === "admin" ||
    actor.role === "manager" ||
    Boolean((actor as AuthUser).permissions?.pos?.approve);

  let approvedByUserId: string | null = input.approvedByUserId ?? (canApproveDirectly ? actor.id : null);

  if (input.managerOverridePin) {
    const overrideRes = await verifyManagerPinOverride(db, {
      pin: input.managerOverridePin,
      terminalId: input.terminalId,
      action: "refund",
      reason: input.reason,
      requestedByUserId: actor.id,
      requestedByName: actor.name,
      requestedByRole: actor.role,
      branchIds: actor.branchIds,
      hasAllBranchScope: actor.role === "admin" || actor.branchScopeMode === "all",
      ipAddress,
    });
    approvedByUserId = overrideRes.approver.id;
  } else if (!canApproveDirectly) {
    throw new AppError(
      403,
      "Manager override PIN is required to process a POS return",
      "POS_OVERRIDE_REQUIRED"
    );
  }

  return db.transaction(async (tx) =>
    executePosReturnTx(tx, actor, input, {
      approvedByUserId,
      ipAddress,
    })
  );
}
