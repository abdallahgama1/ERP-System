import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StockMovement, StockMovementType } from "@/types";
import { ArrowUpCircle, ArrowDownCircle, RefreshCw, Package, FileText, RotateCcw, ArrowRightLeft, Trash2, AlertTriangle, Undo2 } from "lucide-react";

interface MovementHistoryTableProps {
  movements: StockMovement[];
  showProduct?: boolean;
  showBranch?: boolean;
}

const MovementHistoryTable = ({ movements, showProduct = true, showBranch = false }: MovementHistoryTableProps) => {
  const { t } = useTranslation();

  const getMovementTypeConfig = (type: StockMovementType) => {
    const configs: Record<StockMovementType, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
      initial: { 
        label: t("movements.initial"), 
        variant: "default",
        icon: <Package className="h-3.5 w-3.5" />
      },
      assignment: { 
        label: t("movements.assignment"), 
        variant: "secondary",
        icon: <ArrowRightLeft className="h-3.5 w-3.5" />
      },
      adjustment: { 
        label: t("movements.adjustment"), 
        variant: "outline",
        icon: <RefreshCw className="h-3.5 w-3.5" />
      },
      transfer_in: { 
        label: t("movements.transferIn"), 
        variant: "default",
        icon: <ArrowDownCircle className="h-3.5 w-3.5" />
      },
      transfer_out: { 
        label: t("movements.transferOut"), 
        variant: "destructive",
        icon: <ArrowUpCircle className="h-3.5 w-3.5" />
      },
      sales_fulfillment: {
        label: t("movements.salesFulfillment"),
        variant: "destructive",
        icon: <ArrowUpCircle className="h-3.5 w-3.5" />
      },
      sales_return: {
        label: t("movements.salesReturn"),
        variant: "secondary",
        icon: <ArrowDownCircle className="h-3.5 w-3.5" />
      },
      session_count: { 
        label: t("movements.sessionCount"), 
        variant: "outline",
        icon: <FileText className="h-3.5 w-3.5" />
      },
      return: { 
        label: t("movements.return"), 
        variant: "secondary",
        icon: <RotateCcw className="h-3.5 w-3.5" />
      },
      purchase_receive: { 
        label: t("movements.purchaseReceive"), 
        variant: "default",
        icon: <ArrowDownCircle className="h-3.5 w-3.5" />
      },
      receive_no_po: {
        label: t("movements.receiveNoPo"),
        variant: "default",
        icon: <ArrowDownCircle className="h-3.5 w-3.5" />,
      },
      adjustment_in: {
        label: t("movements.adjustmentIn"),
        variant: "secondary",
        icon: <ArrowUpCircle className="h-3.5 w-3.5" />,
      },
      adjustment_out: {
        label: t("movements.adjustmentOut"),
        variant: "outline",
        icon: <ArrowDownCircle className="h-3.5 w-3.5" />,
      },
      write_off: {
        label: t("movements.writeOff"),
        variant: "destructive",
        icon: <Trash2 className="h-3.5 w-3.5" />,
      },
      damage: {
        label: t("movements.damage"),
        variant: "destructive",
        icon: <AlertTriangle className="h-3.5 w-3.5" />,
      },
      return_to_vendor: {
        label: t("movements.returnToVendor"),
        variant: "outline",
        icon: <Undo2 className="h-3.5 w-3.5" />,
      },
      opening_balance: {
        label: t("movements.initial"),
        variant: "default",
        icon: <Package className="h-3.5 w-3.5" />,
      },
      stock_take: {
        label: t("movements.sessionCount"),
        variant: "outline",
        icon: <FileText className="h-3.5 w-3.5" />,
      },
      purchase_return: {
        label: t("movements.returnToVendor"),
        variant: "outline",
        icon: <Undo2 className="h-3.5 w-3.5" />,
      },
      sales_invoice: {
        label: t("movements.salesFulfillment"),
        variant: "destructive",
        icon: <ArrowUpCircle className="h-3.5 w-3.5" />,
      },
    };
    return configs[type];
  };

  if (movements.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t("movements.noMovements")}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("movements.date")}</TableHead>
          {showProduct && <TableHead>{t("movements.product")}</TableHead>}
          {showBranch && <TableHead>{t("movements.branch")}</TableHead>}
          <TableHead>{t("movements.type")}</TableHead>
          <TableHead className="text-right">{t("movements.change")}</TableHead>
          <TableHead className="text-right">{t("movements.balance")}</TableHead>
          <TableHead>{t("movements.reference")}</TableHead>
          <TableHead>{t("movements.notes")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {movements.map((movement) => {
          const typeConfig = getMovementTypeConfig(movement.type);
          return (
            <TableRow key={movement.id}>
              <TableCell className="whitespace-nowrap">
                {format(new Date(movement.createdAt), "MMM d, yyyy HH:mm")}
              </TableCell>
              {showProduct && (
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{movement.product_name}</span>
                    <span className="text-xs text-muted-foreground">{movement.product_sku}</span>
                  </div>
                </TableCell>
              )}
              {showBranch && (
                <TableCell>{movement.branchName || "-"}</TableCell>
              )}
              <TableCell>
                <Badge variant={typeConfig.variant} className="gap-1">
                  {typeConfig.icon}
                  {typeConfig.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono">
                <span className={movement.quantity >= 0 ? "text-green-600" : "text-red-600"}>
                  {movement.quantity >= 0 ? "+" : ""}{movement.quantity}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono font-medium">
                {movement.balanceAfter}
              </TableCell>
              <TableCell className="text-sm">{movement.reference || "-"}</TableCell>
              <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                {movement.notes || "-"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export default MovementHistoryTable;
