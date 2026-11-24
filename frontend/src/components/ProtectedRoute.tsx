import type { ReactNode } from "react";
import type { AppRole, PermissionAction, PermissionModule } from "@erp/shared";
import { RequirePermission } from "@/components/auth/RequirePermission";

export interface ProtectedRouteProps {
  children: ReactNode;
  requiredModule?: PermissionModule;
  requiredAction?: PermissionAction;
  requiredRoles?: AppRole[];
  fallback?: ReactNode;
  redirectTo?: string;
}

export function ProtectedRoute({
  children,
  requiredModule,
  requiredAction = "view",
  requiredRoles,
  fallback,
  redirectTo = "/",
}: ProtectedRouteProps) {
  return (
    <RequirePermission
      module={requiredModule}
      action={requiredAction}
      roles={requiredRoles}
      mode="page"
      fallback={fallback}
      redirectTo={redirectTo || undefined}
    >
      {children}
    </RequirePermission>
  );
}
