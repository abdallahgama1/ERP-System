import type { ZodType, ZodTypeDef } from "zod";
import { computeWmac, roundCurrency, type AppRole, type BranchScopeMode } from "@erp/shared";
import { eq, sql } from "drizzle-orm";
import { branches, branchProducts, DEFAULT_COMPANY_ID, stockMovements, type MovementType } from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num, toNumeric } from "../db/helpers.ts";

export { computeWmac };

export interface RequestActor {
  id: string;
  name: string;
  role: AppRole;
  activeCompanyId?: string;
  branchScopeMode: BranchScopeMode;
  branchIds: string[];
}

export function actorCompanyId(actor?: Pick<RequestActor, "activeCompanyId"> | null): string {
  return actor?.activeCompanyId || DEFAULT_COMPANY_ID;
}

export async function assertBranchInCompany(
  tx: DbOrTx,
  branchId: string,
  companyId: string
): Promise<void> {
  const [row] = await tx
    .select({ id: branches.id, companyId: branches.companyId })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  if (!row || row.companyId !== companyId) {
    throw new AppError(404, "Branch not found in active company", "NOT_FOUND");
  }
}

export function parseOrThrow<TOut>(
  schema: ZodType<TOut, ZodTypeDef, unknown>,
  input: unknown,
  fallbackMessage = "Validation error"
): TOut {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message ?? fallbackMessage, "VALIDATION_ERROR");
  }
  return parsed.data;
}

/**
 * Acquires deterministic row lock on (branchId, productId) inside a DB transaction,
 * creating the branch_products row on demand if none exists yet.
 */
export async function lockBranchProduct(
  tx: DbOrTx,
  branchId: string,
  productId: string,
  fallbackCost = 0,
  companyId?: string
): Promise<{
  id: string;
  companyId: string;
  qtyOnHand: number;
  qtyReserved: number;
  avgCost: number;
}> {
  let effectiveCompanyId = companyId;
  if (!effectiveCompanyId) {
    const [b] = await tx
      .select({ companyId: branches.companyId })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);
    effectiveCompanyId = b?.companyId ?? DEFAULT_COMPANY_ID;
  }

  await tx
    .insert(branchProducts)
    .values({
      companyId: effectiveCompanyId,
      branchId,
      productId,
      qtyOnHand: "0",
      qtyReserved: "0",
      avgCost: toNumeric(fallbackCost, 4),
    })
    .onConflictDoNothing();

  const rows = await tx.execute<{
    id: string;
    company_id: string;
    qty_on_hand: string;
    qty_reserved: string;
    avg_cost: string;
  }>(sql`
    SELECT id, company_id, qty_on_hand, qty_reserved, avg_cost
    FROM branch_products
    WHERE branch_id = ${branchId} AND product_id = ${productId}
    FOR UPDATE
  `);

  const row = rows[0];
  if (!row) {
    throw new AppError(500, "Failed to lock branch inventory row");
  }

  return {
    id: row.id,
    companyId: row.company_id || effectiveCompanyId,
    qtyOnHand: num(row.qty_on_hand),
    qtyReserved: num(row.qty_reserved),
    avgCost: num(row.avg_cost),
  };
}

export interface StockChangeInput {
  companyId?: string;
  branchId: string;
  productId: string;
  qtyDelta: number;
  unitCostForWmac?: number;
  fallbackCost?: number;
  recomputeAvgCost?: boolean;
  rejectNegative?: boolean;
  insufficientStockMessage?: string;
  movementType: MovementType;
  movementUnitCost?: number;
  referenceType: string;
  referenceId: string;
  referenceNumber: string;
  notes: string;
  actorId: string;
}

/**
 * Atomically locks branch inventory, validates non-negative stock when subtracting,
 * updates qtyOnHand & WMAC avgCost, and appends an immutable stock_movements ledger row.
 */
export async function applyBranchStockMovement(
  tx: DbOrTx,
  input: StockChangeInput
): Promise<{
  movementId: string;
  previousQty: number;
  rawNewQty: number;
  newQty: number;
  previousAvgCost: number;
  newAvgCost: number;
  movementCost: number;
  totalValueDelta: number;
}> {
  const fallback = input.fallbackCost ?? input.unitCostForWmac ?? 0;
  const bp = await lockBranchProduct(tx, input.branchId, input.productId, fallback, input.companyId);
  const previousQty = bp.qtyOnHand;
  const rawNewQty = previousQty + input.qtyDelta;

  if (input.rejectNegative !== false && rawNewQty < -0.0001) {
    throw new AppError(
      400,
      input.insufficientStockMessage ??
        `Insufficient stock for product ${input.productId}: available ${previousQty}, requested change ${input.qtyDelta}`,
      "INSUFFICIENT_STOCK"
    );
  }

  // Zero-stock residual clamp: eliminate fractional qty/penny residuals when hitting zero
  const isZeroingOut = Math.abs(rawNewQty) < 0.0001 && input.qtyDelta < 0;
  const newQty = isZeroingOut ? 0 : Math.max(0, rawNewQty);

  const incomingCost = input.unitCostForWmac ?? (bp.avgCost > 0 ? bp.avgCost : fallback);
  const newAvgCost =
    input.qtyDelta > 0 && input.recomputeAvgCost
      ? computeWmac(previousQty, bp.avgCost, input.qtyDelta, incomingCost)
      : bp.avgCost > 0
        ? bp.avgCost
        : fallback;

  await tx
    .update(branchProducts)
    .set({
      qtyOnHand: toNumeric(newQty, 4),
      ...(input.qtyDelta > 0 && input.recomputeAvgCost ? { avgCost: toNumeric(newAvgCost, 4) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(branchProducts.id, bp.id));

  const movementCost =
    input.movementUnitCost ?? (input.qtyDelta > 0 ? incomingCost : bp.avgCost > 0 ? bp.avgCost : fallback);

  // Sweep full carrying value cleanly when inventory hits zero
  const totalValueDelta = isZeroingOut
    ? -roundCurrency(previousQty * bp.avgCost, 4)
    : roundCurrency(input.qtyDelta * movementCost, 4);

  const [movementRow] = await tx
    .insert(stockMovements)
    .values({
      companyId: input.companyId ?? bp.companyId,
      branchId: input.branchId,
      productId: input.productId,
      movementType: input.movementType,
      qtyDelta: toNumeric(input.qtyDelta, 4),
      unitCost: toNumeric(movementCost, 4),
      balanceAfter: toNumeric(newQty, 4),
      avgCostAfter: toNumeric(newAvgCost, 4),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      referenceNumber: input.referenceNumber,
      notes: input.notes,
      createdBy: input.actorId,
    })
    .returning({ id: stockMovements.id });

  return {
    movementId: movementRow.id,
    previousQty,
    rawNewQty,
    newQty,
    previousAvgCost: bp.avgCost,
    newAvgCost,
    movementCost,
    totalValueDelta,
  };
}
