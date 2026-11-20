import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lock, RotateCcw, Shield } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  APP_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  usePermissions,
  type AppRole,
  type PermissionAction,
  type PermissionModule,
} from "@/contexts/PermissionsContext";
import { useAuditLog } from "@/contexts/AuditLogContext";
import { useAuth } from "@/contexts/AuthContext";

export default function Roles() {
  const { t } = useTranslation();
  const { matrix, role, setPermission, resetMatrix } = usePermissions();
  const { record } = useAuditLog();
  const { user } = useAuth();

  const canEdit = role === "admin";

  const toggle = async (
    targetRole: AppRole,
    module: PermissionModule,
    action: PermissionAction,
    allowed: boolean
  ) => {
    if (!canEdit) return;
    if (targetRole === "admin") {
      toast.error(t("roles.adminLocked", "The admin role always keeps full access."));
      return;
    }
    try {
      await setPermission(targetRole, module, action, allowed);
      record("settings", allowed ? "permission.granted" : "permission.revoked", {
        entity: `${targetRole}/${module}`,
        user: user?.name,
        meta: { action },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleReset = async () => {
    try {
      await resetMatrix();
      record("settings", "permission.reset", { user: user?.name });
      toast.success(t("roles.reset", "Permissions reset to defaults"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-7 w-7" />
            {t("roles.title", "Roles & permissions")}
          </h1>
          <p className="text-muted-foreground">
            {t("roles.description", "Control what each role can view, create, edit, delete, and approve per module.")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/users">{t("roles.assignRoles", "Assign roles to users")}</Link>
          </Button>
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={handleReset}>
            <RotateCcw className="h-4 w-4 me-2" />
            {t("roles.resetDefaults", "Reset to defaults")}
          </Button>
        </div>
      </div>

      {!canEdit && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>{t("roles.readOnly", "Read-only")}</AlertTitle>
          <AlertDescription>
            {t("roles.readOnlyDescription", "Only administrators can change permissions. Your current role is")}{" "}
            <Badge variant="secondary">{role}</Badge>
          </AlertDescription>
        </Alert>
      )}

      {APP_ROLES.map((targetRole) => (
        <Card key={targetRole}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 capitalize">
              {t(`roles.role.${targetRole}`, targetRole)}
              {targetRole === "admin" && (
                <Badge variant="outline" className="gap-1">
                  <Lock className="h-3 w-3" />
                  {t("roles.locked", "Full access")}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {t(
                `roles.roleDescription.${targetRole}`,
                targetRole === "admin"
                  ? "Unrestricted access to every module."
                  : targetRole === "manager"
                    ? "Runs day-to-day operations; limited access to user administration."
                    : "Operational access focused on counting, sales, and reading data."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("roles.module", "Module")}</TableHead>
                  {PERMISSION_ACTIONS.map((action) => (
                    <TableHead key={action} className="text-center capitalize">
                      {t(`roles.action.${action}`, action)}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {PERMISSION_MODULES.map((module) => (
                  <TableRow key={module}>
                    <TableCell className="font-medium capitalize">{t(`roles.modules.${module}`, module)}</TableCell>
                    {PERMISSION_ACTIONS.map((action) => (
                      <TableCell key={action} className="text-center">
                        <Checkbox
                          checked={Boolean(matrix[targetRole]?.[module]?.[action])}
                          disabled={!canEdit || targetRole === "admin"}
                          aria-label={`${targetRole} ${module} ${action}`}
                          onCheckedChange={(checked) => toggle(targetRole, module, action, checked === true)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
