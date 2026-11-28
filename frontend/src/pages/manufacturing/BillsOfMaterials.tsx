import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useBomsQuery, useCreateBomMutation } from "@/hooks/queries/useManufacturingQueries";
import { useToast } from "@/hooks/use-toast";
import { formatMoney } from "@/lib/money";

interface DraftComponentLine {
  componentProductId: string;
  quantity: number;
  scrapPercent: number;
}

export default function BillsOfMaterials() {
  const { t } = useTranslation();
  const { products } = useInventoryScope({ products: true });
  const { can } = usePermissions();
  const { settings } = useSettings();
  const { toast } = useToast();

  const { data, isLoading } = useBomsQuery();
  const createBom = useCreateBomMutation();
  const boms = data?.boms ?? [];

  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [outputQty, setOutputQty] = useState("1");
  const [notes, setNotes] = useState("");
  const [components, setComponents] = useState<DraftComponentLine[]>([
    { componentProductId: "", quantity: 1, scrapPercent: 0 },
  ]);

  const canCreate = can("inventory", "create");

  const resetForm = () => {
    setProductId("");
    setName("");
    setOutputQty("1");
    setNotes("");
    setComponents([{ componentProductId: "", quantity: 1, scrapPercent: 0 }]);
  };

  const handleSubmit = async () => {
    const validComps = components.filter((c) => c.componentProductId && c.quantity > 0);
    if (!productId || !name.trim() || validComps.length === 0) {
      toast({
        title: t("common.error", "Error"),
        description: t("manufacturing.boms.validation", "Select a finished product, BOM name, and at least one component."),
        variant: "destructive",
      });
      return;
    }

    try {
      await createBom.mutateAsync({
        productId,
        name: name.trim(),
        outputQty: Math.max(0.0001, Number(outputQty) || 1),
        notes: notes.trim(),
        components: validComps,
      });
      toast({ title: t("manufacturing.boms.created", "Bill of Materials created") });
      resetForm();
      setOpen(false);
    } catch (err) {
      toast({
        title: t("common.error", "Error"),
        description: err instanceof Error ? err.message : "Failed to create BOM",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Boxes className="h-7 w-7 text-primary" />
            {t("manufacturing.boms.title", "Bills of Materials (BOM)")}
          </h1>
          <p className="text-muted-foreground">
            {t("manufacturing.boms.description", "Define multi-component recipes with scrap allowances and circular-dependency protection.")}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 me-2" />
            {t("manufacturing.boms.new", "New BOM")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">{t("common.loading", "Loading...")}</CardContent>
        </Card>
      ) : boms.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {t("manufacturing.boms.empty", "No Bills of Materials defined yet.")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {boms.map((bom) => {
            const estMaterialCost = bom.components.reduce(
              (s, c) => s + c.quantity * (1 + c.scrapPercent / 100) * c.unitCost,
              0
            );
            return (
              <Card key={bom.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <span className="font-mono text-base">{bom.bomNumber}</span>
                        <span>— {bom.name}</span>
                      </CardTitle>
                      <CardDescription>
                        {t("manufacturing.boms.output", "Output")}: <strong>{bom.outputQty}</strong> × {bom.productName} ({bom.productSku}) ·{" "}
                        {t("manufacturing.boms.estCost", "Est. Material Cost")}: {formatMoney(estMaterialCost, settings.currency)}
                      </CardDescription>
                    </div>
                    <Badge variant={bom.isActive ? "default" : "secondary"}>
                      {bom.isActive ? t("common.active", "Active") : t("common.inactive", "Inactive")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("manufacturing.boms.component", "Component")}</TableHead>
                        <TableHead className="text-end">{t("common.quantity", "Qty")}</TableHead>
                        <TableHead className="text-end">{t("manufacturing.boms.scrap", "Scrap %")}</TableHead>
                        <TableHead className="text-end">{t("manufacturing.boms.effectiveQty", "Effective Qty")}</TableHead>
                        <TableHead className="text-end">{t("products.costPrice", "Std Cost")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bom.components.map((c) => {
                        const effective = c.quantity * (1 + c.scrapPercent / 100);
                        return (
                          <TableRow key={c.id}>
                            <TableCell>
                              <div className="font-medium">{c.componentName}</div>
                              <div className="text-xs text-muted-foreground">{c.componentSku}</div>
                            </TableCell>
                            <TableCell className="text-end font-mono">{c.quantity}</TableCell>
                            <TableCell className="text-end font-mono">{c.scrapPercent}%</TableCell>
                            <TableCell className="text-end font-mono">{effective.toFixed(4).replace(/\.?0+$/, "")}</TableCell>
                            <TableCell className="text-end">{formatMoney(c.unitCost, settings.currency)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { if (!o && createBom.isPending) return; setOpen(o); if (!o) resetForm(); }}>
        <DialogContent locked={createBom.isPending} className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("manufacturing.boms.new", "New Bill of Materials")}</DialogTitle>
            <DialogDescription>
              {t("manufacturing.boms.newDesc", "Specify the finished good and raw material components required per production batch.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("manufacturing.boms.finishedGood", "Finished Product")}</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("common.select", "Select product...")} />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.productId} value={p.productId}>
                        {p.product_name} ({p.product_sku})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("manufacturing.boms.bomName", "BOM Name")}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard Assembly v1" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("manufacturing.boms.outputQty", "Output Batch Qty")}</Label>
                <Input type="number" min="0.01" step="0.01" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.notes", "Notes")}</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional production notes" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("manufacturing.boms.components", "Components")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setComponents((prev) => [...prev, { componentProductId: "", quantity: 1, scrapPercent: 0 }])}
                >
                  <Plus className="h-3.5 w-3.5 me-1" />
                  {t("common.addLine", "Add Component")}
                </Button>
              </div>
              <div className="space-y-2">
                {components.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-6">
                      <Select
                        value={line.componentProductId}
                        onValueChange={(v) =>
                          setComponents((prev) => prev.map((c, i) => (i === idx ? { ...c, componentProductId: v } : c)))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Component SKU..." />
                        </SelectTrigger>
                        <SelectContent>
                          {products
                            .filter((p) => p.productId !== productId)
                            .map((p) => (
                              <SelectItem key={p.productId} value={p.productId}>
                                {p.product_name} ({p.product_sku})
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={line.quantity}
                        onChange={(e) =>
                          setComponents((prev) =>
                            prev.map((c, i) => (i === idx ? { ...c, quantity: Number(e.target.value) || 0 } : c))
                          )
                        }
                        placeholder="Qty"
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={line.scrapPercent}
                        onChange={(e) =>
                          setComponents((prev) =>
                            prev.map((c, i) => (i === idx ? { ...c, scrapPercent: Number(e.target.value) || 0 } : c))
                          )
                        }
                        placeholder="Scrap %"
                      />
                    </div>
                    <div className="col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={components.length <= 1}
                        onClick={() => setComponents((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createBom.isPending} onClick={() => setOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <SubmitButton type="button" pending={createBom.isPending} onClick={() => void handleSubmit()}>
              {t("common.save", "Save BOM")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
