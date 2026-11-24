import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import MovementHistoryTable from "./MovementHistoryTable";
import {
  mapApiBranch,
  mapApiMovement,
  useBranchesDirectoryQuery,
  useMovementsQuery,
} from "@/hooks/queries/useInventoryQueries";
import type { Product } from "@/types";

interface ProductLedgerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  productName: string;
  productSku: string;
}

const ProductLedgerDialog = ({
  open,
  onOpenChange,
  productId,
  productName,
  productSku,
}: ProductLedgerDialogProps) => {
  const { t } = useTranslation();
  const branchesQuery = useBranchesDirectoryQuery(open);
  const movementsQuery = useMovementsQuery(undefined, productId, open && Boolean(productId));

  const branches = useMemo(
    () => (branchesQuery.data?.branches ?? []).map(mapApiBranch),
    [branchesQuery.data]
  );

  const allMovements = useMemo(() => {
    const branchMap = new Map(branches.map((b) => [b.branchId, b]));
    const productMap = new Map<string, Product>([
      [
        productId,
        {
          productId,
          product_name: productName,
          product_sku: productSku,
          quantity: 0,
          sellingPrice: 0,
          costPrice: 0,
          brand: "",
          category: "",
        },
      ],
    ]);
    return (movementsQuery.data?.movements ?? [])
      .filter((m) => m.productId === productId)
      .map((m) => mapApiMovement(m, productMap, branchMap));
  }, [movementsQuery.data, branches, productId, productName, productSku]);

  const generalPoolMovements = useMemo(
    () =>
      allMovements.filter(
        (m) => m.branchId === undefined && (m.type === "initial" || m.type === "assignment" || m.type === "adjustment")
      ),
    [allMovements]
  );

  const branchesWithMovements = useMemo(
    () => branches.filter((branch) => allMovements.some((m) => m.branchId === branch.branchId)),
    [branches, allMovements]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("movements.stockLedger")}
          </DialogTitle>
          <DialogDescription>
            {productName} ({productSku}) - {t("movements.ledgerDescription")}
          </DialogDescription>
        </DialogHeader>

        {movementsQuery.isLoading ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="all">{t("movements.allMovements")}</TabsTrigger>
              <TabsTrigger value="general">{t("movements.generalPool")}</TabsTrigger>
              {branchesWithMovements.map((branch) => (
                <TabsTrigger key={branch.branchId} value={`branch-${branch.branchId}`}>
                  {branch.branch_name}
                </TabsTrigger>
              ))}
            </TabsList>

            <ScrollArea className="h-[500px]">
              <TabsContent value="all">
                <MovementHistoryTable movements={allMovements} showProduct={false} showBranch={true} />
              </TabsContent>

              <TabsContent value="general">
                <MovementHistoryTable movements={generalPoolMovements} showProduct={false} showBranch={false} />
              </TabsContent>

              {branchesWithMovements.map((branch) => (
                <TabsContent key={branch.branchId} value={`branch-${branch.branchId}`}>
                  <MovementHistoryTable
                    movements={allMovements.filter((m) => m.branchId === branch.branchId)}
                    showProduct={false}
                    showBranch={false}
                  />
                </TabsContent>
              ))}
            </ScrollArea>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ProductLedgerDialog;
