import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Bell, CheckCheck, Clock, FileWarning, PackageMinus, Truck, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/contexts/PermissionsContext";
import {
  useNotificationMutations,
  useNotificationsQuery,
  type UiNotification,
} from "@/hooks/queries/useNotificationsQueries";
import { apiRequest } from "@/lib/api-client";
import { toast } from "sonner";

const filters = ["all", "unread", "low_stock", "overdue", "approval", "transfer"] as const;

function iconForNotification(n: UiNotification): typeof Bell {
  const lower = n.type.toLowerCase();
  if (lower.includes("stock")) return PackageMinus;
  if (lower.includes("overdue")) return AlertTriangle;
  if (lower.includes("bill") || lower.includes("invoice")) return FileWarning;
  if (lower.includes("transfer")) return Truck;
  return Bell;
}

export default function Notifications() {
  const { t } = useTranslation();
  const { data } = useNotificationsQuery({ limit: 100 });
  const { markRead, markAllRead, dismiss } = useNotificationMutations();
  const { role } = usePermissions();
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const [sweeping, setSweeping] = useState(false);

  const notifications = useMemo(() => data?.notifications ?? [], [data?.notifications]);
  const unreadCount = data?.unreadCount ?? 0;

  const handleOverdueSweep = async () => {
    setSweeping(true);
    try {
      const res = await apiRequest<{ overdueInvoicesMarked: number; overdueBillsMarked: number }>(
        "/api/admin/jobs/overdue-sweep",
        { method: "POST" }
      );
      toast.success(
        t("notifications.overdueSweepDone", {
          defaultValue: `Overdue sweep complete: ${res.overdueInvoicesMarked} invoice(s), ${res.overdueBillsMarked} bill(s) marked overdue.`,
          invoices: res.overdueInvoicesMarked,
          bills: res.overdueBillsMarked,
        })
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSweeping(false);
    }
  };

  const visible = useMemo(() => {
    if (filter === "all") return notifications;
    if (filter === "unread") return notifications.filter((n) => !n.isRead);
    return notifications.filter((n) => n.type.toLowerCase().includes(filter));
  }, [notifications, filter]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="h-7 w-7" />
            {t("notifications.title", "Notifications")}
          </h1>
          <p className="text-muted-foreground">
            {t("notifications.description", "Alerts derived from your live inventory and purchasing data.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {role === "admin" && (
            <Button variant="outline" size="sm" onClick={() => void handleOverdueSweep()} disabled={sweeping}>
              <Clock className="h-4 w-4 me-2" />
              {t("notifications.runOverdueSweep", "Run Overdue Check")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate(undefined)}
            disabled={unreadCount === 0 || markAllRead.isPending}
          >
            <CheckCheck className="h-4 w-4 me-2" />
            {t("notifications.markAllRead", "Mark all read")}
          </Button>
        </div>
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as (typeof filters)[number])}>
        <TabsList className="flex-wrap h-auto">
          {filters.map((f) => (
            <TabsTrigger key={f} value={f}>
              {t(`notifications.filter.${f}`, f.replace("_", " "))}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center space-y-2">
            <CheckCheck className="h-10 w-10 mx-auto text-muted-foreground" />
            <p className="font-medium">{t("notifications.empty", "You're all caught up")}</p>
            <p className="text-sm text-muted-foreground">
              {t("notifications.emptyDescription", "New alerts appear here as stock, orders, and bills change.")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((n) => {
            const Icon = iconForNotification(n);
            const read = n.isRead;
            return (
              <Card key={n.id} className={read ? "opacity-70" : "border-primary/40"}>
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="rounded-md bg-muted p-2">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{n.title}</span>
                      <Badge
                        variant={
                          n.severity === "destructive" ? "destructive" : n.severity === "warning" ? "secondary" : "outline"
                        }
                      >
                        {t(`notifications.severity.${n.severity}`, n.severity)}
                      </Badge>
                      {!read && <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />}
                    </div>
                    <p className="text-sm text-muted-foreground">{n.description}</p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {n.link && (
                        <Button
                          asChild
                          variant="link"
                          size="sm"
                          className="px-0"
                          onClick={() => !read && markRead.mutate(n.id)}
                        >
                          <Link to={n.link}>
                            {t("notifications.open", "Open")}
                            <ArrowRight className="h-3.5 w-3.5 ms-1" />
                          </Link>
                        </Button>
                      )}
                      {!read && (
                        <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>
                          {t("notifications.markRead", "Mark read")}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("notifications.dismiss", "Dismiss")}
                    onClick={() => dismiss.mutate(n.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("notifications.preferences", "Delivery preferences")}</CardTitle>
          <CardDescription>
            {t("notifications.preferencesDescription", "Email and in-app delivery are configured in Settings → Notifications.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">{t("notifications.openSettings", "Open settings")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
