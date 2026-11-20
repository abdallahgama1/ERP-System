import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
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

// ============================================================================
// Branches, Auth & Access Control
// ============================================================================

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    branchType: branchTypeEnum("branch_type").notNull().default("retail"),
    location: text("location").notNull().default(""),
    address: text("address").notNull().default(""),
    phone: text("phone").notNull().default(""),
    email: text("email").notNull().default(""),
    managerName: text("manager_name").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("branches_active_idx").on(t.isActive)]
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

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: appRoleEnum("role").notNull().default("user"),
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId), index("user_sessions_expires_idx").on(t.expiresAt)]
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
  (t) => [index("password_reset_user_idx").on(t.userId)]
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
    docType: text("doc_type").notNull(),
    scopeKey: text("scope_key").notNull().default("company"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(4),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("doc_sequences_type_scope_uq").on(t.docType, t.scopeKey)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    userName: text("user_name").notNull(),
    userRole: text("user_role"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityLabel: text("entity_label"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_branch_idx").on(t.branchId),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("notifications_created_idx").on(t.createdAt), index("notifications_user_idx").on(t.userId)]
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
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idempotency_user_req_uq").on(t.userId, t.method, t.path, t.key)]
);

// ============================================================================
// Accounting Core, Fiscal Calendars, Currencies & Master Data
// ============================================================================

export const fiscalYears = pgTable("fiscal_years", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  status: text("status").$type<"open" | "closed">().notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    name: text("name").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    status: text("status").$type<"open" | "locked">().notNull().default("open"),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "set null" }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("fiscal_periods_year_num_uniq").on(t.fiscalYearId, t.periodNumber),
    index("fiscal_periods_dates_idx").on(t.startDate, t.endDate),
  ]
);

export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
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
  (t) => [index("coa_type_idx").on(t.accountType)]
);

export const glAccountMappings = pgTable("gl_account_mappings", {
  mappingKey: text("mapping_key").primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => chartOfAccounts.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  decimals: integer("decimals").notNull().default(2),
  isBase: boolean("is_base").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    rate: numeric("rate", { precision: 18, scale: 6 }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("fx_rates_pair_idx").on(t.fromCurrency, t.toCurrency, t.effectiveAt)]
);

export const taxCodes = pgTable("tax_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  rate: numeric("rate", { precision: 8, scale: 4 }).notNull().default("0"),
  isDefault: boolean("is_default").notNull().default(false),
  isInclusive: boolean("is_inclusive").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  inputAccountId: uuid("input_account_id").references(() => chartOfAccounts.id, { onDelete: "set null" }),
  outputAccountId: uuid("output_account_id").references(() => chartOfAccounts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const taxonomyItems = pgTable(
  "taxonomy_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
  (t) => [uniqueIndex("taxonomy_kind_name_uq").on(t.kind, t.name)]
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sku: text("sku").notNull().unique(),
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
    trackLots: boolean("track_lots").notNull().default(false),
    trackSerials: boolean("track_serials").notNull().default(false),
    hasBom: boolean("has_bom").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("products_barcode_idx").on(t.barcode), index("products_category_idx").on(t.category)]
);

export const branchProducts = pgTable(
  "branch_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
  ]
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    phone: text("phone").notNull().default(""),
    company: text("company").notNull().default(""),
    billingAddress: text("billing_address").notNull().default(""),
    shippingAddress: text("shipping_address").notNull().default(""),
    taxNumber: text("tax_number").notNull().default(""),
    currency: text("currency").notNull().default("USD"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    creditLimit: numeric("credit_limit", { precision: 18, scale: 4 }),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("customers_name_idx").on(t.name)]
);

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
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
  (t) => [index("vendors_name_idx").on(t.name)]
);

// ============================================================================
// Inventory Movements, Adjustments, Write-Offs, Transfers, Stock-Take Sessions
// ============================================================================

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
  ]
);

export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adjustmentNumber: text("adjustment_number").notNull().unique(),
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
  (t) => [index("stock_adjustments_branch_idx").on(t.branchId, t.createdAt)]
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
    writeOffNumber: text("write_off_number").notNull().unique(),
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
  (t) => [index("stock_write_offs_branch_idx").on(t.branchId, t.createdAt)]
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
    transferNumber: text("transfer_number").notNull().unique(),
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
    sessionNumber: text("session_number").notNull().unique(),
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
  (t) => [index("stock_sessions_branch_status_idx").on(t.branchId, t.status)]
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
    poNumber: text("po_number").notNull().unique(),
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
  (t) => [index("purchase_orders_vendor_idx").on(t.vendorId), index("purchase_orders_branch_idx").on(t.branchId)]
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
    receiveNumber: text("receive_number").notNull().unique(),
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
  (t) => [index("purchase_receives_po_idx").on(t.poId), index("purchase_receives_branch_idx").on(t.branchId)]
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
    billNumber: text("bill_number").notNull().unique(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    receiveId: uuid("receive_id").references(() => purchaseReceives.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Open"),
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
  (t) => [index("vendor_bills_vendor_idx").on(t.vendorId), index("vendor_bills_status_idx").on(t.status)]
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
    paymentNumber: text("payment_number").notNull().unique(),
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
  (t) => [index("payments_made_vendor_idx").on(t.vendorId)]
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
    returnNumber: text("return_number").notNull().unique(),
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
  (t) => [index("purchase_returns_vendor_idx").on(t.vendorId)]
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
    soNumber: text("so_number").notNull().unique(),
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
  (t) => [index("sales_orders_customer_idx").on(t.customerId), index("sales_orders_branch_idx").on(t.branchId)]
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
    invoiceNumber: text("invoice_number").notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    soId: uuid("so_id").references(() => salesOrders.id, { onDelete: "set null" }),
    status: text("status").notNull().default("Draft"),
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
    voidReason: text("void_reason"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sales_invoices_customer_idx").on(t.customerId), index("sales_invoices_status_idx").on(t.status)]
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
    paymentNumber: text("payment_number").notNull().unique(),
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
  (t) => [index("received_payments_customer_idx").on(t.customerId)]
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
    returnNumber: text("return_number").notNull().unique(),
    creditNoteNumber: text("credit_note_number").notNull().unique(),
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
    notes: text("notes").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("sales_returns_customer_idx").on(t.customerId)]
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
    retainerNumber: text("retainer_number").notNull().unique(),
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
  (t) => [index("retainer_invoices_customer_idx").on(t.customerId)]
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
    entryNumber: text("entry_number").notNull().unique(),
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
    index("journal_entries_date_idx").on(t.entryDate),
    index("journal_entries_source_idx").on(t.sourceType, t.sourceId),
    index("journal_entries_branch_idx").on(t.branchId),
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
  ]
);

// ============================================================================
// Enterprise Approvals & Controls (Milestone D1)
// ============================================================================

export const approvalRules = pgTable("approval_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityType: text("entity_type")
    .$type<"purchase_order" | "stock_transfer" | "stock_adjustment" | "stock_write_off">()
    .notNull()
    .unique(),
  minAmount: numeric("min_amount", { precision: 18, scale: 4 }).notNull().default("0"),
  requiredRole: appRoleEnum("required_role").notNull().default("manager"),
  isActive: boolean("is_active").notNull().default(false),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    index("approval_requests_entity_idx").on(t.entityType, t.entityId),
  ]
);
