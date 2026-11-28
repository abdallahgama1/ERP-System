import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ClipboardList, Plus, Search, Eye, Trash2, Calendar, User, Building2, Edit } from "lucide-react";
import { Session, SessionStatus } from "@/types";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useSessionsScope } from "@/hooks/queries/useSessionsScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";

const EDITABLE_STATUS_OPTIONS: Array<"Active" | "In Progress" | "Cancelled"> = [
  "Active",
  "In Progress",
  "Cancelled",
];

const Sessions = () => {
  const { t } = useTranslation();
  const { branches } = useInventoryScope();
  const { sessions, getSessionItems, createSession, updateSession, deleteSession } = useSessionsScope({ includeProducts: true });
  const { user } = useAuth();
  const { role } = usePermissions();
  const [searchTerm, setSearchTerm] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<"Active" | "In Progress" | "Cancelled">("Active");
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const { toast } = useToast();

  const canDeleteEmpty = role === "admin" || role === "manager";

  const getStatusLabel = (status: SessionStatus) => {
    switch (status) {
      case "Active":
        return t("sessions.active");
      case "In Progress":
        return t("sessions.inProgress");
      case "Completed":
        return t("sessions.completed");
      case "Cancelled":
        return t("sessions.cancelled");
      default:
        return status;
    }
  };

  const filteredSessions = sessions.filter(
    (session) =>
      session.id.toString().includes(searchTerm) ||
      session.createdByName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (session.branchName && session.branchName.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (session.description && session.description.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  const openCreateDialog = () => {
    setSelectedBranchId(branches[0]?.branchId.toString() || "");
    setDescription("");
    setIsAddDialogOpen(true);
  };

  const createSessionAction = useIdempotentAction(async () => {
    if (!selectedBranchId) {
      toast({
        title: t("sessions.branchRequired", "Select a branch to start a session"),
        variant: "destructive",
      });
      return;
    }
    const res = await createSession({
      branchId: selectedBranchId,
      description: description.trim() || undefined,
    });
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    setIsAddDialogOpen(false);
    setSelectedBranchId("");
    setDescription("");
    toast({ title: t("sessions.sessionCreated") });
    return { ok: true };
  });

  const handleEdit = (session: Session) => {
    if (session.status === "Completed" || session.status === "Cancelled") return;
    setEditingSession(session);
    setDescription(session.description || "");
    setSelectedBranchId(session.branchId.toString());
    setSelectedStatus(session.status);
    setIsEditDialogOpen(true);
  };

  const updateSessionAction = useIdempotentAction(async () => {
    if (!editingSession) return;
    const res = await updateSession(editingSession.id, {
      description: description.trim() || undefined,
      branchId: selectedBranchId || undefined,
      status: selectedStatus,
    });
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    setIsEditDialogOpen(false);
    setEditingSession(null);
    setDescription("");
    setSelectedBranchId("");
    setSelectedStatus("Active");
    toast({ title: t("sessions.sessionUpdated") });
    return { ok: true };
  });

  const handleConfirmDelete = async () => {
    if (!deleteSessionId) return;
    const res = await deleteSession(deleteSessionId);
    setDeleteSessionId(null);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({ title: t("sessions.sessionDeleted") });
  };

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const getStatusBadgeVariant = (status: SessionStatus) => {
    switch (status) {
      case "Active":
        return "default" as const;
      case "In Progress":
        return "secondary" as const;
      case "Completed":
        return "outline" as const;
      case "Cancelled":
        return "destructive" as const;
      default:
        return "outline" as const;
    }
  };

  const getBranchName = (session: Session) => {
    if (session.branchName) return session.branchName;
    const branch = branches.find((b) => b.branchId === session.branchId);
    return branch?.branch_name || `Branch ${session.branchId}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("sessions.title")}</h1>
          <p className="text-muted-foreground">{t("sessions.description")}</p>
        </div>

        <Dialog open={isAddDialogOpen} onOpenChange={createSessionAction.guardOpenChange(setIsAddDialogOpen)}>
          <DialogTrigger asChild>
            <Button onClick={openCreateDialog} disabled={branches.length === 0}>
              <Plus className="me-2 h-4 w-4" />
              {t("sessions.startNewSession")}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md" locked={createSessionAction.isPending}>
            <DialogHeader>
              <DialogTitle>{t("sessions.startNewSession")}</DialogTitle>
              <DialogDescription>{t("sessions.newSessionDescription")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="branch">{t("sessions.branch")} *</Label>
                <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("sessions.branch")} />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((branch) => (
                      <SelectItem key={branch.branchId} value={branch.branchId.toString()}>
                        {branch.branch_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">{t("sessions.description")}</Label>
                <Textarea
                  id="description"
                  placeholder={t("sessions.description")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="resize-none"
                  rows={3}
                />
              </div>

              <div className="bg-muted/50 p-4 rounded-lg">
                <h4 className="font-medium mb-2">{t("sessions.sessionDetails")}</h4>
                <p className="text-sm text-muted-foreground mb-2">{t("sessions.sessionInfo")}</p>
                <ul className="text-sm space-y-1">
                  <li>
                    • {t("sessions.createdBy")}: {user?.name || user?.email || t("sessions.user")}
                  </li>
                  <li>
                    • {t("sessions.startTime")}: {new Date().toLocaleString()}
                  </li>
                  <li>
                    • {t("common.status")}: {t("sessions.active")}
                  </li>
                  {description && (
                    <li>
                      • {t("sessions.description")}: {description}
                    </li>
                  )}
                  {selectedBranchId && (
                    <li>
                      • {t("sessions.branch")}:{" "}
                      {branches.find((b) => b.branchId.toString() === selectedBranchId)?.branch_name}
                    </li>
                  )}
                </ul>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={createSessionAction.isPending} onClick={() => setIsAddDialogOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <SubmitButton
                  type="button"
                  pending={createSessionAction.isPending}
                  isSlow={createSessionAction.isSlow}
                  onClick={() => void createSessionAction.run()}
                  disabled={!selectedBranchId}
                >
                  {t("common.create")} {t("sessionDetail.session")}
                </SubmitButton>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            <span>{t("sessions.inventorySessions")}</span>
          </CardTitle>
          <CardDescription>{t("sessions.allSessions")}</CardDescription>

          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("sessions.searchSessions")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>
        </CardHeader>

        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("sessions.sessionId")}</TableHead>
                <TableHead>{t("sessions.description")}</TableHead>
                <TableHead>{t("sessions.branch")}</TableHead>
                <TableHead>{t("sessions.createdBy")}</TableHead>
                <TableHead>{t("sessions.createdDate")}</TableHead>
                <TableHead>{t("sessions.lastUpdated")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSessions.map((session) => {
                const isTerminal = session.status === "Completed" || session.status === "Cancelled";
                const canDelete =
                  canDeleteEmpty && session.status === "Active" && getSessionItems(session.id).length === 0;
                return (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <ClipboardList className="h-4 w-4 text-muted-foreground" />
                        <span>#{session.id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{session.description || "—"}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span>{getBranchName(session)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span>{session.createdByName || "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>{formatDate(session.createdAt)}</span>
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(session.updatedAt)}</TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(session.status)}>
                        {getStatusLabel(session.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/sessions/${session.id}`}>
                            <Eye className="h-4 w-4" />
                          </Link>
                        </Button>
                        {!isTerminal && (
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(session)}>
                            <Edit className="h-4 w-4" />
                          </Button>
                        )}
                        {canDelete && (
                          <Button variant="ghost" size="sm" onClick={() => setDeleteSessionId(session.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {filteredSessions.length === 0 && (
            <div className="text-center py-8">
              <ClipboardList className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">{t("sessions.noSessionsFound")}</h3>
              <p className="text-muted-foreground">
                {searchTerm ? t("common.tryAdjusting") : t("sessions.getStartedSession")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Session Dialog (only for open Active / In Progress sessions) */}
      <Dialog open={isEditDialogOpen} onOpenChange={updateSessionAction.guardOpenChange(setIsEditDialogOpen)}>
        <DialogContent className="max-w-md" locked={updateSessionAction.isPending}>
          <DialogHeader>
            <DialogTitle>{t("sessions.editSession")}</DialogTitle>
            <DialogDescription>
              {t("sessions.updateSession")} #{editingSession?.id}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editDescription">{t("sessions.description")}</Label>
              <Textarea
                id="editDescription"
                placeholder={t("sessions.description")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="resize-none"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="editBranch">{t("sessions.branch")}</Label>
              <Select
                value={selectedBranchId}
                onValueChange={setSelectedBranchId}
                disabled={editingSession ? getSessionItems(editingSession.id).length > 0 : false}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("sessions.branch")} />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.branchId} value={branch.branchId.toString()}>
                      {branch.branch_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="editStatus">{t("common.status")}</Label>
              <Select
                value={selectedStatus}
                onValueChange={(value) => setSelectedStatus(value as "Active" | "In Progress" | "Cancelled")}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("common.status")} />
                </SelectTrigger>
                <SelectContent>
                  {EDITABLE_STATUS_OPTIONS.filter(
                    (st) => !(editingSession?.status === "In Progress" && st === "Active"),
                  ).map((status) => (
                    <SelectItem key={status} value={status}>
                      {getStatusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t(
                  "sessions.completeHint",
                  "To complete a session and reconcile stock variances, open the session and click Complete & Reconcile.",
                )}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={updateSessionAction.isPending} onClick={() => setIsEditDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <SubmitButton
                type="button"
                pending={updateSessionAction.isPending}
                isSlow={updateSessionAction.isSlow}
                onClick={() => void updateSessionAction.run()}
              >
                {t("common.update")} {t("sessionDetail.session")}
              </SubmitButton>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteSessionId !== null}
        onOpenChange={(open) => !open && setDeleteSessionId(null)}
        onConfirm={handleConfirmDelete}
        itemName={`Session #${deleteSessionId}`}
      />
    </div>
  );
};

export default Sessions;
