import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, FileText, Mail, MapPin, Phone, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";
import { buildStatementLines, downloadCustomerStatement } from "@/lib/pdf/customerStatementPdf";

export default function CustomerDetail() {
  const { customerId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    customers, customerReceivables, salesOrders, invoices, invoiceBalance,
    receivedPayments, salesReturns, creditNoteBalance, customerCredit,
  } = useSalesScope({ customers: true, salesOrders: true, invoices: true, receivedPayments: true, salesReturns: true, products: true });

  const orders = useMemo(
    () => salesOrders.filter(o => String(o.customerId) === customerId),
    [salesOrders, customerId],
  );

  const customerInvoices = useMemo(
    () => invoices.filter(i => String(i.customerId) === customerId),
    [invoices, customerId],
  );

  const payments = useMemo(
    () => receivedPayments.filter(p => String(p.customerId) === customerId),
    [receivedPayments, customerId],
  );

  const returns = useMemo(
    () => salesReturns.filter(r => String(r.customerId) === customerId),
    [salesReturns, customerId],
  );

  const customer = useMemo(
    () => customers.find(c => String(c.id) === customerId),
    [customers, customerId],
  );

  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: customer?.currency || "USD" }).format(n);

  if (!customer) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => navigate("/sales/customers")}>
          <ArrowLeft className="h-4 w-4 me-2" />
          {t("customers.title")}
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("customers.notFound")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const statementLines = buildStatementLines(customerInvoices, payments, returns);

  const downloadStatementCsv = () =>
    downloadCsv(`statement-${customer.displayName.replace(/\s+/g, "-").toLowerCase()}-${csvTimestamp()}`, statementLines, [
      { header: t("common.date", "Date"), value: (l) => l.date },
      { header: t("common.type", "Type"), value: (l) => l.type },
      { header: t("common.reference", "Reference"), value: (l) => l.reference },
      { header: t("common.debit", "Debit"), value: (l) => (l.debit ? l.debit.toFixed(2) : "") },
      { header: t("common.credit", "Credit"), value: (l) => (l.credit ? l.credit.toFixed(2) : "") },
      { header: t("common.balance", "Balance"), value: (l) => l.balance.toFixed(2) },
    ]);

  const emptyTab = (label: string) => (
    <Card>
      <CardContent className="py-12 text-center text-muted-foreground">{label}</CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Users className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{customer.displayName}</h1>
            <p className="text-muted-foreground">
              {customer.companyName || t(`customers.${customer.customerType}`)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={statementLines.length === 0}
            onClick={() => downloadCustomerStatement(customer, customerInvoices, payments, returns, customer.currency || "USD")}
          >
            <Download className="h-4 w-4 me-2" />
            {t("customers.statement", "Statement")} (PDF)
          </Button>
          <Button variant="outline" disabled={statementLines.length === 0} onClick={downloadStatementCsv}>
            <Download className="h-4 w-4 me-2" />
            {t("customers.statement", "Statement")} (CSV)
          </Button>
          <Button variant="outline" asChild>
            <Link to="/sales/customers"><ArrowLeft className="h-4 w-4 me-2" />{t("customers.title")}</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("customers.receivables")}</CardDescription>
            <CardTitle className="text-2xl">{fmt(customerReceivables(customer.id))}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("customers.creditBalance", "Unapplied credit")}</CardDescription>
            <CardTitle className="text-2xl">{fmt(customerCredit(customer.id))}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("customers.creditLimit")}</CardDescription>
            <CardTitle className="text-2xl">
              {customer.creditLimit === null || customer.creditLimit === undefined
                ? t("customers.unlimited", "Unlimited")
                : customer.creditLimit === 0
                  ? t("customers.strictCod", "Strict COD (0)")
                  : fmt(customer.creditLimit)}
            </CardTitle>
            {typeof customer.creditLimit === "number" && customer.creditLimit > 0 && (
              <div className="pt-1 space-y-1">
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full ${
                      customerReceivables(customer.id) > customer.creditLimit
                        ? "bg-destructive"
                        : "bg-primary"
                    }`}
                    style={{
                      width: `${Math.min(100, Math.round((customerReceivables(customer.id) / customer.creditLimit) * 100))}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {Math.round((customerReceivables(customer.id) / customer.creditLimit) * 100)}% used
                </p>
              </div>
            )}
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("customers.paymentTermsLabel")}</CardDescription>
            <CardTitle className="text-2xl">{customer.paymentTerms}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("customers.contactDetails")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 text-sm">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span>{customer.email || "-"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-muted-foreground" />
            <span>{customer.phone || "-"}</span>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <span className="block text-muted-foreground">{t("customers.billingAddress")}</span>
              <span className="whitespace-pre-line">{customer.billingAddress || "-"}</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <span className="block text-muted-foreground">{t("customers.shippingAddress")}</span>
              <span className="whitespace-pre-line">{customer.shippingAddress || "-"}</span>
            </div>
          </div>
          {customer.taxNumber && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("customers.taxNumber")}:</span>
              <Badge variant="outline">{customer.taxNumber}</Badge>
            </div>
          )}
          {customer.notes && (
            <div className="sm:col-span-2">
              <span className="block text-muted-foreground">{t("customers.notes")}</span>
              <p className="whitespace-pre-line">{customer.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">{t("nav.sales.salesOrders")}</TabsTrigger>
          <TabsTrigger value="invoices">{t("nav.sales.invoices")}</TabsTrigger>
          <TabsTrigger value="payments">{t("nav.sales.receivedPayments")}</TabsTrigger>
          <TabsTrigger value="returns">{t("nav.sales.salesReturns")}</TabsTrigger>
          <TabsTrigger value="statement">{t("customers.statement", "Statement")}</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="mt-4">
          {orders.length === 0 ? (
            emptyTab(t("customers.noOrders"))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("salesOrders.soNumber")}</TableHead>
                      <TableHead>{t("salesOrders.orderDate")}</TableHead>
                      <TableHead>{t("salesOrders.shipFromBranch")}</TableHead>
                      <TableHead className="text-end">{t("salesOrders.grandTotal")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map(o => (
                      <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/sales/orders/${o.id}`)}>
                        <TableCell className="font-medium">{o.soNumber}</TableCell>
                        <TableCell>{new Date(o.orderDate).toLocaleDateString()}</TableCell>
                        <TableCell>{o.branchName}</TableCell>
                        <TableCell className="text-end">{fmt(o.grandTotal)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {t(`salesOrders.statuses.${o.status.toLowerCase().split(" ").join("_")}`)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          {customerInvoices.length === 0 ? (
            emptyTab(t("customers.tabComingSoon"))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("invoices.number", "Invoice #")}</TableHead>
                      <TableHead>{t("invoices.invoiceDate", "Invoice Date")}</TableHead>
                      <TableHead>{t("invoices.dueDate", "Due Date")}</TableHead>
                      <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                      <TableHead className="text-end">{t("invoices.balance", "Balance")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customerInvoices.map(inv => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                        <TableCell>{new Date(inv.invoiceDate).toLocaleDateString()}</TableCell>
                        <TableCell>{new Date(inv.dueDate).toLocaleDateString()}</TableCell>
                        <TableCell className="text-end">{fmt(inv.grandTotal)}</TableCell>
                        <TableCell className="text-end">{fmt(invoiceBalance(inv))}</TableCell>
                        <TableCell><Badge variant="outline">{inv.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          {payments.length === 0 ? (
            emptyTab(t("customers.noPayments", "No payments received from this customer yet."))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("sales.receivedPayments.number", "Payment #")}</TableHead>
                      <TableHead>{t("common.date", "Date")}</TableHead>
                      <TableHead>{t("sales.receivedPayments.method", "Method")}</TableHead>
                      <TableHead>{t("sales.receivedPayments.reference", "Reference")}</TableHead>
                      <TableHead>{t("common.status", "Status")}</TableHead>
                      <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                      <TableHead className="text-end">{t("sales.receivedPayments.unapplied", "Unapplied")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map(p => (
                      <TableRow key={p.id} className={p.status === "Voided" ? "opacity-60" : undefined}>
                        <TableCell className="font-medium">{p.paymentNumber}</TableCell>
                        <TableCell>{new Date(p.paymentDate).toLocaleDateString()}</TableCell>
                        <TableCell className="capitalize">{p.method}</TableCell>
                        <TableCell>{p.reference || "-"}</TableCell>
                        <TableCell><Badge variant={p.status === "Voided" ? "destructive" : "secondary"}>{p.status === "Voided" ? t("common.voided", "Voided") : t("common.posted", "Posted")}</Badge></TableCell>
                        <TableCell className="text-end">{fmt(p.amount)}</TableCell>
                        <TableCell className="text-end">{p.status === "Voided" ? "-" : fmt(p.unapplied)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="returns" className="mt-4">
          {returns.length === 0 ? (
            emptyTab(t("customers.noReturns", "No returns from this customer yet."))
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("sales.salesReturns.number", "Return #")}</TableHead>
                      <TableHead>{t("common.date", "Date")}</TableHead>
                      <TableHead>{t("sales.invoices.number", "Invoice #")}</TableHead>
                      <TableHead>{t("common.branch", "Branch")}</TableHead>
                      <TableHead className="text-end">{t("sales.salesReturns.credit", "Credit")}</TableHead>
                      <TableHead className="text-end">{t("sales.salesReturns.remaining", "Remaining")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returns.map(r => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.returnNumber}</TableCell>
                        <TableCell>{new Date(r.returnDate).toLocaleDateString()}</TableCell>
                        <TableCell>{r.invoiceNumber || "-"}</TableCell>
                        <TableCell>{r.branchName}</TableCell>
                        <TableCell className="text-end">{fmt(r.creditTotal)}</TableCell>
                        <TableCell className="text-end">{fmt(creditNoteBalance(r))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        <TabsContent value="statement" className="mt-4">
          {statementLines.length === 0 ? (
            emptyTab(t("customers.noStatement", "No transactions to show on a statement yet."))
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  {t("customers.statement", "Statement")}
                </CardTitle>
                <CardDescription>
                  {t("customers.statementDesc", "Invoices, payments and credit notes in date order, with a running balance.")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.date", "Date")}</TableHead>
                      <TableHead>{t("common.type", "Type")}</TableHead>
                      <TableHead>{t("common.reference", "Reference")}</TableHead>
                      <TableHead className="text-end">{t("common.debit", "Debit")}</TableHead>
                      <TableHead className="text-end">{t("common.credit", "Credit")}</TableHead>
                      <TableHead className="text-end">{t("common.balance", "Balance")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statementLines.map((l, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{new Date(l.date).toLocaleDateString()}</TableCell>
                        <TableCell>{l.type}</TableCell>
                        <TableCell>{l.reference}</TableCell>
                        <TableCell className="text-end">{l.debit ? fmt(l.debit) : "-"}</TableCell>
                        <TableCell className="text-end">{l.credit ? fmt(l.credit) : "-"}</TableCell>
                        <TableCell className="text-end font-medium">{fmt(l.balance)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
