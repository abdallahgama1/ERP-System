import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, Search, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { useAuditLogsCursorQuery } from "@/hooks/queries/useAuditLogsCursorQuery";
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

export default function AuditLog() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [module, setModule] = useState<AuditModule | "all">("all");

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
              <TableHead>{t("auditLog.user", "User")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {t("auditLog.empty", "No audit entries yet")}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((e) => (
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
                  <TableCell className="text-sm">{e.user || "—"}</TableCell>
                </TableRow>
              ))
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
    </div>
  );
}
