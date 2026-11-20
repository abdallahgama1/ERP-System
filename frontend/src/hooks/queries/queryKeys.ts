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
  auditLogs: ["auditLogs"] as const,
  notifications: ["notifications"] as const,

  inventory: {
    all: ["inventory"] as const,
    products: () => ["inventory", "products"] as const,
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
    orders: () => ["purchases", "orders"] as const,
    receives: () => ["purchases", "receives"] as const,
    bills: () => ["purchases", "bills"] as const,
    payments: () => ["purchases", "payments"] as const,
    returns: () => ["purchases", "returns"] as const,
  },

  sales: {
    all: ["sales"] as const,
    customers: () => ["sales", "customers"] as const,
    orders: () => ["sales", "orders"] as const,
    invoices: () => ["sales", "invoices"] as const,
    payments: () => ["sales", "payments"] as const,
    returns: () => ["sales", "returns"] as const,
    retainers: () => ["sales", "retainers"] as const,
  },

  accounting: {
    all: ["accounting"] as const,
    accounts: () => ["accounting", "accounts"] as const,
    mappings: () => ["accounting", "mappings"] as const,
    journals: () => ["accounting", "journals"] as const,
    fiscalYears: () => ["accounting", "fiscalYears"] as const,
    taxCodes: () => ["accounting", "taxCodes"] as const,
    currencies: () => ["accounting", "currencies"] as const,
    statement: (kind: string, params?: Record<string, string>) =>
      ["accounting", "statement", kind, params ?? {}] as const,
  },

  approvals: {
    all: ["approvals"] as const,
    rules: () => ["approvals", "rules"] as const,
    requests: () => ["approvals", "requests"] as const,
  },
};

export function queryKeysForServerEvent(eventType?: string): ReadonlyArray<readonly unknown[]> {
  switch (eventType) {
    case "inventory_updated":
      return [erpQueryKeys.inventory.all, erpQueryKeys.accounting.all];
    case "purchases_updated":
      return [erpQueryKeys.purchases.all, erpQueryKeys.accounting.all];
    case "sales_updated":
      return [erpQueryKeys.sales.all, erpQueryKeys.accounting.all];
    case "sessions_updated":
      return [erpQueryKeys.sessions.all, erpQueryKeys.accounting.all];
    case "accounting_updated":
      return [erpQueryKeys.accounting.all];
    case "approvals_updated":
      return [erpQueryKeys.approvals.all, erpQueryKeys.notifications];
    case "branches_updated":
    case "users_updated":
      return [erpQueryKeys.branches, erpQueryKeys.permissions];
    case "taxonomy_updated":
      return [erpQueryKeys.taxonomy];
    case "settings_updated":
      return [erpQueryKeys.settings, erpQueryKeys.accounting.taxCodes(), erpQueryKeys.accounting.currencies()];
    case "notifications_updated":
      return [erpQueryKeys.notifications];
    default:
      return [];
  }
}
