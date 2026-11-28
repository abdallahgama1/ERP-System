import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, Edit, Trash2, History, Truck } from "lucide-react";
import { z } from "zod";
import { TablePagination } from "@/components/TablePagination";
import { useVendorsPageQuery } from "@/hooks/queries/usePurchasingQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import type { Vendor } from "@/types";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { usePermissions } from "@/contexts/PermissionsContext";

// Zod validation schema
const vendorSchema = z.object({
  displayName: z.string().min(1, "Display name is required").max(100),
  contactFirstName: z.string().max(50).optional(),
  contactLastName: z.string().max(50).optional(),
  email: z.string().email("Invalid email address").or(z.literal("")),
  phone: z.string().max(20).optional(),
  taxNumber: z.string().max(50).optional(),
  currency: z.enum(["SAR", "AED", "USD", "EGP"]),
  paymentTerms: z.enum(["NET15", "NET30", "COD"]),
  billingAddress: z.string().max(500).optional(),
  shippingAddress: z.string().max(500).optional(),
});

type VendorFormData = z.infer<typeof vendorSchema>;

const initialFormData: VendorFormData = {
  displayName: "",
  contactFirstName: "",
  contactLastName: "",
  email: "",
  phone: "",
  taxNumber: "",
  currency: "SAR",
  paymentTerms: "NET30",
  billingAddress: "",
  shippingAddress: "",
};

const termsFromDays = (days: number): "NET15" | "NET30" | "COD" =>
  days <= 0 ? "COD" : days <= 15 ? "NET15" : "NET30";

const Vendors = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { can } = usePermissions();
  const canCreate = can("purchases", "create");
  const canEdit = can("purchases", "edit");
  const canDelete = can("purchases", "delete");
  const { vendors, addVendor, updateVendor, deleteVendor, vendorPayables } = usePurchasingScope({ vendors: true, bills: true });
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [deleteVendorId, setDeleteVendorId] = useState<string | null>(null);
  const [formData, setFormData] = useState<VendorFormData>(initialFormData);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [duplicateTaxWarning, setDuplicateTaxWarning] = useState<string | null>(null);

  const { data: vendorsPage } = useVendorsPageQuery({
    page,
    pageSize: 25,
    q: searchTerm,
  });

  const filteredVendors = useMemo<Vendor[]>(
    () =>
      (vendorsPage?.vendors ?? []).map((v) => ({
        id: v.id,
        displayName: v.name,
        companyName: v.company || undefined,
        email: v.email || undefined,
        phone: v.phone || undefined,
        taxNumber: v.taxNumber || undefined,
        currency: v.currency === "SAR" || v.currency === "AED" || v.currency === "EGP" ? v.currency : "USD",
        paymentTerms: termsFromDays(v.paymentTermsDays),
        billingAddress: v.address || undefined,
        shippingAddress: v.address || undefined,
        payablesBalance: vendorPayables(v.id),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    [vendorsPage, vendorPayables]
  );

  const resetForm = () => {
    setFormData(initialFormData);
    setFormErrors({});
    setDuplicateTaxWarning(null);
    setEditingVendor(null);
  };

  const handleOpenDialog = (vendor?: Vendor) => {
    if (vendor) {
      setEditingVendor(vendor);
      setFormData({
        displayName: vendor.displayName,
        contactFirstName: vendor.contactFirstName || "",
        contactLastName: vendor.contactLastName || "",
        email: vendor.email || "",
        phone: vendor.phone || "",
        taxNumber: vendor.taxNumber || "",
        currency: vendor.currency,
        paymentTerms: vendor.paymentTerms,
        billingAddress: vendor.billingAddress || "",
        shippingAddress: vendor.shippingAddress || "",
      });
    } else {
      resetForm();
    }
    setIsDialogOpen(true);
  };

  const saveVendorAction = useIdempotentAction(async (confirmDuplicate: boolean = false) => {
    const result = vendorSchema.safeParse(formData);
    
    if (!result.success) {
      const errors: Record<string, string> = {};
      result.error.errors.forEach((err) => {
        if (err.path[0]) {
          errors[err.path[0] as string] = err.message;
        }
      });
      setFormErrors(errors);
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: t("vendors.validationError"),
      });
      return;
    }

    // Duplicate email guard
    const dupErrors: Record<string, string> = {};
    const emailNorm = result.data.email?.trim().toLowerCase();
    if (emailNorm) {
      const emailTaken = vendors.some(
        v => v.email?.trim().toLowerCase() === emailNorm &&
             (!editingVendor || v.id !== editingVendor.id)
      );
      if (emailTaken) dupErrors.email = t("vendors.duplicateEmail", "A vendor with this email already exists");
    }
    if (Object.keys(dupErrors).length > 0) {
      setFormErrors(dupErrors);
      toast({
        variant: "destructive",
        title: t("common.error"),
        description: Object.values(dupErrors)[0],
      });
      return;
    }

    const payload = {
      displayName: result.data.displayName,
      contactFirstName: result.data.contactFirstName,
      contactLastName: result.data.contactLastName,
      email: result.data.email,
      phone: result.data.phone,
      taxNumber: result.data.taxNumber,
      currency: result.data.currency,
      paymentTerms: result.data.paymentTerms,
      billingAddress: result.data.billingAddress,
      shippingAddress: result.data.shippingAddress,
      confirmDuplicate,
    };

    const res = editingVendor
      ? await updateVendor(editingVendor.id, payload)
      : await addVendor(payload);

    if (res.ok === false) {
      if (res.code === "DUPLICATE_TAX_NUMBER_WARNING") {
        setDuplicateTaxWarning(res.error);
        return { ok: false, status: 409 };
      }
      toast({ variant: "destructive", title: t("common.error"), description: res.error });
      return res;
    }

    toast({ title: editingVendor ? t("vendors.vendorUpdated") : t("vendors.vendorCreated") });
    setIsDialogOpen(false);
    resetForm();
    return { ok: true };
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void saveVendorAction.run(false);
  };

  const handleDeleteClick = (vendorId: string) => {
    setDeleteVendorId(vendorId);
  };

  const handleConfirmDelete = async () => {
    if (deleteVendorId) {
      const res = await deleteVendor(deleteVendorId);
      if (res.ok === false) {
        toast({ title: t("common.error"), description: res.error, variant: "destructive" });
      } else {
        toast({ title: t("vendors.vendorDeleted") });
      }
      setDeleteVendorId(null);
    }
  };

  const handleViewHistory = (_vendorId: string) => {
    toast({
      title: t("common.comingSoon"),
      description: t("vendors.historyComingSoon"),
    });
  };

  const getPaymentTermsLabel = (terms: string) => {
    switch (terms) {
      case "NET15":
        return t("vendors.paymentTerms.net15");
      case "NET30":
        return t("vendors.paymentTerms.net30");
      case "COD":
        return t("vendors.paymentTerms.cod");
      default:
        return terms;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("vendors.title")}</h1>
          <p className="text-muted-foreground">{t("vendors.description")}</p>
        </div>
        {canCreate && (
          <Button onClick={() => handleOpenDialog()}>
            <Plus className="me-2 h-4 w-4" />
            {t("vendors.addVendor")}
          </Button>
        )}
      </div>

      {vendors.length === 0 && (vendorsPage?.pageInfo?.total ?? 0) === 0 && !searchTerm.trim() ? (
        // Empty State
        <Card className="flex flex-col items-center justify-center py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <Truck className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="mt-6 text-xl font-semibold">{t("vendors.noVendors")}</h3>
          <p className="mt-2 text-center text-muted-foreground max-w-sm">
            {t("vendors.noVendorsDescription")}
          </p>
          {canCreate && (
            <Button className="mt-6" onClick={() => handleOpenDialog()}>
              <Plus className="me-2 h-4 w-4" />
              {t("vendors.createFirstVendor")}
            </Button>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t("vendors.allVendors")}</CardTitle>
              <div className="relative w-72">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("vendors.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setPage(1);
                  }}
                  className="ps-9"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("vendors.vendorName")}</TableHead>
                  <TableHead>{t("vendors.contactPerson")}</TableHead>
                  <TableHead>{t("vendors.email")}</TableHead>
                  <TableHead>{t("vendors.phone")}</TableHead>
                  <TableHead>{t("vendors.taxId")}</TableHead>
                  <TableHead className="text-end">{t("vendors.payablesBalance")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredVendors.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      {t("vendors.noResults")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredVendors.map((vendor) => (
                    <TableRow key={vendor.id}>
                      <TableCell className="font-medium">{vendor.displayName}</TableCell>
                      <TableCell>
                        {vendor.contactFirstName || vendor.contactLastName
                          ? `${vendor.contactFirstName || ""} ${vendor.contactLastName || ""}`.trim()
                          : "-"}
                      </TableCell>
                      <TableCell>{vendor.email || "-"}</TableCell>
                      <TableCell>{vendor.phone || "-"}</TableCell>
                      <TableCell>
                        {vendor.taxNumber ? (
                          <Badge variant="outline">{vendor.taxNumber}</Badge>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-end font-medium">
                        {vendor.currency} {vendorPayables(vendor.id).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleViewHistory(vendor.id)}
                            title={t("vendors.viewHistory")}
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleOpenDialog(vendor)}
                              title={t("common.edit")}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(vendor.id)}
                              title={t("common.delete")}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            <TablePagination pageInfo={vendorsPage?.pageInfo} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      {/* Add/Edit Vendor Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={saveVendorAction.guardOpenChange((o) => { setIsDialogOpen(o); if (!o) resetForm(); })}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" locked={saveVendorAction.isPending}>
          <DialogHeader>
            <DialogTitle>
              {editingVendor ? t("vendors.editVendor") : t("vendors.addNewVendor")}
            </DialogTitle>
            <DialogDescription>
              {editingVendor
                ? t("vendors.editVendorDescription")
                : t("vendors.addVendorDescription")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Display Name */}
            <div className="space-y-2">
              <Label htmlFor="displayName">
                {t("vendors.displayName")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="displayName"
                value={formData.displayName}
                onChange={(e) =>
                  setFormData({ ...formData, displayName: e.target.value })
                }
                className={formErrors.displayName ? "border-destructive" : ""}
              />
              {formErrors.displayName && (
                <p className="text-sm text-destructive">{formErrors.displayName}</p>
              )}
            </div>

            {/* Contact Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contactFirstName">{t("vendors.contactFirstName")}</Label>
                <Input
                  id="contactFirstName"
                  value={formData.contactFirstName}
                  onChange={(e) =>
                    setFormData({ ...formData, contactFirstName: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactLastName">{t("vendors.contactLastName")}</Label>
                <Input
                  id="contactLastName"
                  value={formData.contactLastName}
                  onChange={(e) =>
                    setFormData({ ...formData, contactLastName: e.target.value })
                  }
                />
              </div>
            </div>

            {/* Email & Phone */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("vendors.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={formErrors.email ? "border-destructive" : ""}
                />
                {formErrors.email && (
                  <p className="text-sm text-destructive">{formErrors.email}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t("vendors.phone")}</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
            </div>

            {/* Tax Number */}
            <div className="space-y-2">
              <Label htmlFor="taxNumber">{t("vendors.taxNumber")}</Label>
              <Input
                id="taxNumber"
                value={formData.taxNumber}
                onChange={(e) => setFormData({ ...formData, taxNumber: e.target.value })}
                placeholder={t("vendors.taxNumberPlaceholder")}
              />
            </div>

            {/* Currency & Payment Terms */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="currency">{t("vendors.currency")}</Label>
                <Select
                  value={formData.currency}
                  onValueChange={(value: "SAR" | "AED" | "USD") =>
                    setFormData({ ...formData, currency: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SAR">SAR - {t("vendors.currencies.sar")}</SelectItem>
                    <SelectItem value="AED">AED - {t("vendors.currencies.aed")}</SelectItem>
                    <SelectItem value="USD">USD - {t("vendors.currencies.usd")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="paymentTerms">{t("vendors.paymentTermsLabel")}</Label>
                <Select
                  value={formData.paymentTerms}
                  onValueChange={(value: "NET15" | "NET30" | "COD") =>
                    setFormData({ ...formData, paymentTerms: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NET15">{t("vendors.paymentTerms.net15")}</SelectItem>
                    <SelectItem value="NET30">{t("vendors.paymentTerms.net30")}</SelectItem>
                    <SelectItem value="COD">{t("vendors.paymentTerms.cod")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Addresses */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="billingAddress">{t("vendors.billingAddress")}</Label>
                <Textarea
                  id="billingAddress"
                  value={formData.billingAddress}
                  onChange={(e) =>
                    setFormData({ ...formData, billingAddress: e.target.value })
                  }
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shippingAddress">{t("vendors.shippingAddress")}</Label>
                <Textarea
                  id="shippingAddress"
                  value={formData.shippingAddress}
                  onChange={(e) =>
                    setFormData({ ...formData, shippingAddress: e.target.value })
                  }
                  rows={3}
                />
              </div>
            </div>

            {duplicateTaxWarning && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-2">
                <p className="font-medium text-amber-900 dark:text-amber-200">{t("common.confirmDuplicateTaxTitle")}</p>
                <p className="text-muted-foreground">{duplicateTaxWarning}</p>
                <SubmitButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  pending={saveVendorAction.isPending}
                  isSlow={saveVendorAction.isSlow}
                  onClick={() => void saveVendorAction.run(true)}
                >
                  {t("common.confirmDuplicateTaxAction")}
                </SubmitButton>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={saveVendorAction.isPending}
                onClick={() => {
                  setIsDialogOpen(false);
                  resetForm();
                }}
              >
                {t("common.cancel")}
              </Button>
              <SubmitButton
                type="submit"
                pending={saveVendorAction.isPending}
                isSlow={saveVendorAction.isSlow}
              >
                {editingVendor ? t("common.save") : t("vendors.createVendor")}
              </SubmitButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirm Delete Dialog */}
      <ConfirmDeleteDialog
        open={deleteVendorId !== null}
        onOpenChange={(open) => !open && setDeleteVendorId(null)}
        onConfirm={handleConfirmDelete}
        itemName={vendors.find((v) => v.id === deleteVendorId)?.displayName}
      />
    </div>
  );
};

export default Vendors;
