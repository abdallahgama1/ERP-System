import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import MovementHistoryTable from "@/components/inventory/MovementHistoryTable";
import { useInventory } from "@/contexts/InventoryContext";

export default function MovementHistory() {
  const { t } = useTranslation();
  const { movements } = useInventory();
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return movements;
    return movements.filter(
      (m) =>
        m.product_name.toLowerCase().includes(q) ||
        m.product_sku.toLowerCase().includes(q) ||
        (m.branchName || "").toLowerCase().includes(q) ||
        (m.reference || "").toLowerCase().includes(q),
    );
  }, [movements, search]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <ArrowLeftRight className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t("pages.reports.movementHistory.title")}</h1>
            <p className="text-muted-foreground">{t("pages.reports.movementHistory.description")}</p>
          </div>
        </div>
        <Button variant="outline" asChild>
          <Link to="/">{t("placeholder.backToDashboard")}</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("movements.title")}</CardTitle>
          <CardDescription>{filtered.length} movements</CardDescription>
          <div className="relative mt-3">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="ps-9"
              placeholder={t("common.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          <MovementHistoryTable movements={filtered} showProduct showBranch />
        </CardContent>
      </Card>
    </div>
  );
}
