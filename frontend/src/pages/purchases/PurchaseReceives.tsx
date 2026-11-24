import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Plus, Search, Eye, Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { usePermissions } from "@/contexts/PermissionsContext";

const PurchaseReceives = () => {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const canCreate = can("purchases", "create");
  const { purchaseOrders, receives } = usePurchasingScope({ purchaseOrders: true, receives: true, vendors: true, products: true });
  const [searchTerm, setSearchTerm] = useState("");

  const receivablePOs = purchaseOrders.filter(
    (po) => po.status === "Issued" || po.status === "Partially Received",
  );

  const filteredReceives = receives.filter(
    (receive) =>
      receive.receiveNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      receive.poNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      receive.vendorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      receive.branchName.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const formatDate = (dateString: string) => new Date(dateString).toLocaleDateString();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("purchaseReceives.title")}</h1>
          <p className="text-muted-foreground">{t("purchaseReceives.description")}</p>
        </div>
      </div>

      {/* Pending POs Section */}
      {receivablePOs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("purchaseReceives.pendingOrders")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("purchaseOrders.poNumber")}</TableHead>
                  <TableHead>{t("purchaseOrders.vendor")}</TableHead>
                  <TableHead>{t("purchaseOrders.expectedDate")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receivablePOs.map((po) => (
                  <TableRow key={po.id}>
                    <TableCell className="font-medium">{po.poNumber}</TableCell>
                    <TableCell>{po.vendorName}</TableCell>
                    <TableCell>{formatDate(po.expectedDate)}</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          po.status === "Issued"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
                            : "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
                        }
                      >
                        {t(`purchaseOrders.statuses.${po.status.toLowerCase().split(" ").join("_")}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      {canCreate && (
                        <Button asChild size="sm">
                          <Link to={`/purchases/receives/new?poId=${po.id}`}>
                            <Package className="me-2 h-4 w-4" />
                            {t("purchaseReceives.receiveItems")}
                          </Link>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Receives History (Immutable GRNs — corrections use Purchase Returns or Stock Adjustments) */}
      {receives.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <Package className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="mt-6 text-xl font-semibold">{t("purchaseReceives.noReceives")}</h3>
          <p className="mt-2 text-center text-muted-foreground max-w-sm">
            {t("purchaseReceives.noReceivesDescription")}
          </p>
          {receivablePOs.length > 0 && canCreate && (
            <Button className="mt-6" asChild>
              <Link to={`/purchases/receives/new?poId=${receivablePOs[0].id}`}>
                <Plus className="me-2 h-4 w-4" />
                {t("purchaseReceives.receiveFirstOrder")}
              </Link>
            </Button>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t("purchaseReceives.allReceives")}</CardTitle>
              <div className="relative w-72">
                <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("purchaseReceives.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="ps-9"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("purchaseReceives.receiveNumber")}</TableHead>
                  <TableHead>{t("purchaseOrders.poNumber")}</TableHead>
                  <TableHead>{t("purchaseOrders.vendor")}</TableHead>
                  <TableHead>{t("purchaseReceives.branch")}</TableHead>
                  <TableHead>{t("purchaseReceives.receiveDate")}</TableHead>
                  <TableHead className="text-center">{t("purchaseReceives.itemsCount")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReceives.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">
                      {t("purchaseReceives.noResults")}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredReceives.map((receive) => (
                    <TableRow key={receive.id}>
                      <TableCell className="font-medium">{receive.receiveNumber}</TableCell>
                      <TableCell>{receive.poNumber}</TableCell>
                      <TableCell>{receive.vendorName}</TableCell>
                      <TableCell>{receive.branchName}</TableCell>
                      <TableCell>{formatDate(receive.receiveDate)}</TableCell>
                      <TableCell className="text-center">{receive.items.length}</TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="icon" asChild title={t("common.view")}>
                            <Link to={`/purchases/receives/${receive.id}`}>
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default PurchaseReceives;
