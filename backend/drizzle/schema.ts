import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// ============================================================================
// Enums
// ============================================================================

export const appRoleEnum = pgEnum("app_role", ["admin", "manager", "user"]);
export const branchTypeEnum = pgEnum("branch_type", ["hq_warehouse", "warehouse", "retail"]);
export const branchScopeModeEnum = pgEnum("branch_scope_mode", ["all", "selected"]);
export const movementTypeEnum = pgEnum("movement_type", [
  "purchase_receive",
  "purchase_return",
  "sales_invoice",
  "sales_return",
  "transfer_out",
  "transfer_in",
  "adjustment_in",
  "adjustment_out",
  "write_off",
  "stock_take",
  "opening_balance",
  "work_order_consume",
  "work_order_produce",
]);
export const sessionStatusEnum = pgEnum("session_status", ["In Progress", "Completed", "Cancelled"]);

export type AppRole = (typeof appRoleEnum.enumValues)[number];
export type BranchType = (typeof branchTypeEnum.enumValues)[number];
export type BranchScopeMode = (typeof branchScopeModeEnum.enumValues)[number];
export type MovementType = (typeof movementTypeEnum.enumValues)[number];

export const DEFAULT_COMPANY_ID = "00000000-0000-4000-8000-000000000001";

// ============================================================================
// Multi-Company, Branches, Auth & Access Control
// ============================================================================

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    legalName: text("legal_name").notNull().default(""),
    taxRegistrationNumber: text("tax_registration_number").notNull().default(""),
    baseCurrency: text("base_currency").notNull().default("USD"),
    einvoicingMode: text("einvoicing_mode")
      .$type<"none" | "zatca_qr" | "zatca_phase2" | "eta_egypt">()
      .notNull()
      .default("none"),
    defaultBranchId: uuid("default_branch_id"),
    address: text("address").notNull().default(""),
    phone: text("phone").notNull().default(""),
    email: text("email").notNull().default(""),
    settingsJson: jsonb("settings_json").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("companies_active_idx").on(t.isActive)]
);

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    branchType: branchTypeEnum("branch_type").notNull().default("retail"),
    location: text("location").notNull().default(""),
    address: text("address").notNull().default(""),
    phone: text("phone").notNull().default(""),
    email: text("email").notNull().default(""),
    managerName: text("manager_name").notNull().default(""),
    etaBranchId: text("eta_branch_id").notNull().default("0"),
    country: text("country").notNull().default("EG"),
    governorate: text("governorate").notNull().default(""),
    regionCity: text("region_city").notNull().default(""),
    street: text("street").notNull().default(""),
    buildingNumber: text("building_number").notNull().default(""),
    postalCode: text("postal_code").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("branches_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("branches_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    uniqueIndex("branches_company_name_norm_uq").on(t.companyId, sql`lower(btrim(${t.name}))`),
    index("branches_company_idx").on(t.companyId),
    index("branches_active_idx").on(t.isActive),
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    defaultBranchId: uuid("default_branch_id").references(() => branches.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("users_email_idx").on(t.email)]
);

export const customRoles = pgTable(
  "custom_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    baseRole: appRoleEnum("base_role").notNull().default("user"),
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("custom_roles_company_name_uq").on(t.companyId, t.name),
    uniqueIndex("custom_roles_company_name_norm_uq").on(t.companyId, sql`lower(btrim(${t.name}))`),
    index("custom_roles_company_idx").on(t.companyId),
  ]
);

export const customRolePermissions = pgTable(
  "custom_role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customRoleId: uuid("custom_role_id")
      .notNull()
      .references(() => customRoles.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    canView: boolean("can_view").notNull().default(false),
    canCreate: boolean("can_create").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    canApprove: boolean("can_approve").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("custom_role_permissions_role_module_uq").on(t.customRoleId, t.module)]
);

export const userCompanies = pgTable(
  "user_companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    role: appRoleEnum("role").notNull().default("user"),
    customRoleId: uuid("custom_role_id").references(() => customRoles.id, { onDelete: "set null" }),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("user_companies_user_company_uq").on(t.userId, t.companyId),
    index("user_companies_company_idx").on(t.companyId),
  ]
);

export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  isEnabled: boolean("is_enabled").notNull().default(false),
  totpSecretEncrypted: text("totp_secret_encrypted").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  recoveryCodesHashes: jsonb("recovery_codes_hashes").$type<string[]>().notNull().default([]),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const authLockouts = pgTable(
  "auth_lockouts",
  {
    scope: text("scope").notNull(),
    identifier: text("identifier").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).defaultNow().notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.identifier] }),
    index("auth_lockouts_locked_until_idx").on(t.lockedUntil),
  ]
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: appRoleEnum("role").notNull().default("user"),
    customRoleId: uuid("custom_role_id").references(() => customRoles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("user_roles_user_uq").on(t.userId)]
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeCompanyId: uuid("active_company_id").references(() => companies.id, { onDelete: "set null" }),
    posTerminalId: uuid("pos_terminal_id").references(() => posTerminals.id, { onDelete: "set null" }),
    activeCashierId: uuid("active_cashier_id").references(() => users.id, { onDelete: "set null" }),
    isTerminalLocked: boolean("is_terminal_locked").notNull().default(false),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("user_sessions_user_idx").on(t.userId),
    index("user_sessions_expires_idx").on(t.expiresAt),
    index("user_sessions_active_company_idx").on(t.activeCompanyId),
  ]
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("password_reset_user_idx").on(t.userId), index("password_reset_expires_idx").on(t.expiresAt)]
);

export const userBranchScopes = pgTable("user_branch_scopes", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  scopeMode: branchScopeModeEnum("scope_mode").notNull().default("selected"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userBranches = pgTable(
  "user_branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("user_branches_user_branch_uq").on(t.userId, t.branchId),
    index("user_branches_branch_idx").on(t.branchId),
  ]
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    role: appRoleEnum("role").notNull(),
    module: text("module").notNull(),
    canView: boolean("can_view").notNull().default(false),
    canCreate: boolean("can_create").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    canApprove: boolean("can_approve").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("role_permissions_role_module_uq").on(t.role, t.module)]
);

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  language: text("language").notNull().default("en"),
  activeBranchId: uuid("active_branch_id").references(() => branches.id, { onDelete: "set null" }),
  preferencesJson: jsonb("preferences_json").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companySettings = pgTable("company_settings", {
  id: integer("id").primaryKey().default(1),
  companyName: text("company_name").notNull().default("Count It Keep It"),
  legalName: text("legal_name").notNull().default(""),
  taxRegistrationNumber: text("tax_registration_number").notNull().default(""),
  baseCurrency: text("base_currency").notNull().default("USD"),
  einvoicingMode: text("einvoicing_mode")
    .$type<"none" | "zatca_qr" | "zatca_phase2" | "eta_egypt">()
    .notNull()
    .default("none"),
  defaultBranchId: uuid("default_branch_id").references(() => branches.id, { onDelete: "set null" }),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  settingsJson: jsonb("settings_json").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// System Infrastructure: Sequences, Audit Logs, Notifications, Idempotency
// ============================================================================

export const documentSequences = pgTable(
  "document_sequences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    scopeKey: text("scope_key").notNull().default("company"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(4),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("doc_sequences_company_type_scope_uq").on(t.companyId, t.docType, t.scopeKey)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    userName: text("user_name").notNull(),
    userRole: text("user_role"),
    branchId: uuid("branch_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityLabel: text("entity_label"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    beforeJson: jsonb("before_json").$type<Record<string, unknown> | null>(),
    afterJson: jsonb("after_json").$type<Record<string, unknown> | null>(),
    changedFields: jsonb("changed_fields").$type<string[]>().notNull().default([]),
    ipAddress: text("ip_address"),
    chainSeq: bigint("chain_seq", { mode: "number" }),
    prevHash: text("prev_hash"),
    entryHash: text("entry_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_branch_idx").on(t.branchId),
    index("audit_logs_created_id_idx").on(t.createdAt, t.id),
    index("audit_logs_entity_created_id_idx").on(t.entityType, t.createdAt, t.id),
    index("audit_logs_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("audit_logs_company_created_id_idx").on(t.companyId, t.createdAt, t.id),
    uniqueIndex("audit_logs_company_chain_seq_uq").on(t.companyId, t.chainSeq),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("notifications_created_idx").on(t.createdAt),
    index("notifications_user_idx").on(t.userId),
    index("notifications_company_created_idx").on(t.companyId, t.createdAt),
  ]
);

export const notificationUserStates = pgTable(
  "notification_user_states",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] })]
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull().default(""),
    state: text("state").$type<"in_progress" | "completed">().notNull().default("completed"),
    posTerminalId: uuid("pos_terminal_id"),
    statusCode: integer("status_code"),
    responseBody: jsonb("response_body").$type<unknown>(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idempotency_company_user_req_uq").on(t.companyId, t.userId, t.method, t.path, t.key),
    index("idempotency_expires_idx").on(t.expiresAt),
    index("idempotency_state_locked_idx").on(t.state, t.lockedUntil),
  ]
);

export const userSavedViews = pgTable(
  "user_saved_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    name: text("name").notNull(),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("user_saved_views_user_company_res_name_uq").on(t.userId, t.companyId, t.resource, t.name),
    index("user_saved_views_lookup_idx").on(t.companyId, t.userId, t.resource),
  ]
);

export const documentAttachments = pgTable(
  "document_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageDriver: text("storage_driver").$type<"local" | "s3">().notNull().default("local"),
    storageKey: text("storage_key").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    uploadedByName: text("uploaded_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("document_attachments_company_entity_idx").on(t.companyId, t.entityType, t.entityId),
    uniqueIndex("document_attachments_storage_key_uq").on(t.storageKey),
  ]
);

export const printTemplates = pgTable(
  "print_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull(),
    name: text("name").notNull(),
    headerHtml: text("header_html").notNull().default(""),
    footerHtml: text("footer_html").notNull().default(""),
    logoUrl: text("logo_url").notNull().default(""),
    accentColor: text("accent_color").notNull().default("#0f172a"),
    customCss: text("custom_css").notNull().default(""),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("print_templates_company_type_name_uq").on(t.companyId, t.documentType, t.name),
    index("print_templates_company_type_idx").on(t.companyId, t.documentType),
  ]
);

// ============================================================================
// Accounting Core, Fiscal Calendars, Currencies & Master Data
// ============================================================================

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("fiscal_years_company_name_uq").on(t.companyId, t.name)]
);

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    name: text("name").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    status: text("status").$type<"open" | "locked" | "closed">().notNull().default("open"),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "set null" }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("fiscal_periods_year_num_uniq").on(t.fiscalYearId, t.periodNumber),
    index("fiscal_periods_dates_idx").on(t.startDate, t.endDate),
    index("fiscal_periods_company_dates_idx").on(t.companyId, t.startDate, t.endDate),
  ]
);

export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    accountType: text("account_type").$type<"asset" | "liability" | "equity" | "revenue" | "expense">().notNull(),
    normalBalance: text("normal_balance").$type<"debit" | "credit">().notNull(),
    parentId: uuid("parent_id"),
    description: text("description").notNull().default(""),
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("coa_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("coa_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    index("coa_type_idx").on(t.accountType),
    index("coa_company_type_idx").on(t.companyId, t.accountType),
  ]
);

export const glAccountMappings = pgTable(
  "gl_account_mappings",
  {
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    mappingKey: text("mapping_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.mappingKey] })]
);

export const currencies = pgTable(
  "currencies",
  {
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull().default(2),
    isBase: boolean("is_base").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.code] })]
);

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    rate: numeric("rate", { precision: 18, scale: 6 }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("fx_rates_pair_idx").on(t.fromCurrency, t.toCurrency, t.effectiveAt),
    index("fx_rates_company_pair_idx").on(t.companyId, t.fromCurrency, t.toCurrency, t.effectiveAt),
  ]
);

export const taxCodes = pgTable(
  "tax_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rate: numeric("rate", { precision: 8, scale: 4 }).notNull().default("0"),
    isDefault: boolean("is_default").notNull().default(false),
    isInclusive: boolean("is_inclusive").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    inputAccountId: uuid("input_account_id").references(() => chartOfAccounts.id, { onDelete: "set null" }),
    outputAccountId: uuid("output_account_id").references(() => chartOfAccounts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tax_codes_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("tax_codes_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
  ]
);

export const taxonomyItems = pgTable(
  "taxonomy_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"category" | "brand" | "tag" | "unit">().notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    symbol: text("symbol").notNull().default(""),
    parentId: uuid("parent_id"),
    color: text("color").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("taxonomy_company_kind_name_uq").on(t.companyId, t.kind, t.name),
    uniqueIndex("taxonomy_company_kind_name_norm_uq").on(t.companyId, t.kind, sql`lower(btrim(${t.name}))`),
  ]
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    name: text("name").notNull(),
    nameAr: text("name_ar").notNull().default(""),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    brand: text("brand").notNull().default(""),
    unit: text("unit").notNull().default("pcs"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    costPrice: numeric("cost_price", { precision: 18, scale: 4 }).notNull().default("0"),
    sellingPrice: numeric("selling_price", { precision: 18, scale: 4 }).notNull().default("0"),
    minStockLevel: numeric("min_stock_level", { precision: 18, scale: 4 }).notNull().default("0"),
    taxCodeId: uuid("tax_code_id").references(() => taxCodes.id, { onDelete: "set null" }),
    itemType: text("item_type")
      .$type<"stock" | "non_stock" | "service" | "manufactured">()
      .notNull()
      .default("stock"),
    trackingMode: text("tracking_mode")
      .$type<"none" | "lot" | "serial">()
      .notNull()
      .default("none"),
    requiresExpiry: boolean("requires_expiry").notNull().default(false),
    shelfLifeDays: integer("shelf_life_days"),
    pickingStrategy: text("picking_strategy")
      .$type<"FEFO" | "FIFO" | "LIFO">()
      .notNull()
      .default("FEFO"),
    trackLots: boolean("track_lots").notNull().default(false),
    trackSerials: boolean("track_serials").notNull().default(false),
    etaCodeType: text("eta_code_type").$type<"EGS" | "GS1">().notNull().default("EGS"),
    etaItemCode: text("eta_item_code").notNull().default(""),
    etaUnitType: text("eta_unit_type").notNull().default("EA"),
    hasBom: boolean("has_bom").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("products_company_sku_uq").on(t.companyId, t.sku),
    uniqueIndex("products_company_sku_norm_uq").on(t.companyId, sql`lower(btrim(${t.sku}))`),
    uniqueIndex("products_company_barcode_norm_uq")
      .on(t.companyId, sql`lower(btrim(${t.barcode}))`)
      .where(sql`${t.barcode} IS NOT NULL AND btrim(${t.barcode}) <> ''`),
    index("products_barcode_idx").on(t.barcode),
    index("products_category_idx").on(t.category),
    index("products_name_id_idx").on(t.name, t.id),
    index("products_created_id_idx").on(t.createdAt, t.id),
    index("products_company_created_id_idx").on(t.companyId, t.createdAt, t.id),
  ]
);

export const branchProducts = pgTable(
  "branch_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    qtyOnHand: numeric("qty_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
    qtyReserved: numeric("qty_reserved", { precision: 18, scale: 4 }).notNull().default("0"),
    avgCost: numeric("avg_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    minStockLevel: numeric("min_stock_level", { precision: 18, scale: 4 }),
    binLocation: text("bin_location").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("branch_products_branch_product_uq").on(t.branchId, t.productId),
    index("branch_products_product_idx").on(t.productId),
    index("branch_products_company_idx").on(t.companyId),
  ]
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    company: text("company").notNull().default(""),
    billingAddress: text("billing_address").notNull().default(""),
    shippingAddress: text("shipping_address").notNull().default(""),
    taxNumber: text("tax_number").notNull().default(""),
    etaReceiverType: text("eta_receiver_type").$type<"B" | "P" | "F">().notNull().default("B"),
    currency: text("currency").notNull().default("USD"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    creditLimit: numeric("credit_limit", { precision: 18, scale: 4 }),
    isWalkIn: boolean("is_walk_in").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("customers_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("customers_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    index("customers_name_idx").on(t.name),
    index("customers_name_id_idx").on(t.name, t.id),
    index("customers_created_id_idx").on(t.createdAt, t.id),
    index("customers_company_name_id_idx").on(t.companyId, t.name, t.id),
  ]
);

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    company: text("company").notNull().default(""),
    address: text("address").notNull().default(""),
    taxNumber: text("tax_number").notNull().default(""),
    currency: text("currency").notNull().default("USD"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("vendors_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("vendors_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    index("vendors_name_idx").on(t.name),
    index("vendors_name_id_idx").on(t.name, t.id),
    index("vendors_created_id_idx").on(t.createdAt, t.id),
    index("vendors_company_name_id_idx").on(t.companyId, t.name, t.id),
  ]
);

// ============================================================================
// Inventory Movements, Adjustments, Write-Offs, Transfers, Stock-Take Sessions
// ============================================================================

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    movementType: movementTypeEnum("movement_type").notNull(),
    qtyDelta: numeric("qty_delta", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    balanceAfter: numeric("balance_after", { precision: 18, scale: 4 }).notNull(),
    avgCostAfter: numeric("avg_cost_after", { precision: 18, scale: 4 }).notNull().default("0"),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    referenceNumber: text("reference_number").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("stock_movements_branch_product_idx").on(t.branchId, t.productId, t.createdAt),
    index("stock_movements_ref_idx").on(t.referenceType, t.referenceId),
    index("stock_movements_created_id_idx").on(t.createdAt, t.id),
    index("stock_movements_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("stock_movements_company_created_id_idx").on(t.companyId, t.createdAt, t.id),
  ]
);

export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    adjustmentNumber: text("adjustment_number").notNull(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("Posted"),
    approvalStatus: text("approval_status")
      .$type<"not_required" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_required"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_adjustments_company_num_uq").on(t.companyId, t.adjustmentNumber),
    index("stock_adjustments_branch_idx").on(t.branchId, t.createdAt),
  ]
);

export const stockAdjustmentLines = pgTable(
  "stock_adjustment_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adjustmentId: uuid("adjustment_id")
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    qtyDelta: numeric("qty_delta", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    previousQty: numeric("previous_qty", { precision: 18, scale: 4 }).notNull(),
    newQty: numeric("new_qty", { precision: 18, scale: 4 }).notNull(),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("stock_adjustment_lines_adj_idx").on(t.adjustmentId)]
);

export const stockWriteOffs = pgTable(
  "stock_write_offs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    writeOffNumber: text("write_off_number").notNull(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("Posted"),
    approvalStatus: text("approval_status")
      .$type<"not_required" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_required"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_write_offs_company_num_uq").on(t.companyId, t.writeOffNumber),
    index("stock_write_offs_branch_idx").on(t.branchId, t.createdAt),
  ]
);

export const stockWriteOffLines = pgTable(
  "stock_write_off_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    writeOffId: uuid("write_off_id")
      .notNull()
      .references(() => stockWriteOffs.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    totalValue: numeric("total_value", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("stock_write_off_lines_wo_idx").on(t.writeOffId)]
);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    transferNumber: text("transfer_number").notNull(),
    fromBranchId: uuid("from_branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    toBranchId: uuid("to_branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: text("status")
      .$type<"Draft" | "In Transit" | "Received" | "Partial" | "Cancelled">()
      .notNull()
      .default("In Transit"),
    shortageResolution: text("shortage_resolution").$type<"backorder" | "close_short" | "claim_carrier">(),
    notes: text("notes").notNull().default(""),
    approvalStatus: text("approval_status")
      .$type<"not_required" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_required"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_transfers_company_num_uq").on(t.companyId, t.transferNumber),
    index("stock_transfers_from_idx").on(t.fromBranchId, t.createdAt),
    index("stock_transfers_to_idx").on(t.toBranchId, t.createdAt),
  ]
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    qtySent: numeric("qty_sent", { precision: 18, scale: 4 }).notNull(),
    qtyReceived: numeric("qty_received", { precision: 18, scale: 4 }).notNull().default("0"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("stock_transfer_lines_tr_idx").on(t.transferId)]
);

export const stockSessions = pgTable(
  "stock_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    sessionNumber: text("session_number").notNull(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    status: sessionStatusEnum("status").notNull().default("In Progress"),
    notes: text("notes").notNull().default(""),
    adjustmentId: uuid("adjustment_id").references(() => stockAdjustments.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name").notNull().default(""),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_sessions_company_num_uq").on(t.companyId, t.sessionNumber),
    index("stock_sessions_branch_status_idx").on(t.branchId, t.status),
  ]
);

export const stockSessionItems = pgTable(
  "stock_session_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => stockSessions.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    expectedQty: numeric("expected_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    countedQty: numeric("counted_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    variance: numeric("variance", { precision: 18, scale: 4 }).notNull().default("0"),
    scannedCount: integer("scanned_count").notNull().default(0),
    notes: text("notes").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("stock_session_items_session_prod_uq").on(t.sessionId, t.productId)]
);

// ============================================================================
// Purchasing
// ============================================================================

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    poNumber: text("po_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("Draft"),
    orderDate: timestamp("order_date", { withTimezone: true }).defaultNow().notNull(),
    expectedDate: timestamp("expected_date", { withTimezone: true }),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
    approvalStatus: text("approval_status")
      .$type<"not_required" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_required"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("purchase_orders_company_num_uq").on(t.companyId, t.poNumber),
    index("purchase_orders_vendor_idx").on(t.vendorId),
    index("purchase_orders_branch_idx").on(t.branchId),
    index("purchase_orders_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("purchase_orders_created_id_idx").on(t.createdAt, t.id),
  ]
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    receivedQty: numeric("received_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("purchase_order_lines_po_idx").on(t.poId)]
);

export const purchaseReceives = pgTable(
  "purchase_receives",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    receiveNumber: text("receive_number").notNull(),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("Received"),
    receiveDate: timestamp("receive_date", { withTimezone: true }).defaultNow().notNull(),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("purchase_receives_company_num_uq").on(t.companyId, t.receiveNumber),
    index("purchase_receives_po_idx").on(t.poId),
    index("purchase_receives_branch_idx").on(t.branchId),
  ]
);

export const purchaseReceiveLines = pgTable(
  "purchase_receive_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    receiveId: uuid("receive_id")
      .notNull()
      .references(() => purchaseReceives.id, { onDelete: "cascade" }),
    poLineId: uuid("po_line_id").references(() => purchaseOrderLines.id, { onDelete: "set null" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("purchase_receive_lines_rec_idx").on(t.receiveId)]
);

export const vendorBills = pgTable(
  "vendor_bills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    billNumber: text("bill_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    receiveId: uuid("receive_id").references(() => purchaseReceives.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Open"),
    source: text("source").$type<"standard" | "opening_balance">().notNull().default("standard"),
    billDate: timestamp("bill_date", { withTimezone: true }).defaultNow().notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("vendor_bills_company_num_uq").on(t.companyId, t.billNumber),
    index("vendor_bills_vendor_idx").on(t.vendorId),
    index("vendor_bills_status_idx").on(t.status),
    index("vendor_bills_company_source_idx").on(t.companyId, t.source),
    index("vendor_bills_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("vendor_bills_created_id_idx").on(t.createdAt, t.id),
  ]
);

export const vendorBillLines = pgTable(
  "vendor_bill_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => vendorBills.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("vendor_bill_lines_bill_idx").on(t.billId)]
);

export const paymentsMade = pgTable(
  "payments_made",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    paymentNumber: text("payment_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    paymentDate: timestamp("payment_date", { withTimezone: true }).defaultNow().notNull(),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    paymentMethod: text("payment_method").notNull().default("Bank Transfer"),
    reference: text("reference").notNull().default(""),
    status: text("status").$type<"Posted" | "Voided">().notNull().default("Posted"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_made_company_num_uq").on(t.companyId, t.paymentNumber),
    index("payments_made_vendor_idx").on(t.vendorId),
  ]
);

export const paymentMadeAllocations = pgTable(
  "payment_made_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => paymentsMade.id, { onDelete: "cascade" }),
    billId: uuid("bill_id")
      .notNull()
      .references(() => vendorBills.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("payment_made_alloc_payment_idx").on(t.paymentId), index("payment_made_alloc_bill_idx").on(t.billId)]
);

export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    returnNumber: text("return_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    receiveId: uuid("receive_id").references(() => purchaseReceives.id, { onDelete: "set null" }),
    billId: uuid("bill_id").references(() => vendorBills.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Posted"),
    returnDate: timestamp("return_date", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason").notNull().default(""),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("purchase_returns_company_num_uq").on(t.companyId, t.returnNumber),
    index("purchase_returns_vendor_idx").on(t.vendorId),
  ]
);

export const purchaseReturnLines = pgTable(
  "purchase_return_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("purchase_return_lines_ret_idx").on(t.returnId)]
);

// ============================================================================
// Sales
// ============================================================================

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    soNumber: text("so_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("Draft"),
    orderDate: timestamp("order_date", { withTimezone: true }).defaultNow().notNull(),
    expectedShipmentDate: timestamp("expected_shipment_date", { withTimezone: true }),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
    approvalStatus: text("approval_status")
      .$type<"not_required" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_required"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("sales_orders_company_num_uq").on(t.companyId, t.soNumber),
    index("sales_orders_customer_idx").on(t.customerId),
    index("sales_orders_branch_idx").on(t.branchId),
    index("sales_orders_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("sales_orders_created_id_idx").on(t.createdAt, t.id),
  ]
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    soId: uuid("so_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    invoicedQty: numeric("invoiced_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discount: numeric("discount", { precision: 18, scale: 4 }).notNull().default("0"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("sales_order_lines_so_idx").on(t.soId)]
);

export const salesInvoices = pgTable(
  "sales_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    invoiceNumber: text("invoice_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    soId: uuid("so_id").references(() => salesOrders.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Draft"),
    source: text("source").$type<"standard" | "opening_balance">().notNull().default("standard"),
    invoiceDate: timestamp("invoice_date", { withTimezone: true }).defaultNow().notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    creditAppliedAmount: numeric("credit_applied_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    retainerAppliedAmount: numeric("retainer_applied_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    eInvoiceStatus: text("e_invoice_status").notNull().default("not_applicable"),
    icv: integer("icv"),
    invoiceHash: text("invoice_hash"),
    prevInvoiceHash: text("prev_invoice_hash"),
    qrTlv: text("qr_tlv"),
    eInvoicePayloadJson: jsonb("e_invoice_payload_json").$type<Record<string, unknown>>(),
    sourceChannel: text("source_channel").$type<"erp" | "pos">().notNull().default("erp"),
    posTerminalId: uuid("pos_terminal_id").references(() => posTerminals.id, { onDelete: "set null" }),
    posShiftId: uuid("pos_shift_id").references(() => posShifts.id, { onDelete: "set null" }),
    cashierUserId: uuid("cashier_user_id").references(() => users.id, { onDelete: "set null" }),
    offlineClientTxId: text("offline_client_tx_id"),
    syncStatus: text("sync_status").$type<"synced" | "reconciled_conflict">().notNull().default("synced"),
    etaDocumentUuid: text("eta_document_uuid"),
    etaSubmissionUuid: text("eta_submission_uuid"),
    etaReceiptStatus: text("eta_receipt_status").notNull().default("not_applicable"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("sales_invoices_company_num_uq").on(t.companyId, t.invoiceNumber),
    index("sales_invoices_customer_idx").on(t.customerId),
    index("sales_invoices_status_idx").on(t.status),
    index("sales_invoices_company_source_idx").on(t.companyId, t.source),
    index("sales_invoices_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
    index("sales_invoices_status_date_id_idx").on(t.status, t.invoiceDate, t.id),
    index("sales_invoices_created_id_idx").on(t.createdAt, t.id),
    index("sales_invoices_company_created_id_idx").on(t.companyId, t.createdAt, t.id),
    index("sales_invoices_pos_shift_date_id_idx").on(t.posShiftId, t.invoiceDate, t.id),
    uniqueIndex("sales_invoices_pos_terminal_offline_tx_uq").on(t.posTerminalId, t.offlineClientTxId),
  ]
);

export const salesInvoiceLines = pgTable(
  "sales_invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "restrict" }),
    description: text("description").notNull().default(""),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    unitCostSnapshot: numeric("unit_cost_snapshot", { precision: 18, scale: 4 }).notNull().default("0"),
    discount: numeric("discount", { precision: 18, scale: 4 }).notNull().default("0"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("sales_invoice_lines_inv_idx").on(t.invoiceId)]
);

export const receivedPayments = pgTable(
  "received_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    paymentNumber: text("payment_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    paymentDate: timestamp("payment_date", { withTimezone: true }).defaultNow().notNull(),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    paymentMethod: text("payment_method").notNull().default("Bank Transfer"),
    reference: text("reference").notNull().default(""),
    status: text("status").$type<"Posted" | "Voided">().notNull().default("Posted"),
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("received_payments_company_num_uq").on(t.companyId, t.paymentNumber),
    index("received_payments_customer_idx").on(t.customerId),
  ]
);

export const receivedPaymentAllocations = pgTable(
  "received_payment_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => receivedPayments.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("received_payment_alloc_pay_idx").on(t.paymentId), index("received_payment_alloc_inv_idx").on(t.invoiceId)]
);

export const salesReturns = pgTable(
  "sales_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    returnNumber: text("return_number").notNull(),
    creditNoteNumber: text("credit_note_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => salesInvoices.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Open"),
    returnDate: timestamp("return_date", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason").notNull().default(""),
    restockItems: boolean("restock_items").notNull().default(true),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    appliedAmount: numeric("applied_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    etaDocumentUuid: text("eta_document_uuid"),
    etaSubmissionUuid: text("eta_submission_uuid"),
    eInvoiceStatus: text("e_invoice_status").notNull().default("not_applicable"),
    eInvoicePayloadJson: jsonb("e_invoice_payload_json").$type<Record<string, unknown>>(),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("sales_returns_company_num_uq").on(t.companyId, t.returnNumber),
    uniqueIndex("sales_returns_company_cn_uq").on(t.companyId, t.creditNoteNumber),
    index("sales_returns_customer_idx").on(t.customerId),
  ]
);

export const salesReturnLines = pgTable(
  "sales_return_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => salesReturns.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    unitCostSnapshot: numeric("unit_cost_snapshot", { precision: 18, scale: 4 }).notNull().default("0"),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [index("sales_return_lines_ret_idx").on(t.returnId)]
);

export const creditNoteApplications = pgTable(
  "credit_note_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => salesReturns.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("credit_note_app_ret_idx").on(t.returnId), index("credit_note_app_inv_idx").on(t.invoiceId)]
);

export const retainerInvoices = pgTable(
  "retainer_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    retainerNumber: text("retainer_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Draft"),
    issueDate: timestamp("issue_date", { withTimezone: true }).defaultNow().notNull(),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    appliedAmount: numeric("applied_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("retainer_invoices_company_num_uq").on(t.companyId, t.retainerNumber),
    index("retainer_invoices_customer_idx").on(t.customerId),
  ]
);

export const retainerApplications = pgTable(
  "retainer_applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    retainerId: uuid("retainer_id")
      .notNull()
      .references(() => retainerInvoices.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("retainer_app_ret_idx").on(t.retainerId), index("retainer_app_inv_idx").on(t.invoiceId)]
);

// ============================================================================
// Double-Entry General Ledger
// ============================================================================

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    entryNumber: text("entry_number").notNull(),
    entryDate: timestamp("entry_date", { withTimezone: true }).defaultNow().notNull(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    fiscalPeriodId: uuid("fiscal_period_id").references(() => fiscalPeriods.id, { onDelete: "set null" }),
    sourceType: text("source_type").notNull().default("manual"),
    sourceId: text("source_id"),
    referenceNumber: text("reference_number").notNull().default(""),
    memo: text("memo").notNull().default(""),
    status: text("status").$type<"posted" | "reversed">().notNull().default("posted"),
    reversedEntryId: uuid("reversed_entry_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("journal_entries_company_num_uq").on(t.companyId, t.entryNumber),
    index("journal_entries_date_idx").on(t.entryDate),
    index("journal_entries_source_idx").on(t.sourceType, t.sourceId),
    index("journal_entries_branch_idx").on(t.branchId),
    index("journal_entries_date_created_id_idx").on(t.entryDate, t.createdAt, t.id),
    index("journal_entries_branch_date_created_id_idx").on(t.branchId, t.entryDate, t.createdAt, t.id),
    index("journal_entries_company_date_id_idx").on(t.companyId, t.entryDate, t.createdAt, t.id),
  ]
);

export const costCenters = pgTable(
  "cost_centers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    description: text("description").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cost_centers_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("cost_centers_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    uniqueIndex("cost_centers_company_name_norm_uq").on(t.companyId, sql`lower(btrim(${t.name}))`),
    index("cost_centers_company_active_idx").on(t.companyId, t.isActive),
  ]
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "restrict" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    debitBase: numeric("debit_base", { precision: 18, scale: 4 }).notNull().default("0"),
    creditBase: numeric("credit_base", { precision: 18, scale: 4 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 6 }).notNull().default("1"),
    debitTx: numeric("debit_tx", { precision: 18, scale: 4 }).notNull().default("0"),
    creditTx: numeric("credit_tx", { precision: 18, scale: 4 }).notNull().default("0"),
    description: text("description").notNull().default(""),
  },
  (t) => [
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.accountId),
    index("journal_lines_cost_center_idx").on(t.costCenterId),
  ]
);

// ============================================================================
// Enterprise Approvals & Controls (Milestone D1)
// ============================================================================

export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type")
      .$type<"purchase_order" | "stock_transfer" | "stock_adjustment" | "stock_write_off">()
      .notNull(),
    minAmount: numeric("min_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    requiredRole: appRoleEnum("required_role").notNull().default("manager"),
    isActive: boolean("is_active").notNull().default(false),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("approval_rules_company_entity_uq").on(t.companyId, t.entityType)]
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type")
      .$type<"purchase_order" | "stock_transfer" | "stock_adjustment" | "stock_write_off">()
      .notNull(),
    entityId: uuid("entity_id").notNull(),
    entityNumber: text("entity_number").notNull(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull().default("0"),
    status: text("status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestedByName: text("requested_by_name").notNull().default(""),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedByName: text("reviewed_by_name").notNull().default(""),
    decisionComment: text("decision_comment").notNull().default(""),
    selfApprovedSingleAdmin: boolean("self_approved_single_admin").notNull().default(false),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.requestedAt),
    index("approval_requests_company_status_idx").on(t.companyId, t.status, t.requestedAt),
    index("approval_requests_entity_idx").on(t.entityType, t.entityId),
  ]
);

// ============================================================================
// Lot/Batch Expiry & Serial Tracking (Milestone D2)
// ============================================================================

export const stockLots = pgTable(
  "stock_lots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    lotNumber: text("lot_number").notNull(),
    manufactureDate: timestamp("manufacture_date", { withTimezone: true }),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_lots_product_lot_uq").on(t.productId, t.lotNumber),
    index("stock_lots_expiry_idx").on(t.expiryDate),
    index("stock_lots_company_expiry_idx").on(t.companyId, t.expiryDate),
  ]
);

export const branchLotBalances = pgTable(
  "branch_lot_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => stockLots.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    qtyOnHand: numeric("qty_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
    qtyReserved: numeric("qty_reserved", { precision: 18, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("branch_lot_balances_branch_lot_uq").on(t.branchId, t.lotId),
    index("branch_lot_balances_branch_product_idx").on(t.branchId, t.productId),
    index("branch_lot_balances_company_idx").on(t.companyId),
  ]
);

export const stockSerials = pgTable(
  "stock_serials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    serialNumber: text("serial_number").notNull(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    lotId: uuid("lot_id").references(() => stockLots.id, { onDelete: "set null" }),
    status: text("status")
      .$type<"in_stock" | "reserved" | "in_transit" | "sold" | "returned" | "written_off" | "consumed">()
      .notNull()
      .default("in_stock"),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    receivedFromType: text("received_from_type"),
    receivedFromId: text("received_from_id"),
    soldInvoiceId: uuid("sold_invoice_id").references(() => salesInvoices.id, { onDelete: "set null" }),
    workOrderId: uuid("work_order_id"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stock_serials_product_serial_uq").on(t.productId, t.serialNumber),
    index("stock_serials_branch_status_idx").on(t.branchId, t.status),
    index("stock_serials_serial_idx").on(t.serialNumber),
    index("stock_serials_company_serial_idx").on(t.companyId, t.serialNumber),
  ]
);

export const stockMovementAllocations = pgTable(
  "stock_movement_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    movementId: uuid("movement_id")
      .notNull()
      .references(() => stockMovements.id, { onDelete: "cascade" }),
    lotId: uuid("lot_id").references(() => stockLots.id, { onDelete: "set null" }),
    serialId: uuid("serial_id").references(() => stockSerials.id, { onDelete: "set null" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("stock_mov_alloc_movement_idx").on(t.movementId),
    index("stock_mov_alloc_lot_idx").on(t.lotId),
    index("stock_mov_alloc_serial_idx").on(t.serialId),
  ]
);

// ============================================================================
// Manufacturing: Bills of Materials & Work Orders (Milestone D2)
// ============================================================================

export const billsOfMaterials = pgTable(
  "bills_of_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    bomNumber: text("bom_number").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    outputQty: numeric("output_qty", { precision: 18, scale: 4 }).notNull().default("1"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("boms_company_num_uq").on(t.companyId, t.bomNumber),
    index("boms_product_idx").on(t.productId),
  ]
);

export const bomComponents = pgTable(
  "bom_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bomId: uuid("bom_id")
      .notNull()
      .references(() => billsOfMaterials.id, { onDelete: "cascade" }),
    componentProductId: uuid("component_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    scrapPercent: numeric("scrap_percent", { precision: 8, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("bom_components_bom_idx").on(t.bomId)]
);

export const workOrders = pgTable(
  "work_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    woNumber: text("wo_number").notNull(),
    bomId: uuid("bom_id")
      .notNull()
      .references(() => billsOfMaterials.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    plannedQty: numeric("planned_qty", { precision: 18, scale: 4 }).notNull(),
    completedQty: numeric("completed_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    status: text("status")
      .$type<"Draft" | "Released" | "In Progress" | "Completed" | "Cancelled">()
      .notNull()
      .default("Released"),
    wipValueIssued: numeric("wip_value_issued", { precision: 18, scale: 4 }).notNull().default("0"),
    wipValueAbsorbed: numeric("wip_value_absorbed", { precision: 18, scale: 4 }).notNull().default("0"),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("work_orders_company_num_uq").on(t.companyId, t.woNumber),
    index("work_orders_branch_status_idx").on(t.branchId, t.status),
  ]
);

export const workOrderMaterials = pgTable(
  "work_order_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    componentProductId: uuid("component_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }).notNull(),
    issuedQty: numeric("issued_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    unitCostSnapshot: numeric("unit_cost_snapshot", { precision: 18, scale: 4 }).notNull().default("0"),
  },
  (t) => [index("wo_materials_wo_idx").on(t.workOrderId)]
);

// ============================================================================
// POS / Cashier Register Mode & ETA Egypt E-Receipt Submissions
// ============================================================================

export const posTerminals = pgTable(
  "pos_terminals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    receiptHeader: text("receipt_header").notNull().default(""),
    receiptFooter: text("receipt_footer").notNull().default(""),
    paperWidthMm: integer("paper_width_mm").notNull().default(80),
    defaultCustomerId: uuid("default_customer_id").references(() => customers.id, { onDelete: "set null" }),
    etaPosSerial: text("eta_pos_serial").notNull().default(""),
    etaPosOsVersion: text("eta_pos_os_version").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pos_terminals_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("pos_terminals_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    uniqueIndex("pos_terminals_company_name_norm_uq").on(t.companyId, sql`lower(btrim(${t.name}))`),
    index("pos_terminals_branch_idx").on(t.branchId),
  ]
);

export const posShifts = pgTable(
  "pos_shifts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    shiftNumber: text("shift_number").notNull(),
    terminalId: uuid("terminal_id")
      .notNull()
      .references(() => posTerminals.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    openingFloat: numeric("opening_float", { precision: 18, scale: 4 }).notNull().default("0"),
    expectedCash: numeric("expected_cash", { precision: 18, scale: 4 }).notNull().default("0"),
    countedCash: numeric("counted_cash", { precision: 18, scale: 4 }),
    cashVariance: numeric("cash_variance", { precision: 18, scale: 4 }),
    totalCashSales: numeric("total_cash_sales", { precision: 18, scale: 4 }).notNull().default("0"),
    totalCardSales: numeric("total_card_sales", { precision: 18, scale: 4 }).notNull().default("0"),
    totalWalletSales: numeric("total_wallet_sales", { precision: 18, scale: 4 }).notNull().default("0"),
    totalSalesCount: integer("total_sales_count").notNull().default(0),
    totalCashRefunds: numeric("total_cash_refunds", { precision: 18, scale: 4 }).notNull().default("0"),
    totalCardRefunds: numeric("total_card_refunds", { precision: 18, scale: 4 }).notNull().default("0"),
    totalWalletRefunds: numeric("total_wallet_refunds", { precision: 18, scale: 4 }).notNull().default("0"),
    totalRefundsCount: integer("total_refunds_count").notNull().default(0),
    notes: text("notes").notNull().default(""),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pos_shifts_company_num_uq").on(t.companyId, t.shiftNumber),
    index("pos_shifts_terminal_status_idx").on(t.terminalId, t.status),
    index("pos_shifts_branch_opened_idx").on(t.branchId, t.openedAt),
    uniqueIndex("pos_shifts_one_open_per_terminal_uq")
      .on(t.terminalId)
      .where(sql`${t.status} = 'open'`),
  ]
);

export const posShiftCashMovements = pgTable(
  "pos_shift_cash_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => posShifts.id, { onDelete: "cascade" }),
    type: text("type").$type<"pay_in" | "pay_out" | "safe_drop">().notNull(),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    reason: text("reason").notNull().default(""),
    performedByUserId: uuid("performed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("pos_shift_cash_mov_shift_idx").on(t.shiftId)]
);

export const userPosPins = pgTable("user_pos_pins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  pinHash: text("pin_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const posTenders = pgTable(
  "pos_tenders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "cascade" }),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => posShifts.id, { onDelete: "restrict" }),
    method: text("method").$type<"cash" | "card" | "mobile_wallet">().notNull(),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    tenderedAmount: numeric("tendered_amount", { precision: 18, scale: 4 }).notNull(),
    changeGiven: numeric("change_given", { precision: 18, scale: 4 }).notNull().default("0"),
    reference: text("reference").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("pos_tenders_invoice_idx").on(t.invoiceId), index("pos_tenders_shift_idx").on(t.shiftId)]
);

export const posReturns = pgTable(
  "pos_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    returnNumber: text("return_number").notNull(),
    originalInvoiceId: uuid("original_invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    terminalId: uuid("terminal_id")
      .notNull()
      .references(() => posTerminals.id, { onDelete: "restrict" }),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => posShifts.id, { onDelete: "restrict" }),
    cashierUserId: uuid("cashier_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    refundMethod: text("refund_method").$type<"cash" | "card" | "mobile_wallet">().notNull(),
    restockItems: boolean("restock_items").notNull().default(true),
    reason: text("reason").notNull().default(""),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    etaDocumentUuid: text("eta_document_uuid"),
    etaSubmissionUuid: text("eta_submission_uuid"),
    etaReceiptStatus: text("eta_receipt_status").notNull().default("not_applicable"),
    eInvoicePayloadJson: jsonb("e_invoice_payload_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("pos_returns_company_num_uq").on(t.companyId, t.returnNumber),
    index("pos_returns_original_inv_idx").on(t.originalInvoiceId),
    index("pos_returns_shift_idx").on(t.shiftId),
    index("pos_returns_branch_created_id_idx").on(t.branchId, t.createdAt, t.id),
  ]
);

export const posReturnLines = pgTable(
  "pos_return_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    posReturnId: uuid("pos_return_id")
      .notNull()
      .references(() => posReturns.id, { onDelete: "cascade" }),
    originalInvoiceLineId: uuid("original_invoice_line_id")
      .notNull()
      .references(() => salesInvoiceLines.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
    restockedQty: numeric("restocked_qty", { precision: 18, scale: 4 }).notNull().default("0"),
    unitCostSnapshot: numeric("unit_cost_snapshot", { precision: 18, scale: 4 }).notNull().default("0"),
  },
  (t) => [
    index("pos_return_lines_ret_idx").on(t.posReturnId),
    index("pos_return_lines_orig_line_idx").on(t.originalInvoiceLineId),
  ]
);

export const einvoiceSubmissions = pgTable(
  "einvoice_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => salesInvoices.id, { onDelete: "cascade" }),
    posReturnId: uuid("pos_return_id").references(() => posReturns.id, { onDelete: "cascade" }),
    salesReturnId: uuid("sales_return_id").references(() => salesReturns.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"eta_egypt" | "zatca_phase2">().notNull(),
    documentType: text("document_type").$type<"receipt" | "invoice">().notNull().default("receipt"),
    documentUuid: text("document_uuid").notNull(),
    submissionUuid: text("submission_uuid"),
    status: text("status")
      .$type<"pending" | "submitted" | "accepted" | "rejected" | "failed">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    requestPayloadJson: jsonb("request_payload_json").$type<Record<string, unknown>>().notNull().default({}),
    responsePayloadJson: jsonb("response_payload_json").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("einvoice_sub_status_retry_idx").on(t.status, t.nextRetryAt),
    index("einvoice_sub_company_status_idx").on(t.companyId, t.status, t.nextRetryAt),
    uniqueIndex("einvoice_sub_invoice_provider_uq")
      .on(t.invoiceId, t.provider)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    uniqueIndex("einvoice_sub_pos_return_provider_uq")
      .on(t.posReturnId, t.provider)
      .where(sql`${t.posReturnId} IS NOT NULL`),
    uniqueIndex("einvoice_sub_sales_return_provider_uq")
      .on(t.salesReturnId, t.provider)
      .where(sql`${t.salesReturnId} IS NOT NULL`),
  ]
);

// ============================================================================
// Wave 2A: Treasury (Bank & Cashboxes), Bank Reconciliation & Operating Expenses
// ============================================================================

export const treasuryAccounts = pgTable(
  "treasury_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    accountType: text("account_type").$type<"bank" | "cashbox">().notNull(),
    currency: text("currency").notNull().default("USD"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    glAccountId: uuid("gl_account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    bankName: text("bank_name").notNull().default(""),
    accountNumber: text("account_number").notNull().default(""),
    iban: text("iban").notNull().default(""),
    source: text("source").$type<"standard" | "opening_balance">().notNull().default("standard"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("treasury_accounts_company_code_uq").on(t.companyId, t.code),
    uniqueIndex("treasury_accounts_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.code}))`),
    uniqueIndex("treasury_accounts_company_name_norm_uq").on(t.companyId, sql`lower(btrim(${t.name}))`),
    uniqueIndex("treasury_accounts_company_iban_norm_uq")
      .on(t.companyId, sql`lower(btrim(${t.iban}))`)
      .where(sql`btrim(${t.iban}) <> ''`),
    uniqueIndex("treasury_accounts_company_gl_uq").on(t.companyId, t.glAccountId),
    index("treasury_accounts_company_type_idx").on(t.companyId, t.accountType),
  ]
);

export const treasuryTransfers = pgTable(
  "treasury_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    transferNumber: text("transfer_number").notNull(),
    transferDate: timestamp("transfer_date", { withTimezone: true }).defaultNow().notNull(),
    fromTreasuryAccountId: uuid("from_treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "restrict" }),
    toTreasuryAccountId: uuid("to_treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    reference: text("reference").notNull().default(""),
    memo: text("memo").notNull().default(""),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("treasury_transfers_company_num_uq").on(t.companyId, t.transferNumber),
    index("treasury_transfers_company_date_idx").on(t.companyId, t.transferDate),
  ]
);

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    treasuryAccountId: uuid("treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "cascade" }),
    statementNumber: text("statement_number").notNull(),
    fileName: text("file_name").notNull().default("statement.csv"),
    fromDate: timestamp("from_date", { withTimezone: true }),
    toDate: timestamp("to_date", { withTimezone: true }),
    lineCount: integer("line_count").notNull().default(0),
    importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_statements_company_num_uq").on(t.companyId, t.statementNumber),
    index("bank_statements_treasury_idx").on(t.treasuryAccountId, t.createdAt),
  ]
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    treasuryAccountId: uuid("treasury_account_id")
      .notNull()
      .references(() => treasuryAccounts.id, { onDelete: "cascade" }),
    lineDate: timestamp("line_date", { withTimezone: true }).notNull(),
    description: text("description").notNull().default(""),
    reference: text("reference").notNull().default(""),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    runningBalance: numeric("running_balance", { precision: 18, scale: 4 }),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").$type<"unmatched" | "reconciled" | "ignored">().notNull().default("unmatched"),
    matchedJournalLineId: uuid("matched_journal_line_id").references(() => journalLines.id, {
      onDelete: "set null",
    }),
    reconciledBy: uuid("reconciled_by").references(() => users.id, { onDelete: "set null" }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_stmt_lines_treasury_fp_uq").on(t.treasuryAccountId, t.fingerprint),
    uniqueIndex("bank_stmt_lines_matched_jl_uq")
      .on(t.matchedJournalLineId)
      .where(sql`${t.matchedJournalLineId} IS NOT NULL`),
    index("bank_stmt_lines_treasury_status_idx").on(t.treasuryAccountId, t.status, t.lineDate),
  ]
);

export const expenseClaims = pgTable(
  "expense_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    claimNumber: text("claim_number").notNull(),
    claimDate: timestamp("claim_date", { withTimezone: true }).defaultNow().notNull(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedByName: text("submitted_by_name").notNull().default(""),
    payeeName: text("payee_name").notNull().default(""),
    paymentMode: text("payment_mode")
      .$type<"direct_treasury" | "employee_reimbursement">()
      .notNull()
      .default("direct_treasury"),
    treasuryAccountId: uuid("treasury_account_id").references(() => treasuryAccounts.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<"draft" | "pending_approval" | "approved" | "paid" | "rejected">()
      .notNull()
      .default("draft"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    reference: text("reference").notNull().default(""),
    notes: text("notes").notNull().default(""),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewComment: text("review_comment").notNull().default(""),
    accrualJournalEntryId: uuid("accrual_journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    paymentJournalEntryId: uuid("payment_journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("expense_claims_company_num_uq").on(t.companyId, t.claimNumber),
    index("expense_claims_company_status_date_idx").on(t.companyId, t.status, t.claimDate),
  ]
);

export const expenseClaimLines = pgTable(
  "expense_claim_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => expenseClaims.id, { onDelete: "cascade" }),
    expenseAccountId: uuid("expense_account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    description: text("description").notNull().default(""),
    netAmount: numeric("net_amount", { precision: 18, scale: 4 }).notNull(),
    taxCodeId: uuid("tax_code_id").references(() => taxCodes.id, { onDelete: "set null" }),
    taxRate: numeric("tax_rate", { precision: 8, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [
    index("expense_claim_lines_claim_idx").on(t.claimId),
    index("expense_claim_lines_cc_idx").on(t.costCenterId),
  ]
);

// ============================================================================
// Wave 2B: Fixed Assets & Automated Depreciation
// ============================================================================

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    assetCode: text("asset_code").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default("Equipment"),
    serialNumber: text("serial_number").notNull().default(""),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "set null" }),
    acquisitionDate: timestamp("acquisition_date", { withTimezone: true }).notNull(),
    inServiceDate: timestamp("in_service_date", { withTimezone: true }).notNull(),
    acquisitionCost: numeric("acquisition_cost", { precision: 18, scale: 4 }).notNull(),
    salvageValue: numeric("salvage_value", { precision: 18, scale: 4 }).notNull().default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationMethod: text("depreciation_method")
      .$type<"straight_line" | "declining_balance">()
      .notNull()
      .default("straight_line"),
    decliningRatePct: numeric("declining_rate_pct", { precision: 8, scale: 4 }).notNull().default("200"),
    accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    netBookValue: numeric("net_book_value", { precision: 18, scale: 4 }).notNull(),
    status: text("status")
      .$type<"active" | "fully_depreciated" | "disposed">()
      .notNull()
      .default("active"),
    assetAccountId: uuid("asset_account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    accumDepAccountId: uuid("accum_dep_account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    depExpenseAccountId: uuid("dep_expense_account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
    acquisitionJournalEntryId: uuid("acquisition_journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    disposalProceeds: numeric("disposal_proceeds", { precision: 18, scale: 4 }),
    disposalJournalEntryId: uuid("disposal_journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    source: text("source").$type<"standard" | "opening_balance">().notNull().default("standard"),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("fixed_assets_company_code_uq").on(t.companyId, t.assetCode),
    uniqueIndex("fixed_assets_company_code_norm_uq").on(t.companyId, sql`lower(btrim(${t.assetCode}))`),
    uniqueIndex("fixed_assets_company_serial_norm_uq")
      .on(t.companyId, sql`lower(btrim(${t.serialNumber}))`)
      .where(sql`btrim(${t.serialNumber}) <> ''`),
    index("fixed_assets_company_status_idx").on(t.companyId, t.status),
  ]
);

export const fixedAssetDepreciationEntries = pgTable(
  "fixed_asset_depreciation_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .default(DEFAULT_COMPANY_ID)
      .references(() => companies.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    depreciationDate: timestamp("depreciation_date", { withTimezone: true }).notNull(),
    depreciationAmount: numeric("depreciation_amount", { precision: 18, scale: 4 }).notNull(),
    accumulatedAfter: numeric("accumulated_after", { precision: 18, scale: 4 }).notNull(),
    netBookValueAfter: numeric("net_book_value_after", { precision: 18, scale: 4 }).notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("fixed_asset_dep_asset_period_uq").on(t.assetId, t.periodKey),
    index("fixed_asset_dep_company_period_idx").on(t.companyId, t.periodKey),
  ]
);
