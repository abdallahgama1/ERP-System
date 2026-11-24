import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Target, Plus, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { CostCenterDto } from "@erp/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useCostCenterMutations, useCostCentersQuery } from "@/hooks/queries/useAccountingQueries";

export default function CostCenters() {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const { branches } = useInventoryScope();
  const { data: costCenters = [], isLoading } = useCostCentersQuery(false);
  const { createCostCenter, updateCostCenter } = useCostCenterMutations();

  const canCreate = can("accounting", "create");
  const canEdit = can("accounting", "edit");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CostCenterDto | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState<string>("none");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);

  const openCreate = () => {
    setEditing(null);
    setCode("");
    setName("");
    setBranchId("none");
    setDescription("");
    setIsActive(true);
    setDialogOpen(true);
  };

  const openEdit = (cc: CostCenterDto) => {
    setEditing(cc);
    setCode(cc.code);
    setName(cc.name);
    setBranchId(cc.branchId ?? "none");
    setDescription(cc.description);
    setIsActive(cc.isActive);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error(t("accounting.costCenters.validationRequired", "Code and name are required"));
      return;
    }
    try {
      if (editing) {
        await updateCostCenter.mutateAsync({
          id: editing.id,
          data: {
            code: code.trim(),
            name: name.trim(),
            branchId: branchId === "none" ? null : branchId,
            description: description.trim(),
            isActive,
          },
        });
        toast.success(t("accounting.costCenters.updated", "Cost center updated"));
      } else {
        await createCostCenter.mutateAsync({
          code: code.trim(),
          name: name.trim(),
          branchId: branchId === "none" ? null : branchId,
          description: description.trim(),
          isActive,
        });
        toast.success(t("accounting.costCenters.created", "Cost center created"));
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save cost center");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Target className="h-7 w-7 text-primary" />
            {t("accounting.costCenters.title", "Cost Centers")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.costCenters.description",
              "Track department, project, and operational cost centers across journal entries, expenses, and Profit & Loss."
            )}
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 me-2" />
            {t("accounting.costCenters.new", "New Cost Center")}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("accounting.costCenters.listTitle", "Active & Archived Cost Centers")}</CardTitle>
          <CardDescription>
            {t("accounting.costCenters.countLabel", "{{count}} cost centers configured", {
              count: costCenters.length,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.code", "Code")}</TableHead>
                <TableHead>{t("common.name", "Name")}</TableHead>
                <TableHead>{t("common.branch", "Branch")}</TableHead>
                <TableHead>{t("common.description", "Description")}</TableHead>
                <TableHead>{t("common.status", "Status")}</TableHead>
                {canEdit && <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {t("common.loading", "Loading...")}
                  </TableCell>
                </TableRow>
              ) : costCenters.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    {t("accounting.costCenters.empty", "No cost centers yet. Create your first department or project code.")}
                  </TableCell>
                </TableRow>
              ) : (
                costCenters.map((cc) => (
                  <TableRow key={cc.id}>
                    <TableCell className="font-mono font-medium">{cc.code}</TableCell>
                    <TableCell className="font-medium">{cc.name}</TableCell>
                    <TableCell>{cc.branchName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground max-w-xs truncate">
                      {cc.description || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={cc.isActive ? "default" : "secondary"}>
                        {cc.isActive ? t("common.active", "Active") : t("common.inactive", "Inactive")}
                      </Badge>
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-end">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(cc)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("accounting.costCenters.edit", "Edit Cost Center")
                : t("accounting.costCenters.new", "New Cost Center")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "accounting.costCenters.dialogDesc",
                "Assign a short code (e.g. CC-MKT, CC-OPS) to tag journal lines and expense claims."
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="cc-code">{t("common.code", "Code")}</Label>
                <Input
                  id="cc-code"
                  placeholder="CC-OPS"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cc-name">{t("common.name", "Name")}</Label>
                <Input
                  id="cc-name"
                  placeholder="Operations"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("common.branch", "Linked Branch (Optional)")}</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("common.companyWide", "Company-Wide (All Branches)")}</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.branchId} value={b.branchId}>
                      {b.branch_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="cc-desc">{t("common.description", "Description")}</Label>
              <Input
                id="cc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="cc-active">{t("common.active", "Active")}</Label>
              <Switch id="cc-active" checked={isActive} onCheckedChange={setIsActive} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={handleSave}
              disabled={createCostCenter.isPending || updateCostCenter.isPending}
            >
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
