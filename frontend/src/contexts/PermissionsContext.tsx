import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  APP_ROLES,
  DEFAULT_PERMISSION_MATRIX,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  type AppRole,
  type PermissionAction,
  type PermissionModule,
  type RolePermissionMatrix,
} from "@erp/shared";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";

export { APP_ROLES, DEFAULT_PERMISSION_MATRIX as DEFAULT_ROLE_MATRIX, PERMISSION_ACTIONS, PERMISSION_MODULES };
export type { AppRole, PermissionAction, PermissionModule, RolePermissionMatrix };

const DEFAULT_ROLE_MATRIX = DEFAULT_PERMISSION_MATRIX;

interface PermissionsContextType {
  role: AppRole;
  matrix: RolePermissionMatrix;
  isLoading: boolean;
  can: (module: PermissionModule, action?: PermissionAction) => boolean;
  setPermission: (targetRole: AppRole, module: PermissionModule, action: PermissionAction, allowed: boolean) => Promise<void>;
  resetMatrix: () => Promise<void>;
  reloadMatrix: () => Promise<void>;
}

const PermissionsContext = createContext<PermissionsContextType | undefined>(undefined);

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { user, refreshUser } = useAuth();
  const role: AppRole = user?.role ?? "user";
  const [matrix, setMatrix] = useState<RolePermissionMatrix>(() => structuredClone(DEFAULT_ROLE_MATRIX));
  const [isLoading, setIsLoading] = useState(false);

  const reloadMatrix = useCallback(async () => {
    if (!user) {
      setMatrix(structuredClone(DEFAULT_ROLE_MATRIX));
      return;
    }
    setIsLoading(true);
    try {
      const res = await apiRequest<{ matrix: RolePermissionMatrix }>("/api/roles/permissions");
      if (res.matrix) {
        setMatrix(res.matrix);
      }
    } catch {
      // Fall back to default matrix if server matrix cannot be loaded
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void reloadMatrix();
  }, [reloadMatrix]);

  const can = useCallback(
    (module: PermissionModule, action: PermissionAction = "view"): boolean => {
      if (role === "admin") return true;
      const fromUser = user?.permissions?.[module]?.[action];
      if (typeof fromUser === "boolean") return fromUser;
      return Boolean(matrix[role]?.[module]?.[action]);
    },
    [matrix, role, user?.permissions]
  );

  const persistMatrix = useCallback(
    async (next: RolePermissionMatrix, prev: RolePermissionMatrix) => {
      setMatrix(next);
      try {
        await apiRequest<{ ok: boolean }>("/api/roles/permissions", {
          method: "PUT",
          body: { matrix: next },
        });
        await refreshUser();
      } catch (err) {
        setMatrix(prev);
        throw err;
      }
    },
    [refreshUser]
  );

  const setPermission = useCallback(
    async (targetRole: AppRole, module: PermissionModule, action: PermissionAction, allowed: boolean) => {
      const prev = matrix;
      const next: RolePermissionMatrix = structuredClone(matrix);
      next[targetRole][module][action] = allowed;
      await persistMatrix(next, prev);
    },
    [matrix, persistMatrix]
  );

  const resetMatrix = useCallback(async () => {
    const prev = matrix;
    const next = structuredClone(DEFAULT_ROLE_MATRIX);
    await persistMatrix(next, prev);
  }, [matrix, persistMatrix]);

  const value = useMemo(
    () => ({ role, matrix, isLoading, can, setPermission, resetMatrix, reloadMatrix }),
    [role, matrix, isLoading, can, setPermission, resetMatrix, reloadMatrix]
  );

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error("usePermissions must be used within a PermissionsProvider");
  return ctx;
}
