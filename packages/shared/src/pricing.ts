/**
 * Rounds currency values cleanly to avoid IEEE-754 float drift across lines.
 */
export function roundCurrency(value: number, scale = 2): number {
  const factor = Math.pow(10, scale);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Rounds inventory quantities cleanly up to 4 fractional decimal places.
 */
export function roundQty(value: number, scale = 4): number {
  const factor = Math.pow(10, scale);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Computes Weighted Moving Average Cost (WMAC) when positive stock enters a branch.
 */
export function computeWmac(
  currentQty: number,
  currentAvgCost: number,
  incomingQty: number,
  incomingUnitCost: number
): number {
  if (incomingQty <= 0) return currentAvgCost;
  if (currentQty <= 0) return incomingUnitCost;
  const totalQty = currentQty + incomingQty;
  if (totalQty <= 0) return incomingUnitCost;
  return (currentQty * currentAvgCost + incomingQty * incomingUnitCost) / totalQty;
}

export interface LinePricingInput {
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  isTaxInclusive?: boolean;
}

export interface LinePricingResult {
  gross: number;
  taxable: number;
  taxAmount: number;
  lineTotal: number;
}

/**
 * Computes deterministic line subtotal, tax amount, and total with discount clamping.
 * Supports both tax-exclusive (default) and tax-inclusive (retail POS / VAT-included) pricing.
 */
export function calculateLineAmounts(line: LinePricingInput, scale = 2): LinePricingResult {
  const gross = roundCurrency(line.quantity * line.unitPrice, scale);
  const clampedDiscount = Math.min(Math.max(line.discount ?? 0, 0), gross);
  const netAfterDiscount = roundCurrency(Math.max(0, gross - clampedDiscount), scale);
  const rate = Math.max(0, line.taxRate ?? 0);

  if (line.isTaxInclusive && rate > 0) {
    const taxable = roundCurrency(netAfterDiscount / (1 + rate / 100), scale);
    const taxAmount = roundCurrency(netAfterDiscount - taxable, scale);
    return { gross, taxable, taxAmount, lineTotal: netAfterDiscount };
  }

  const taxable = netAfterDiscount;
  const taxAmount = roundCurrency((taxable * rate) / 100, scale);
  const lineTotal = roundCurrency(taxable + taxAmount, scale);
  return { gross, taxable, taxAmount, lineTotal };
}

export interface DocumentTotalsResult {
  subtotal: number;
  taxTotal: number;
  grandTotal: number;
}

/**
 * Aggregates line-level amounts into subtotal, taxTotal, and grandTotal.
 */
export function calculateDocumentTotals(lines: LinePricingInput[], scale = 2): DocumentTotalsResult {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const computed = calculateLineAmounts(line, scale);
    subtotal = roundCurrency(subtotal + computed.taxable, scale);
    taxTotal = roundCurrency(taxTotal + computed.taxAmount, scale);
  }
  const grandTotal = roundCurrency(subtotal + taxTotal, scale);
  return { subtotal, taxTotal, grandTotal };
}
