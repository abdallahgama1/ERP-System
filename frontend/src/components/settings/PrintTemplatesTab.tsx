import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  PRINT_TEMPLATE_DOC_TYPES,
  type PrintTemplateDocType,
  type PrintTemplateDto,
} from "@erp/shared";
import { usePermissions } from "@/contexts/PermissionsContext";
import {
  usePrintTemplateMutations,
  usePrintTemplatesQuery,
} from "@/hooks/queries/usePrintTemplatesQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

export function PrintTemplatesTab() {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const templatesQuery = usePrintTemplatesQuery();
  const { createPrintTemplate, updatePrintTemplate, deletePrintTemplate } = usePrintTemplateMutations();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<PrintTemplateDocType>("invoice");
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [accentColor, setAccentColor] = useState("#1d4ed8");
  const [headerHtml, setHeaderHtml] = useState("");
  const [footerHtml, setFooterHtml] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PrintTemplateDto | null>(null);

  const templates = templatesQuery.data?.templates ?? [];
  const canEdit = can("settings", "edit") || can("settings", "create");
  const canDelete = can("settings", "delete");

  const resetForm = () => {
    setEditingId(null);
    setDocumentType("invoice");
    setName("");
    setLogoUrl("");
    setAccentColor("#1d4ed8");
    setHeaderHtml("");
    setFooterHtml("");
    setIsDefault(false);
  };

  const loadIntoForm = (tpl: PrintTemplateDto) => {
    setEditingId(tpl.id);
    setDocumentType(tpl.documentType);
    setName(tpl.name);
    setLogoUrl(tpl.logoUrl ?? "");
    setAccentColor(tpl.accentColor || "#1d4ed8");
    setHeaderHtml(tpl.headerHtml ?? "");
    setFooterHtml(tpl.footerHtml ?? "");
    setIsDefault(Boolean(tpl.isDefault));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error(t("printTemplates.nameRequired", "Template name is required"));
      return;
    }
    try {
      if (editingId) {
        await updatePrintTemplate.mutateAsync({
          id: editingId,
          body: {
            name: name.trim(),
            logoUrl: logoUrl.trim() || null,
            accentColor: accentColor.trim() || "#1d4ed8",
            headerHtml,
            footerHtml,
            isDefault,
          },
        });
        toast.success(t("printTemplates.updated", "Print template updated"));
      } else {
        await createPrintTemplate.mutateAsync({
          documentType,
          name: name.trim(),
          logoUrl: logoUrl.trim() || null,
          accentColor: accentColor.trim() || "#1d4ed8",
          headerHtml,
          footerHtml,
          isDefault,
        });
        toast.success(t("printTemplates.created", "Print template created"));
      }
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deletePrintTemplate.mutateAsync(deleteTarget.id);
      toast.success(t("printTemplates.deleted", "Print template deleted"));
      if (editingId === deleteTarget.id) resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t("printTemplates.title", "Print & Email Templates")}
          </CardTitle>
          <CardDescription>
            {t(
              "printTemplates.description",
              "Customize branded headers, footers, logos, and accent colors per document type."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.name", "Template Name")}</TableHead>
                  <TableHead>{t("printTemplates.documentType", "Document Type")}</TableHead>
                  <TableHead>{t("printTemplates.accent", "Accent")}</TableHead>
                  <TableHead>{t("common.status", "Default")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templatesQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                ) : templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      {t("printTemplates.empty", "No print templates configured yet.")}
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((tpl) => (
                    <TableRow key={tpl.id}>
                      <TableCell className="font-medium">{tpl.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {tpl.documentType.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className="h-4 w-4 rounded border inline-block"
                            style={{ backgroundColor: tpl.accentColor }}
                          />
                          <span className="font-mono text-xs">{tpl.accentColor}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {tpl.isDefault ? <Badge>{t("common.default", "Default")}</Badge> : "—"}
                      </TableCell>
                      <TableCell className="text-end space-x-1">
                        {canEdit && (
                          <Button type="button" size="sm" variant="ghost" onClick={() => loadIntoForm(tpl)}>
                            {t("common.edit", "Edit")}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={t("common.delete", "Delete")}
                            onClick={() => setDeleteTarget(tpl)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {canEdit && (
            <form onSubmit={handleSave} className="space-y-4 border-t pt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {editingId
                    ? t("printTemplates.editTemplate", "Edit Print Template")
                    : t("printTemplates.createTemplate", "New Print Template")}
                </h3>
                {editingId && (
                  <Button type="button" variant="ghost" size="sm" onClick={resetForm}>
                    {t("common.cancel")}
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="tpl-name">{t("common.name", "Template Name")}</Label>
                  <Input
                    id="tpl-name"
                    placeholder="Modern Invoice A4"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("printTemplates.documentType", "Document Type")}</Label>
                  <Select
                    value={documentType}
                    onValueChange={(v) => setDocumentType(v as PrintTemplateDocType)}
                    disabled={Boolean(editingId)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRINT_TEMPLATE_DOC_TYPES.map((dt) => (
                        <SelectItem key={dt} value={dt} className="capitalize">
                          {dt.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tpl-logo">{t("printTemplates.logoUrl", "Logo URL")}</Label>
                  <Input
                    id="tpl-logo"
                    placeholder="/logo.png or https://..."
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tpl-accent">{t("printTemplates.accentColor", "Accent Color")}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="tpl-accent"
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      placeholder="#1d4ed8"
                    />
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : "#1d4ed8"}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="h-9 w-12 rounded border p-0.5 cursor-pointer"
                      aria-label="Pick accent color"
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="tpl-header">{t("printTemplates.headerHtml", "Header HTML")}</Label>
                  <Textarea
                    id="tpl-header"
                    rows={3}
                    placeholder="<div>Company Header</div>"
                    value={headerHtml}
                    onChange={(e) => setHeaderHtml(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tpl-footer">{t("printTemplates.footerHtml", "Footer HTML")}</Label>
                  <Textarea
                    id="tpl-footer"
                    rows={3}
                    placeholder="<div>Thank you for your business</div>"
                    value={footerHtml}
                    onChange={(e) => setFooterHtml(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between flex-wrap gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Switch checked={isDefault} onCheckedChange={setIsDefault} />
                  {t("printTemplates.setAsDefault", "Set as default template for this document type")}
                </label>
                <Button
                  type="submit"
                  disabled={createPrintTemplate.isPending || updatePrintTemplate.isPending}
                >
                  <Plus className="h-4 w-4 me-2" />
                  {editingId
                    ? t("common.save", "Save Template")
                    : t("printTemplates.saveNew", "Create Print Template")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => void handleConfirmDelete()}
        title={t("printTemplates.deleteTitle", "Delete Print Template")}
        itemName={deleteTarget?.name}
      />
    </div>
  );
}
