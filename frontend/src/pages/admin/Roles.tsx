import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lock, Plus, Save, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  APP_ROLES,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  buildEmptyPermissionRecord,
  normalizeRolePermissionsMap,
  type AppRole,
  type CustomRoleDto,
  type PermissionAction,
  type PermissionMap,
  type PermissionModule,
} from "@erp/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useCustomRoleMutations, useCustomRolesQuery } from "@/hooks/queries/useCustomRolesQueries";

export default function Roles() {
  const { t } = useTranslation();
  const { role: currentUserRole, can } = usePermissions();
  const rolesQuery = useCustomRolesQuery();
  const { createCustomRole, updateCustomRole, deleteCustomRole } = useCustomRoleMutations();

  const roles = useMemo(() => rolesQuery.data?.roles ?? [], [rolesQuery.data?.roles]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftBaseRole, setDraftBaseRole] = useState<AppRole>("user");
  const [draftPerms, setDraftPerms] = useState<PermissionMap>(() => buildEmptyPermissionRecord());
  const [dirty, setDirty] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBaseRole, setNewBaseRole] = useState<AppRole>("user");
  const [newPerms, setNewPerms] = useState<PermissionMap>(() => buildEmptyPermissionRecord());

  const [deleteTarget, setDeleteTarget] = useState<CustomRoleDto | null>(null);

  const canCreate = can("roles", "create");
  const canEdit = can("roles", "edit");
  const canDelete = can("roles", "delete");

  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? roles[0] ?? null;

  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRole) return;
    setDraftName(selectedRole.name);
    setDraftDesc(selectedRole.description ?? "");
    setDraftBaseRole(selectedRole.baseRole);
    setDraftPerms(normalizeRolePermissionsMap(selectedRole.permissions));
    setDirty(false);
  }, [selectedRole]);

  const isLockedAdminPreset = Boolean(selectedRole?.isSystem && selectedRole.name.toLowerCase() === "admin");

  const toggleDraftPerm = (mod: PermissionModule, action: PermissionAction, allowed: boolean) => {
    if (!canEdit || isLockedAdminPreset) return;
    setDraftPerms((prev) => ({
      ...prev,
      [mod]: { ...prev[mod], [action]: allowed },
    }));
    setDirty(true);
  };

  const handleSaveRole = async () => {
    if (!selectedRole || !canEdit || isLockedAdminPreset) return;
    try {
      await updateCustomRole.mutateAsync({
        id: selectedRole.id,
        body: {
          ...(selectedRole.isSystem ? {} : { name: draftName.trim(), baseRole: draftBaseRole }),
          description: draftDesc.trim(),
          permissions: draftPerms,
        },
      });
      setDirty(false);
      toast.success(t("roles.saved", "Role permissions updated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      toast.error(t("roles.nameRequired", "Role name is required"));
      return;
    }
    try {
      const res = await createCustomRole.mutateAsync({
        name: newName.trim(),
        description: newDesc.trim(),
        baseRole: newBaseRole,
        permissions: newPerms,
      });
      toast.success(t("roles.created", "Custom role created"));
      setCreateOpen(false);
      setNewName("");
      setNewDesc("");
      setNewBaseRole("user");
      setNewPerms(buildEmptyPermissionRecord());
      setSelectedRoleId(res.role.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleDeleteRole = async () => {
    if (!deleteTarget) return;
    try {
      await deleteCustomRole.mutateAsync(deleteTarget.id);
      toast.success(t("roles.deleted", "Custom role deleted"));
      if (selectedRoleId === deleteTarget.id) {
        setSelectedRoleId(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="h-7 w-7" />
            {t("roles.title", "Roles & Permissions")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "roles.description",
              "Manage system role presets and custom roles with granular 21-module permissions."
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("users", "view") && (
            <Button asChild variant="outline" size="sm">
              <Link to="/users">{t("roles.assignRoles", "Assign roles to users")}</Link>
            </Button>
          )}
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="create-custom-role-btn">
              <Plus className="h-4 w-4 me-2" />
              {t("roles.createCustomRole", "Create Custom Role")}
            </Button>
          )}
        </div>
      </div>

      {!canEdit && (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>{t("roles.readOnly", "Read-only")}</AlertTitle>
          <AlertDescription>
            {t("roles.readOnlyDescription", "You do not have permission to edit roles. Your current role is")}{" "}
            <Badge variant="secondary">{currentUserRole}</Badge>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Role List */}
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle className="text-base">{t("roles.directory", "Company Roles")}</CardTitle>
            <CardDescription>
              {t("roles.directoryDesc", "8 system presets plus any custom roles configured for this company.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {rolesQuery.isLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t("common.loading")}</p>
            ) : (
              roles.map((r) => {
                const isSelected = selectedRole?.id === r.id;
                return (
                  <div
                    key={r.id}
                    className={`flex items-center justify-between gap-2 rounded-md border p-3 cursor-pointer transition-colors ${
                      isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                    }`}
                    onClick={() => setSelectedRoleId(r.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedRoleId(r.id);
                      }
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{r.name}</span>
                        {r.isSystem ? (
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <Lock className="h-2.5 w-2.5" />
                            {t("roles.system", "System")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            {t("roles.custom", "Custom")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                        {t("roles.baseRole", "Base")}: {r.baseRole}
                      </p>
                    </div>
                    {!r.isSystem && canDelete && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        aria-label={t("common.delete", "Delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(r);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Right Permission Matrix Editor */}
        <Card className="lg:col-span-8">
          {selectedRole ? (
            <>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
                <div className="space-y-1 flex-1 min-w-[200px]">
                  <CardTitle className="flex items-center gap-2 flex-wrap">
                    <span>{selectedRole.name}</span>
                    {isLockedAdminPreset && (
                      <Badge variant="outline" className="gap-1">
                        <Lock className="h-3 w-3" />
                        {t("roles.locked", "Full access")}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>{selectedRole.description || t("roles.noDescription", "Custom role")}</CardDescription>
                </div>
                {canEdit && !isLockedAdminPreset && (
                  <Button
                    size="sm"
                    disabled={!dirty || updateCustomRole.isPending}
                    onClick={() => void handleSaveRole()}
                  >
                    <Save className="h-4 w-4 me-2" />
                    {t("common.save", "Save Changes")}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {!selectedRole.isSystem && canEdit && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="edit-role-name">{t("common.name", "Name")}</Label>
                      <Input
                        id="edit-role-name"
                        value={draftName}
                        onChange={(e) => {
                          setDraftName(e.target.value);
                          setDirty(true);
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="edit-role-desc">{t("common.description", "Description")}</Label>
                      <Input
                        id="edit-role-desc"
                        value={draftDesc}
                        onChange={(e) => {
                          setDraftDesc(e.target.value);
                          setDirty(true);
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>{t("roles.baseRole", "Base Role")}</Label>
                      <Select
                        value={draftBaseRole}
                        onValueChange={(v) => {
                          setDraftBaseRole(v as AppRole);
                          setDirty(true);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APP_ROLES.map((r) => (
                            <SelectItem key={r} value={r} className="capitalize">
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto">
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
                      {PERMISSION_MODULES.map((mod) => (
                        <TableRow key={mod}>
                          <TableCell className="font-medium capitalize">
                            {t(`roles.modules.${mod}`, mod)}
                          </TableCell>
                          {PERMISSION_ACTIONS.map((action) => (
                            <TableCell key={action} className="text-center">
                              <Checkbox
                                checked={Boolean(draftPerms[mod]?.[action])}
                                disabled={!canEdit || isLockedAdminPreset}
                                aria-label={`${selectedRole.name} ${mod} ${action}`}
                                onCheckedChange={(checked) => toggleDraftPerm(mod, action, checked === true)}
                              />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="py-12 text-center text-muted-foreground">
              {t("roles.selectPrompt", "Select a role to view or edit permissions.")}
            </CardContent>
          )}
        </Card>
      </div>

      {/* Create Custom Role Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("roles.createCustomRole", "Create Custom Role")}</DialogTitle>
            <DialogDescription>
              {t("roles.createDesc", "Define a named role and choose granular permissions across all modules.")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateRole} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="new-role-name">{t("common.name", "Role Name")}</Label>
                <Input
                  id="new-role-name"
                  placeholder="Inventory Auditor"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-role-desc">{t("common.description", "Description")}</Label>
                <Input
                  id="new-role-desc"
                  placeholder="Read-only stock and audit access"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("roles.baseRole", "Base Role")}</Label>
                <Select value={newBaseRole} onValueChange={(v) => setNewBaseRole(v as AppRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APP_ROLES.map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="overflow-x-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("roles.module", "Module")}</TableHead>
                    {PERMISSION_ACTIONS.map((action) => (
                      <TableHead key={action} className="text-center capitalize">
                        {action}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {PERMISSION_MODULES.map((mod) => (
                    <TableRow key={mod}>
                      <TableCell className="font-medium capitalize">{mod}</TableCell>
                      {PERMISSION_ACTIONS.map((action) => (
                        <TableCell key={action} className="text-center">
                          <Checkbox
                            checked={Boolean(newPerms[mod]?.[action])}
                            aria-label={`new-role ${mod} ${action}`}
                            onCheckedChange={(checked) =>
                              setNewPerms((prev) => ({
                                ...prev,
                                [mod]: { ...prev[mod], [action]: checked === true },
                              }))
                            }
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={createCustomRole.isPending}>
                {t("roles.createRole", "Create Role")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => void handleDeleteRole()}
        title={t("roles.deleteTitle", "Delete Custom Role")}
        itemName={deleteTarget?.name}
      />
    </div>
  );
}
