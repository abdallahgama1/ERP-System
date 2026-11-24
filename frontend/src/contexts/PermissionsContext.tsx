import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { UNSAFE_LocationContext } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { erpQueryKeys } from "@/hooks/queries/queryKeys";

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
  const queryClient = useQueryClient();
  const locationCtx = useContext(UNSAFE_LocationContext);
  const pathname =
    locationCtx?.location?.pathname ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const isRolesRoute = pathname === "/roles" || pathname.startsWith("/roles/");

  const role: AppRole = user?.role ?? "user";
  const [matrixOverride, setMatrixOverride] = useState<RolePermissionMatrix | null>(null);

  const canViewRoles = role === "admin" || Boolean(user?.permissions?.roles?.view);
  const shouldFetchMatrix = Boolean(user) && canViewRoles && (isRolesRoute || !user?.permissions);

  const matrixQuery = useQuery({
    queryKey: erpQueryKeys.permissions,
    queryFn: () => apiRequest<{ matrix: RolePermissionMatrix }>("/api/roles/permissions"),
    enabled: shouldFetchMatrix,
    staleTime: 60_000,
  });

  useEffect(() => {
    setMatrixOverride(null);
  }, [user?.id, user?.activeCompanyId]);

  const matrix = useMemo<RolePermissionMatrix>(() => {
    if (matrixOverride) return matrixOverride;
    if (matrixQuery.data?.matrix) return matrixQuery.data.matrix;
    return structuredClone(DEFAULT_ROLE_MATRIX);
  }, [matrixOverride, matrixQuery.data]);

  const reloadMatrix = useCallback(async () => {
    if (!user) {
      setMatrixOverride(null);
      return;
    }
    try {
      const res = await queryClient.fetchQuery({
        queryKey: erpQueryKeys.permissions,
        queryFn: () => apiRequest<{ matrix: RolePermissionMatrix }>("/api/roles/permissions"),
        staleTime: 0,
      });
      if (res.matrix) {
        setMatrixOverride(res.matrix);
      }
    } catch {
      // Fall back to default matrix if server matrix cannot be loaded
    }
  }, [user, queryClient]);

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
      setMatrixOverride(next);
      try {
        await apiRequest<{ ok: boolean }>("/api/roles/permissions", {
          method: "PUT",
          body: { matrix: next },
        });
        queryClient.setQueryData(erpQueryKeys.permissions, { matrix: next });
        await refreshUser();
      } catch (err) {
        setMatrixOverride(prev);
        throw err;
      }
    },
    [queryClient, refreshUser]
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

  const isLoading = Boolean(user) && shouldFetchMatrix && matrixQuery.isLoading;

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
