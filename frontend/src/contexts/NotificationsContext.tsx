import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { apiRequest } from '@/lib/api-client';
import { useAuth } from './AuthContext';
import { useInventory } from './InventoryContext';
import { usePurchases } from './PurchasesContext';
import { useSettings } from './SettingsContext';

export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationKind = 'low_stock' | 'po_overdue' | 'bill_overdue' | 'bill_mismatch' | 'in_transit';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  link?: string;
  at: string;
}

interface NotificationsContextType {
  notifications: AppNotification[];
  unreadCount: number;
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  restoreDismissed: () => void;
  dismissedCount: number;
}

const NotificationsContext = createContext<NotificationsContextType | undefined>(undefined);


const daysSince = (iso?: string) => {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
};

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { products, branchProducts, transfers } = useInventory();
  const { purchaseOrders, bills, billBalance } = usePurchases();
  const { settings } = useSettings();

  const { user } = useAuth();
  const [read, setReadState] = useState<string[]>([]);
  const [dismissed, setDismissedState] = useState<string[]>([]);

  useEffect(() => {
    if (!user) {
      setReadState([]);
      setDismissedState([]);
      return;
    }
    let cancelled = false;
    apiRequest<{ preferences: { preferencesJson?: Record<string, unknown> } | null }>('/api/settings/preferences')
      .then((res) => {
        if (cancelled) return;
        const notifState = res.preferences?.preferencesJson?.notificationsState as
          | { read?: string[]; dismissed?: string[] }
          | undefined;
        if (Array.isArray(notifState?.read)) setReadState(notifState.read);
        if (Array.isArray(notifState?.dismissed)) setDismissedState(notifState.dismissed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  const persistNotifState = useCallback(
    (nextRead: string[], nextDismissed: string[]) => {
      if (!user) return;
      void apiRequest('/api/settings/preferences', {
        method: 'PUT',
        body: {
          preferencesJson: {
            notificationsState: { read: nextRead, dismissed: nextDismissed },
          },
        },
      }).catch(() => {});
    },
    [user]
  );

  const setRead = useCallback(
    (updater: (prev: string[]) => string[]) => {
      setReadState((prev) => {
        const next = updater(prev);
        persistNotifState(next, dismissed);
        return next;
      });
    },
    [dismissed, persistNotifState]
  );

  const setDismissed = useCallback(
    (updater: string[] | ((prev: string[]) => string[])) => {
      setDismissedState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        persistNotifState(read, next);
        return next;
      });
    },
    [read, persistNotifState]
  );

  const derived = useMemo<AppNotification[]>(() => {
    const out: AppNotification[] = [];
    const threshold = settings.lowStockThreshold;
    const now = new Date().toISOString();

    // Low stock — general pool
    products.forEach(p => {
      if (p.quantity <= threshold) {
        out.push({
          id: `low_stock:product:${p.productId}`,
          kind: 'low_stock',
          severity: p.quantity === 0 ? 'critical' : 'warning',
          title: `${p.product_name} is low on stock`,
          description: `${p.quantity} left in the general pool (threshold ${threshold}) · SKU ${p.product_sku}`,
          link: '/products',
          at: now,
        });
      }
    });

    // Low stock — per branch allocation
    branchProducts.forEach(bp => {
      if (bp.quantity <= threshold) {
        out.push({
          id: `low_stock:branch:${bp.branchId}:${bp.productId}`,
          kind: 'low_stock',
          severity: bp.quantity === 0 ? 'critical' : 'warning',
          title: `${bp.product_name} is low at a branch`,
          description: `${bp.quantity} left allocated to branch #${bp.branchId} (threshold ${threshold})`,
          link: `/branches/${bp.branchId}`,
          at: now,
        });
      }
    });

    // POs past expected date
    const today = new Date().toISOString().split('T')[0];
    purchaseOrders.forEach(po => {
      if (po.status !== 'Issued' && po.status !== 'Partially Received') return;
      if (!po.expectedDate || po.expectedDate >= today) return;
      out.push({
        id: `po_overdue:${po.id}`,
        kind: 'po_overdue',
        severity: 'warning',
        title: `${po.poNumber} is past its expected date`,
        description: `${po.vendorName} · expected ${po.expectedDate} · ${daysSince(po.expectedDate)} day(s) late · status ${po.status}`,
        link: `/purchases/orders/${po.id}`,
        at: po.expectedDate,
      });
    });

    // Bills overdue / mismatched
    bills.forEach(bill => {
      const balance = billBalance(bill);
      if (bill.status !== 'Cancelled' && balance > 0.005 && bill.dueDate && bill.dueDate < today) {
        out.push({
          id: `bill_overdue:${bill.id}`,
          kind: 'bill_overdue',
          severity: 'critical',
          title: `${bill.billNumber} is overdue`,
          description: `${bill.vendorName} · due ${bill.dueDate} · outstanding ${balance.toFixed(2)}`,
          link: '/purchases/bills',
          at: bill.dueDate,
        });
      }
      if (bill.matchStatus && bill.matchStatus !== 'matched') {
        out.push({
          id: `bill_mismatch:${bill.id}`,
          kind: 'bill_mismatch',
          severity: 'warning',
          title: `${bill.billNumber} failed 3-way match`,
          description: `${bill.vendorName} · ${bill.matchStatus.replace('_', ' ')}${bill.matchNotes?.length ? ` · ${bill.matchNotes[0]}` : ''}`,
          link: '/purchases/bills',
          at: bill.billDate,
        });
      }
    });

    // In-transit transfers
    transfers.forEach(tr => {
      if (tr.status !== 'In Transit') return;
      out.push({
        id: `in_transit:${tr.id}`,
        kind: 'in_transit',
        severity: 'info',
        title: `${tr.reference} is in transit`,
        description: `${tr.sourceBranchName} → ${tr.destBranchName} · dispatched ${daysSince(tr.dispatchedAt)} day(s) ago`,
        link: `/inventory/transfers/${tr.id}`,
        at: tr.dispatchedAt ?? tr.createdAt,
      });
    });

    const severityRank: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return out.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.at.localeCompare(a.at));
  }, [products, branchProducts, transfers, purchaseOrders, bills, billBalance, settings.lowStockThreshold]);

  const notifications = useMemo(
    () => derived.filter(n => !dismissed.includes(n.id)),
    [derived, dismissed],
  );

  const isRead = useCallback((id: string) => read.includes(id), [read]);
  const markRead = useCallback((id: string) => {
    setRead(prev => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const markAllRead = useCallback(() => {
    setRead(prev => Array.from(new Set([...prev, ...notifications.map(n => n.id)])));
  }, [notifications]);
  const dismiss = useCallback((id: string) => {
    setDismissed(prev => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const restoreDismissed = useCallback(() => setDismissed([]), []);

  const unreadCount = useMemo(
    () => notifications.filter(n => !read.includes(n.id)).length,
    [notifications, read],
  );

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      isRead,
      markRead,
      markAllRead,
      dismiss,
      restoreDismissed,
      dismissedCount: dismissed.length,
    }),
    [notifications, unreadCount, isRead, markRead, markAllRead, dismiss, restoreDismissed, dismissed.length],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider');
  return ctx;
}