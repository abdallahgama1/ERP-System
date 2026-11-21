import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  calculateLineAmounts,
  roundCurrency,
  type closeShiftSchema,
  type createPosTerminalSchema,
  type openShiftSchema,
  type posCheckoutSchema,
  type shiftCashMovementSchema,
  type updatePosTerminalSchema,
} from "@erp/shared";
import {
  branches,
  branchProducts,
  companySettings,
  customers,
  notifications,
  posShiftCashMovements,
  posShifts,
  posTenders,
  posTerminals,
  products,
  salesInvoiceLines,
  salesInvoices,
  taxCodes,
  userBranches,
  userBranchScopes,
  userPosPins,
  userRoles,
  users,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { applyInvoiceEInvoiceMetadata } from "./einvoicing.service.ts";
import { postMappedJournal, type MappedLineSpec } from "./gl.service.ts";
import { consumeTrackedStock, linkConsumedAllocations } from "./lots-serials.service.ts";
import { buildBranchScopeCondition } from "./query-helpers.ts";
import { applyBranchStockMovement, type RequestActor } from "./stock-locks.ts";

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
    productId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRate: number;
    taxAmount: number;
    lineTotal: number;
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
    }>(sql`
      SELECT id, shift_number, terminal_id, branch_id, status, opening_float, total_cash_sales
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
      num(shift.opening_float) + num(shift.total_cash_sales) + netMovements,
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

    await tx.insert(salesInvoiceLines).values({
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
    });
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
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxRate: l.taxRate,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
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
