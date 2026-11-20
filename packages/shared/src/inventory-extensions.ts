import { z } from "zod";

export const ITEM_TYPES = ["stock", "non_stock", "service", "manufactured"] as const;
export type ItemTypeShared = (typeof ITEM_TYPES)[number];

export const TRACKING_MODES = ["none", "lot", "serial"] as const;
export type TrackingModeShared = (typeof TRACKING_MODES)[number];

export const PICKING_STRATEGIES = ["FEFO", "FIFO", "LIFO"] as const;
export type PickingStrategyShared = (typeof PICKING_STRATEGIES)[number];

export const SERIAL_STATUSES = [
  "in_stock",
  "reserved",
  "in_transit",
  "sold",
  "returned",
  "written_off",
  "consumed",
] as const;
export type SerialStatusShared = (typeof SERIAL_STATUSES)[number];

export const WORK_ORDER_STATUSES = [
  "Draft",
  "Released",
  "In Progress",
  "Completed",
  "Cancelled",
] as const;
export type WorkOrderStatusShared = (typeof WORK_ORDER_STATUSES)[number];

export const lotAllocationInputSchema = z.object({
  lotId: z.string().uuid().optional(),
  lotNumber: z.string().trim().min(1).max(80).optional(),
  quantity: z.number().positive(),
});

export const lotReceiveMetaSchema = z.object({
  lotNumber: z.string().trim().min(1).max(80).optional(),
  manufactureDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const bomComponentInputSchema = z.object({
  componentProductId: z.string().uuid(),
  quantity: z.number().positive(),
  scrapPercent: z.number().min(0).max(100).optional().default(0),
  notes: z.string().trim().max(250).optional().default(""),
});

export const createBomSchema = z.object({
  productId: z.string().uuid(),
  name: z.string().trim().min(1, "BOM name is required").max(160),
  outputQty: z.number().positive().optional().default(1),
  isActive: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().default(""),
  components: z.array(bomComponentInputSchema).min(1, "At least one component is required"),
});

export const updateBomSchema = createBomSchema.partial().omit({ productId: true });

export const createWorkOrderSchema = z.object({
  bomId: z.string().uuid(),
  branchId: z.string().uuid(),
  plannedQty: z.number().positive(),
  status: z.enum(["Draft", "Released"]).optional().default("Released"),
  notes: z.string().trim().max(500).optional().default(""),
});

export const issueWorkOrderSchema = z.object({
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        componentProductId: z.string().uuid(),
        quantity: z.number().positive(),
        lotAllocations: z.array(lotAllocationInputSchema).optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .optional(),
});

export const completeWorkOrderSchema = z.object({
  qtyCompleted: z.number().positive(),
  notes: z.string().trim().max(500).optional().default(""),
  lotNumber: z.string().trim().min(1).max(80).optional(),
  manufactureDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const cancelWorkOrderSchema = z.object({
  reason: z.string().trim().max(500).optional().default("Cancelled"),
});
