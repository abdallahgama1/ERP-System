import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type { CursorPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export interface BackendNotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  branchId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  createdAt: string;
  readAt?: string | null;
}

export type NotificationSeverity = "info" | "warning" | "destructive";

export interface UiNotification {
  id: string;
  type: string;
  title: string;
  description: string;
  message: string;
  severity: NotificationSeverity;
  link?: string;
  branchId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
}

export function resolveNotificationLink(entityType?: string | null, entityId?: string | null): string | undefined {
  switch (entityType) {
    case "sales_invoice":
      return "/sales/invoices";
    case "vendor_bill":
      return "/purchases/bills";
    case "purchase_order":
      return entityId ? `/purchases/orders/${entityId}` : "/purchases/orders";
    case "stock_transfer":
      return entityId ? `/inventory/transfers/${entityId}` : "/inventory/transfers";
    case "approval_request":
      return "/approvals";
    case "stock_lot":
      return "/inventory/lots";
    case "pos_shift":
    case "pos_sale":
      return "/pos";
    default:
      return undefined;
  }
}

export function resolveNotificationSeverity(type: string): NotificationSeverity {
  const lower = type.toLowerCase();
  if (lower.includes("overdue") || lower.includes("expired") || lower.includes("out_of_stock") || lower.includes("rejected")) {
    return "destructive";
  }
  if (lower.includes("low_stock") || lower.includes("expir") || lower.includes("pending") || lower.includes("warning")) {
    return "warning";
  }
  return "info";
}

export function mapNotificationRow(row: BackendNotificationRow): UiNotification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.message,
    message: row.message,
    severity: resolveNotificationSeverity(row.type),
    link: resolveNotificationLink(row.entityType, row.entityId),
    branchId: row.branchId ?? null,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    createdAt: row.createdAt,
    readAt: row.readAt ?? null,
    isRead: Boolean(row.readAt),
  };
}

export interface NotificationsListResponse {
  notifications: BackendNotificationRow[];
  items?: BackendNotificationRow[];
  pageInfo?: CursorPageInfo;
}

export function useNotificationsQuery(options: { limit?: number; enabled?: boolean } = {}) {
  const { user } = useAuth();
  const limit = options.limit ?? 20;
  const enabled = options.enabled ?? true;

  return useQuery({
    queryKey: [...erpQueryKeys.notifications, "list", limit],
    queryFn: () => apiRequest<NotificationsListResponse>(`/api/notifications?limit=${limit}`),
    select: (res) => {
      const rows = res.notifications ?? res.items ?? [];
      const notifications = rows.map(mapNotificationRow);
      const unreadCount = notifications.filter((n) => !n.isRead).length;
      return {
        notifications,
        items: notifications,
        unreadCount,
        pageInfo: res.pageInfo,
      };
    },
    enabled: Boolean(user) && enabled,
    staleTime: 30_000,
  });
}

export function useNotificationsInfiniteQuery(limit = 30, enabled = true) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: [...erpQueryKeys.notifications, "infinite", limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (pageParam) params.set("cursor", pageParam);
      return apiRequest<NotificationsListResponse>(`/api/notifications?${params.toString()}`);
    },
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? (lastPage.pageInfo.nextCursor ?? undefined) : undefined,
    enabled: Boolean(user) && enabled,
  });
}

export function useMarkNotificationReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.notifications });
    },
  });
}

export function useMarkAllNotificationsReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      apiRequest<{ ok: boolean }>("/api/notifications/read-all", {
        method: "POST",
        body: ids ? { ids } : {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.notifications });
    },
  });
}

export function useDismissNotificationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/notifications/${id}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.notifications });
    },
  });
}

export function useRunOverdueSweepMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<{ ok: boolean; created?: number }>("/api/admin/jobs/overdue-sweep", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.notifications });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sales.all });
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.purchases.all });
    },
  });
}

export function useNotificationMutations() {
  const markRead = useMarkNotificationReadMutation();
  const markAllRead = useMarkAllNotificationsReadMutation();
  const dismiss = useDismissNotificationMutation();
  const runOverdueSweep = useRunOverdueSweepMutation();

  return {
    markRead,
    markAllRead,
    dismiss,
    runOverdueSweep,
  };
}
