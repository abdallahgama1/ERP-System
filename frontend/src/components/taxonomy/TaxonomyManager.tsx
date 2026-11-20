import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LucideIcon, Plus, Search, Edit, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useToast } from "@/hooks/use-toast";
import { useTaxonomy, TaxonomyItem, TaxonomyKind } from "@/contexts/TaxonomyContext";
import { useAuditLog } from "@/contexts/AuditLogContext";

interface TaxonomyManagerProps {
  kind: TaxonomyKind;
  title: string;
  description: string;
  icon: LucideIcon;
  /** show the short-code column/field (units of measure) */
  withCode?: boolean;
  /** show the "used by N products" column */
  withUsage?: boolean;
}

const emptyForm = { name: "", code: "", description: "" };

export function TaxonomyManager({
  kind, title, description, icon: Icon, withCode = false, withUsage = true,
}: TaxonomyManagerProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { list, addItem, updateItem, removeItem, usageCount } = useTaxonomy();
  const { record } = useAuditLog();

  const items = list(kind);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaxonomyItem | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      i => i.name.toLowerCase().includes(q) || (i.code ?? "").toLowerCase().includes(q)
    );
  }, [items, search]);

  const openAdd = () => { setEditing(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (item: TaxonomyItem) => {
    setEditing(item);
    setForm({ name: item.name, code: item.code ?? "", description: item.description ?? "" });
    setDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name: form.name.trim(),
      code: withCode ? form.code.trim() : undefined,
      description: form.description.trim() || undefined,
    };
    if (!payload.name) {
      toast({ title: t("taxonomy.nameRequired", "Name is required"), variant: "destructive" });
      return;
    }
    const error = editing ? updateItem(kind, editing.id, payload) : addItem(kind, payload);
    if (error === "duplicate") {
      toast({
        title: t("taxonomy.duplicate", "Already exists"),
        description: t("taxonomy.duplicateDescription", "Another entry already uses this name."),
        variant: "destructive",
      });
      return;
    }
    record("settings", editing ? "taxonomy.update" : "taxonomy.create", {
      entity: kind, entityId: editing?.id, meta: { name: payload.name },
    });
    toast({ title: editing ? t("taxonomy.updated", "Entry updated") : t("taxonomy.created", "Entry created") });
    setDialogOpen(false);
    setEditing(null);
    setForm(emptyForm);
  };

  const handleDeleteClick = (item: TaxonomyItem) => {
    const used = usageCount(kind, item.name);
    if (used > 0) {
      toast({
        title: t("taxonomy.cannotDelete", "Cannot delete"),
        description: t("taxonomy.inUse", {
          defaultValue: "{{count}} product(s) still use this value.",
          count: used,
        }),
        variant: "destructive",
      });
      return;
    }
    setDeleteId(item.id);
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    const item = items.find(i => i.id === deleteId);
    const error = removeItem(kind, deleteId);
    if (error) {
      toast({ title: t("taxonomy.cannotDelete", "Cannot delete"), variant: "destructive" });
    } else {
      record("settings", "taxonomy.delete", { entity: kind, entityId: deleteId, meta: { name: item?.name } });
      toast({ title: t("taxonomy.deleted", "Entry deleted") });
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="me-2 h-4 w-4" />
          {t("taxonomy.addEntry", "Add entry")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5" />
            {title}
            <Badge variant="secondary">{items.length}</Badge>
          </CardTitle>
          <CardDescription>{t("taxonomy.listDescription", "Manage the values available across the catalog.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="ps-9"
              placeholder={t("common.search", "Search")}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Icon className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">
                {items.length === 0
                  ? t("taxonomy.empty", "Nothing here yet.")
                  : t("taxonomy.noResults", "No matches for your search.")}
              </p>
              {items.length === 0 && (
                <Button onClick={openAdd}>
                  <Plus className="me-2 h-4 w-4" />
                  {t("taxonomy.addEntry", "Add entry")}
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("taxonomy.name", "Name")}</TableHead>
                  {withCode && <TableHead>{t("taxonomy.code", "Code")}</TableHead>}
                  <TableHead>{t("taxonomy.description", "Description")}</TableHead>
                  {withUsage && <TableHead className="text-end">{t("taxonomy.products", "Products")}</TableHead>}
                  <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(item => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    {withCode && <TableCell className="text-muted-foreground">{item.code || "—"}</TableCell>}
                    <TableCell className="text-muted-foreground">{item.description || "—"}</TableCell>
                    {withUsage && (
                      <TableCell className="text-end">
                        <Badge variant="secondary">{usageCount(kind, item.name)}</Badge>
                      </TableCell>
                    )}
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(item)} aria-label={t("common.edit", "Edit")}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDeleteClick(item)} aria-label={t("common.delete", "Delete")}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("taxonomy.editEntry", "Edit entry") : t("taxonomy.addEntry", "Add entry")}
            </DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tx-name">{t("taxonomy.name", "Name")}</Label>
              <Input id="tx-name" value={form.name} maxLength={80}
                onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
            {withCode && (
              <div className="space-y-2">
                <Label htmlFor="tx-code">{t("taxonomy.code", "Code")}</Label>
                <Input id="tx-code" value={form.code} maxLength={12}
                  onChange={e => setForm({ ...form, code: e.target.value })} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="tx-desc">{t("taxonomy.description", "Description")}</Label>
              <Input id="tx-desc" value={form.description} maxLength={160}
                onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {t("common.cancel", "Cancel")}
              </Button>
              <Button type="submit">{t("common.save", "Save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteId !== null}
        onOpenChange={open => !open && setDeleteId(null)}
        onConfirm={confirmDelete}
        itemName={items.find(i => i.id === deleteId)?.name}
      />
    </div>
  );
}