export const APP_ROLES = ["admin", "manager", "user"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const PERMISSION_ACTIONS = ["view", "create", "edit", "delete", "approve"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_MODULES = [
  "products",
  "branches",
  "sessions",
  "inventory",
  "manufacturing",
  "sales",
  "pos",
  "purchases",
  "accounting",
  "reports",
  "taxonomy",
  "approvals",
  "einvoicing",
  "audit",
  "companies",
  "roles",
  "users",
  "settings",
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const BRANCH_TYPES = ["hq_warehouse", "warehouse", "retail"] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

export const BRANCH_SCOPE_MODES = ["all", "selected"] as const;
export type BranchScopeMode = (typeof BRANCH_SCOPE_MODES)[number];

export type ModulePermission = Record<PermissionAction, boolean>;
export type PermissionMap = Record<PermissionModule, ModulePermission>;
export type RolePermissionMatrix = Record<AppRole, PermissionMap>;

const fullAccess = (): ModulePermission => ({
  view: true,
  create: true,
  edit: true,
  delete: true,
  approve: true,
});

const readOnlyAccess = (): ModulePermission => ({
  view: true,
  create: false,
  edit: false,
  delete: false,
  approve: false,
});

const noAccess = (): ModulePermission => ({
  view: false,
  create: false,
  edit: false,
  delete: false,
  approve: false,
});

export function buildEmptyPermissionRecord(): PermissionMap {
  return {
    products: noAccess(),
    branches: noAccess(),
    sessions: noAccess(),
    inventory: noAccess(),
    manufacturing: noAccess(),
    sales: noAccess(),
    pos: noAccess(),
    purchases: noAccess(),
    accounting: noAccess(),
    reports: noAccess(),
    taxonomy: noAccess(),
    approvals: noAccess(),
    einvoicing: noAccess(),
    audit: noAccess(),
    companies: noAccess(),
    roles: noAccess(),
    users: noAccess(),
    settings: noAccess(),
  };
}

export function normalizeRolePermissionsMap(
  input?: Partial<Record<string, Partial<Record<PermissionAction, boolean>>>> | null
): PermissionMap {
  const result = buildEmptyPermissionRecord();
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const mod of PERMISSION_MODULES) {
    const incoming = input[mod];
    if (incoming && typeof incoming === "object") {
      result[mod] = {
        view: incoming.view === true,
        create: incoming.create === true,
        edit: incoming.edit === true,
        delete: incoming.delete === true,
        approve: incoming.approve === true,
      };
    }
  }
  return result;
}

function createPermissionMap(
  overrides: Partial<PermissionMap>,
  fallback: () => ModulePermission = noAccess
): PermissionMap {
  const map = {} as PermissionMap;
  for (const mod of PERMISSION_MODULES) {
    const entry = overrides[mod] ?? fallback();
    map[mod] = { ...entry };
  }
  return map;
}

export const DEFAULT_PERMISSION_MATRIX: RolePermissionMatrix = {
  admin: createPermissionMap({}, fullAccess),
  manager: {
    products: { view: true, create: true, edit: true, delete: false, approve: true },
    branches: { view: true, create: false, edit: true, delete: false, approve: false },
    sessions: { view: true, create: true, edit: true, delete: false, approve: true },
    inventory: { view: true, create: true, edit: true, delete: false, approve: true },
    manufacturing: { view: true, create: true, edit: true, delete: false, approve: true },
    sales: { view: true, create: true, edit: true, delete: false, approve: true },
    pos: fullAccess(),
    purchases: { view: true, create: true, edit: true, delete: false, approve: true },
    accounting: readOnlyAccess(),
    reports: { view: true, create: true, edit: false, delete: false, approve: false },
    taxonomy: { view: true, create: true, edit: true, delete: false, approve: false },
    approvals: { view: true, create: true, edit: false, delete: false, approve: true },
    einvoicing: { view: true, create: true, edit: true, delete: false, approve: true },
    audit: readOnlyAccess(),
    companies: noAccess(),
    roles: readOnlyAccess(),
    users: readOnlyAccess(),
    settings: readOnlyAccess(),
  },
  user: {
    products: readOnlyAccess(),
    branches: readOnlyAccess(),
    sessions: { view: true, create: true, edit: true, delete: false, approve: false },
    inventory: { view: true, create: true, edit: false, delete: false, approve: false },
    manufacturing: { view: true, create: true, edit: false, delete: false, approve: false },
    sales: { view: true, create: true, edit: true, delete: false, approve: false },
    pos: { view: true, create: true, edit: false, delete: false, approve: false },
    purchases: { view: true, create: true, edit: false, delete: false, approve: false },
    accounting: noAccess(),
    reports: readOnlyAccess(),
    taxonomy: readOnlyAccess(),
    approvals: readOnlyAccess(),
    einvoicing: noAccess(),
    audit: noAccess(),
    companies: noAccess(),
    roles: noAccess(),
    users: noAccess(),
    settings: readOnlyAccess(),
  },
};

export interface SystemRolePreset {
  name: string;
  description: string;
  baseRole: AppRole;
  permissions: PermissionMap;
}

export const SYSTEM_ROLE_PRESETS: readonly SystemRolePreset[] = [
  {
    name: "Admin",
    description: "Full administrative access across all modules, companies, roles, and security controls.",
    baseRole: "admin",
    permissions: createPermissionMap({}, fullAccess),
  },
  {
    name: "Finance Manager",
    description: "Full accounting, financial reporting, e-invoicing, and approval authority.",
    baseRole: "manager",
    permissions: createPermissionMap({
      accounting: fullAccess(),
      reports: fullAccess(),
      einvoicing: { view: true, create: true, edit: true, delete: false, approve: true },
      approvals: { view: true, create: true, edit: false, delete: false, approve: true },
      sales: { view: true, create: false, edit: false, delete: false, approve: true },
      purchases: { view: true, create: false, edit: false, delete: false, approve: true },
      audit: readOnlyAccess(),
      pos: readOnlyAccess(),
      products: readOnlyAccess(),
      branches: readOnlyAccess(),
      sessions: readOnlyAccess(),
      inventory: readOnlyAccess(),
      manufacturing: readOnlyAccess(),
      taxonomy: readOnlyAccess(),
      settings: readOnlyAccess(),
    }),
  },
  {
    name: "Accountant",
    description: "General ledger journal posting, financial reports, and audit read access.",
    baseRole: "user",
    permissions: createPermissionMap({
      accounting: { view: true, create: true, edit: true, delete: false, approve: false },
      reports: readOnlyAccess(),
      einvoicing: readOnlyAccess(),
      audit: readOnlyAccess(),
      sales: readOnlyAccess(),
      purchases: readOnlyAccess(),
      pos: readOnlyAccess(),
      products: readOnlyAccess(),
      branches: readOnlyAccess(),
      inventory: readOnlyAccess(),
      taxonomy: readOnlyAccess(),
    }),
  },
  {
    name: "Warehouse Manager",
    description: "Full inventory, manufacturing, stock-take sessions, receiving, and operational approvals.",
    baseRole: "manager",
    permissions: createPermissionMap({
      products: { view: true, create: true, edit: true, delete: false, approve: true },
      sessions: { view: true, create: true, edit: true, delete: false, approve: true },
      inventory: { view: true, create: true, edit: true, delete: false, approve: true },
      manufacturing: { view: true, create: true, edit: true, delete: false, approve: true },
      approvals: { view: true, create: true, edit: false, delete: false, approve: true },
      taxonomy: { view: true, create: true, edit: true, delete: false, approve: false },
      purchases: { view: true, create: false, edit: true, delete: false, approve: false },
      branches: readOnlyAccess(),
      sales: readOnlyAccess(),
      reports: readOnlyAccess(),
    }),
  },
  {
    name: "Purchasing Officer",
    description: "Purchase orders, receiving, vendor bills, and supplier catalog management.",
    baseRole: "user",
    permissions: createPermissionMap({
      purchases: { view: true, create: true, edit: true, delete: false, approve: false },
      products: { view: true, create: true, edit: false, delete: false, approve: false },
      inventory: readOnlyAccess(),
      branches: readOnlyAccess(),
      taxonomy: readOnlyAccess(),
      reports: readOnlyAccess(),
      approvals: readOnlyAccess(),
    }),
  },
  {
    name: "Sales Manager",
    description: "Sales orders, invoicing, returns, POS operations, and commercial approvals.",
    baseRole: "manager",
    permissions: createPermissionMap({
      sales: { view: true, create: true, edit: true, delete: false, approve: true },
      pos: { view: true, create: true, edit: true, delete: false, approve: true },
      products: readOnlyAccess(),
      branches: readOnlyAccess(),
      inventory: readOnlyAccess(),
      reports: readOnlyAccess(),
      taxonomy: readOnlyAccess(),
      approvals: readOnlyAccess(),
      einvoicing: readOnlyAccess(),
    }),
  },
  {
    name: "Branch Manager",
    description: "Branch-wide operational management across sales, POS, inventory, and purchasing.",
    baseRole: "manager",
    permissions: createPermissionMap({
      products: { view: true, create: true, edit: true, delete: false, approve: true },
      branches: { view: true, create: false, edit: true, delete: false, approve: false },
      sessions: { view: true, create: true, edit: true, delete: false, approve: true },
      inventory: { view: true, create: true, edit: true, delete: false, approve: true },
      manufacturing: { view: true, create: true, edit: true, delete: false, approve: true },
      sales: { view: true, create: true, edit: true, delete: false, approve: true },
      pos: fullAccess(),
      purchases: { view: true, create: true, edit: true, delete: false, approve: true },
      reports: { view: true, create: true, edit: false, delete: false, approve: false },
      taxonomy: { view: true, create: true, edit: true, delete: false, approve: false },
      approvals: { view: true, create: true, edit: false, delete: false, approve: true },
      einvoicing: { view: true, create: true, edit: true, delete: false, approve: true },
      accounting: readOnlyAccess(),
      audit: readOnlyAccess(),
      users: readOnlyAccess(),
      settings: readOnlyAccess(),
      roles: readOnlyAccess(),
    }),
  },
  {
    name: "Cashier",
    description: "Point-of-sale checkout, shift operations, and customer sales entry.",
    baseRole: "user",
    permissions: createPermissionMap({
      pos: { view: true, create: true, edit: false, delete: false, approve: false },
      sales: { view: true, create: true, edit: false, delete: false, approve: false },
      products: readOnlyAccess(),
      branches: readOnlyAccess(),
    }),
  },
] as const;
