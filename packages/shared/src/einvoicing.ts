import { z } from "zod";
import { offsetPageQuerySchema, optionalSearchQuery } from "./pagination.ts";
import { EINVOICE_SUBMISSION_STATUSES, type EinvoiceSubmissionStatus } from "./pos.ts";

export const EINVOICE_PROVIDERS = ["eta_egypt", "zatca_phase2"] as const;
export type EinvoiceProvider = (typeof EINVOICE_PROVIDERS)[number];

export const EINVOICE_DOCUMENT_TYPES = ["receipt", "invoice"] as const;
export type EinvoiceDocumentType = (typeof EINVOICE_DOCUMENT_TYPES)[number];

export const ETA_RECEIPT_TYPES = ["S", "R"] as const;
export type EtaReceiptType = (typeof ETA_RECEIPT_TYPES)[number];

const optionalEnumFilter = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values), z.literal(""), z.literal("all")])
    .transform((v) => (v === "" || v === "all" ? undefined : v))
    .optional();

export const einvoiceQueueQuerySchema = offsetPageQuerySchema.extend({
  status: optionalEnumFilter(EINVOICE_SUBMISSION_STATUSES),
  provider: optionalEnumFilter(EINVOICE_PROVIDERS),
  documentType: optionalEnumFilter(EINVOICE_DOCUMENT_TYPES),
  fromDate: optionalSearchQuery,
  toDate: optionalSearchQuery,
  sortBy: z.enum(["createdAt", "updatedAt", "nextRetryAt", "attempts", "status"]).optional(),
});
export type EinvoiceQueueQuery = z.infer<typeof einvoiceQueueQuerySchema>;

export const einvoiceRetrySchema = z.object({
  submissionId: z.string().uuid().optional(),
  submissionIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  force: z.boolean().optional().default(false),
  resetAttempts: z.boolean().optional().default(false),
});
export type EinvoiceRetryInput = z.infer<typeof einvoiceRetrySchema>;

export interface EtaSubmissionListItemDto {
  id: string;
  invoiceId: string | null;
  posReturnId: string | null;
  documentNumber: string | null;
  branchId: string | null;
  branchName: string | null;
  provider: EinvoiceProvider;
  documentType: EinvoiceDocumentType;
  receiptType: EtaReceiptType | null;
  documentUuid: string;
  submissionUuid: string | null;
  status: EinvoiceSubmissionStatus;
  attempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  totalAmount: number | null;
  currency: string | null;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EtaSubmissionDetailDto extends EtaSubmissionListItemDto {
  requestPayloadJson: Record<string, unknown>;
  responsePayloadJson: Record<string, unknown> | null;
}

export interface EinvoiceQueueSummaryDto {
  pending: number;
  submitted: number;
  accepted: number;
  rejected: number;
  failed: number;
  total: number;
  etaConfigured: boolean;
}
