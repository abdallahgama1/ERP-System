import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions, type AppRole, type PermissionAction, type PermissionModule } from "@/contexts/PermissionsContext";
import { Skeleton } from "@/components/ui/skeleton";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredModule?: PermissionModule;
  requiredAction?: PermissionAction;
  requiredRoles?: AppRole[];
}

export function ProtectedRoute({
  children,
  requiredModule,
  requiredAction = "view",
  requiredRoles,
}: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const { role, can } = usePermissions();

  if (isLoading) {
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

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRoles && !requiredRoles.includes(role)) {
    return <Navigate to="/" replace />;
  }

  if (requiredModule && !can(requiredModule, requiredAction)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
