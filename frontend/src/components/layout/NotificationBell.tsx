import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useNotificationMutations,
  useNotificationsQuery,
} from "@/hooks/queries/useNotificationsQueries";

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useNotificationsQuery({ limit: 20 });
  const { markRead, markAllRead } = useNotificationMutations();

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  const top = notifications.slice(0, 6);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={t("notifications.title", "Notifications")}>
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -end-1 h-5 min-w-5 justify-center rounded-full px-1 text-[10px]"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          {t("notifications.title", "Notifications")}
          {unreadCount > 0 && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => markAllRead.mutate(undefined)}
              disabled={markAllRead.isPending}
            >
              {t("notifications.markAllRead", "Mark all read")}
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {top.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t("notifications.empty", "You're all caught up")}
          </p>
        ) : (
          top.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="flex flex-col items-start gap-0.5"
              onSelect={() => {
                if (!n.isRead) {
                  markRead.mutate(n.id);
                }
                if (n.link) navigate(n.link);
              }}
            >
              <span className="flex w-full items-center gap-2 text-sm font-medium">
                {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                <span className="truncate">{n.title}</span>
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{n.description}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/notifications" className="w-full justify-center text-sm">
            {t("notifications.viewAll", "View all notifications")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}