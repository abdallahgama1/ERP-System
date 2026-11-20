import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import MovementHistoryTable from "./MovementHistoryTable";
import { useInventory } from "@/contexts/InventoryContext";

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
  const { branches, movements } = useInventory();

  const allMovements = movements.filter((m) => m.productId === productId);
  const generalPoolMovements = allMovements.filter(
    (m) => m.branchId === undefined && (m.type === "initial" || m.type === "assignment" || m.type === "adjustment"),
  );

  const branchesWithMovements = branches.filter((branch) =>
    allMovements.some((m) => m.branchId === branch.branchId),
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
      </DialogContent>
    </Dialog>
  );
};

export default ProductLedgerDialog;
