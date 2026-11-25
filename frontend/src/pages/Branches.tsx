import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Label } from "@/components/ui/label";
import { Building2, Plus, Search, Edit, Trash2, MapPin, Phone, Eye } from "lucide-react";
import { Branch } from "@/types";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

const Branches = () => {
  const { t } = useTranslation();
  const { branches, addBranch, updateBranch, deleteBranch } = useInventoryScope();
  const { can } = usePermissions();
  const canCreateBranch = can("branches", "create");
  const canEditBranch = can("branches", "edit");
  const canDeleteBranch = can("branches", "delete");
  const [searchTerm, setSearchTerm] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [deleteBranchId, setDeleteBranchId] = useState<string | null>(null);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    branch_name: "",
    branch_location: "",
    contact_number: "",
    etaBranchId: "0",
    governorate: "",
    regionCity: "",
    street: "",
    buildingNumber: "",
  });

  const filteredBranches = branches.filter(branch =>
    branch.branch_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    branch.branch_location.toLowerCase().includes(searchTerm.toLowerCase()) ||
    branch.contact_number.includes(searchTerm)
  );

  const resetForm = () => {
    setFormData({
      branch_name: "",
      branch_location: "",
      contact_number: "",
      etaBranchId: "0",
      governorate: "",
      regionCity: "",
      street: "",
      buildingNumber: "",
    });
    setEditingBranch(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (editingBranch) {
      const res = await updateBranch(editingBranch.branchId, formData);
      if (res.ok === false) {
        toast({ title: t('common.error'), description: res.error, variant: "destructive" });
        return;
      }
      toast({ title: t('branches.branchUpdated') });
    } else {
      const res = await addBranch(formData);
      if (res.ok === false) {
        toast({ title: t('common.error'), description: res.error, variant: "destructive" });
        return;
      }
      toast({ title: t('branches.branchAdded') });
    }

    resetForm();
    setIsAddDialogOpen(false);
  };

  const handleEdit = (branch: Branch) => {
    setEditingBranch(branch);
    setFormData({
      branch_name: branch.branch_name,
      branch_location: branch.branch_location,
      contact_number: branch.contact_number,
      etaBranchId: branch.etaBranchId ?? "0",
      governorate: branch.governorate ?? "",
      regionCity: branch.regionCity ?? "",
      street: branch.street ?? "",
      buildingNumber: branch.buildingNumber ?? "",
    });
    setIsAddDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (deleteBranchId) {
      const res = await deleteBranch(deleteBranchId);
      if (res.ok === false) {
        toast({ title: t('common.error'), description: res.error, variant: "destructive" });
      } else {
        toast({ title: t('branches.branchDeleted') });
      }
      setDeleteBranchId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('branches.title')}</h1>
          <p className="text-muted-foreground">
            {t('branches.description')}
          </p>
        </div>
        
        {(canCreateBranch || canEditBranch) && (
          <Dialog
            open={isAddDialogOpen}
            onOpenChange={(open) => {
              setIsAddDialogOpen(open);
              if (!open) resetForm();
            }}
          >
            {canCreateBranch && (
              <DialogTrigger asChild>
                <Button onClick={resetForm}>
                  <Plus className="me-2 h-4 w-4" />
                  {t('branches.addBranch')}
                </Button>
              </DialogTrigger>
            )}
            <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingBranch ? t('branches.editBranch') : t('branches.addNewBranch')}
              </DialogTitle>
              <DialogDescription>
                {editingBranch ? t('branches.editDescription') : t('branches.addDescription')}
              </DialogDescription>
            </DialogHeader>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="branch_name">{t('branches.branchName')}</Label>
                <Input
                  id="branch_name"
                  value={formData.branch_name}
                  onChange={(e) => setFormData({...formData, branch_name: e.target.value})}
                  placeholder="e.g., Downtown Store"
                  required
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="branch_location">{t('branches.location')}</Label>
                <Input
                  id="branch_location"
                  value={formData.branch_location}
                  onChange={(e) => setFormData({...formData, branch_location: e.target.value})}
                  placeholder="e.g., 123 Main St, Anytown"
                  required
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="contact_number">{t('branches.contactNumber')}</Label>
                <Input
                  id="contact_number"
                  value={formData.contact_number}
                  onChange={(e) => setFormData({...formData, contact_number: e.target.value})}
                  placeholder="e.g., +15551234567"
                  required
                />
              </div>

              <div className="rounded-md border p-3 space-y-3 bg-muted/20">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("branches.etaAddressSection", "ETA Egypt Tax Address (Optional)")}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="etaBranchId" className="text-xs">
                      {t("branches.etaBranchId", "ETA Branch Code")}
                    </Label>
                    <Input
                      id="etaBranchId"
                      value={formData.etaBranchId}
                      onChange={(e) => setFormData({ ...formData, etaBranchId: e.target.value })}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="governorate" className="text-xs">
                      {t("branches.governorate", "Governorate")}
                    </Label>
                    <Input
                      id="governorate"
                      value={formData.governorate}
                      onChange={(e) => setFormData({ ...formData, governorate: e.target.value })}
                      placeholder="Cairo"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="regionCity" className="text-xs">
                      {t("branches.regionCity", "City / Region")}
                    </Label>
                    <Input
                      id="regionCity"
                      value={formData.regionCity}
                      onChange={(e) => setFormData({ ...formData, regionCity: e.target.value })}
                      placeholder="Nasr City"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="buildingNumber" className="text-xs">
                      {t("branches.buildingNumber", "Building #")}
                    </Label>
                    <Input
                      id="buildingNumber"
                      value={formData.buildingNumber}
                      onChange={(e) => setFormData({ ...formData, buildingNumber: e.target.value })}
                      placeholder="12"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="street" className="text-xs">
                    {t("branches.street", "Street")}
                  </Label>
                  <Input
                    id="street"
                    value={formData.street}
                    onChange={(e) => setFormData({ ...formData, street: e.target.value })}
                    placeholder="Makram Ebeid St"
                  />
                </div>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit">
                  {editingBranch ? t('common.update') : t('common.add')} {t('sessions.branch')}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            <span>{t('branches.branchLocations')}</span>
          </CardTitle>
          <CardDescription>
            {t('branches.allBranches')}
          </CardDescription>
          
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('branches.searchBranches')}
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
                <TableHead>{t('branches.branchName')}</TableHead>
                <TableHead>{t('branches.location')}</TableHead>
                <TableHead>{t('branches.contactNumber')}</TableHead>
                <TableHead>{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBranches.map((branch) => (
                <TableRow key={branch.branchId}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      <span>{branch.branch_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <span>{branch.branch_location}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <span>{branch.contact_number}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        asChild
                      >
                        <Link to={`/branches/${branch.branchId}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                      {canEditBranch && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(branch)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      )}
                      {canDeleteBranch && !branch.isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteBranchId(branch.branchId)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          {filteredBranches.length === 0 && (
            <div className="text-center py-8">
              <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">{t('branches.noBranchesFound')}</h3>
              <p className="text-muted-foreground">
                {searchTerm ? t('common.tryAdjusting') : t('branches.getStartedBranch')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDeleteDialog
        open={deleteBranchId !== null}
        onOpenChange={(open) => !open && setDeleteBranchId(null)}
        onConfirm={handleConfirmDelete}
        itemName={branches.find(b => b.branchId === deleteBranchId)?.branch_name}
      />
    </div>
  );
};

export default Branches;