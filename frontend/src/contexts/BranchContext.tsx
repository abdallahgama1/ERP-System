import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, buildApiUrl } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { erpQueryKeys, queryKeysForServerEvent } from "@/hooks/queries/queryKeys";
import { usePreferencesQuery, type UserPreferencesPayload } from "@/hooks/queries/useSettingsQueries";

export interface ErpBranch {
  id: string;
  code: string;
  name: string;
  branchType: "hq_warehouse" | "warehouse" | "retail";
  location: string;
  address?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  etaBranchId?: string;
  country?: string;
  governorate?: string;
  regionCity?: string;
  street?: string;
  buildingNumber?: string;
  postalCode?: string;
  isDefault: boolean;
  isActive: boolean;
}

interface BranchContextType {
  branches: ErpBranch[];
  directoryBranches: ErpBranch[];
  activeBranchId: string | "all";
  activeBranch: ErpBranch | null;
  canViewAllBranches: boolean;
  isLoading: boolean;
  setActiveBranchId: (branchId: string | "all") => Promise<void>;
  refreshBranches: () => Promise<void>;
}

const BranchContext = createContext<BranchContextType | undefined>(undefined);

export function BranchProvider({ children }: { children: React.ReactNode }) {
  const { user, activeCompanyId, refreshUser } = useAuth();
  const queryClient = useQueryClient();

  const [activeBranchIdOverride, setActiveBranchIdOverride] = useState<{
    userId: string;
    companyId: string;
    branchId: string | "all";
  } | null>(null);

  const canViewAllBranches = user?.role === "admin" || user?.branchScopeMode === "all";

  const branchesQuery = useQuery({
    queryKey: erpQueryKeys.branches,
    queryFn: () => apiRequest<{ branches: ErpBranch[] }>("/api/branches"),
    enabled: Boolean(user),
    staleTime: 60_000,
  });

  const directoryQuery = useQuery({
    queryKey: erpQueryKeys.branchesDirectory,
    queryFn: () => apiRequest<{ branches: ErpBranch[] }>("/api/branches?scope=directory"),
    enabled: false,
    staleTime: 60_000,
  });

  const preferencesQuery = usePreferencesQuery(Boolean(user));

  const branches = useMemo(() => (user ? (branchesQuery.data?.branches ?? []) : []), [user, branchesQuery.data]);

  const directoryBranches = useMemo(() => {
    if (!user) return [];
    if (canViewAllBranches) {
      return branches.filter((b) => b.isActive !== false);
    }
    return directoryQuery.data?.branches ?? branches;
  }, [user, canViewAllBranches, branches, directoryQuery.data]);

  // Seed erpQueryKeys.branchesDirectory when canViewAllBranches so downstream directory consumers share cache without an extra GET
  useEffect(() => {
    if (user && canViewAllBranches && branchesQuery.data) {
      queryClient.setQueryData(erpQueryKeys.branchesDirectory, {
        branches: (branchesQuery.data.branches ?? []).filter((b) => b.isActive !== false),
      });
    }
  }, [user, canViewAllBranches, branchesQuery.data, queryClient]);

  const activeBranchId = useMemo<string | "all">(() => {
    if (!user) return "all";
    if (
      activeBranchIdOverride &&
      activeBranchIdOverride.userId === user.id &&
      activeBranchIdOverride.companyId === activeCompanyId
    ) {
      return activeBranchIdOverride.branchId;
    }
    const savedId = preferencesQuery.data?.preferences?.activeBranchId ?? user.defaultBranchId ?? null;
    if (savedId && branches.some((b) => b.id === savedId)) {
      return savedId;
    }
    if (canViewAllBranches) {
      return "all";
    }
    return branches[0]?.id ?? "all";
  }, [user, activeCompanyId, activeBranchIdOverride, preferencesQuery.data, branches, canViewAllBranches]);

  const refreshBranches = useCallback(async () => {
    if (!user) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.branches }),
      ...(!canViewAllBranches ? [queryClient.invalidateQueries({ queryKey: erpQueryKeys.branchesDirectory })] : []),
    ]);
  }, [user, canViewAllBranches, queryClient]);

  // Subscribe to server-sent live update events
  useEffect(() => {
    if (!user) return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(buildApiUrl("/api/events"), { withCredentials: true });
      source.addEventListener("erp_update", (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as { type?: string; payload?: Record<string, unknown> };
          if (
            parsed.type === "permissions_updated" ||
            parsed.type === "custom_roles_updated" ||
            parsed.type === "roles_updated" ||
            parsed.type === "companies_updated" ||
            parsed.type === "users_updated"
          ) {
            void refreshUser();
          }
          const targets = queryKeysForServerEvent(parsed.type);
          if (targets.length > 0) {
            for (const queryKey of targets) {
              void queryClient.invalidateQueries({ queryKey });
            }
          } else {
            void queryClient.invalidateQueries();
          }
          window.dispatchEvent(new CustomEvent("erp:server-event", { detail: parsed }));
        } catch {
          // ignore malformed SSE event
        }
      });
    } catch {
      // ignore SSE unsupported error
    }

    return () => {
      source?.close();
    };
  }, [user, queryClient, refreshUser]);

  const setActiveBranchId = useCallback(
    async (branchId: string | "all") => {
      if (!user) return;
      if (branchId === "all" && !canViewAllBranches) {
        return;
      }
      setActiveBranchIdOverride({ userId: user.id, companyId: activeCompanyId, branchId });
      queryClient.setQueryData<UserPreferencesPayload>(erpQueryKeys.preferences, (prev) => ({
        preferences: {
          ...(prev?.preferences ?? {}),
          activeBranchId: branchId === "all" ? null : branchId,
        },
      }));
      try {
        await apiRequest("/api/settings/preferences", {
          method: "PUT",
          body: { activeBranchId: branchId === "all" ? null : branchId },
        });
      } catch {
        // local state stays responsive
      }
    },
    [user, activeCompanyId, canViewAllBranches, queryClient]
  );

  const activeBranch = useMemo(
    () => (activeBranchId === "all" ? null : branches.find((b) => b.id === activeBranchId) ?? null),
    [branches, activeBranchId]
  );

  const isLoading = Boolean(user) && (branchesQuery.isLoading || (!canViewAllBranches && directoryQuery.isLoading));

  const value = useMemo(
    () => ({
      branches,
      directoryBranches,
      activeBranchId,
      activeBranch,
      canViewAllBranches,
      isLoading,
      setActiveBranchId,
      refreshBranches,
    }),
    [
      branches,
      directoryBranches,
      activeBranchId,
      activeBranch,
      canViewAllBranches,
      isLoading,
      setActiveBranchId,
      refreshBranches,
    ]
  );

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch() {
  const ctx = useContext(BranchContext);
  if (!ctx) {
    throw new Error("useBranch must be used within a BranchProvider");
  }
  return ctx;
}
