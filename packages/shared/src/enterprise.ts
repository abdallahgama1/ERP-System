import { z } from "zod";
import { APP_ROLES, PERMISSION_MODULES, type AppRole, type PermissionMap, type PermissionModule } from "./permissions.ts";
import { EINVOICING_MODES, type EInvoicingModeShared } from "./pos.ts";

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

// ============================================================================
// Wave 1: Multi-Company / Multi-Entity Tenancy
// ============================================================================

export const DEFAULT_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_COMPANY_CODE = "COMP-01";

export const createCompanySchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, "Company code may only contain letters, numbers, underscores, and hyphens")
    .transform((v) => v.toUpperCase())
    .optional(),
  name: z.string().trim().min(1, "Company name is required").max(160),
  legalName: z.string().trim().max(200).optional().default(""),
  taxRegistrationNumber: z.string().trim().max(80).optional().default(""),
  baseCurrency: z.string().trim().min(3).max(10).optional().default("USD"),
  einvoicingMode: z.enum(EINVOICING_MODES).optional().default("none"),
  address: z.string().trim().max(400).optional().default(""),
  phone: z.string().trim().max(60).optional().default(""),
  email: z.string().trim().email("Invalid company email").or(z.literal("")).optional().default(""),
  settingsJson: z.record(z.unknown()).optional().default({}),
  isActive: z.boolean().optional().default(true),
});

export const updateCompanySchema = createCompanySchema.partial().extend({
  defaultBranchId: z.string().uuid().nullable().optional(),
});

export const switchCompanySchema = z.object({
  companyId: z.string().uuid(),
});

export const assignCompanyMemberSchema = z.object({
  userId: z.string().uuid(),
  customRoleId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional().default(false),
});

export const updateCompanyMemberSchema = z.object({
  customRoleId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export type CreateCompanyInput = z.input<typeof createCompanySchema>;
export type UpdateCompanyInput = z.input<typeof updateCompanySchema>;
export type SwitchCompanyInput = z.infer<typeof switchCompanySchema>;
export type AssignCompanyMemberInput = z.input<typeof assignCompanyMemberSchema>;
export type UpdateCompanyMemberInput = z.input<typeof updateCompanyMemberSchema>;

export interface CompanyDto {
  id: string;
  code: string;
  name: string;
  legalName: string;
  taxRegistrationNumber: string;
  baseCurrency: string;
  einvoicingMode: EInvoicingModeShared;
  defaultBranchId: string | null;
  address: string;
  phone: string;
  email: string;
  settingsJson: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserCompanySummaryDto {
  id: string;
  code: string;
  name: string;
  role: AppRole;
  customRoleId: string | null;
  customRoleName: string | null;
  isDefault: boolean;
  isActive: boolean;
}

// ============================================================================
// Wave 1: Dynamic Custom Roles & Permissions
// ============================================================================

export const modulePermissionSchema = z.object({
  view: z.boolean().default(false),
  create: z.boolean().default(false),
  edit: z.boolean().default(false),
  delete: z.boolean().default(false),
  approve: z.boolean().default(false),
});

const customRolePermissionsShape = Object.fromEntries(
  PERMISSION_MODULES.map((mod) => [mod, modulePermissionSchema])
) as Record<PermissionModule, typeof modulePermissionSchema>;

export const customRolePermissionsMapSchema = z.object(customRolePermissionsShape).strict();

export const createCustomRoleSchema = z.object({
  name: z.string().trim().min(2, "Role name must be at least 2 characters").max(80),
  description: z.string().trim().max(300).optional().default(""),
  baseRole: z.enum(APP_ROLES).default("user"),
  permissions: customRolePermissionsMapSchema,
});

export const updateCustomRoleSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  baseRole: z.enum(APP_ROLES).optional(),
  isActive: z.boolean().optional(),
  permissions: customRolePermissionsMapSchema.optional(),
});

export const assignUserCustomRoleSchema = z.object({
  customRoleId: z.string().uuid(),
  companyId: z.string().uuid().optional(),
});

export type CreateCustomRoleInput = z.input<typeof createCustomRoleSchema>;
export type UpdateCustomRoleInput = z.input<typeof updateCustomRoleSchema>;
export type AssignUserCustomRoleInput = z.infer<typeof assignUserCustomRoleSchema>;

export interface CustomRoleDto {
  id: string;
  companyId: string;
  name: string;
  description: string;
  baseRole: AppRole;
  isSystem: boolean;
  isActive: boolean;
  permissions: PermissionMap;
  assignedUserCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Wave 1: TOTP MFA (2FA)
// ============================================================================

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Verification code must be a 6-digit numeric code");

export const mfaCodeOrRecoverySchema = z
  .string()
  .trim()
  .min(6, "Verification or recovery code is required")
  .max(32);

export const mfaVerifyEnrollSchema = z.object({
  code: totpCodeSchema,
});

export const mfaVerifyLoginSchema = z.object({
  mfaChallengeToken: z.string().trim().min(10, "MFA challenge token is required"),
  code: mfaCodeOrRecoverySchema,
});

export const mfaDisableSchema = z.object({
  password: z.string().min(1, "Current password is required"),
  code: mfaCodeOrRecoverySchema.optional(),
});

export const mfaRegenerateRecoveryCodesSchema = z
  .object({
    password: z.string().min(1).optional(),
    code: mfaCodeOrRecoverySchema.optional(),
  })
  .refine((v) => Boolean(v.password || v.code), {
    message: "Current password or verification code is required.",
  });

export type MfaVerifyEnrollInput = z.infer<typeof mfaVerifyEnrollSchema>;
export type MfaVerifyLoginInput = z.infer<typeof mfaVerifyLoginSchema>;
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;
export type MfaRegenerateRecoveryCodesInput = z.infer<typeof mfaRegenerateRecoveryCodesSchema>;

export interface MfaStatusDto {
  enabled: boolean;
  enrolledAt: string | null;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  recoveryCodesRemaining: number;
}

export interface MfaEnrollResponseDto {
  otpauthUrl: string;
  secretMasked: string;
  recoveryCodes: string[];
}

export interface MfaChallengeResponseDto {
  mfaRequired: true;
  mfaChallengeToken: string;
}

// ============================================================================
// Wave 1: Active Sessions & Revocation
// ============================================================================

export const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export interface ActiveSessionDto {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  activeCompanyId: string | null;
  lastActivityAt: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
  isTerminalBound: boolean;
}

// ============================================================================
// Wave 1: Audit Diffs
// ============================================================================

export const AUDIT_SENSITIVE_FIELDS = [
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "token",
  "rawToken",
  "resetToken",
  "tokenHash",
  "secret",
  "totpSecret",
  "totpSecretEncrypted",
  "recoveryCode",
  "recoveryCodes",
  "recoveryCodesHashes",
  "mfaChallengeToken",
  "pin",
  "posPin",
  "pinHash",
  "etaClientSecret",
  "s3SecretAccessKey",
  "smtpPass",
] as const;

export interface AuditDiffEntryDto {
  id: string;
  companyId: string;
  at: string;
  actorUserId: string | null;
  user: string;
  userRole: string | null;
  module: string;
  action: string;
  entity: string;
  entityId: string;
  branchId: string | null;
  meta: Record<string, unknown>;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  changedFields: string[];
}

// ============================================================================
// Wave 1: Global Search (`Ctrl+K` / `Cmd+K`)
// ============================================================================

export const SEARCH_ENTITY_TYPES = [
  "product",
  "customer",
  "vendor",
  "sales_order",
  "sales_invoice",
  "purchase_order",
  "vendor_bill",
  "journal_entry",
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const globalSearchQuerySchema = z.object({
  q: z.string().trim().min(1, "Search query is required").max(120),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export interface GlobalSearchResultItemDto {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string;
  route: string;
}

export interface GlobalSearchResponseDto {
  query: string;
  results: GlobalSearchResultItemDto[];
}

// ============================================================================
// Wave 1: Saved Views
// ============================================================================

export const savedViewConfigSchema = z.object({
  columns: z.record(z.boolean()).optional(),
  columnOrder: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  filters: z.record(z.unknown()).optional(),
  sortBy: z.string().trim().max(80).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const createSavedViewSchema = z.object({
  resource: z.string().trim().min(1, "Resource key is required").max(80),
  name: z.string().trim().min(1, "View name is required").max(80),
  configJson: savedViewConfigSchema.default({}),
  isDefault: z.boolean().optional().default(false),
});

export const updateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  configJson: savedViewConfigSchema.optional(),
  isDefault: z.boolean().optional(),
});

export const savedViewsQuerySchema = z.object({
  resource: z.string().trim().min(1).max(80).optional(),
});

export type SavedViewConfig = z.infer<typeof savedViewConfigSchema>;
export type CreateSavedViewInput = z.input<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.input<typeof updateSavedViewSchema>;

export interface SavedViewDto {
  id: string;
  companyId: string;
  userId: string;
  resource: string;
  name: string;
  configJson: SavedViewConfig;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Wave 1: Server-Side Exports (`csv | xlsx`)
// ============================================================================

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_RESOURCES = [
  "products",
  "customers",
  "vendors",
  "sales-orders",
  "invoices",
  "purchase-orders",
  "vendor-bills",
  "journal-entries",
  "movements",
  "audit-logs",
] as const;
export type ExportResource = (typeof EXPORT_RESOURCES)[number];

export const exportParamsSchema = z.object({
  resource: z.enum(EXPORT_RESOURCES),
});

export const exportQuerySchema = z.object({
  format: z.enum(EXPORT_FORMATS).optional().default("csv"),
  q: z.string().trim().max(120).optional(),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(60).optional(),
  branchId: z.string().uuid().optional(),
  fromDate: z.string().trim().max(40).optional(),
  toDate: z.string().trim().max(40).optional(),
});

export type ExportQuery = z.infer<typeof exportQuerySchema>;

// ============================================================================
// Wave 1: Document Attachments (10MB max, strict MIME allowlist)
// ============================================================================

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
] as const;
export type AttachmentAllowedMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export const ATTACHMENT_ENTITY_TYPES = [
  "invoice",
  "sales_invoice",
  "vendor_bill",
  "product",
  "journal_entry",
  "purchase_order",
  "sales_order",
  "customer",
  "vendor",
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const attachmentListQuerySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: z.string().trim().min(1).max(120),
});

export const attachmentUploadFieldsSchema = attachmentListQuerySchema;

export const attachmentFileMetaSchema = z.object({
  fileName: z.string().trim().min(1).max(255).optional(),
  mimeType: z.enum(ATTACHMENT_ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
});

export type AttachmentFileMetaInput = z.infer<typeof attachmentFileMetaSchema>;

export interface DocumentAttachmentDto {
  id: string;
  companyId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageDriver: "local" | "s3";
  uploadedBy: string | null;
  uploadedByName: string;
  createdAt: string;
}

// ============================================================================
// Wave 1: Print Templates
// ============================================================================

export const PRINT_TEMPLATE_DOC_TYPES = [
  "invoice",
  "purchase_order",
  "sales_order",
  "vendor_bill",
  "receipt",
  "journal_entry",
] as const;
export type PrintTemplateDocType = (typeof PRINT_TEMPLATE_DOC_TYPES)[number];

export const printTemplateConfigSchema = z.object({
  showLogo: z.boolean().optional().default(true),
  showTaxNumber: z.boolean().optional().default(true),
  showQrCode: z.boolean().optional().default(true),
  paperSize: z.enum(["A4", "Letter", "80mm"]).optional().default("A4"),
  fontFamily: z.string().trim().max(60).optional().default("Inter"),
});

const safeLogoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^(\/(?!\/).*|https?:\/\/.+)$/i.test(v), {
    message: "Logo URL must be empty, a relative path starting with '/', or an http(s) URL",
  });

export const createPrintTemplateSchema = z.object({
  documentType: z.enum(PRINT_TEMPLATE_DOC_TYPES),
  name: z.string().trim().min(1, "Template name is required").max(100),
  headerHtml: z.string().max(10_000).optional().default(""),
  footerHtml: z.string().max(10_000).optional().default(""),
  logoUrl: safeLogoUrlSchema.optional().default(""),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Accent color must be a 6-digit hex color")
    .optional()
    .default("#0f172a"),
  customCss: z.string().max(10_000).optional().default(""),
  configJson: printTemplateConfigSchema.optional().default({}),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});

export const updatePrintTemplateSchema = createPrintTemplateSchema.partial().omit({
  documentType: true,
});

export type PrintTemplateConfig = z.infer<typeof printTemplateConfigSchema>;
export type CreatePrintTemplateInput = z.input<typeof createPrintTemplateSchema>;
export type UpdatePrintTemplateInput = z.input<typeof updatePrintTemplateSchema>;

export interface PrintTemplateDto {
  id: string;
  companyId: string;
  documentType: PrintTemplateDocType;
  name: string;
  headerHtml: string;
  footerHtml: string;
  logoUrl: string;
  accentColor: string;
  customCss: string;
  configJson: PrintTemplateConfig;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Wave 1: Document Emailing
// ============================================================================

export const EMAILABLE_DOCUMENT_TYPES = PRINT_TEMPLATE_DOC_TYPES;
export type EmailableDocumentType = PrintTemplateDocType;

export const emailDocumentParamsSchema = z.object({
  type: z.enum(EMAILABLE_DOCUMENT_TYPES),
  id: z.string().uuid(),
});

export const emailDocumentSchema = z.object({
  to: z.union([
    z.string().trim().email("Valid recipient email is required"),
    z.array(z.string().trim().email("Each recipient must be a valid email")).min(1).max(20),
  ]),
  cc: z.array(z.string().trim().email()).max(10).optional().default([]),
  subject: z
    .string()
    .trim()
    .min(1, "Email subject is required")
    .max(200)
    .refine((v) => !/[\r\n]/.test(v), {
      message: "Email subject must not contain line breaks",
    }),
  message: z.string().trim().max(5000).optional().default(""),
  attachStoredFiles: z.boolean().optional().default(false),
  attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
  templateId: z.string().uuid().optional(),
});

export type EmailDocumentInput = z.input<typeof emailDocumentSchema>;

export interface EmailDocumentResponseDto {
  sent: boolean;
  recipients: string[];
  subject: string;
  attachmentCount: number;
  messageId?: string;
}
