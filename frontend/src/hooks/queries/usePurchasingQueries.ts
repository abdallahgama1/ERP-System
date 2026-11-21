import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { OffsetPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import type { BillStatus, PaymentMethod, PurchaseOrderStatus, PurchaseReturnReason } from "@/types";

export interface ApiVendor {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  taxNumber: string;
  currency: string;
  paymentTermsDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiPO {
  id: string;
  poNumber: string;
  vendorId: string;
  branchId: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDate: string | null;
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
    receivedQty: number;
    unitCost: number;
    taxRate: number;
    lineTotal: number;
  }>;
}

export interface ApiReceive {
  id: string;
  receiveNumber: string;
  poId: string | null;
  vendorId: string;
  branchId: string;
  receiveDate: string;
  notes: string;
  createdAt: string;
  lines: Array<{
    id: string;
    poLineId: string | null;
    productId: string;
    quantity: number;
    unitCost: number;
  }>;
}

export interface ApiBill {
  id: string;
  billNumber: string;
  vendorId: string;
  branchId: string;
  poId: string | null;
  receiveId: string | null;
  status: BillStatus;
  billDate: string;
  dueDate: string;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  paidAmount: number;
  voidReason: string | null;
  notes: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string | null;
    description: string;
    quantity: number;
    unitCost: number;
    taxRate: number;
    lineTotal: number;
  }>;
}

export interface ApiPaymentMade {
  id: string;
  paymentNumber: string;
  vendorId: string;
  paymentDate: string;
  amount: number;
  paymentMethod: PaymentMethod;
  reference: string;
  status: "Posted" | "Voided";
  voidReason: string | null;
  voidedAt: string | null;
  notes: string;
  createdAt: string;
  allocations: Array<{ billId: string; amount: number }>;
}

export interface ApiPurchaseReturn {
  id: string;
  returnNumber: string;
  vendorId: string;
  branchId: string;
  receiveId: string | null;
  returnDate: string;
  reason: PurchaseReturnReason;
  totalAmount: number;
  notes: string;
  createdAt: string;
  lines: Array<{
    id: string;
    productId: string;
    quantity: number;
    unitCost: number;
  }>;
}

export function useVendorsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.vendors(),
    queryFn: () => apiRequest<{ vendors: ApiVendor[] }>("/api/vendors"),
    enabled: Boolean(user),
  });
}

export interface VendorsPageFilters {
  page?: number;
  pageSize?: number;
  q?: string;
}

export function useVendorsPageQuery(filters: VendorsPageFilters = {}) {
  const { user } = useAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  if (filters.q?.trim()) params.set("q", filters.q.trim());

  return useQuery({
    queryKey: [
      ...erpQueryKeys.purchases.vendors(),
      "page",
      {
        page,
        pageSize,
        q: filters.q?.trim() ?? "",
      },
    ],
    queryFn: () =>
      apiRequest<{ vendors: ApiVendor[]; items: ApiVendor[]; pageInfo: OffsetPageInfo }>(
        `/api/vendors?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user),
  });
}

export function usePurchaseOrdersQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.orders(),
    queryFn: () => apiRequest<{ purchaseOrders: ApiPO[] }>("/api/purchase-orders"),
    enabled: Boolean(user),
  });
}

export interface PurchaseOrdersPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function usePurchaseOrdersPageQuery(filters: PurchaseOrdersPageFilters = {}) {
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
      ...erpQueryKeys.purchases.orders(),
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
      apiRequest<{ purchaseOrders: ApiPO[]; items: ApiPO[]; pageInfo: OffsetPageInfo }>(
        `/api/purchase-orders?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user),
  });
}

export function usePurchaseReceivesQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.receives(),
    queryFn: () => apiRequest<{ receives: ApiReceive[] }>("/api/purchase-receives"),
    enabled: Boolean(user),
  });
}

export function useVendorBillsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.bills(),
    queryFn: () => apiRequest<{ bills: ApiBill[] }>("/api/vendor-bills"),
    enabled: Boolean(user),
  });
}

export interface VendorBillsPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function useVendorBillsPageQuery(filters: VendorBillsPageFilters = {}) {
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
      ...erpQueryKeys.purchases.bills(),
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
      apiRequest<{ bills: ApiBill[]; items: ApiBill[]; pageInfo: OffsetPageInfo }>(
        `/api/vendor-bills?${params.toString()}`
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(user),
  });
}

export function usePaymentsMadeQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.payments(),
    queryFn: () => apiRequest<{ payments: ApiPaymentMade[] }>("/api/payments-made"),
    enabled: Boolean(user),
  });
}

export function usePurchaseReturnsQuery() {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.returns(),
    queryFn: () => apiRequest<{ returns: ApiPurchaseReturn[] }>("/api/purchase-returns"),
    enabled: Boolean(user),
  });
}
