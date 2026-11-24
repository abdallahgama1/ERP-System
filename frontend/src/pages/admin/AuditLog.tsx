import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, History, Loader2, Search, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import { useAuditLogsCursorQuery, type AuditLogItem } from "@/hooks/queries/useAuditLogsCursorQuery";
import type { AuditModule } from "@/types";

const MODULES: (AuditModule | "all")[] = [
  "all",
  "inventory",
  "purchases",
  "sales",
  "sessions",
  "users",
  "settings",
  "transfers",
  "adjustments",
  "write_offs",
];

function formatDiffJson(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AuditLog() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [module, setModule] = useState<AuditModule | "all">("all");
  const [inspectEntry, setInspectEntry] = useState<AuditLogItem | null>(null);

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useAuditLogsCursorQuery({ module, q, limit: 50 });

  const filtered = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.entries ?? []),
    [data]
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <History className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">{t("pages.admin.auditLog.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("pages.admin.auditLog.description")}</p>
          </div>
        </div>
        <Badge variant="outline" className="gap-1.5 py-1.5 px-3">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          {t("auditLog.immutable", "Append-only ledger")}
        </Badge>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative max-w-sm flex-1 min-w-[200px]">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("common.search")}
              className="ps-9"
            />
          </div>
          <Select value={module} onValueChange={(v) => setModule(v as AuditModule | "all")}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODULES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m === "all" ? t("common.all", "All modules") : m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("movements.date")}</TableHead>
              <TableHead>{t("auditLog.module", "Module")}</TableHead>
              <TableHead>{t("auditLog.action", "Action")}</TableHead>
              <TableHead>{t("auditLog.entity", "Entity")}</TableHead>
              <TableHead>{t("auditLog.changedFields", "Changed Fields")}</TableHead>
              <TableHead>{t("auditLog.user", "User")}</TableHead>
              <TableHead className="text-end">{t("common.details", "Diff")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  {t("auditLog.empty", "No audit entries yet")}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((e) => {
                const changedFields = Array.isArray(e.changedFields) ? e.changedFields : [];
                const hasDiff = Boolean(e.beforeJson || e.afterJson || changedFields.length > 0);
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {format(new Date(e.at), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{e.module}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{e.action}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {e.entity ? `${e.entity}${e.entityId ? ` #${e.entityId}` : ""}` : "—"}
                    </TableCell>
                    <TableCell>
                      {changedFields.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {changedFields.slice(0, 4).map((field) => (
                            <Badge key={field} variant="secondary" className="text-[10px] font-mono">
                              {field}
                            </Badge>
                          ))}
                          {changedFields.length > 4 && (
                            <Badge variant="outline" className="text-[10px]">
                              +{changedFields.length - 4}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{e.user || "—"}</TableCell>
                    <TableCell className="text-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setInspectEntry(e)}
                        aria-label={t("auditLog.viewDiff", "View Diff")}
                      >
                        <Eye className="h-4 w-4 me-1" />
                        {hasDiff ? t("auditLog.viewDiff", "View Diff") : t("common.details", "Details")}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        {hasNextPage && (
          <div className="flex justify-center pt-4">
            <Button
              variant="outline"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("common.loadMore", "Load more")}
            </Button>
          </div>
        )}
      </Card>

      {/* Before / After Diff Viewer Dialog */}
      <Dialog open={inspectEntry !== null} onOpenChange={(open) => !open && setInspectEntry(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="audit-diff-dialog">
          <DialogHeader>
            <DialogTitle>{t("auditLog.diffViewerTitle", "Audit Entry Diff")}</DialogTitle>
            <DialogDescription>
              {inspectEntry
                ? `${inspectEntry.module} · ${inspectEntry.action} · ${inspectEntry.user || "System"} · ${format(
                    new Date(inspectEntry.at),
                    "yyyy-MM-dd HH:mm:ss"
                  )}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {inspectEntry && (
            <div className="space-y-4">
              {Array.isArray(inspectEntry.changedFields) && inspectEntry.changedFields.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("auditLog.changedFields", "Changed Fields")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {inspectEntry.changedFields.map((field) => (
                      <Badge key={field} variant="secondary" className="font-mono text-xs">
                        {field}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("auditLog.before", "Before")}
                  </p>
                  <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">
                    {formatDiffJson(inspectEntry.beforeJson)}
                  </pre>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("auditLog.after", "After")}
                  </p>
                  <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">
                    {formatDiffJson(inspectEntry.afterJson)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
