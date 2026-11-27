import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OffsetPageInfo } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";
import { daysFromTerms, termsFromDays } from "./useSalesQueries";
import type {
  BillMatchStatus,
  BillStatus,
  Branch,
  PaymentMade,
  PaymentMethod,
  Product,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseReceive,
  PurchaseReturn,
  PurchaseReturnReason,
  Vendor,
  VendorBill,
} from "@/types";

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
  source?: "standard" | "opening_balance";
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

// ============================================================================
// Pure Mappers & Domain Helpers
// ============================================================================

export { daysFromTerms, termsFromDays };

export function mapApiVendor(v: ApiVendor, payablesBalance = 0): Vendor {
  return {
    id: v.id,
    displayName: v.name,
    companyName: v.company || undefined,
    email: v.email || undefined,
    phone: v.phone || undefined,
    taxNumber: v.taxNumber || undefined,
    currency: v.currency === "SAR" || v.currency === "AED" || v.currency === "EGP" ? v.currency : "USD",
    paymentTerms: termsFromDays(v.paymentTermsDays),
    billingAddress: v.address || undefined,
    shippingAddress: v.address || undefined,
    payablesBalance,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export function mapApiPO(
  po: ApiPO,
  vendorNameMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  productMap?: Map<string, Product>
): PurchaseOrder {
  return {
    id: po.id,
    poNumber: po.poNumber,
    vendorId: po.vendorId,
    vendorName: vendorNameMap?.get(po.vendorId) ?? "",
    branchId: po.branchId,
    branchName: branchMap?.get(po.branchId)?.branch_name ?? "",
    orderDate: po.orderDate.slice(0, 10),
    expectedDate: (po.expectedDate ?? po.orderDate).slice(0, 10),
    status: po.status,
    subtotal: po.subtotal,
    totalTax: po.taxTotal,
    grandTotal: po.totalAmount,
    internalNotes: po.notes || undefined,
    createdAt: po.createdAt,
    updatedAt: po.updatedAt,
    items: (po.lines ?? []).map((l) => {
      const p = productMap?.get(l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: p?.product_name ?? "",
        product_sku: p?.product_sku ?? "",
        quantity: l.quantity,
        receivedQty: l.receivedQty,
        unitPrice: l.unitCost,
        taxPercent: l.taxRate,
        amount: l.lineTotal,
      };
    }),
  };
}

export function mapApiReceive(
  r: ApiReceive,
  poMap?: Map<string, ApiPO>,
  vendorNameMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  productMap?: Map<string, Product>
): PurchaseReceive {
  const linkedPo = r.poId ? poMap?.get(r.poId) : undefined;
  return {
    id: r.id,
    receiveNumber: r.receiveNumber,
    purchaseOrderId: r.poId ?? "",
    poNumber: linkedPo?.poNumber ?? "",
    vendorId: r.vendorId,
    vendorName: vendorNameMap?.get(r.vendorId) ?? "",
    branchId: r.branchId,
    branchName: branchMap?.get(r.branchId)?.branch_name ?? "",
    receiveDate: r.receiveDate.slice(0, 10),
    notes: r.notes || undefined,
    createdAt: r.createdAt,
    items: (r.lines ?? []).map((l) => {
      const p = productMap?.get(l.productId);
      const poLine = linkedPo?.lines.find((pl) => pl.id === l.poLineId || pl.productId === l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: p?.product_name ?? "",
        product_sku: p?.product_sku ?? "",
        orderedQty: poLine?.quantity ?? l.quantity,
        previouslyReceivedQty: Math.max(0, (poLine?.receivedQty ?? l.quantity) - l.quantity),
        receivingNow: l.quantity,
        unitPrice: l.unitCost,
      };
    }),
  };
}

export function mapApiBill(
  b: ApiBill,
  poMap?: Map<string, ApiPO>,
  receiveMap?: Map<string, ApiReceive>,
  vendorNameMap?: Map<string, string>,
  productMap?: Map<string, Product>
): VendorBill {
  const linkedPo = b.poId ? poMap?.get(b.poId) : undefined;
  const linkedReceive = b.receiveId ? receiveMap?.get(b.receiveId) : undefined;
  const matchNotes: string[] = [];
  let matchStatus: BillMatchStatus = linkedReceive ? "matched" : "unmatched";

  const items = (b.lines ?? []).map((l) => {
    const p = l.productId ? productMap?.get(l.productId) : undefined;
    const recLine = linkedReceive?.lines.find((rl) => rl.productId === l.productId);
    const poLine = linkedPo?.lines.find((pl) => pl.productId === l.productId);
    if (recLine && Math.abs(l.quantity - recLine.quantity) > 0.001) {
      matchStatus = "qty_mismatch";
      matchNotes.push(`${p?.product_name ?? "Item"}: billed ${l.quantity}, received ${recLine.quantity}`);
    }
    if (poLine && Math.abs(l.unitCost - poLine.unitCost) > 0.01) {
      if (matchStatus === "matched") matchStatus = "price_mismatch";
      matchNotes.push(`${p?.product_name ?? "Item"}: bill price ${l.unitCost}, PO price ${poLine.unitCost}`);
    }
    return {
      id: l.id,
      productId: l.productId ?? "",
      product_name: p?.product_name ?? l.description ?? "",
      product_sku: p?.product_sku ?? "",
      quantity: l.quantity,
      unitPrice: l.unitCost,
      taxPercent: l.taxRate,
      amount: l.lineTotal,
      receivedQty: recLine?.quantity,
      orderedUnitPrice: poLine?.unitCost,
    };
  });

  return {
    id: b.id,
    billNumber: b.billNumber,
    vendorId: b.vendorId,
    vendorName: vendorNameMap?.get(b.vendorId) ?? "",
    branchId: b.branchId,
    receiveId: b.receiveId ?? undefined,
    receiveNumber: linkedReceive?.receiveNumber,
    purchaseOrderId: b.poId ?? undefined,
    poNumber: linkedPo?.poNumber,
    billDate: b.billDate.slice(0, 10),
    dueDate: b.dueDate.slice(0, 10),
    status: b.status,
    matchStatus,
    matchNotes,
    items,
    subtotal: b.subtotal,
    totalTax: b.taxTotal,
    grandTotal: b.totalAmount,
    amountPaid: b.paidAmount,
    voidReason: b.voidReason ?? undefined,
    notes: b.notes || undefined,
    createdAt: b.createdAt,
  };
}

export function mapApiPaymentMade(
  pm: ApiPaymentMade,
  vendorNameMap?: Map<string, string>,
  billNumberMap?: Map<string, string>
): PaymentMade {
  return {
    id: pm.id,
    paymentNumber: pm.paymentNumber,
    vendorId: pm.vendorId,
    vendorName: vendorNameMap?.get(pm.vendorId) ?? "",
    paymentDate: pm.paymentDate.slice(0, 10),
    method: pm.paymentMethod,
    reference: pm.reference || undefined,
    amount: pm.amount,
    status: pm.status,
    voidReason: pm.voidReason ?? undefined,
    voidedAt: pm.voidedAt ?? undefined,
    notes: pm.notes || undefined,
    createdAt: pm.createdAt,
    allocations: (pm.allocations ?? []).map((a) => ({
      billId: a.billId,
      billNumber: billNumberMap?.get(a.billId) ?? "",
      amount: a.amount,
    })),
  };
}

export function mapApiPurchaseReturn(
  ret: ApiPurchaseReturn,
  receiveMap?: Map<string, ApiReceive>,
  poMap?: Map<string, ApiPO>,
  vendorNameMap?: Map<string, string>,
  branchMap?: Map<string, Branch>,
  productMap?: Map<string, Product>
): PurchaseReturn {
  const rec = ret.receiveId ? receiveMap?.get(ret.receiveId) : undefined;
  const po = rec?.poId ? poMap?.get(rec.poId) : undefined;
  return {
    id: ret.id,
    reference: ret.returnNumber,
    receiveId: ret.receiveId ?? "",
    receiveNumber: rec?.receiveNumber ?? "",
    purchaseOrderId: rec?.poId ?? "",
    poNumber: po?.poNumber ?? "",
    vendorId: ret.vendorId,
    vendorName: vendorNameMap?.get(ret.vendorId) ?? "",
    branchId: ret.branchId,
    branchName: branchMap?.get(ret.branchId)?.branch_name ?? "",
    returnDate: ret.returnDate.slice(0, 10),
    reason: ret.reason,
    note: ret.notes || undefined,
    creditAmount: ret.totalAmount,
    createdAt: ret.createdAt,
    items: (ret.lines ?? []).map((l) => {
      const p = productMap?.get(l.productId);
      const recLine = rec?.lines.find((rl) => rl.productId === l.productId);
      return {
        id: l.id,
        productId: l.productId,
        product_name: p?.product_name ?? "",
        product_sku: p?.product_sku ?? "",
        receivedQty: recLine?.quantity ?? l.quantity,
        returnQty: l.quantity,
        unitPrice: l.unitCost,
      };
    }),
  };
}

export function computeBillBalance(bill: Pick<VendorBill, "grandTotal" | "amountPaid">): number {
  return Math.max(0, bill.grandTotal - bill.amountPaid);
}

export function computeVendorPayables(vendorId: string, bills: VendorBill[]): number {
  return bills
    .filter((b) => b.vendorId === vendorId && b.status !== "Cancelled")
    .reduce((sum, b) => sum + computeBillBalance(b), 0);
}

export function computeVendorCredit(vendorId: string, purchaseReturns: PurchaseReturn[]): number {
  return purchaseReturns.filter((r) => r.vendorId === vendorId).reduce((s, r) => s + r.creditAmount, 0);
}

export function computeReturnedQtyForReceive(
  receiveId: string,
  purchaseReturns: PurchaseReturn[],
  receives: PurchaseReceive[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  const rec = receives.find((r) => r.id === receiveId);
  for (const ret of purchaseReturns.filter((p) => p.receiveId === receiveId)) {
    for (const item of ret.items) {
      counts[item.productId] = (counts[item.productId] ?? 0) + item.returnQty;
      const matchLine = rec?.items.find((ri) => ri.productId === item.productId);
      if (matchLine) {
        counts[matchLine.id] = (counts[matchLine.id] ?? 0) + item.returnQty;
      }
    }
  }
  return counts;
}

// ============================================================================
// Query Hooks
// ============================================================================

export function useVendorsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.vendors(),
    queryFn: () => apiRequest<{ vendors: ApiVendor[] }>("/api/vendors"),
    enabled: Boolean(user) && enabled,
  });
}

export function useVendorsDirectoryQuery(q?: string, enabled = true) {
  const { user } = useAuth();
  const trimmed = q?.trim() ?? "";
  const params = new URLSearchParams({ page: "1", pageSize: "200" });
  if (trimmed) params.set("q", trimmed);

  return useQuery({
    queryKey: erpQueryKeys.purchases.vendorsDirectory(trimmed),
    queryFn: () => apiRequest<{ vendors: ApiVendor[]; items?: ApiVendor[] }>(`/api/vendors?${params.toString()}`),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export interface VendorsPageFilters {
  page?: number;
  pageSize?: number;
  q?: string;
}

export function useVendorsPageQuery(filters: VendorsPageFilters = {}, enabled = true) {
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
    enabled: Boolean(user) && enabled,
  });
}

export function usePurchaseOrdersQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.orders(),
    queryFn: () => apiRequest<{ purchaseOrders: ApiPO[] }>("/api/purchase-orders"),
    enabled: Boolean(user) && enabled,
  });
}

export function usePurchaseOrdersDirectoryQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.ordersDirectory(),
    queryFn: () =>
      apiRequest<{ purchaseOrders: ApiPO[]; items?: ApiPO[] }>("/api/purchase-orders?page=1&pageSize=200"),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export interface PurchaseOrdersPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function usePurchaseOrdersPageQuery(filters: PurchaseOrdersPageFilters = {}, enabled = true) {
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
    enabled: Boolean(user) && enabled,
  });
}

export function usePurchaseReceivesQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.receives(),
    queryFn: () => apiRequest<{ receives: ApiReceive[] }>("/api/purchase-receives"),
    enabled: Boolean(user) && enabled,
  });
}

export function useVendorBillsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.bills(),
    queryFn: () => apiRequest<{ bills: ApiBill[] }>("/api/vendor-bills"),
    enabled: Boolean(user) && enabled,
  });
}

export interface VendorBillsPageFilters {
  page?: number;
  pageSize?: number;
  status?: string;
  branchId?: string;
  q?: string;
}

export function useVendorBillsPageQuery(filters: VendorBillsPageFilters = {}, enabled = true) {
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
    enabled: Boolean(user) && enabled,
  });
}

export function usePaymentsMadeQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.payments(),
    queryFn: () => apiRequest<{ payments: ApiPaymentMade[] }>("/api/payments-made"),
    enabled: Boolean(user) && enabled,
  });
}

export function usePurchaseReturnsQuery(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.purchases.returns(),
    queryFn: () => apiRequest<{ returns: ApiPurchaseReturn[] }>("/api/purchase-returns"),
    enabled: Boolean(user) && enabled,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function usePurchasingMutations() {
  const queryClient = useQueryClient();

  const invalidatePurchases = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.purchases.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.approvals.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const invalidatePurchasesAndStock = () => {
    invalidatePurchases();
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.tracking.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
  };

  const createVendor = useMutation({
    mutationFn: (body: {
      name: string;
      company?: string;
      email?: string;
      phone?: string;
      address?: string;
      taxNumber?: string;
      currency?: string;
      paymentTermsDays?: number;
    }) => apiRequest<{ vendor: ApiVendor }>("/api/vendors", { method: "POST", body }),
    onSuccess: invalidatePurchases,
  });

  const updateVendor = useMutation({
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
        address?: string;
        taxNumber?: string;
        currency?: string;
        paymentTermsDays?: number;
      };
    }) => apiRequest<{ vendor: ApiVendor }>(`/api/vendors/${id}`, { method: "PUT", body }),
    onSuccess: invalidatePurchases,
  });

  const deleteVendor = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/vendors/${id}`, { method: "DELETE" }),
    onSuccess: invalidatePurchases,
  });

  const createPurchaseOrder = useMutation({
    mutationFn: (body: {
      vendorId: string;
      branchId: string;
      status?: "Draft" | "Issued";
      orderDate: string;
      expectedDate?: string | null;
      notes?: string;
      lines: Array<{ productId: string; description?: string; quantity: number; unitCost: number; taxRate: number }>;
    }) =>
      apiRequest<{ purchaseOrder: { id: string; poNumber: string; createdAt: string; updatedAt: string } }>(
        "/api/purchase-orders",
        { method: "POST", body }
      ),
    onSuccess: invalidatePurchases,
  });

  const updatePurchaseOrder = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        vendorId: string;
        branchId: string;
        status?: "Draft" | "Issued";
        orderDate: string;
        expectedDate?: string | null;
        notes?: string;
        lines: Array<{ productId: string; description?: string; quantity: number; unitCost: number; taxRate: number }>;
      };
    }) => apiRequest(`/api/purchase-orders/${id}`, { method: "PUT", body }),
    onSuccess: invalidatePurchases,
  });

  const issuePurchaseOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/purchase-orders/${id}/issue`, { method: "POST" }),
    onSuccess: invalidatePurchases,
  });

  const cancelPurchaseOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/purchase-orders/${id}/cancel`, { method: "POST" }),
    onSuccess: invalidatePurchases,
  });

  const deletePurchaseOrder = useMutation({
    mutationFn: (id: string) => apiRequest(`/api/purchase-orders/${id}`, { method: "DELETE" }),
    onSuccess: invalidatePurchases,
  });

  const createPurchaseReceive = useMutation({
    mutationFn: (body: {
      poId?: string | null;
      vendorId: string;
      branchId: string;
      receiveDate: string;
      notes?: string;
      lines: Array<{
        productId: string;
        quantity: number;
        unitCost: number;
        lotNumber?: string;
        expiryDate?: string;
        serialNumbers?: string[];
      }>;
    }) =>
      apiRequest<{ receive: { id: string; receiveNumber: string; createdAt: string } }>("/api/purchase-receives", {
        method: "POST",
        body,
      }),
    onSuccess: invalidatePurchasesAndStock,
  });

  const createVendorBill = useMutation({
    mutationFn: (body: {
      vendorId: string;
      branchId: string;
      receiveId?: string | null;
      poId?: string | null;
      billDate: string;
      dueDate: string;
      notes?: string;
      lines: Array<{ productId: string | null; description: string; quantity: number; unitCost: number; taxRate: number }>;
    }) =>
      apiRequest<{ bill: { id: string; billNumber: string; createdAt: string } }>("/api/vendor-bills", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const voidVendorBill = useMutation({
    mutationFn: ({ id, reason = "Voided by user" }: { id: string; reason?: string }) =>
      apiRequest(`/api/vendor-bills/${id}/void`, { method: "POST", body: { reason } }),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const createPaymentMade = useMutation({
    mutationFn: (body: {
      vendorId: string;
      branchId?: string | null;
      paymentDate: string;
      amount: number;
      paymentMethod: PaymentMethod;
      reference?: string;
      notes?: string;
      allocations: Array<{ billId: string; amount: number }>;
    }) =>
      apiRequest<{ payment: { id: string; paymentNumber: string; createdAt: string } }>("/api/payments-made", {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const voidPaymentMade = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiRequest(`/api/payments-made/${id}/void`, { method: "POST", body: { reason } }),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.accounting.all });
    },
  });

  const createPurchaseReturn = useMutation({
    mutationFn: (body: {
      vendorId: string;
      branchId: string;
      receiveId?: string | null;
      reason: PurchaseReturnReason;
      notes?: string;
      lines: Array<{ productId: string; quantity: number; unitCost: number; taxRate?: number }>;
    }) =>
      apiRequest<{ purchaseReturn: { id: string; returnNumber: string; totalAmount: string; createdAt: string } }>(
        "/api/purchase-returns",
        { method: "POST", body }
      ),
    onSuccess: invalidatePurchasesAndStock,
  });

  return {
    createVendor,
    updateVendor,
    deleteVendor,
    createPurchaseOrder,
    updatePurchaseOrder,
    issuePurchaseOrder,
    cancelPurchaseOrder,
    deletePurchaseOrder,
    createPurchaseReceive,
    createVendorBill,
    voidVendorBill,
    createPaymentMade,
    voidPaymentMade,
    createPurchaseReturn,
  };
}
