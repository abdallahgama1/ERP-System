import React, { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";
import type { AuditEntry, AuditModule } from "@/types";

interface AuditLogContextType {
  entries: AuditEntry[];
  isLoading: boolean;
  record: (
    module: AuditModule,
    action: string,
    opts?: { entity?: string; entityId?: string | number; user?: string; branchId?: string; meta?: Record<string, unknown> }
  ) => void;
  refresh: () => Promise<void>;
}

const AuditLogContext = createContext<AuditLogContextType | undefined>(undefined);

export function AuditLogProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  }, [queryClient]);

  const record = useCallback<AuditLogContextType["record"]>(
    (module, action, opts) => {
      const optimistic: AuditEntry = {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        actorUserId: user?.id,
        module,
        action,
        entity: opts?.entity,
        entityId: opts?.entityId,
        user: opts?.user ?? user?.name ?? "System",
        meta: opts?.meta,
      };
      setEntries((prev) => [optimistic, ...prev].slice(0, 50));

      if (!user) return;
      void apiRequest("/api/audit-logs", {
        method: "POST",
        body: {
          module,
          action,
          entity: opts?.entity,
          entityId: opts?.entityId !== undefined ? String(opts.entityId) : undefined,
          branchId: opts?.branchId ?? null,
          meta: opts?.meta ?? {},
        },
      })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
        })
        .catch(() => {
          // non-blocking client audit write
        });
    },
    [queryClient, user]
  );

  const value = useMemo(
    () => ({ entries, isLoading: false, record, refresh }),
    [entries, record, refresh]
  );

  return <AuditLogContext.Provider value={value}>{children}</AuditLogContext.Provider>;
}

export function useAuditLog() {
  const ctx = useContext(AuditLogContext);
  if (!ctx) throw new Error("useAuditLog must be used within an AuditLogProvider");
  return ctx;
}
