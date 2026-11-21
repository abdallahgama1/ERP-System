import { z } from "zod";
import { lotAllocationInputSchema } from "./inventory-extensions.ts";
import { calculateDocumentTotals } from "./pricing.ts";

export const EINVOICING_MODES = ["none", "zatca_qr", "zatca_phase2", "eta_egypt"] as const;
export type EInvoicingModeShared = (typeof EINVOICING_MODES)[number];

export const POS_PAYMENT_METHODS = ["cash", "card", "mobile_wallet"] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

export const POS_SHIFT_STATUSES = ["open", "closed"] as const;
export type PosShiftStatus = (typeof POS_SHIFT_STATUSES)[number];

export const POS_CASH_MOVEMENT_TYPES = ["pay_in", "pay_out", "safe_drop"] as const;
export type PosCashMovementType = (typeof POS_CASH_MOVEMENT_TYPES)[number];

export const createPosTerminalSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().trim().min(1, "Terminal code is required").max(32),
  name: z.string().trim().min(1, "Terminal name is required").max(120),
  receiptPrefix: z.string().trim().min(1).max(24).optional().default("POS-"),
  defaultCustomerId: z.string().uuid().nullable().optional(),
  etaPosSerial: z.string().trim().max(80).nullable().optional(),
  etaPosOsVersion: z.string().trim().max(80).nullable().optional(),
  etaActivityCode: z.string().trim().max(40).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const updatePosTerminalSchema = createPosTerminalSchema.partial().omit({ branchId: true });

export const bindTerminalSchema = z.object({
  terminalId: z.string().uuid(),
});

export const openShiftSchema = z.object({
  terminalId: z.string().uuid(),
  openingFloat: z.number().min(0).default(0),
  notes: z.string().trim().max(500).optional().default(""),
});

export const closeShiftSchema = z.object({
  countedCash: z.number().min(0),
  notes: z.string().trim().max(500).optional().default(""),
  forceClose: z.boolean().optional().default(false),
});

export const shiftCashMovementSchema = z.object({
  movementType: z.enum(POS_CASH_MOVEMENT_TYPES),
  amount: z.number().positive(),
  reason: z.string().trim().min(1, "Reason is required").max(250),
});

export const setCashierPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 numeric digits"),
  currentPassword: z.string().min(1).optional(),
  userId: z.string().uuid().optional(),
});

export const pinSwitchSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4 to 6 numeric digits"),
  userId: z.string().uuid().optional(),
  terminalId: z.string().uuid().optional(),
});

export const posTenderLineSchema = z
  .object({
    method: z.enum(POS_PAYMENT_METHODS),
    amount: z.number().positive(),
    tenderedAmount: z.number().positive().optional(),
    reference: z.string().trim().max(120).optional().default(""),
  })
  .refine(
    (t) => t.method !== "cash" || t.tenderedAmount === undefined || t.tenderedAmount + 0.005 >= t.amount,
    { message: "Cash tendered amount cannot be less than applied cash amount" }
  );

export const posCheckoutLineSchema = z.object({
  productId: z.string().uuid(),
  description: z.string().trim().max(250).optional().default(""),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
  discount: z.number().min(0).optional().default(0),
  taxRate: z.number().min(0).max(100).optional().default(0),
  isTaxInclusive: z.boolean().optional().default(false),
  lotAllocations: z.array(lotAllocationInputSchema).optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const posCheckoutSchema = z
  .object({
    terminalId: z.string().uuid(),
    shiftId: z.string().uuid(),
    customerId: z.string().uuid().nullable().optional(),
    cashierUserId: z.string().uuid().optional(),
    currency: z.string().trim().max(10).optional().default("USD"),
    fxRate: z.number().positive().optional().default(1),
    notes: z.string().trim().max(500).optional().default(""),
    offlineClientTxId: z.string().trim().min(8).max(80).optional(),
    offlineReceiptRef: z.string().trim().max(80).optional(),
    offlineCreatedAt: z.string().datetime({ offset: true }).optional(),
    lines: z.array(posCheckoutLineSchema).min(1, "Cart cannot be empty"),
    tenders: z.array(posTenderLineSchema).min(1, "At least one payment tender is required"),
  })
  .refine(
    (data) => {
      const totals = calculateDocumentTotals(
        data.lines.map((l) => ({
          quantity: l.quantity ?? 0,
          unitPrice: l.unitPrice ?? 0,
          discount: l.discount,
          taxRate: l.taxRate,
          isTaxInclusive: l.isTaxInclusive,
        })),
        2
      );
      const tenderSum = data.tenders.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      return Math.abs(tenderSum - totals.grandTotal) <= 0.01;
    },
    { message: "Sum of payment tenders must equal cart grand total" }
  );

export const posSyncBatchSchema = z.object({
  terminalId: z.string().uuid(),
  sales: z.array(posCheckoutSchema).min(1).max(100),
});

export type PosCheckoutInput = z.infer<typeof posCheckoutSchema>;
export type PosSyncBatchInput = z.infer<typeof posSyncBatchSchema>;
