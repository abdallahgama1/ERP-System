import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Search, Shield, Users as UsersIcon, Plus, Building2, KeyRound, Copy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks, useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions, type AppRole } from "@/contexts/PermissionsContext";
import { useBranch } from "@/contexts/BranchContext";
import { apiRequest } from "@/lib/api-client";
import { toast } from "sonner";

interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  isActive: boolean;
  branchScopeMode: "all" | "selected";
  branchIds: string[];
  defaultBranchId: string | null;
  createdAt: string;
}

export default function Users() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<AppRole>("user");
  const [newScopeMode, setNewScopeMode] = useState<"all" | "selected">("selected");
  const [newBranchIds, setNewBranchIds] = useState<string[]>([]);

  const [branchDialogUser, setBranchDialogUser] = useState<UserRecord | null>(null);
  const [editScopeMode, setEditScopeMode] = useState<"all" | "selected">("selected");
  const [editBranchIds, setEditBranchIds] = useState<string[]>([]);
  const [editDefaultBranchId, setEditDefaultBranchId] = useState<string>("");

  const [resetUrlDialog, setResetUrlDialog] = useState<{ email: string; url: string } | null>(null);
  const rowLocks = useActionLocks();

  const { user: currentUser, refreshUser } = useAuth();
  const { role: currentRole, can } = usePermissions();
  const { branches } = useBranch();
  const { t } = useTranslation();

  const isAdmin = currentRole === "admin";
  const canCreate = can("users", "create");
  const canEdit = can("users", "edit");

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiRequest<{ users: UserRecord[] }>("/api/users");
      setUsers(res.users ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("users.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (target: UserRecord, newUserRole: AppRole) => {
    if (!canEdit || target.role === newUserRole) return;
    setUpdatingUserId(target.id);
    try {
      await apiRequest(`/api/users/${target.id}/role`, {
        method: "PUT",
        body: { role: newUserRole },
      });
      setUsers((prev) =>
        prev.map((u) =>
          u.id === target.id
            ? {
                ...u,
                role: newUserRole,
                branchScopeMode: newUserRole === "admin" ? "all" : u.branchScopeMode,
              }
            : u
        )
      );
      if (target.id === currentUser?.id) {
        await refreshUser();
      }
      toast.success(t("users.roleUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("users.roleUpdateFailed"));
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleToggleStatus = async (target: UserRecord, nextActive: boolean) => {
    if (!canEdit) return;
    setUpdatingUserId(target.id);
    try {
      await apiRequest(`/api/users/${target.id}/status`, {
        method: "PUT",
        body: { isActive: nextActive },
      });
      setUsers((prev) => prev.map((u) => (u.id === target.id ? { ...u, isActive: nextActive } : u)));
      toast.success(
        nextActive
          ? t("users.userActivated", "User account activated")
          : t("users.userDeactivated", "User account deactivated")
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setUpdatingUserId(null);
    }
  };

  const createUserAction = useIdempotentAction(async () => {
    const res = await apiRequest<{ user: UserRecord }>("/api/users", {
      method: "POST",
      body: {
        name: newName.trim(),
        email: newEmail.trim(),
        password: newPassword,
        role: newRole,
        branchScopeMode: newRole === "admin" ? "all" : newScopeMode,
        branchIds: newScopeMode === "all" ? [] : newBranchIds,
        defaultBranchId: newBranchIds[0] ?? null,
      },
    });
    setUsers((prev) => [res.user, ...prev]);
    setCreateOpen(false);
    setNewName("");
    setNewEmail("");
    setNewPassword("");
    setNewRole("user");
    setNewScopeMode("selected");
    setNewBranchIds([]);
    toast.success(t("users.userCreated", "User account created"));
  });

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createUserAction.isPending) return;
    if (newPassword.length < 8) {
      toast.error(t("settings.passwordMinLength"));
      return;
    }
    try {
      await createUserAction.run();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const openBranchDialog = (u: UserRecord) => {
    setBranchDialogUser(u);
    setEditScopeMode(u.branchScopeMode);
    setEditBranchIds(u.branchIds);
    setEditDefaultBranchId(u.defaultBranchId ?? "");
  };

  const saveBranchesAction = useIdempotentAction(async () => {
    if (!branchDialogUser) return;
    await apiRequest(`/api/users/${branchDialogUser.id}/branches`, {
      method: "PUT",
      body: {
        branchScopeMode: branchDialogUser.role === "admin" ? "all" : editScopeMode,
        branchIds: editScopeMode === "all" ? [] : editBranchIds,
        defaultBranchId: editDefaultBranchId || null,
      },
    });
    await fetchUsers();
    if (branchDialogUser.id === currentUser?.id) {
      await refreshUser();
    }
    setBranchDialogUser(null);
    toast.success(t("users.branchesUpdated", "Branch access updated"));
  });

  const handleSaveBranches = async () => {
    if (!branchDialogUser || saveBranchesAction.isPending) return;
    try {
      await saveBranchesAction.run();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleIssueResetToken = async (target: UserRecord) => {
    try {
      const res = await apiRequest<{ resetPath: string }>(`/api/users/${target.id}/reset-token`, {
        method: "POST",
      });
      const fullUrl = `${window.location.origin}${res.resetPath}`;
      setResetUrlDialog({ email: target.email, url: fullUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      u.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.role.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getRoleBadgeVariant = (role: AppRole) => {
    switch (role) {
      case "admin":
        return "destructive" as const;
      case "manager":
        return "secondary" as const;
      default:
        return "outline" as const;
    }
  };

  const getRoleLabel = (role: AppRole) => {
    switch (role) {
      case "admin":
        return t("users.admin");
      case "manager":
        return t("users.manager");
      default:
        return t("users.user");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t("users.title")}</h1>
          <p className="text-muted-foreground">{t("users.description")}</p>
        </div>
        <div className="flex gap-2">
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 me-2" />
              {t("users.addUser", "Add User")}
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to="/roles">
              <Shield className="h-4 w-4 me-2" />
              {t("nav.admin.roles", "Roles & Permissions")}
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UsersIcon className="w-5 h-5" />
            {t("users.allUsers")}
          </CardTitle>
          <CardDescription>{t("users.allUsersDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("users.searchUsers")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>

          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead>{t("common.email")}</TableHead>
                  <TableHead>{t("common.role")}</TableHead>
                  <TableHead>{t("users.branchScope", "Branches")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  {canEdit && <TableHead className="text-end">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={canEdit ? 6 : 5}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canEdit ? 6 : 5} className="h-24 text-center">
                      {t("users.noUsersFound")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredUsers.map((u) => {
                    const isSelf = u.id === currentUser?.id;
                    const canChangeRole = canEdit && !isSelf && (isAdmin || u.role !== "admin");
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">
                          {u.name}
                          {isSelf && (
                            <Badge variant="outline" className="ms-2 text-xs">
                              {t("common.currentUser")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>
                          {canChangeRole ? (
                            <Select
                              value={u.role}
                              disabled={updatingUserId === u.id}
                              onValueChange={(value: AppRole) => handleRoleChange(u, value)}
                            >
                              <SelectTrigger className="w-32">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="user">{t("users.user")}</SelectItem>
                                <SelectItem value="manager">{t("users.manager")}</SelectItem>
                                {isAdmin && <SelectItem value="admin">{t("users.admin")}</SelectItem>}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant={getRoleBadgeVariant(u.role)}>{getRoleLabel(u.role)}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {u.role === "admin" || u.branchScopeMode === "all" ? (
                            <Badge variant="secondary">{t("users.allBranches", "All branches")}</Badge>
                          ) : (
                            <Badge variant="outline">
                              {u.branchIds.length} {t("nav.branches", "Branches")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {canEdit && !isSelf ? (
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={u.isActive}
                                disabled={updatingUserId === u.id}
                                onCheckedChange={(checked) => handleToggleStatus(u, checked)}
                                aria-label={`Toggle status for ${u.email}`}
                              />
                              <span className="text-xs text-muted-foreground">
                                {u.isActive ? t("common.active") : t("common.inactive", "Inactive")}
                              </span>
                            </div>
                          ) : (
                            <Badge variant={u.isActive ? "default" : "secondary"}>
                              {u.isActive ? t("common.active") : t("common.inactive", "Inactive")}
                            </Badge>
                          )}
                        </TableCell>
                        {canEdit && (
                          <TableCell className="text-end">
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={u.role === "admin"}
                                onClick={() => openBranchDialog(u)}
                              >
                                <Building2 className="h-3.5 w-3.5 me-1" />
                                {t("users.assignBranches", "Branches")}
                              </Button>
                              {isAdmin && (
                                <SubmitButton
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  hideSlowText
                                  pending={rowLocks.isPending(`reset:${u.id}`)}
                                  onClick={() => void rowLocks.runLocked(`reset:${u.id}`, () => handleIssueResetToken(u))}
                                >
                                  <KeyRound className="h-3.5 w-3.5 me-1" />
                                  {t("users.resetLink", "Reset Link")}
                                </SubmitButton>
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={(o) => { if (!o && createUserAction.isPending) return; setCreateOpen(o); }}>
        <DialogContent locked={createUserAction.isPending} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("users.addUser", "Add User")}</DialogTitle>
            <DialogDescription>
              {t("users.createDescription", "Create an internal ERP account and assign its role and branch scope.")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-user-name">{t("common.name")}</Label>
              <Input id="new-user-name" value={newName} onChange={(e) => setNewName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-email">{t("common.email")}</Label>
              <Input
                id="new-user-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-password">{t("common.password")}</Label>
              <Input
                id="new-user-password"
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>{t("common.role")}</Label>
              <Select value={newRole} onValueChange={(v: AppRole) => setNewRole(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("users.user")}</SelectItem>
                  <SelectItem value="manager">{t("users.manager")}</SelectItem>
                  {isAdmin && <SelectItem value="admin">{t("users.admin")}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            {newRole !== "admin" && (
              <div className="space-y-3 border rounded-md p-3">
                <Label>{t("users.branchScope", "Branch Scope")}</Label>
                <RadioGroup
                  value={newScopeMode}
                  onValueChange={(v: "all" | "selected") => setNewScopeMode(v)}
                  className="flex gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="all" id="new-scope-all" />
                    <Label htmlFor="new-scope-all">{t("users.allBranches", "All branches")}</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="selected" id="new-scope-selected" />
                    <Label htmlFor="new-scope-selected">{t("users.selectedBranches", "Selected")}</Label>
                  </div>
                </RadioGroup>
                {newScopeMode === "selected" && branches.length > 0 && (
                  <div className="space-y-2 max-h-36 overflow-y-auto pt-1">
                    {branches.map((b) => (
                      <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={newBranchIds.includes(b.id)}
                          onCheckedChange={(c) => {
                            setNewBranchIds((prev) =>
                              c === true ? [...prev, b.id] : prev.filter((id) => id !== b.id)
                            );
                          }}
                        />
                        <span>{b.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={createUserAction.isPending} onClick={() => setCreateOpen(false)}>
                {t("common.cancel")}
              </Button>
              <SubmitButton type="submit" pending={createUserAction.isPending}>
                {t("users.addUser", "Add User")}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(branchDialogUser)} onOpenChange={(open) => { if (!open && !saveBranchesAction.isPending) setBranchDialogUser(null); }}>
        <DialogContent locked={saveBranchesAction.isPending} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("users.assignBranches", "Assign Branches")}</DialogTitle>
            <DialogDescription>
              {branchDialogUser?.name} ({branchDialogUser?.email})
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <RadioGroup
              value={editScopeMode}
              onValueChange={(v: "all" | "selected") => setEditScopeMode(v)}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="edit-scope-all" />
                <Label htmlFor="edit-scope-all">{t("users.allBranches", "All branches")}</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="selected" id="edit-scope-selected" />
                <Label htmlFor="edit-scope-selected">{t("users.selectedBranches", "Selected branches")}</Label>
              </div>
            </RadioGroup>

            {editScopeMode === "selected" && (
              <div className="space-y-2 border rounded-md p-3 max-h-48 overflow-y-auto">
                {branches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("branches.noBranches", "No branches configured yet.")}</p>
                ) : (
                  branches.map((b) => (
                    <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={editBranchIds.includes(b.id)}
                        onCheckedChange={(c) => {
                          setEditBranchIds((prev) =>
                            c === true ? [...prev, b.id] : prev.filter((id) => id !== b.id)
                          );
                        }}
                      />
                      <span>{b.name}</span>
                    </label>
                  ))
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>{t("users.defaultBranch", "Default Branch")}</Label>
              <Select
                value={editDefaultBranchId || "__none__"}
                onValueChange={(v) => setEditDefaultBranchId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("common.none", "None")}</SelectItem>
                  {branches
                    .filter((b) => editScopeMode === "all" || editBranchIds.includes(b.id))
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saveBranchesAction.isPending} onClick={() => setBranchDialogUser(null)}>
              {t("common.cancel")}
            </Button>
            <SubmitButton type="button" onClick={() => void handleSaveBranches()} pending={saveBranchesAction.isPending}>
              {t("common.save", "Save")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(resetUrlDialog)} onOpenChange={(open) => !open && setResetUrlDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("users.resetLink", "One-Time Password Reset Link")}</DialogTitle>
            <DialogDescription>
              {resetUrlDialog?.email} — {t("users.resetLinkHint", "Share this private one-time link securely (expires in 2 hours).")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={resetUrlDialog?.url ?? ""} className="font-mono text-xs" />
            <Button
              variant="outline"
              onClick={() => {
                if (!resetUrlDialog) return;
                void navigator.clipboard.writeText(resetUrlDialog.url);
                toast.success(t("common.copied", "Copied to clipboard"));
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
