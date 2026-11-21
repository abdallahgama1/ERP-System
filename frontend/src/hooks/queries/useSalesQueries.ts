import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { OffsetPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type { InvoiceStatus, PaymentMethod, RetainerStatus, SalesOrderStatus, SalesReturnReason } from "@/types";

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

export function useCustomersQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.customers(),
    queryFn: () => apiRequest<{ customers: ApiCustomer[] }>("/api/customers"),
    enabled: Boolean(user),
  });
}

export function useSalesOrdersQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.orders(),
    queryFn: () => apiRequest<{ salesOrders: ApiSalesOrder[] }>("/api/sales-orders"),
    enabled: Boolean(user),
  });
}

export function useSalesInvoicesQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.invoices(),
    queryFn: () => apiRequest<{ invoices: ApiInvoice[] }>("/api/sales-invoices"),
    enabled: Boolean(user),
  });
}

export interface SalesInvoicesPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function useSalesInvoicesPageQuery(filters: SalesInvoicesPageFilters = {}) {
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
    enabled: Boolean(user),
  });
}

export function useReceivedPaymentsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.payments(),
    queryFn: () => apiRequest<{ payments: ApiReceivedPayment[] }>("/api/received-payments"),
    enabled: Boolean(user),
  });
}

export function useSalesReturnsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.returns(),
    queryFn: () => apiRequest<{ returns: ApiSalesReturn[] }>("/api/sales-returns"),
    enabled: Boolean(user),
  });
}

export function useRetainerInvoicesQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.sales.retainers(),
    queryFn: () => apiRequest<{ retainers: ApiRetainer[] }>("/api/retainer-invoices"),
    enabled: Boolean(user),
  });
}
