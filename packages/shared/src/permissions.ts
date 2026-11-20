export const APP_ROLES = ["admin", "manager", "user"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const PERMISSION_ACTIONS = ["view", "create", "edit", "delete", "approve"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_MODULES = [
  "products",
  "branches",
  "sessions",
  "inventory",
  "sales",
  "purchases",
  "accounting",
  "reports",
  "taxonomy",
  "users",
  "settings",
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const BRANCH_TYPES = ["hq_warehouse", "warehouse", "retail"] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

export const BRANCH_SCOPE_MODES = ["all", "selected"] as const;
export type BranchScopeMode = (typeof BRANCH_SCOPE_MODES)[number];

export type ModulePermission = Record<PermissionAction, boolean>;
export type RolePermissionMatrix = Record<AppRole, Record<PermissionModule, ModulePermission>>;

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

export const DEFAULT_PERMISSION_MATRIX: RolePermissionMatrix = {
  admin: {
    products: fullAccess(),
    branches: fullAccess(),
    sessions: fullAccess(),
    inventory: fullAccess(),
    sales: fullAccess(),
    purchases: fullAccess(),
    accounting: fullAccess(),
    reports: fullAccess(),
    taxonomy: fullAccess(),
    users: fullAccess(),
    settings: fullAccess(),
  },
  manager: {
    products: { view: true, create: true, edit: true, delete: false, approve: true },
    branches: { view: true, create: false, edit: true, delete: false, approve: false },
    sessions: { view: true, create: true, edit: true, delete: false, approve: true },
    inventory: { view: true, create: true, edit: true, delete: false, approve: true },
    sales: { view: true, create: true, edit: true, delete: false, approve: true },
    purchases: { view: true, create: true, edit: true, delete: false, approve: true },
    accounting: readOnlyAccess(),
    reports: { view: true, create: true, edit: false, delete: false, approve: false },
    taxonomy: { view: true, create: true, edit: true, delete: false, approve: false },
    users: readOnlyAccess(),
    settings: readOnlyAccess(),
  },
  user: {
    products: readOnlyAccess(),
    branches: readOnlyAccess(),
    sessions: { view: true, create: true, edit: true, delete: false, approve: false },
    inventory: { view: true, create: true, edit: false, delete: false, approve: false },
    sales: { view: true, create: true, edit: true, delete: false, approve: false },
    purchases: { view: true, create: true, edit: false, delete: false, approve: false },
    accounting: noAccess(),
    reports: readOnlyAccess(),
    taxonomy: readOnlyAccess(),
    users: noAccess(),
    settings: readOnlyAccess(),
  },
};
