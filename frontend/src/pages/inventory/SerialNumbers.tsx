import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Barcode, History, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBranch } from "@/contexts/BranchContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useSerialsQuery, useSerialTraceQuery } from "@/hooks/queries/useTrackingQueries";
import { formatMoney } from "@/lib/money";

export default function SerialNumbers() {
  const { t } = useTranslation();
  const { activeBranchId } = useBranch();
  const { settings } = useSettings();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [traceId, setTraceId] = useState<string | null>(null);

  const { data, isLoading } = useSerialsQuery(activeBranchId, statusFilter, search);
  const { data: traceData, isLoading: traceLoading } = useSerialTraceQuery(traceId);
  const serials = data?.serials ?? [];

  const statusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === "in_stock") return "default";
    if (status === "in_transit" || status === "reserved") return "secondary";
    if (status === "written_off") return "destructive";
    return "outline";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Barcode className="h-7 w-7 text-primary" />
          {t("tracking.serials.title", "Serial Number Registry")}
        </h1>
        <p className="text-muted-foreground">
          {t("tracking.serials.description", "Trace individual serialized units from receipt through branch transfers, production, and sales.")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("tracking.serials.registry", "Serialized Units")}</CardTitle>
          <CardDescription>
            {t("tracking.serials.registryDesc", "Click Trace on any serial number to inspect its full chain of custody.")}
          </CardDescription>
          <div className="flex flex-wrap gap-3 pt-2">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="h-4 w-4 text-muted-foreground absolute start-3 top-3" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("tracking.serials.search", "Scan or type serial #, SKU, or product...")}
                className="ps-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all", "All Statuses")}</SelectItem>
                <SelectItem value="in_stock">In Stock</SelectItem>
                <SelectItem value="in_transit">In Transit</SelectItem>
                <SelectItem value="sold">Sold</SelectItem>
                <SelectItem value="consumed">Consumed (WO)</SelectItem>
                <SelectItem value="written_off">Written Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-muted-foreground">{t("common.loading", "Loading...")}</div>
          ) : serials.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {t("tracking.serials.empty", "No serialized units found.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tracking.serials.serialNumber", "Serial #")}</TableHead>
                  <TableHead>{t("products.productName", "Product")}</TableHead>
                  <TableHead>{t("branches.branch", "Branch")}</TableHead>
                  <TableHead>{t("common.status", "Status")}</TableHead>
                  <TableHead className="text-end">{t("products.costPrice", "Unit Cost")}</TableHead>
                  <TableHead>{t("common.updated", "Updated")}</TableHead>
                  <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serials.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono font-medium">{s.serialNumber}</TableCell>
                    <TableCell>
                      <div className="font-medium">{s.productName}</div>
                      <div className="text-xs text-muted-foreground">{s.productSku}</div>
                    </TableCell>
                    <TableCell>{s.branchName || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(s.status)}>{s.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-end">{formatMoney(s.unitCost, settings.currency)}</TableCell>
                    <TableCell>{new Date(s.updatedAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-end">
                      <Button variant="outline" size="sm" onClick={() => setTraceId(s.id)}>
                        <History className="h-3.5 w-3.5 me-1.5" />
                        {t("tracking.serials.trace", "Trace")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!traceId} onOpenChange={(open) => !open && setTraceId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono">
              {traceData?.serial.serialNumber ?? t("tracking.serials.trace", "Serial Trace")}
            </DialogTitle>
            <DialogDescription>
              {traceData
                ? `${traceData.serial.productName} (${traceData.serial.productSku}) — ${traceData.serial.status}`
                : t("common.loading", "Loading...")}
            </DialogDescription>
          </DialogHeader>
          {traceLoading ? (
            <div className="py-6 text-center text-muted-foreground">{t("common.loading", "Loading...")}</div>
          ) : (traceData?.history ?? []).length === 0 ? (
            <div className="py-6 text-center text-muted-foreground">
              {t("tracking.serials.noHistory", "No movement history recorded.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.date", "Date")}</TableHead>
                  <TableHead>{t("movements.type", "Movement")}</TableHead>
                  <TableHead>{t("branches.branch", "Branch")}</TableHead>
                  <TableHead>{t("common.reference", "Reference")}</TableHead>
                  <TableHead className="text-end">{t("common.quantity", "Delta")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traceData?.history.map((h) => (
                  <TableRow key={h.allocationId}>
                    <TableCell className="text-xs">{new Date(h.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{h.movementType}</Badge>
                    </TableCell>
                    <TableCell>{h.branchName ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{h.referenceNumber || "—"}</TableCell>
                    <TableCell className="text-end font-mono">{h.qtyDelta > 0 ? `+${h.qtyDelta}` : h.qtyDelta}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
