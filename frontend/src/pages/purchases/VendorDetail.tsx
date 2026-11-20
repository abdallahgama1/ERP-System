import { useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Truck, Mail, Phone, FileText, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePurchases } from "@/contexts/PurchasesContext";
import { useSettings } from "@/contexts/SettingsContext";

export default function VendorDetail() {
  const { vendorId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { vendors, purchaseOrders, receives, bills, payments, purchaseReturns, vendorPayables } = usePurchases();
  const { settings } = useSettings();

  const vendor = useMemo(() => vendors.find((v) => String(v.id) === vendorId), [vendors, vendorId]);
  const vendorPOs = useMemo(() => purchaseOrders.filter((p) => p.vendorId === vendor?.id), [purchaseOrders, vendor]);
  const vendorReceives = useMemo(() => receives.filter((r) => r.vendorId === vendor?.id), [receives, vendor]);
  const vendorBills = useMemo(() => bills.filter((b) => b.vendorId === vendor?.id), [bills, vendor]);
  const vendorPayments = useMemo(() => payments.filter((p) => p.vendorId === vendor?.id), [payments, vendor]);
  const vendorReturns = useMemo(() => purchaseReturns.filter((r) => r.vendorId === vendor?.id), [purchaseReturns, vendor]);

  const fmt = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: vendor?.currency || settings.currency || "USD" }).format(n);

  if (!vendor) {
    return (
      <div className="p-6 space-y-4">
        <Button variant="outline" onClick={() => navigate("/purchases/vendors")}>
          <ArrowLeft className="h-4 w-4 me-2" />
          {t("nav.purchases.vendors")}
        </Button>
        <Card><CardContent className="py-12 text-center text-muted-foreground">Vendor not found</CardContent></Card>
      </div>
    );
  }

  const totalPOValue = vendorPOs.reduce((s, p) => s + p.grandTotal, 0);
  const openPOs = vendorPOs.filter((p) => p.status !== "Closed" && p.status !== "Cancelled").length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Truck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{vendor.displayName}</h1>
            <p className="text-muted-foreground">{t("pages.purchases.vendorDetail.description")}</p>
          </div>
        </div>
        <Button variant="outline" asChild>
          <Link to="/purchases/vendors"><ArrowLeft className="h-4 w-4 me-2" />{t("nav.purchases.vendors")}</Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>Payables Balance</CardDescription><CardTitle className="text-2xl">{fmt(vendorPayables(vendor.id))}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Total PO Value</CardDescription><CardTitle className="text-2xl">{fmt(totalPOValue)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Open POs</CardDescription><CardTitle className="text-2xl">{openPOs}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Receives</CardDescription><CardTitle className="text-2xl">{vendorReceives.length}</CardTitle></CardHeader></Card>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="orders">Purchase Orders ({vendorPOs.length})</TabsTrigger>
          <TabsTrigger value="receives">Receives ({vendorReceives.length})</TabsTrigger>
          <TabsTrigger value="bills">Bills ({vendorBills.length})</TabsTrigger>
          <TabsTrigger value="payments">Payments ({vendorPayments.length})</TabsTrigger>
          <TabsTrigger value="returns">Returns ({vendorReturns.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <Card>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <CardContent className="grid sm:grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-muted-foreground" />{vendor.email || "—"}</div>
              <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" />{vendor.phone || "—"}</div>
              <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" />Tax: {vendor.taxNumber || "—"}</div>
              <div className="flex items-center gap-2"><Wallet className="h-4 w-4 text-muted-foreground" />Terms: {vendor.paymentTerms}</div>
              {vendor.billingAddress && <div className="sm:col-span-2"><strong>Billing:</strong> {vendor.billingAddress}</div>}
              {vendor.shippingAddress && <div className="sm:col-span-2"><strong>Shipping:</strong> {vendor.shippingAddress}</div>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders">
          <Card>
            <CardContent className="pt-6">
              {vendorPOs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No purchase orders yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>PO #</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead className="text-end">Total</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {vendorPOs.map((po) => (
                      <TableRow key={po.id} className="cursor-pointer" onClick={() => navigate(`/purchases/orders/${po.id}`)}>
                        <TableCell className="font-medium">{po.poNumber}</TableCell>
                        <TableCell>{po.orderDate}</TableCell>
                        <TableCell><Badge variant="outline">{po.status}</Badge></TableCell>
                        <TableCell className="text-end">{fmt(po.grandTotal)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receives">
          <Card>
            <CardContent className="pt-6">
              {vendorReceives.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No receives yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>GRN #</TableHead><TableHead>PO #</TableHead><TableHead>Branch</TableHead><TableHead>Date</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {vendorReceives.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.receiveNumber}</TableCell>
                        <TableCell>{r.poNumber}</TableCell>
                        <TableCell>{r.branchName}</TableCell>
                        <TableCell>{r.receiveDate}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bills">
          <Card>
            <CardContent className="pt-6">
              {vendorBills.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No bills yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Bill #</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead className="text-end">Total</TableHead><TableHead className="text-end">Balance</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {vendorBills.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium">{b.billNumber}</TableCell>
                        <TableCell>{b.dueDate}</TableCell>
                        <TableCell><Badge variant="outline">{b.status}</Badge></TableCell>
                        <TableCell className="text-end">{fmt(b.grandTotal)}</TableCell>
                        <TableCell className="text-end">{fmt(Math.max(0, b.grandTotal - b.amountPaid))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payments">
          <Card>
            <CardContent className="pt-6">
              {vendorPayments.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No payments yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Payment #</TableHead><TableHead>Date</TableHead><TableHead>Method</TableHead><TableHead>Bills</TableHead><TableHead>Status</TableHead><TableHead className="text-end">Amount</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {vendorPayments.map((p) => (
                      <TableRow key={p.id} className={p.status === "Voided" ? "opacity-60" : undefined}>
                        <TableCell className="font-medium">{p.paymentNumber}</TableCell>
                        <TableCell>{p.paymentDate}</TableCell>
                        <TableCell><Badge variant="outline">{p.method}</Badge></TableCell>
                        <TableCell className="text-sm">{p.allocations.map((a) => a.billNumber).join(", ")}</TableCell>
                        <TableCell><Badge variant={p.status === "Voided" ? "destructive" : "secondary"}>{p.status === "Voided" ? "Voided" : "Posted"}</Badge></TableCell>
                        <TableCell className="text-end">{fmt(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="returns">
          <Card>
            <CardContent className="pt-6">
              {vendorReturns.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No returns yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Return #</TableHead><TableHead>GRN #</TableHead><TableHead>Branch</TableHead><TableHead>Date</TableHead><TableHead>Reason</TableHead><TableHead className="text-end">Credit</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {vendorReturns.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.reference}</TableCell>
                        <TableCell>{r.receiveNumber}</TableCell>
                        <TableCell>{r.branchName}</TableCell>
                        <TableCell>{r.returnDate}</TableCell>
                        <TableCell><Badge variant="outline">{r.reason}</Badge></TableCell>
                        <TableCell className="text-end">{fmt(r.creditAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

