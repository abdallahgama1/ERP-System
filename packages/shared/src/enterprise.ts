import { z } from "zod";
import { APP_ROLES } from "./permissions.ts";

export const APPROVAL_ENTITY_TYPES = [
  "purchase_order",
  "stock_transfer",
  "stock_adjustment",
  "stock_write_off",
] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];

export const APPROVAL_STATUSES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const upsertApprovalRuleSchema = z.object({
  entityType: z.enum(APPROVAL_ENTITY_TYPES),
  minAmount: z.number().min(0),
  requiredRole: z.enum(APP_ROLES).default("manager"),
  isActive: z.boolean().default(false),
  description: z.string().trim().max(300).optional().default(""),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(500).optional().default(""),
});

export type UpsertApprovalRuleInput = z.input<typeof upsertApprovalRuleSchema>;
export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;
