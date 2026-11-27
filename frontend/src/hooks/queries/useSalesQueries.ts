import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OffsetPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type {
  Branch,
  Customer,
  Invoice,
  InvoiceStatus,
  PaymentMethod,
  Product,
  ReceivedPayment,
  RetainerInvoice,
  RetainerStatus,
  SalesOrder,
  SalesOrderStatus,
  SalesReturn,
  SalesReturnReason,
} from "@/types";

export interface ApiCustomer {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  billingAddress: string;
  shippingAddress: string;
  taxNumber: string;
  etaReceiverType?: "B" | "P" | "F";
  currency: string;
  paymentTermsDays: number;
  creditLimit: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiSalesOrder {
  id: string;
  soNumber: string;
  customerId: string;
  branchId: string;
  status: SalesOrderStatus;
  orderDate: string;
  expectedShipmentDate: string | null;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lines: Array<{
    id: string;
    productId: string;
    quantity: number;
    invoicedQty: number;
    unitPrice: number;
    taxRate: number;
    lineTotal: number;
  }>;
}

export interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  branchId: string;
  soId: string | null;
  status: InvoiceStatus;
  source?: "standard" | "opening_balance";
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  paidAmount: number;
  creditAppliedAmount: number;
  retainerAppliedAmount: number;
  icv?: number | null;
  qrTlv?: string | null;
  invoiceHash?: string | null;
  prevInvoiceHash?: string | null;
  eInvoiceStatus?: string;
  voidReason: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lines: Array<{
    id: string;
    productId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineTotal: number;
  }>;
}

export interface ApiReceivedPayment {
  id: string;
  paymentNumber: string;
  customerId: string;
  paymentDate: string;
  amount: number;
  paymentMethod: PaymentMethod;
  reference: string;
  status: "Posted" | "Voided";
  voidReason: string | null;
  voidedAt: string | null;
  notes: string;
  createdAt: string;
  allocations: Array<{ invoiceId: string; amount: number }>;
}

export interface ApiSalesReturn {
  id: string;
  returnNumber: string;
  creditNoteNumber: string;
  customerId: string;
  branchId: string;
  invoiceId: string | null;
  returnDate: string;
  reason: SalesReturnReason;
  restockItems: boolean;
  totalAmount: number;
  appliedAmount: number;
  notes: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    quantity: number;
    unitPrice: number;
    taxRate: number;
    lineTotal: number;
  }>;
}

export interface ApiRetainer {
  id: string;
  retainerNumber: string;
  customerId: string;
  branchId: string | null;
  status: RetainerStatus;
  issueDate: string;
  amount: number;
  paidAmount: number;
  appliedAmount: number;
  notes: string;
  createdAt: string;
}

// ============================================================================
// Pure Mappers & Domain Helpers
// ============================================================================

export function termsFromDays(days: number): "NET15" | "NET30" | "COD" {
  if (days <= 0) return "COD";
  if (days <= 15) return "NET15";
  return "NET30";
}

export function daysFromTerms(terms: "NET15" | "NET30" | "COD"): number {
  if (terms === "COD") return 0;
  if (terms === "NET15") return 15;
  return 30;
}

export function mapApiCustomer(c: ApiCustomer): Customer {
  return {
    id: c.id,
    displayName: c.name,
    companyName: c.company || undefined,
    customerType: c.company ? "business" : "individual",
    email: c.email || undefined,
    phone: c.phone || undefined,
    taxNumber: c.taxNumber || undefined,
    etaReceiverType: c.etaReceiverType ?? (c.company || c.taxNumber ? "B" : "P"),
    currency: c.currency === "SAR" || c.currency === "AED" || c.currency === "EGP" ? c.currency : "USD",
    paymentTerms: termsFromDays(c.paymentTermsDays),
    creditLimit: c.creditLimit,
    billingAddress: c.billingAddress || undefined,
    shippingAddress: c.shippingAddress || undefined,
    notes: c.notes || undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function mapApiSalesOrder(
  so: ApiSalesOrder,
  customerMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  productMap?: Map<string, Product>
): SalesOrder {
  return {
    id: so.id,
    soNumber: so.soNumber,
    customerId: so.customerId,
    customerName: customerMap?.get(so.customerId) ?? "",
    branchId: so.branchId,
    branchName: branchMap?.get(so.branchId)?.branch_name ?? "",
    orderDate: so.orderDate.slice(0, 10),
    expectedShipDate: (so.expectedShipmentDate ?? so.orderDate).slice(0, 10),
    status: so.status,
    subtotal: so.subtotal,
    totalTax: so.taxTotal,
    grandTotal: so.totalAmount,
    internalNotes: so.notes || undefined,
    createdAt: so.createdAt,
    updatedAt: so.updatedAt,
    items: (so.lines ?? []).map((l) => {
      const p = productMap?.get(l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: p?.product_name ?? "",
        product_sku: p?.product_sku ?? "",
        quantity: l.quantity,
        fulfilledQty: l.invoicedQty,
        unitPrice: l.unitPrice,
        taxPercent: l.taxRate,
        amount: l.lineTotal,
      };
    }),
  };
}

export function mapApiInvoice(
  inv: ApiInvoice,
  customerMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  soNumMap?: Map<string, string>,
  productMap?: Map<string, Product>
): Invoice {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    customerId: inv.customerId,
    customerName: customerMap?.get(inv.customerId) ?? "",
    branchId: inv.branchId,
    branchName: branchMap?.get(inv.branchId)?.branch_name ?? "",
    salesOrderId: inv.soId ?? undefined,
    soNumber: inv.soId ? soNumMap?.get(inv.soId) : undefined,
    invoiceDate: inv.invoiceDate.slice(0, 10),
    dueDate: inv.dueDate.slice(0, 10),
    status: inv.status,
    subtotal: inv.subtotal,
    totalTax: inv.taxTotal,
    grandTotal: inv.totalAmount,
    amountPaid: inv.paidAmount + inv.creditAppliedAmount + inv.retainerAppliedAmount,
    creditAppliedAmount: inv.creditAppliedAmount,
    retainerAppliedAmount: inv.retainerAppliedAmount,
    icv: inv.icv ?? null,
    invoiceHash: inv.invoiceHash ?? null,
    prevInvoiceHash: inv.prevInvoiceHash ?? null,
    qrTlv: inv.qrTlv ?? null,
    eInvoiceStatus: inv.eInvoiceStatus,
    voidReason: inv.voidReason ?? undefined,
    notes: inv.notes || undefined,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    items: (inv.lines ?? []).map((l) => {
      const p = l.productId ? productMap?.get(l.productId) : undefined;
      return {
        id: l.id,
        productId: l.productId ?? "",
        product_name: p?.product_name ?? l.description ?? "",
        product_sku: p?.product_sku ?? "",
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxPercent: l.taxRate,
        amount: l.lineTotal,
      };
    }),
  };
}

export function mapApiReceivedPayment(
  rp: ApiReceivedPayment,
  customerMap?: Map<string, string>,
  invNumMap?: Map<string, string>
): ReceivedPayment {
  const allocSum = (rp.allocations ?? []).reduce((s, a) => s + a.amount, 0);
  return {
    id: rp.id,
    paymentNumber: rp.paymentNumber,
    customerId: rp.customerId,
    customerName: customerMap?.get(rp.customerId) ?? "",
    paymentDate: rp.paymentDate.slice(0, 10),
    method: rp.paymentMethod,
    reference: rp.reference || undefined,
    amount: rp.amount,
    unapplied: rp.status === "Voided" ? 0 : Math.max(0, rp.amount - allocSum),
    status: rp.status,
    voidReason: rp.voidReason ?? undefined,
    voidedAt: rp.voidedAt ?? undefined,
    notes: rp.notes || undefined,
    createdAt: rp.createdAt,
    allocations: (rp.allocations ?? []).map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: invNumMap?.get(a.invoiceId) ?? "",
      amount: a.amount,
    })),
  };
}

export function mapApiSalesReturn(
  sr: ApiSalesReturn,
  customerMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  invNumMap?: Map<string, string>,
  productMap?: Map<string, Product>
): SalesReturn {
  return {
    id: sr.id,
    returnNumber: sr.returnNumber,
    creditNoteNumber: sr.creditNoteNumber,
    customerId: sr.customerId,
    customerName: customerMap?.get(sr.customerId) ?? "",
    invoiceId: sr.invoiceId ?? undefined,
    invoiceNumber: sr.invoiceId ? invNumMap?.get(sr.invoiceId) : undefined,
    branchId: sr.branchId,
    branchName: branchMap?.get(sr.branchId)?.branch_name ?? "",
    returnDate: sr.returnDate.slice(0, 10),
    reason: sr.reason,
    creditTotal: sr.totalAmount,
    creditApplied: sr.appliedAmount,
    notes: sr.notes || undefined,
    createdAt: sr.createdAt,
    items: (sr.lines ?? []).map((l) => {
      const p = productMap?.get(l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: p?.product_name ?? "",
        product_sku: p?.product_sku ?? "",
        returnQty: l.quantity,
        unitPrice: l.unitPrice,
        taxPercent: l.taxRate,
        amount: l.lineTotal,
        disposition: sr.restockItems ? "restock" : "write_off",
      };
    }),
  };
}

export function mapApiRetainer(ret: ApiRetainer, customerMap?: Map<string, string>): RetainerInvoice {
  return {
    id: ret.id,
    retainerNumber: ret.retainerNumber,
    customerId: ret.customerId,
    customerName: customerMap?.get(ret.customerId) ?? "",
    branchId: ret.branchId ?? undefined,
    retainerDate: ret.issueDate.slice(0, 10),
    status: ret.status,
    amount: ret.amount,
    amountPaid: ret.paidAmount,
    amountApplied: ret.appliedAmount,
    notes: ret.notes || undefined,
    createdAt: ret.createdAt,
    updatedAt: ret.createdAt,
  };
}

export function computeInvoiceBalance(invoice: Pick<Invoice, "status" | "grandTotal" | "amountPaid">): number {
  return invoice.status === "Cancelled" ? 0 : Math.max(0, invoice.grandTotal - invoice.amountPaid);
}

export function computeCustomerReceivables(customerId: string, invoices: Invoice[]): number {
  return invoices.filter((i) => i.customerId === customerId).reduce((sum, i) => sum + computeInvoiceBalance(i), 0);
}

export function computeCustomerCredit(
  customerId: string,
  receivedPayments: ReceivedPayment[],
  salesReturns: SalesReturn[]
): number {
  const unappliedPay = receivedPayments
    .filter((p) => p.customerId === customerId && p.status !== "Voided")
    .reduce((s, p) => s + p.unapplied, 0);
  const openCreditNotes = salesReturns
    .filter((r) => r.customerId === customerId)
    .reduce((s, r) => s + Math.max(0, r.creditTotal - r.creditApplied), 0);
  return unappliedPay + openCreditNotes;
}

export function computeCreditNoteBalance(ret: Pick<SalesReturn, "creditTotal" | "creditApplied">): number {
  return Math.max(0, ret.creditTotal - ret.creditApplied);
}

export function computeRetainerAvailable(ret: Pick<RetainerInvoice, "amountPaid" | "amountApplied">): number {
  return Math.max(0, ret.amountPaid - ret.amountApplied);
}

export function computeReturnedQtyForInvoice(invoiceId: string, salesReturns: SalesReturn[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sr of salesReturns.filter((r) => r.invoiceId === invoiceId)) {
    for (const item of sr.items) {
      counts[item.productId] = (counts[item.productId] ?? 0) + item.returnQty;
    }
  }
  return counts;
}

// ============================================================================
// Query Hooks
// ============================================================================

export function useCustomersQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.customers(),
    queryFn: () => apiRequest<{ customers: ApiCustomer[] }>("/api/customers"),
    enabled: Boolean(user) && enabled,
  });
}

export function useCustomersDirectoryQuery(q?: string, enabled = true) {
  const { user } = useAuth();
  const trimmed = q?.trim() ?? "";
  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (trimmed) params.set("q", trimmed);

  return useQuery({
    queryKey: erpQueryKeys.sales.customersDirectory(trimmed),
    queryFn: () => apiRequest<{ customers: ApiCustomer[]; items?: ApiCustomer[] }>(`/api/customers?${params.toString()}`),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export interface CustomersPageFilters {
  page?: number;
  pageSize?: number;
  q?: string;
}

export function useCustomersPageQuery(filters: CustomersPageFilters = {}, enabled = true) {
  const { user } = useAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (filters.q?.trim()) params.set("q", filters.q.trim());

  return useQuery({
    queryKey: [
      ...erpQueryKeys.sales.customers(),
      "page",
      {
        page,
        pageSize,
        q: filters.q?.trim() ?? "",
      },
    ],
    queryFn: () =>
      apiRequest<{ customers: ApiCustomer[]; items: ApiCustomer[]; pageInfo: OffsetPageInfo }>(
        `/api/customers?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user) && enabled,
  });
}

export function useSalesOrdersQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.orders(),
    queryFn: () => apiRequest<{ salesOrders: ApiSalesOrder[] }>("/api/sales-orders"),
    enabled: Boolean(user) && enabled,
  });
}

export function useSalesOrdersDirectoryQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.ordersDirectory(),
    queryFn: () =>
      apiRequest<{ salesOrders: ApiSalesOrder[]; items?: ApiSalesOrder[] }>("/api/sales-orders?page=1&pageSize=200"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export interface SalesOrdersPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function useSalesOrdersPageQuery(filters: SalesOrdersPageFilters = {}, enabled = true) {
  const { user } = useAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.branchId && filters.branchId !== "all") params.set("branchId", filters.branchId);
  if (filters.q?.trim()) params.set("q", filters.q.trim());

  return useQuery({
    queryKey: [
      ...erpQueryKeys.sales.orders(),
      "page",
      {
        page,
        pageSize,
        status: filters.status ?? "all",
        branchId: filters.branchId ?? "all",
        q: filters.q?.trim() ?? "",
      },
    ],
    queryFn: () =>
      apiRequest<{ salesOrders: ApiSalesOrder[]; items: ApiSalesOrder[]; pageInfo: OffsetPageInfo }>(
        `/api/sales-orders?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user) && enabled,
  });
}

export function useSalesInvoicesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.invoices(),
    queryFn: () => apiRequest<{ invoices: ApiInvoice[] }>("/api/sales-invoices"),
    enabled: Boolean(user) && enabled,
  });
}

export interface SalesInvoicesPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function useSalesInvoicesPageQuery(filters: SalesInvoicesPageFilters = {}, enabled = true) {
  const { user } = useAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.branchId && filters.branchId !== "all") params.set("branchId", filters.branchId);
  if (filters.q?.trim()) params.set("q", filters.q.trim());

  return useQuery({
    queryKey: [
      ...erpQueryKeys.sales.invoices(),
      "page",
      {
        page,
        pageSize,
        status: filters.status ?? "all",
        branchId: filters.branchId ?? "all",
        q: filters.q?.trim() ?? "",
      },
    ],
    queryFn: () =>
      apiRequest<{ invoices: ApiInvoice[]; items: ApiInvoice[]; pageInfo: OffsetPageInfo }>(
        `/api/sales-invoices?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user) && enabled,
  });
}

export function useReceivedPaymentsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.payments(),
    queryFn: () => apiRequest<{ payments: ApiReceivedPayment[] }>("/api/received-payments"),
    enabled: Boolean(user) && enabled,
  });
}

export function useSalesReturnsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.returns(),
    queryFn: () => apiRequest<{ returns: ApiSalesReturn[] }>("/api/sales-returns"),
    enabled: Boolean(user) && enabled,
  });
}

export function useRetainerInvoicesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.retainers(),
    queryFn: () => apiRequest<{ retainers: ApiRetainer[] }>("/api/retainer-invoices"),
    enabled: Boolean(user) && enabled,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useSalesMutations() {
  const queryClient = useQueryClient();

  const invalidateSales = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.sales.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const invalidateSalesAndStock = () => {
    invalidateSales();
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.tracking.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const createCustomer = useMutation({
    mutationFn: (body: {
      name: string;
      company?: string;
      email?: string;
      phone?: string;
      billingAddress?: string;
      shippingAddress?: string;
      taxNumber?: string;
      currency?: string;
      paymentTermsDays?: number;
      creditLimit?: number | null;
      notes?: string;
    }) => apiRequest<{ customer: ApiCustomer }>("/api/customers", { method: "POST", body }),
    onSuccess: invalidateSales,
  });

  const updateCustomer = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        name?: string;
        company?: string;
        email?: string;
        phone?: string;
        billingAddress?: string;
        shippingAddress?: string;
        taxNumber?: string;
        currency?: string;
        paymentTermsDays?: number;
        creditLimit?: number | null;
        notes?: string;
      };
    }) => apiRequest<{ customer: ApiCustomer }>(`/api/customers/${id}`, { method: "PUT", body }),
    onSuccess: invalidateSales,
  });

  const deleteCustomer = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/customers/${id}`, { method: "DELETE" }),
    onSuccess: invalidateSales,
  });

  const createSalesOrder = useMutation({
    mutationFn: (body: {
      customerId: string;
      branchId: string;
      status?: "Draft" | "Confirmed";
      orderDate: string;
      expectedShipmentDate?: string | null;
      notes?: string;
      lines: Array<{ productId: string; description?: string; quantity: number; unitPrice: number; taxRate: number }>;
    }) =>
      apiRequest<{ salesOrder: { id: string; soNumber: string; createdAt: string; updatedAt: string } }>(
        "/api/sales-orders",
        { method: "POST", body }
      ),
    onSuccess: invalidateSales,
  });

  const updateSalesOrder = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        customerId: string;
        branchId: string;
        status?: "Draft" | "Confirmed";
        orderDate: string;
        expectedShipmentDate?: string | null;
        notes?: string;
        lines: Array<{ productId: string; description?: string; quantity: number; unitPrice: number; taxRate: number }>;
      };
    }) => apiRequest(`/api/sales-orders/${id}`, { method: "PUT", body }),
    onSuccess: invalidateSales,
  });

  const deleteSalesOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sales-orders/${id}`, { method: "DELETE" }),
    onSuccess: invalidateSales,
  });

  const confirmSalesOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sales-orders/${id}/confirm`, { method: "POST" }),
    onSuccess: invalidateSales,
  });

  const cancelSalesOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sales-orders/${id}/cancel`, { method: "POST" }),
    onSuccess: invalidateSales,
  });

  const fulfillSalesOrder = useMutation({
    mutationFn: ({
      id,
      lines,
    }: {
      id: string;
      lines: Array<{
        salesOrderLineId?: string;
        productId: string;
        quantity: number;
        lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
        serialNumbers?: string[];
      }>;
    }) => apiRequest(`/api/sales-orders/${id}/fulfill`, { method: "POST", body: { lines } }),
    onSuccess: invalidateSalesAndStock,
  });

  const createInvoice = useMutation({
    mutationFn: (body: {
      customerId: string;
      branchId: string;
      soId?: string | null;
      status?: string;
      invoiceDate: string;
      dueDate: string;
      notes?: string;
      lines: Array<{
        productId: string | null;
        description: string;
        quantity: number;
        unitPrice: number;
        taxRate: number;
        lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
        serialNumbers?: string[];
      }>;
    }) =>
      apiRequest<{ invoice: { id: string; invoiceNumber: string; createdAt: string; updatedAt: string } }>(
        "/api/sales-invoices",
        { method: "POST", body }
      ),
    onSuccess: invalidateSalesAndStock,
  });

  const sendInvoice = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/sales-invoices/${id}/send`, { method: "POST" }),
    onSuccess: invalidateSalesAndStock,
  });

  const voidInvoice = useMutation({
    mutationFn: ({ id, reason = "Voided by user" }: { id: string; reason?: string }) =>
      apiRequest(`/api/sales-invoices/${id}/void`, { method: "POST", body: { reason } }),
    onSuccess: invalidateSalesAndStock,
  });

  const createReceivedPayment = useMutation({
    mutationFn: (body: {
      customerId: string;
      branchId?: string | null;
      paymentDate: string;
      amount: number;
      paymentMethod: PaymentMethod;
      reference?: string;
      notes?: string;
      allocations: Array<{ invoiceId: string; amount: number }>;
    }) =>
      apiRequest<{ payment: { id: string; paymentNumber: string; createdAt: string } }>("/api/received-payments", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidateSales();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const voidReceivedPayment = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiRequest(`/api/received-payments/${id}/void`, { method: "POST", body: { reason } }),
    onSuccess: () => {
      invalidateSales();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const createSalesReturn = useMutation({
    mutationFn: (body: {
      customerId: string;
      branchId: string;
      invoiceId?: string | null;
      returnDate: string;
      reason: SalesReturnReason;
      restockItems: boolean;
      notes?: string;
      lines: Array<{ productId: string; quantity: number; unitPrice: number; taxRate: number }>;
    }) =>
      apiRequest<{
        salesReturn: { id: string; returnNumber: string; creditNoteNumber: string; totalAmount: string; createdAt: string };
      }>("/api/sales-returns", { method: "POST", body }),
    onSuccess: invalidateSalesAndStock,
  });

  const applySalesReturnCredit = useMutation({
    mutationFn: ({ returnId, invoiceId, amount }: { returnId: string; invoiceId: string; amount: number }) =>
      apiRequest(`/api/sales-returns/${returnId}/apply`, { method: "POST", body: { invoiceId, amount } }),
    onSuccess: invalidateSales,
  });

  const createRetainer = useMutation({
    mutationFn: (body: {
      customerId: string;
      branchId?: string | null;
      status?: string;
      issueDate: string;
      amount: number;
      notes?: string;
    }) =>
      apiRequest<{ retainer: { id: string; retainerNumber: string; createdAt: string } }>("/api/retainer-invoices", {
        method: "POST",
        body,
      }),
    onSuccess: invalidateSales,
  });

  const sendRetainer = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/retainer-invoices/${id}/send`, { method: "POST" }),
    onSuccess: invalidateSales,
  });

  const cancelRetainer = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/retainer-invoices/${id}/cancel`, { method: "POST" }),
    onSuccess: invalidateSales,
  });

  const deleteRetainer = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/retainer-invoices/${id}`, { method: "DELETE" }),
    onSuccess: invalidateSales,
  });

  const recordRetainerPayment = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/retainer-invoices/${id}/record-payment`, { method: "POST" }),
    onSuccess: () => {
      invalidateSales();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const applyRetainer = useMutation({
    mutationFn: ({ retainerId, invoiceId, amount }: { retainerId: string; invoiceId: string; amount: number }) =>
      apiRequest(`/api/retainer-invoices/${retainerId}/apply`, { method: "POST", body: { invoiceId, amount } }),
    onSuccess: invalidateSales,
  });

  return {
    createCustomer,
    updateCustomer,
    deleteCustomer,
    createSalesOrder,
    updateSalesOrder,
    deleteSalesOrder,
    confirmSalesOrder,
    cancelSalesOrder,
    fulfillSalesOrder,
    createInvoice,
    sendInvoice,
    voidInvoice,
    createReceivedPayment,
    voidReceivedPayment,
    createSalesReturn,
    applySalesReturnCredit,
    createRetainer,
    sendRetainer,
    cancelRetainer,
    deleteRetainer,
    recordRetainerPayment,
    applyRetainer,
  };
}
