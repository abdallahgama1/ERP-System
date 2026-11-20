import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, buildApiUrl } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { queryKeysForServerEvent } from "@/hooks/queries/queryKeys";

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
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [branches, setBranches] = useState<ErpBranch[]>([]);
  const [directoryBranches, setDirectoryBranches] = useState<ErpBranch[]>([]);
  const [activeBranchId, setActiveBranchIdState] = useState<string | "all">("all");
  const [isLoading, setIsLoading] = useState(false);

  const canViewAllBranches = user?.role === "admin" || user?.branchScopeMode === "all";

  const refreshBranches = useCallback(async () => {
    if (!user) {
      setBranches([]);
      setDirectoryBranches([]);
      setActiveBranchIdState("all");
      return;
    }

    setIsLoading(true);
    try {
      const [accessibleRes, dirRes, prefRes] = await Promise.all([
        apiRequest<{ branches: ErpBranch[] }>("/api/branches"),
        apiRequest<{ branches: ErpBranch[] }>("/api/branches?scope=directory"),
        apiRequest<{ preferences: { activeBranchId?: string | null } }>("/api/settings/preferences").catch(() => ({
          preferences: { activeBranchId: null },
        })),
      ]);

      const accessible = accessibleRes.branches ?? [];
      setBranches(accessible);
      setDirectoryBranches(dirRes.branches ?? accessible);

      const savedId = prefRes.preferences?.activeBranchId ?? user.defaultBranchId ?? null;
      if (savedId && accessible.some((b) => b.id === savedId)) {
        setActiveBranchIdState(savedId);
      } else if (user.role === "admin" || user.branchScopeMode === "all") {
        setActiveBranchIdState("all");
      } else {
        setActiveBranchIdState(accessible[0]?.id ?? "all");
      }
    } catch {
      // Retain existing branch list on transient network error
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refreshBranches();
  }, [refreshBranches]);

  // Subscribe to server-sent live update events
  useEffect(() => {
    if (!user) return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(buildApiUrl("/api/events"), { withCredentials: true });
      source.addEventListener("erp_update", (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as { type?: string; payload?: Record<string, unknown> };
          if (parsed.type === "branches_updated" || parsed.type === "users_updated") {
            void refreshBranches();
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
  }, [user, refreshBranches, queryClient]);

  const setActiveBranchId = useCallback(
    async (branchId: string | "all") => {
      if (branchId === "all" && !canViewAllBranches) {
        return;
      }
      setActiveBranchIdState(branchId);
      try {
        await apiRequest("/api/settings/preferences", {
          method: "PUT",
          body: { activeBranchId: branchId === "all" ? null : branchId },
        });
      } catch {
        // local state stays responsive
      }
    },
    [canViewAllBranches]
  );

  const activeBranch = useMemo(
    () => (activeBranchId === "all" ? null : branches.find((b) => b.id === activeBranchId) ?? null),
    [branches, activeBranchId]
  );

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
