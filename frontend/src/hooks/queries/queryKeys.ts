/**
 * Centralized TanStack Query key factories across all ERP domains.
 * Enables targeted SSE event invalidation without over-fetching unrelated modules.
 */
export const erpQueryKeys = {
  branches: ["branches"] as const,
  branchesDirectory: ["branches", "directory"] as const,
  taxonomy: ["taxonomy"] as const,
  permissions: ["permissions"] as const,
  settings: ["settings"] as const,
  companySettings: ["settings", "company"] as const,
  preferences: ["settings", "preferences"] as const,
  users: ["users"] as const,
  auditLogs: ["auditLogs"] as const,
  notifications: ["notifications"] as const,

  companies: {
    all: ["companies"] as const,
    list: () => ["companies", "list"] as const,
    detail: (id: string) => ["companies", "detail", id] as const,
    members: (id: string) => ["companies", "members", id] as const,
  },

  customRoles: {
    all: ["customRoles"] as const,
    list: (companyId?: string) => ["customRoles", "list", companyId ?? "active"] as const,
  },

  mfa: {
    all: ["mfa"] as const,
    status: () => ["mfa", "status"] as const,
  },

  sessionsMgmt: {
    all: ["sessionsMgmt"] as const,
    list: () => ["sessionsMgmt", "list"] as const,
  },

  search: {
    all: ["search"] as const,
    query: (q: string, limit = 20) => ["search", { q, limit }] as const,
  },

  savedViews: {
    all: ["savedViews"] as const,
    byResource: (resource?: string) => ["savedViews", resource ?? "all"] as const,
  },

  attachments: {
    all: ["attachments"] as const,
    list: (entityType: string, entityId: string) => ["attachments", entityType, entityId] as const,
  },

  printTemplates: {
    all: ["printTemplates"] as const,
    list: (documentType?: string) => ["printTemplates", "list", documentType ?? "all"] as const,
  },

  inventory: {
    all: ["inventory"] as const,
    products: () => ["inventory", "products"] as const,
    productsDirectory: (q?: string) => ["inventory", "products", "directory", q ?? ""] as const,
    movements: (branchId?: string, productId?: string) =>
      ["inventory", "movements", { branchId: branchId ?? "all", productId: productId ?? "all" }] as const,
    adjustments: () => ["inventory", "adjustments"] as const,
    writeOffs: () => ["inventory", "writeOffs"] as const,
    transfers: () => ["inventory", "transfers"] as const,
  },

  sessions: {
    all: ["sessions"] as const,
    list: () => ["sessions", "list"] as const,
  },

  purchases: {
    all: ["purchases"] as const,
    vendors: () => ["purchases", "vendors"] as const,
    vendorsDirectory: (q?: string) => ["purchases", "vendors", "directory", q ?? ""] as const,
    orders: () => ["purchases", "orders"] as const,
    ordersDirectory: () => ["purchases", "orders", "directory"] as const,
    receives: () => ["purchases", "receives"] as const,
    bills: () => ["purchases", "bills"] as const,
    payments: () => ["purchases", "payments"] as const,
    returns: () => ["purchases", "returns"] as const,
  },

  sales: {
    all: ["sales"] as const,
    customers: () => ["sales", "customers"] as const,
    customersDirectory: (q?: string) => ["sales", "customers", "directory", q ?? ""] as const,
    orders: () => ["sales", "orders"] as const,
    ordersDirectory: () => ["sales", "orders", "directory"] as const,
    invoices: () => ["sales", "invoices"] as const,
    payments: () => ["sales", "payments"] as const,
    returns: () => ["sales", "returns"] as const,
    retainers: () => ["sales", "retainers"] as const,
  },

  accounting: {
    all: ["accounting"] as const,
    accounts: () => ["accounting", "accounts"] as const,
    costCenters: () => ["accounting", "costCenters"] as const,
    mappings: () => ["accounting", "mappings"] as const,
    journals: () => ["accounting", "journals"] as const,
    fiscalYears: () => ["accounting", "fiscalYears"] as const,
    taxCodes: () => ["accounting", "taxCodes"] as const,
    currencies: () => ["accounting", "currencies"] as const,
    statement: (kind: string, params?: Record<string, string>) =>
      ["accounting", "statement", kind, params ?? {}] as const,
  },

  treasury: {
    all: ["treasury"] as const,
    accounts: () => ["treasury", "accounts"] as const,
    transfers: () => ["treasury", "transfers"] as const,
    reconciliation: (accountId: string) => ["treasury", "reconciliation", accountId] as const,
  },

  expenses: {
    all: ["expenses"] as const,
    list: (params?: Record<string, unknown>) => ["expenses", "list", params ?? {}] as const,
    detail: (id: string) => ["expenses", "detail", id] as const,
  },

  fixedAssets: {
    all: ["fixedAssets"] as const,
    list: () => ["fixedAssets", "list"] as const,
    schedule: (id: string) => ["fixedAssets", "schedule", id] as const,
  },

  approvals: {
    all: ["approvals"] as const,
    rules: () => ["approvals", "rules"] as const,
    requests: () => ["approvals", "requests"] as const,
  },

  tracking: {
    all: ["tracking"] as const,
    lots: (branchId?: string, productId?: string) =>
      ["tracking", "lots", { branchId: branchId ?? "all", productId: productId ?? "all" }] as const,
    serials: (branchId?: string, status?: string, search?: string) =>
      ["tracking", "serials", { branchId: branchId ?? "all", status: status ?? "all", search: search ?? "" }] as const,
    serialTrace: (serialId: string) => ["tracking", "serialTrace", serialId] as const,
  },

  manufacturing: {
    all: ["manufacturing"] as const,
    boms: () => ["manufacturing", "boms"] as const,
    workOrders: () => ["manufacturing", "workOrders"] as const,
  },

  pos: {
    all: ["pos"] as const,
    terminals: (branchId?: string) => ["pos", "terminals", branchId ?? "all"] as const,
    catalog: (branchId?: string) => ["pos", "catalog", branchId ?? "default"] as const,
    activeShift: (terminalId?: string) => ["pos", "activeShift", terminalId ?? "none"] as const,
    cashiers: (branchId?: string) => ["pos", "cashiers", branchId ?? "all"] as const,
  },

  einvoicing: {
    all: ["einvoicing"] as const,
    submissions: (params?: Record<string, unknown>) => ["einvoicing", "submissions", params ?? {}] as const,
    summary: () => ["einvoicing", "summary"] as const,
    detail: (id: string) => ["einvoicing", "detail", id] as const,
  },
};

export function queryKeysForServerEvent(eventType?: string): ReadonlyArray<readonly unknown[]> {
  switch (eventType) {
    case "inventory_updated":
      return [erpQueryKeys.inventory.all, erpQueryKeys.tracking.all, erpQueryKeys.accounting.all];
    case "purchases_updated":
      return [erpQueryKeys.purchases.all, erpQueryKeys.tracking.all, erpQueryKeys.accounting.all];
    case "sales_updated":
      return [erpQueryKeys.sales.all, erpQueryKeys.tracking.all, erpQueryKeys.accounting.all];
    case "sessions_updated":
      return [erpQueryKeys.sessions.all, erpQueryKeys.accounting.all];
    case "accounting_updated":
      return [erpQueryKeys.accounting.all, erpQueryKeys.treasury.all];
    case "treasury_updated":
      return [erpQueryKeys.treasury.all, erpQueryKeys.accounting.all];
    case "expenses_updated":
      return [erpQueryKeys.expenses.all, erpQueryKeys.treasury.all, erpQueryKeys.accounting.all];
    case "fixed_assets_updated":
      return [erpQueryKeys.fixedAssets.all, erpQueryKeys.accounting.all];
    case "approvals_updated":
      return [erpQueryKeys.approvals.all, erpQueryKeys.notifications];
    case "tracking_updated":
      return [erpQueryKeys.tracking.all, erpQueryKeys.inventory.all];
    case "manufacturing_updated":
      return [erpQueryKeys.manufacturing.all, erpQueryKeys.inventory.all, erpQueryKeys.accounting.all];
    case "branches_updated":
      return [erpQueryKeys.branches, erpQueryKeys.branchesDirectory, erpQueryKeys.permissions];
    case "users_updated":
      return [erpQueryKeys.branches, erpQueryKeys.permissions, erpQueryKeys.users, erpQueryKeys.companies.all];
    case "permissions_updated":
    case "custom_roles_updated":
    case "roles_updated":
      return [erpQueryKeys.permissions, erpQueryKeys.customRoles.all];
    case "companies_updated":
      return [
        erpQueryKeys.companies.all,
        erpQueryKeys.companySettings,
        erpQueryKeys.settings,
        erpQueryKeys.branches,
        erpQueryKeys.branchesDirectory,
      ];
    case "taxonomy_updated":
      return [erpQueryKeys.taxonomy];
    case "settings_updated":
      return [
        erpQueryKeys.settings,
        erpQueryKeys.companySettings,
        erpQueryKeys.preferences,
        erpQueryKeys.printTemplates.all,
        erpQueryKeys.accounting.taxCodes(),
        erpQueryKeys.accounting.currencies(),
        erpQueryKeys.companies.all,
      ];
    case "notifications_updated":
      return [erpQueryKeys.notifications];
    case "audit_updated":
      return [erpQueryKeys.auditLogs];
    case "attachments_updated":
      return [erpQueryKeys.attachments.all];
    case "print_templates_updated":
      return [erpQueryKeys.printTemplates.all];
    case "saved_views_updated":
      return [erpQueryKeys.savedViews.all];
    case "mfa_updated":
      return [erpQueryKeys.mfa.all];
    case "sessions_mgmt_updated":
      return [erpQueryKeys.sessionsMgmt.all];
    case "pos_updated":
      return [erpQueryKeys.pos.all, erpQueryKeys.sales.all, erpQueryKeys.inventory.all, erpQueryKeys.einvoicing.all];
    case "einvoicing_updated":
      return [erpQueryKeys.einvoicing.all, erpQueryKeys.sales.all, erpQueryKeys.pos.all];
    default:
      return [];
  }
}
