import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Loader2, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import MovementHistoryTable from "@/components/inventory/MovementHistoryTable";
import { useBranch } from "@/contexts/BranchContext";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useMovementsCursorQuery } from "@/hooks/queries/useInventoryQueries";
import type { StockMovement } from "@/types";

export default function MovementHistory() {
  const { t } = useTranslation();
  const { activeBranchId } = useBranch();
  const { products, branches } = useInventoryScope({ products: true });
  const [search, setSearch] = useState("");

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useMovementsCursorQuery({
    branchId: activeBranchId,
    q: search,
    limit: 50,
  });

  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);
  const branchMap = useMemo(() => new Map(branches.map((b) => [b.branchId, b])), [branches]);

  const movements = useMemo<StockMovement[]>(
    () =>
      (data?.pages ?? [])
        .flatMap((p) => p.movements ?? [])
        .map((m) => {
          const prod = productMap.get(m.productId);
          const br = branchMap.get(m.branchId);
          return {
            id: m.id,
            productId: m.productId,
            branchId: m.branchId,
            product_name: prod?.product_name ?? "",
            product_sku: prod?.product_sku ?? "",
            branchName: br?.branch_name,
            type: m.type,
            quantity: m.qtyDelta,
            unitCost: m.unitCost,
            reference: m.referenceNumber || undefined,
            notes: m.notes || undefined,
            createdAt: m.createdAt,
            balanceAfter: m.balanceAfter,
          };
        }),
    [branchMap, data, productMap]
  );

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
          <CardDescription>{movements.length} movements loaded</CardDescription>
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
          {isLoading ? (
            <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
          ) : (
            <MovementHistoryTable movements={movements} showProduct showBranch />
          )}
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
        </CardContent>
      </Card>
    </div>
  );
}
