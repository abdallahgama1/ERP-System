import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Search, Edit, Trash2, Users } from "lucide-react";
import { z } from "zod";
import { TablePagination } from "@/components/TablePagination";
import { useCustomersPageQuery } from "@/hooks/queries/useSalesQueries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { Customer } from "@/types";

const customerSchema = z.object({
  displayName: z.string().trim().min(1, "Display name is required").max(100),
  companyName: z.string().max(100).optional(),
  customerType: z.enum(["business", "individual"]),
  contactFirstName: z.string().max(50).optional(),
  contactLastName: z.string().max(50).optional(),
  email: z.string().email("Invalid email address").or(z.literal("")),
  phone: z.string().max(20).optional(),
  taxNumber: z.string().max(50).optional(),
  etaReceiverType: z.enum(["B", "P", "F"]).optional(),
  currency: z.enum(["SAR", "AED", "USD", "EGP"]),
  paymentTerms: z.enum(["NET15", "NET30", "COD"]),
  creditLimit: z.union([z.number().min(0), z.null()]).optional(),
  billingAddress: z.string().max(500).optional(),
  shippingAddress: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});

type FormData = z.infer<typeof customerSchema>;

const initialForm: FormData = {
  displayName: "",
  companyName: "",
  customerType: "business",
  contactFirstName: "",
  contactLastName: "",
  email: "",
  phone: "",
  taxNumber: "",
  etaReceiverType: "B",
  currency: "SAR",
  paymentTerms: "NET30",
  creditLimit: null,
  billingAddress: "",
  shippingAddress: "",
  notes: "",
};

const termsFromDays = (days: number): "NET15" | "NET30" | "COD" =>
  days <= 0 ? "COD" : days <= 15 ? "NET15" : "NET30";

export default function Customers() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = can("sales", "create");
  const canEdit = can("sales", "edit");
  const canDelete = can("sales", "delete");
  const { customers, addCustomer, updateCustomer, deleteCustomer, customerReceivables } = useSalesScope({ customers: true, invoices: true });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(initialForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicateTaxWarning, setDuplicateTaxWarning] = useState<string | null>(null);

  const { data: customersPage } = useCustomersPageQuery({
    page,
    pageSize: 25,
    q: search,
  });

  const filtered = useMemo<Customer[]>(
    () =>
      (customersPage?.customers ?? []).map((c) => ({
        id: c.id,
        displayName: c.name,
        companyName: c.company || undefined,
        customerType: c.company ? "business" : "individual",
        email: c.email || undefined,
        phone: c.phone || undefined,
        taxNumber: c.taxNumber || undefined,
        etaReceiverType: c.etaReceiverType ?? (c.company || c.taxNumber ? "B" : "P"),
        currency: c.currency === "SAR" || c.currency === "AED" || c.currency === "EGP" ? c.currency : "USD",
        paymentTerms: termsFromDays(c.paymentTermsDays),
        creditLimit: c.creditLimit,
        billingAddress: c.billingAddress || undefined,
        shippingAddress: c.shippingAddress || undefined,
        notes: c.notes || undefined,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    [customersPage]
  );

  const openDialog = (customer?: Customer) => {
    if (customer) {
      setEditing(customer);
      setForm({
        displayName: customer.displayName,
        companyName: customer.companyName ?? "",
        customerType: customer.customerType,
        contactFirstName: customer.contactFirstName ?? "",
        contactLastName: customer.contactLastName ?? "",
        email: customer.email ?? "",
        phone: customer.phone ?? "",
        taxNumber: customer.taxNumber ?? "",
        etaReceiverType: customer.etaReceiverType ?? (customer.customerType === "business" ? "B" : "P"),
        currency: customer.currency,
        paymentTerms: customer.paymentTerms,
        creditLimit: customer.creditLimit ?? null,
        billingAddress: customer.billingAddress ?? "",
        shippingAddress: customer.shippingAddress ?? "",
        notes: customer.notes ?? "",
      });
    } else {
      setEditing(null);
      setForm(initialForm);
    }
    setErrors({});
    setDuplicateTaxWarning(null);
    setOpen(true);
  };

  const saveCustomerAction = useIdempotentAction(async (confirmDuplicate: boolean = false) => {
    const result = customerSchema.safeParse(form);
    if (!result.success) {
      const next: Record<string, string> = {};
      result.error.errors.forEach(err => {
        if (err.path[0]) next[String(err.path[0])] = err.message;
      });
      setErrors(next);
      toast({ variant: "destructive", title: t("common.error"), description: Object.values(next)[0] });
      return;
    }

    const payload = {
      displayName: form.displayName.trim(),
      companyName: form.companyName,
      customerType: form.customerType,
      contactFirstName: form.contactFirstName,
      contactLastName: form.contactLastName,
      email: form.email,
      phone: form.phone,
      taxNumber: form.taxNumber,
      etaReceiverType: form.etaReceiverType ?? (form.customerType === "business" ? "B" : "P"),
      currency: form.currency,
      paymentTerms: form.paymentTerms,
      creditLimit: form.creditLimit === undefined ? null : form.creditLimit,
      billingAddress: form.billingAddress,
      shippingAddress: form.shippingAddress,
      notes: form.notes,
      confirmDuplicate,
    };

    const err = await (editing ? updateCustomer(editing.id, payload) : addCustomer(payload));
    if (err) {
      if (err.startsWith("DUPLICATE_TAX_NUMBER_WARNING:")) {
        setDuplicateTaxWarning(err.slice("DUPLICATE_TAX_NUMBER_WARNING:".length));
        return { ok: false, status: 409 };
      }
      toast({ variant: "destructive", title: t("common.error"), description: err });
      return { ok: false };
    }
    setDuplicateTaxWarning(null);
    toast({ title: editing ? t("customers.customerUpdated") : t("customers.customerCreated") });
    setOpen(false);
    setEditing(null);
    setForm(initialForm);
    return { ok: true };
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void saveCustomerAction.run(false);
  };

  const termsLabel = (terms: Customer["paymentTerms"]) =>
    terms === "NET15" ? t("vendors.paymentTerms.net15")
      : terms === "NET30" ? t("vendors.paymentTerms.net30")
      : t("vendors.paymentTerms.cod");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("customers.title")}</h1>
          <p className="text-muted-foreground">{t("customers.description")}</p>
        </div>
        {canCreate && (
          <Button onClick={() => openDialog()}>
            <Plus className="me-2 h-4 w-4" />
            {t("customers.addCustomer")}
          </Button>
        )}
      </div>

      {customers.length === 0 && (customersPage?.pageInfo?.total ?? 0) === 0 && !search.trim() ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <Users className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="mt-6 text-xl font-semibold">{t("customers.noCustomers")}</h3>
          <p className="mt-2 text-center text-muted-foreground max-w-sm">{t("customers.noCustomersDescription")}</p>
          {canCreate && (
            <Button className="mt-6" onClick={() => openDialog()}>
              <Plus className="me-2 h-4 w-4" />
              {t("customers.createFirstCustomer")}
            </Button>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <CardTitle>{t("customers.allCustomers")}</CardTitle>
              <div className="relative w-72">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("customers.searchPlaceholder")}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
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
                  <TableHead>{t("customers.customerName")}</TableHead>
                  <TableHead>{t("customers.contactPerson")}</TableHead>
                  <TableHead>{t("vendors.email")}</TableHead>
                  <TableHead>{t("vendors.phone")}</TableHead>
                  <TableHead>{t("customers.paymentTermsLabel")}</TableHead>
                  <TableHead className="text-end">{t("customers.receivables")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      {t("customers.noResults")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map(customer => (
                    <TableRow
                      key={customer.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/sales/customers/${customer.id}`)}
                    >
                      <TableCell className="font-medium">
                        <Link
                          to={`/sales/customers/${customer.id}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {customer.displayName}
                        </Link>
                        {customer.companyName && (
                          <span className="block text-xs text-muted-foreground">{customer.companyName}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {[customer.contactFirstName, customer.contactLastName].filter(Boolean).join(" ") || "-"}
                      </TableCell>
                      <TableCell>{customer.email || "-"}</TableCell>
                      <TableCell>{customer.phone || "-"}</TableCell>
                      <TableCell><Badge variant="outline">{termsLabel(customer.paymentTerms)}</Badge></TableCell>
                      <TableCell className="text-end font-medium">
                        {customer.currency} {customerReceivables(customer.id).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-end" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-2">
                          {canEdit && (
                            <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => openDialog(customer)}>
                              <Edit className="h-4 w-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button variant="ghost" size="icon" title={t("common.delete")} onClick={() => setDeleteId(customer.id)}>
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
            <TablePagination pageInfo={customersPage?.pageInfo} onPageChange={setPage} />
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={saveCustomerAction.guardOpenChange((o) => { setOpen(o); if (!o) setDuplicateTaxWarning(null); })}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" locked={saveCustomerAction.isPending}>
          <DialogHeader>
            <DialogTitle>{editing ? t("customers.editCustomer") : t("customers.addNewCustomer")}</DialogTitle>
            <DialogDescription>{t("customers.formDescription")}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="displayName">
                  {t("customers.displayName")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="displayName"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  className={errors.displayName ? "border-destructive" : ""}
                />
                {errors.displayName && <p className="text-sm text-destructive">{errors.displayName}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerType">{t("customers.customerType")}</Label>
                <Select
                  value={form.customerType}
                  onValueChange={(v: FormData["customerType"]) => setForm({ ...form, customerType: v })}
                >
                  <SelectTrigger id="customerType"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="business">{t("customers.business")}</SelectItem>
                    <SelectItem value="individual">{t("customers.individual")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="companyName">{t("customers.companyName")}</Label>
              <Input id="companyName" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="contactFirstName">{t("vendors.contactFirstName")}</Label>
                <Input id="contactFirstName" value={form.contactFirstName} onChange={(e) => setForm({ ...form, contactFirstName: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactLastName">{t("vendors.contactLastName")}</Label>
                <Input id="contactLastName" value={form.contactLastName} onChange={(e) => setForm({ ...form, contactLastName: e.target.value })} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email">{t("vendors.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className={errors.email ? "border-destructive" : ""}
                />
                {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t("vendors.phone")}</Label>
                <Input id="phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="taxNumber">{t("customers.taxNumber")}</Label>
                <Input id="taxNumber" value={form.taxNumber} onChange={(e) => setForm({ ...form, taxNumber: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="etaReceiverType">{t("customers.etaReceiverType", "ETA Receiver Type")}</Label>
                <Select
                  value={form.etaReceiverType ?? "B"}
                  onValueChange={(v: "B" | "P" | "F") => setForm({ ...form, etaReceiverType: v })}
                >
                  <SelectTrigger id="etaReceiverType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="B">{t("customers.etaBusiness", "B — Business (RIN)")}</SelectItem>
                    <SelectItem value="P">{t("customers.etaPerson", "P — Person (National ID)")}</SelectItem>
                    <SelectItem value="F">{t("customers.etaForeigner", "F — Foreign Buyer")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="creditLimit">
                  {t("customers.creditLimit")} ({t("customers.blankUnlimited", "blank = unlimited, 0 = strict COD")})
                </Label>
                <Input
                  id="creditLimit"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={t("customers.unlimited", "Unlimited")}
                  value={form.creditLimit === null || form.creditLimit === undefined ? "" : form.creditLimit}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      creditLimit: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="currency">{t("vendors.currency")}</Label>
                <Select value={form.currency} onValueChange={(v: FormData["currency"]) => setForm({ ...form, currency: v })}>
                  <SelectTrigger id="currency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SAR">SAR</SelectItem>
                    <SelectItem value="AED">AED</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EGP">EGP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="paymentTerms">{t("customers.paymentTermsLabel")}</Label>
                <Select value={form.paymentTerms} onValueChange={(v: FormData["paymentTerms"]) => setForm({ ...form, paymentTerms: v })}>
                  <SelectTrigger id="paymentTerms"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NET15">{t("vendors.paymentTerms.net15")}</SelectItem>
                    <SelectItem value="NET30">{t("vendors.paymentTerms.net30")}</SelectItem>
                    <SelectItem value="COD">{t("vendors.paymentTerms.cod")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="billingAddress">{t("customers.billingAddress")}</Label>
                <Textarea id="billingAddress" rows={3} value={form.billingAddress} onChange={(e) => setForm({ ...form, billingAddress: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shippingAddress">{t("customers.shippingAddress")}</Label>
                <Textarea id="shippingAddress" rows={3} value={form.shippingAddress} onChange={(e) => setForm({ ...form, shippingAddress: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">{t("customers.notes")}</Label>
              <Textarea id="notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            {duplicateTaxWarning && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-2">
                <p className="font-medium text-amber-900 dark:text-amber-200">{t("common.confirmDuplicateTaxTitle")}</p>
                <p className="text-muted-foreground">{duplicateTaxWarning}</p>
                <SubmitButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  pending={saveCustomerAction.isPending}
                  isSlow={saveCustomerAction.isSlow}
                  onClick={() => void saveCustomerAction.run(true)}
                >
                  {t("common.confirmDuplicateTaxAction")}
                </SubmitButton>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saveCustomerAction.isPending}
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <SubmitButton
                type="submit"
                pending={saveCustomerAction.isPending}
                isSlow={saveCustomerAction.isSlow}
              >
                {editing ? t("common.save") : t("customers.addCustomer")}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
        onConfirm={async () => {
          if (deleteId !== null) {
            const res = await deleteCustomer(deleteId);
            if (res.ok === false) {
              toast({ title: t("common.error"), description: res.error, variant: "destructive" });
            } else {
              toast({ title: t("customers.customerDeleted") });
            }
            setDeleteId(null);
          }
        }}
        itemName={customers.find(c => c.id === deleteId)?.displayName}
      />
    </div>
  );
}
