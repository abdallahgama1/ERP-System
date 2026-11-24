import type { ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import type { AppRole, PermissionAction, PermissionModule } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface RequirePermissionProps {
  module?: PermissionModule;
  action?: PermissionAction;
  roles?: AppRole[];
  mode?: "hide" | "page";
  fallback?: ReactNode;
  redirectTo?: string;
  children: ReactNode;
}

export function RequirePermission({
  module,
  action = "view",
  roles,
  mode = "hide",
  fallback,
  redirectTo,
  children,
}: RequirePermissionProps) {
  const { t } = useTranslation();
  const { user, isLoading } = useAuth();
  const { role, can } = usePermissions();

  if (isLoading) {
    if (mode === "page") {
      return (
        <div className="min-h-screen flex">
          <aside className="hidden md:flex w-64 border-e bg-sidebar p-4 flex-col gap-3">
            <Skeleton className="h-8 w-32" />
            <div className="mt-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          </aside>
          <main className="flex-1 p-6 space-y-4">
            <Skeleton className="h-10 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mt-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
            <Skeleton className="h-64 w-full mt-6" />
          </main>
        </div>
      );
    }
    return null;
  }

  if (!user) {
    if (mode === "page") {
      return <Navigate to="/login" replace />;
    }
    return fallback !== undefined ? <>{fallback}</> : null;
  }

  const roleAllowed = roles ? roles.includes(role) : true;
  const moduleAllowed = module ? can(module, action) : true;

  if (!roleAllowed || !moduleAllowed) {
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }
    if (redirectTo) {
      return <Navigate to={redirectTo} replace />;
    }
    if (mode === "page") {
      return (
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <Card className="w-full max-w-md text-center" role="alert" data-testid="access-denied-card">
            <CardHeader className="items-center space-y-2">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <ShieldAlert className="h-6 w-6" aria-hidden="true" />
              </div>
              <CardTitle>
                403 — {t("common.accessDenied", "Access Denied")}
              </CardTitle>
              <CardDescription>
                {t("common.accessDeniedDescription", "You do not have permission to view this page.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/">{t("common.backToDashboard", "Back to Dashboard")}</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }
    return null;
  }

  return <>{children}</>;
}
