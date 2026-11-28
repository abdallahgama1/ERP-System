import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useCompaniesQuery, useCompanyMutations } from "@/hooks/queries/useCompaniesQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function CompaniesTab() {
  const { t } = useTranslation();
  const { activeCompanyId } = useAuth();
  const { can } = usePermissions();
  const companiesQuery = useCompaniesQuery();
  const { createCompany, switchCompany } = useCompanyMutations();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [einvoicingMode, setEinvoicingMode] = useState<"none" | "zatca_qr" | "zatca_phase2" | "eta_egypt">("none");

  const companies = companiesQuery.data?.companies ?? [];
  const canCreate = can("companies", "create");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) {
      toast.error(t("companies.codeAndNameRequired", "Company code and name are required"));
      return;
    }
    try {
      await createCompany.mutateAsync({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        baseCurrency: baseCurrency.trim().toUpperCase() || "USD",
        einvoicingMode,
      });
      setCode("");
      setName("");
      toast.success(t("companies.created", "Company created with default branch, chart of accounts, and role presets"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            {t("companies.title", "Companies & Subsidiaries")}
          </CardTitle>
          <CardDescription>
            {t(
              "companies.description",
              "Manage isolated legal entities and switch the active tenant workspace."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.code", "Code")}</TableHead>
                  <TableHead>{t("common.name", "Name")}</TableHead>
                  <TableHead>{t("settings.currency", "Currency")}</TableHead>
                  <TableHead>{t("common.status", "Status")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companiesQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                ) : (
                  companies.map((c) => {
                    const isCurrent = c.id === activeCompanyId;
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono font-medium">{c.code}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{c.name}</span>
                            {c.isDefault && <Badge variant="secondary">Primary</Badge>}
                          </div>
                        </TableCell>
                        <TableCell>{c.baseCurrency}</TableCell>
                        <TableCell>
                          <Badge variant={c.isActive ? "default" : "outline"}>
                            {c.isActive ? t("common.active") : t("common.inactive", "Inactive")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-end">
                          {isCurrent ? (
                            <Badge variant="outline" className="gap-1">
                              <Check className="h-3 w-3" />
                              {t("companies.active", "Active")}
                            </Badge>
                          ) : (
                            <SubmitButton
                              type="button"
                              size="sm"
                              variant="outline"
                              hideSlowText
                              pending={switchCompany.isPending}
                              onClick={() =>
                                void switchCompany
                                  .mutateAsync(c.id)
                                  .then(() => toast.success(`Switched to ${c.name}`))
                                  .catch((err) =>
                                    toast.error(err instanceof Error ? err.message : t("common.error"))
                                  )
                              }
                            >
                              {t("companies.switch", "Switch")}
                            </SubmitButton>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {canCreate && (
            <form onSubmit={handleCreate} className="space-y-4 border-t pt-4">
              <h3 className="text-sm font-semibold">{t("companies.createNew", "Create New Company")}</h3>
              <div className="grid gap-3 sm:grid-cols-4 items-end">
                <div className="space-y-1">
                  <Label htmlFor="new-company-code">{t("common.code", "Code")}</Label>
                  <Input
                    id="new-company-code"
                    placeholder="COMP-02"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-company-name">{t("common.name", "Name")}</Label>
                  <Input
                    id="new-company-name"
                    placeholder="Subsidiary LLC"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-company-currency">{t("settings.currency", "Base Currency")}</Label>
                  <Input
                    id="new-company-currency"
                    placeholder="EUR"
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                    maxLength={10}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("settings.accounting.einvoicingMode", "E-Invoicing")}</Label>
                  <Select
                    value={einvoicingMode}
                    onValueChange={(v) =>
                      setEinvoicingMode(v as "none" | "zatca_qr" | "zatca_phase2" | "eta_egypt")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="zatca_qr">ZATCA QR</SelectItem>
                      <SelectItem value="zatca_phase2">ZATCA Phase 2</SelectItem>
                      <SelectItem value="eta_egypt">ETA Egypt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <SubmitButton type="submit" pending={createCompany.isPending}>
                <Plus className="h-4 w-4 me-2" />
                {t("companies.createButton", "Create Company")}
              </SubmitButton>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
