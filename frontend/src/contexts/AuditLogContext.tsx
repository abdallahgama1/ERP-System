import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
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
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadEntries = useCallback(async () => {
    if (!user) {
      setEntries([]);
      return;
    }
    setIsLoading(true);
    try {
      const res = await apiRequest<{ entries: AuditEntry[] }>("/api/audit-logs?limit=250");
      setEntries(res.entries ?? []);
    } catch {
      // ignore if role doesn't have reports.view yet
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    const onServerEvent = () => {
      void loadEntries();
    };
    window.addEventListener("erp:server-event", onServerEvent);
    return () => window.removeEventListener("erp:server-event", onServerEvent);
  }, [loadEntries]);

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
      setEntries((prev) => [optimistic, ...prev].slice(0, 500));

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
      }).catch(() => {
        // non-blocking client audit write
      });
    },
    [user]
  );

  const value = useMemo(
    () => ({ entries, isLoading, record, refresh: loadEntries }),
    [entries, isLoading, record, loadEntries]
  );

  return <AuditLogContext.Provider value={value}>{children}</AuditLogContext.Provider>;
}

export function useAuditLog() {
  const ctx = useContext(AuditLogContext);
  if (!ctx) throw new Error("useAuditLog must be used within an AuditLogProvider");
  return ctx;
}
