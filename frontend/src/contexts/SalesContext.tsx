import React, { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";
import {
  useCustomersQuery,
  useReceivedPaymentsQuery,
  useRetainerInvoicesQuery,
  useSalesInvoicesQuery,
  useSalesOrdersQuery,
  useSalesReturnsQuery,
  type ApiCustomer,
  type ApiInvoice,
  type ApiReceivedPayment,
  type ApiRetainer,
  type ApiSalesOrder,
  type ApiSalesReturn,
} from "@/hooks/queries/useSalesQueries";
import { useBranch } from "./BranchContext";
import { useInventory } from "./InventoryContext";
import type {
  Customer,
  Invoice,
  InvoiceItem,
  PaymentMethod,
  ReceivedPayment,
  RetainerInvoice,
  SalesOrder,
  SalesOrderStatus,
  SalesReturn,
  SalesReturnDisposition,
  SalesReturnReason,
} from "@/types";

type CustomerInput = Omit<Customer, "id" | "createdAt" | "updatedAt">;

export type SalesOrderInput = Omit<
  SalesOrder,
  "id" | "soNumber" | "status" | "createdAt" | "updatedAt" | "subtotal" | "totalTax" | "grandTotal"
> & { status?: SalesOrderStatus };

export type InvoiceInput = {
  customerId: string;
  customerName: string;
  branchId?: string;
  salesOrderId?: string;
  soNumber?: string;
  invoiceDate: string;
  dueDate: string;
  notes?: string;
  createdBy?: string;
  items: Array<Omit<InvoiceItem, "id" | "amount">>;
};

export type ReceivedPaymentInput = {
  customerId: string;
  paymentDate: string;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  createdBy?: string;
  amount: number;
  allocations: Array<{ invoiceId: string; amount: number }>;
};

export type SalesReturnInput = {
  customerId: string;
  invoiceId?: string;
  salesOrderId?: string;
  branchId: string;
  returnDate: string;
  reason: SalesReturnReason;
  notes?: string;
  createdBy?: string;
  items: Array<{
    productId: string;
    product_name: string;
    product_sku: string;
    returnQty: number;
    unitPrice: number;
    taxPercent: number;
    disposition: SalesReturnDisposition;
  }>;
};

export type RetainerInput = {
  customerId: string;
  branchId?: string;
  retainerDate: string;
  amount: number;
  notes?: string;
  createdBy?: string;
};

const daysFromTerms = (terms: "NET15" | "NET30" | "COD"): number =>
  terms === "COD" ? 0 : terms === "NET15" ? 15 : 30;

const termsFromDays = (days: number): "NET15" | "NET30" | "COD" =>
  days <= 0 ? "COD" : days <= 15 ? "NET15" : "NET30";

interface SalesContextType {
  customers: Customer[];
  getCustomer: (id: string) => Customer | undefined;
  addCustomer: (data: CustomerInput) => Promise<string | null>;
  updateCustomer: (id: string, data: CustomerInput) => Promise<string | null>;
  deleteCustomer: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  customerReceivables: (customerId: string) => number;

  salesOrders: SalesOrder[];
  getSalesOrder: (id: string) => SalesOrder | undefined;
  nextSoNumber: () => string;
  createSalesOrder: (data: SalesOrderInput) => Promise<{ ok: true; order: SalesOrder } | { ok: false; error: string }>;
  updateSalesOrder: (
    id: string,
    data: SalesOrderInput
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteSalesOrder: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  confirmSalesOrder: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  cancelSalesOrder: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  fulfillSalesOrder: (
    id: string,
    lines: Array<{ itemId: string; qty: number }>
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  invoices: Invoice[];
  nextInvoiceNo: () => string;
  invoiceBalance: (invoice: Invoice) => number;
  createInvoice: (data: InvoiceInput) => Promise<{ ok: true; invoice: Invoice } | { ok: false; error: string }>;
  sendInvoice: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  cancelInvoice: (id: string, reason?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteInvoice: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  recordInvoicePayment: (id: string, amount: number) => Promise<{ ok: true } | { ok: false; error: string }>;

  receivedPayments: ReceivedPayment[];
  nextReceiptNo: () => string;
  createReceivedPayment: (
    input: ReceivedPaymentInput
  ) => Promise<{ ok: true; payment: ReceivedPayment } | { ok: false; error: string }>;
  voidReceivedPayment: (id: string, reason: string, actor?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  customerCredit: (customerId: string) => number;

  salesReturns: SalesReturn[];
  nextReturnNo: () => string;
  returnedQtyForInvoice: (invoiceId: string) => Record<string, number>;
  createSalesReturn: (
    input: SalesReturnInput
  ) => Promise<{ ok: true; salesReturn: SalesReturn } | { ok: false; error: string }>;
  creditNoteBalance: (ret: SalesReturn) => number;
  applyCreditNoteToInvoice: (
    returnId: string,
    invoiceId: string,
    amount: number
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  retainers: RetainerInvoice[];
  nextRetainerNo: () => string;
  retainerAvailable: (r: RetainerInvoice) => number;
  createRetainer: (
    input: RetainerInput
  ) => Promise<{ ok: true; retainer: RetainerInvoice } | { ok: false; error: string }>;
  sendRetainer: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  cancelRetainer: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteRetainer: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  recordRetainerPayment: (id: string, amount: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  applyRetainerToInvoice: (
    retainerId: string,
    invoiceId: string,
    amount: number
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  refreshSales: () => Promise<void>;
}

const SalesContext = createContext<SalesContextType | undefined>(undefined);

export function SalesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { activeBranchId } = useBranch();
  const { products, branches, refreshInventory } = useInventory();

  const customersQuery = useCustomersQuery();
  const salesOrdersQuery = useSalesOrdersQuery();
  const invoicesQuery = useSalesInvoicesQuery();
  const paymentsQuery = useReceivedPaymentsQuery();
  const returnsQuery = useSalesReturnsQuery();
  const retainersQuery = useRetainerInvoicesQuery();

  const loadAll = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.sales.all });
  }, [queryClient]);

  const { customers, salesOrders, invoices, receivedPayments, salesReturns, retainers } = useMemo(() => {
    const prodMap = new Map(products.map((p) => [p.productId, p]));
    const brMap = new Map(branches.map((b) => [b.branchId, b]));
    const rawCustomers = customersQuery.data?.customers ?? [];
    const custMap = new Map(rawCustomers.map((c) => [c.id, c]));

    const mappedCustomers: Customer[] = rawCustomers.map((c) => ({
      id: c.id,
      displayName: c.name,
      companyName: c.company || undefined,
      customerType: c.company ? "business" : "individual",
      email: c.email || undefined,
      phone: c.phone || undefined,
      taxNumber: c.taxNumber || undefined,
      currency: c.currency === "SAR" || c.currency === "AED" || c.currency === "EGP" ? c.currency : "USD",
      paymentTerms: termsFromDays(c.paymentTermsDays),
      creditLimit: c.creditLimit,
      billingAddress: c.billingAddress || undefined,
      shippingAddress: c.shippingAddress || undefined,
      notes: c.notes || undefined,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    const rawSos = salesOrdersQuery.data?.salesOrders ?? [];
    const soNumMap = new Map(rawSos.map((o) => [o.id, o.soNumber]));

    const mappedSalesOrders: SalesOrder[] = rawSos.map((so) => ({
      id: so.id,
      soNumber: so.soNumber,
      customerId: so.customerId,
      customerName: custMap.get(so.customerId)?.name ?? "",
      branchId: so.branchId,
      branchName: brMap.get(so.branchId)?.branch_name ?? "",
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
        const p = prodMap.get(l.productId);
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
    }));

    const rawInvs = invoicesQuery.data?.invoices ?? [];
    const invNumMap = new Map(rawInvs.map((i) => [i.id, i.invoiceNumber]));

    const mappedInvoices: Invoice[] = rawInvs.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customerId,
      customerName: custMap.get(inv.customerId)?.name ?? "",
      branchId: inv.branchId,
      branchName: brMap.get(inv.branchId)?.branch_name ?? "",
      salesOrderId: inv.soId ?? undefined,
      soNumber: inv.soId ? soNumMap.get(inv.soId) : undefined,
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
        const p = l.productId ? prodMap.get(l.productId) : undefined;
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
    }));

    const mappedPayments: ReceivedPayment[] = (paymentsQuery.data?.payments ?? []).map((rp) => {
      const allocSum = (rp.allocations ?? []).reduce((s, a) => s + a.amount, 0);
      return {
        id: rp.id,
        paymentNumber: rp.paymentNumber,
        customerId: rp.customerId,
        customerName: custMap.get(rp.customerId)?.name ?? "",
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
          invoiceNumber: invNumMap.get(a.invoiceId) ?? "",
          amount: a.amount,
        })),
      };
    });

    const mappedReturns: SalesReturn[] = (returnsQuery.data?.returns ?? []).map((sr) => ({
      id: sr.id,
      returnNumber: sr.returnNumber,
      creditNoteNumber: sr.creditNoteNumber,
      customerId: sr.customerId,
      customerName: custMap.get(sr.customerId)?.name ?? "",
      invoiceId: sr.invoiceId ?? undefined,
      invoiceNumber: sr.invoiceId ? invNumMap.get(sr.invoiceId) : undefined,
      branchId: sr.branchId,
      branchName: brMap.get(sr.branchId)?.branch_name ?? "",
      returnDate: sr.returnDate.slice(0, 10),
      reason: sr.reason,
      creditTotal: sr.totalAmount,
      creditApplied: sr.appliedAmount,
      notes: sr.notes || undefined,
      createdAt: sr.createdAt,
      items: (sr.lines ?? []).map((l) => {
        const p = prodMap.get(l.productId);
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
    }));

    const mappedRetainers: RetainerInvoice[] = (retainersQuery.data?.retainers ?? []).map((ret) => ({
      id: ret.id,
      retainerNumber: ret.retainerNumber,
      customerId: ret.customerId,
      customerName: custMap.get(ret.customerId)?.name ?? "",
      branchId: ret.branchId ?? undefined,
      retainerDate: ret.issueDate.slice(0, 10),
      status: ret.status,
      amount: ret.amount,
      amountPaid: ret.paidAmount,
      amountApplied: ret.appliedAmount,
      notes: ret.notes || undefined,
      createdAt: ret.createdAt,
      updatedAt: ret.createdAt,
    }));

    return {
      customers: mappedCustomers,
      salesOrders: mappedSalesOrders,
      invoices: mappedInvoices,
      receivedPayments: mappedPayments,
      salesReturns: mappedReturns,
      retainers: mappedRetainers,
    };
  }, [
    products,
    branches,
    customersQuery.data,
    salesOrdersQuery.data,
    invoicesQuery.data,
    paymentsQuery.data,
    returnsQuery.data,
    retainersQuery.data,
  ]);

  const resolveBranchId = useCallback(
    (preferred?: string) =>
      preferred ||
      (activeBranchId !== "all" ? activeBranchId : (branches.find((b) => b.isDefault)?.branchId ?? branches[0]?.branchId)) ||
      "",
    [activeBranchId, branches]
  );

  const invoiceBalance = useCallback(
    (invoice: Invoice) =>
      invoice.status === "Cancelled" ? 0 : Math.max(0, invoice.grandTotal - invoice.amountPaid),
    []
  );

  const getCustomer = useCallback((id: string) => customers.find((c) => c.id === id), [customers]);

  const addCustomer = useCallback<SalesContextType["addCustomer"]>(
    async (data) => {
      try {
        await apiRequest("/api/customers", {
          method: "POST",
          body: {
            name: data.displayName,
            company: data.companyName ?? "",
            email: data.email ?? "",
            phone: data.phone ?? "",
            billingAddress: data.billingAddress ?? "",
            shippingAddress: data.shippingAddress ?? "",
            taxNumber: data.taxNumber ?? "",
            currency: data.currency,
            paymentTermsDays: daysFromTerms(data.paymentTerms),
            creditLimit: data.creditLimit ?? null,
            notes: data.notes ?? "",
          },
        });
        await loadAll();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to add customer";
      }
    },
    [loadAll]
  );

  const updateCustomer = useCallback<SalesContextType["updateCustomer"]>(
    async (id, data) => {
      try {
        await apiRequest(`/api/customers/${id}`, {
          method: "PUT",
          body: {
            name: data.displayName,
            company: data.companyName ?? "",
            email: data.email ?? "",
            phone: data.phone ?? "",
            billingAddress: data.billingAddress ?? "",
            shippingAddress: data.shippingAddress ?? "",
            taxNumber: data.taxNumber ?? "",
            currency: data.currency,
            paymentTermsDays: daysFromTerms(data.paymentTerms),
            creditLimit: data.creditLimit ?? null,
            notes: data.notes ?? "",
          },
        });
        await loadAll();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to update customer";
      }
    },
    [loadAll]
  );

  const deleteCustomer = useCallback<SalesContextType["deleteCustomer"]>(
    async (id) => {
      try {
        await apiRequest(`/api/customers/${id}`, { method: "DELETE" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete customer" };
      }
    },
    [loadAll]
  );

  const customerReceivables = useCallback(
    (customerId: string) =>
      invoices
        .filter((i) => i.customerId === customerId)
        .reduce((sum, i) => sum + invoiceBalance(i), 0),
    [invoices, invoiceBalance]
  );

  const getSalesOrder = useCallback((id: string) => salesOrders.find((o) => o.id === id), [salesOrders]);
  const nextSoNumber = useCallback(() => `SO-${String(salesOrders.length + 1).padStart(4, "0")}`, [salesOrders.length]);

  const createSalesOrder = useCallback<SalesContextType["createSalesOrder"]>(
    async (data) => {
      try {
        const res = await apiRequest<{ salesOrder: { id: string; soNumber: string; createdAt: string; updatedAt: string } }>(
          "/api/sales-orders",
          {
            method: "POST",
            body: {
              customerId: data.customerId,
              branchId: data.branchId,
              status: data.status === "Confirmed" ? "Confirmed" : "Draft",
              orderDate: data.orderDate,
              expectedShipmentDate: data.expectedShipDate || null,
              notes: data.internalNotes ?? "",
              lines: data.items.map((i) => ({
                productId: i.productId,
                description: i.product_name,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                taxRate: i.taxPercent,
              })),
            },
          }
        );
        await loadAll();
        const subtotal = data.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
        const totalTax = data.items.reduce((s, i) => s + (i.quantity * i.unitPrice * i.taxPercent) / 100, 0);
        return {
          ok: true,
          order: {
            ...data,
            id: res.salesOrder.id,
            soNumber: res.salesOrder.soNumber,
            status: data.status === "Confirmed" ? "Confirmed" : "Draft",
            subtotal,
            totalTax,
            grandTotal: subtotal + totalTax,
            createdAt: res.salesOrder.createdAt,
            updatedAt: res.salesOrder.updatedAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create sales order" };
      }
    },
    [loadAll]
  );

  const updateSalesOrder = useCallback<SalesContextType["updateSalesOrder"]>(
    async (id, data) => {
      try {
        await apiRequest(`/api/sales-orders/${id}`, {
          method: "PUT",
          body: {
            customerId: data.customerId,
            branchId: data.branchId,
            status: data.status === "Confirmed" ? "Confirmed" : "Draft",
            orderDate: data.orderDate,
            expectedShipmentDate: data.expectedShipDate || null,
            notes: data.internalNotes ?? "",
            lines: data.items.map((i) => ({
              productId: i.productId,
              description: i.product_name,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              taxRate: i.taxPercent,
            })),
          },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update sales order" };
      }
    },
    [loadAll]
  );

  const deleteSalesOrder = useCallback<SalesContextType["deleteSalesOrder"]>(
    async (id) => {
      try {
        await apiRequest(`/api/sales-orders/${id}`, { method: "DELETE" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete sales order" };
      }
    },
    [loadAll]
  );

  const confirmSalesOrder = useCallback<SalesContextType["confirmSalesOrder"]>(
    async (id) => {
      try {
        await apiRequest(`/api/sales-orders/${id}/confirm`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to confirm sales order" };
      }
    },
    [loadAll]
  );

  const cancelSalesOrder = useCallback<SalesContextType["cancelSalesOrder"]>(
    async (id) => {
      try {
        await apiRequest(`/api/sales-orders/${id}/cancel`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel sales order" };
      }
    },
    [loadAll]
  );

  const fulfillSalesOrder = useCallback<SalesContextType["fulfillSalesOrder"]>(
    async (id, lines) => {
      try {
        await apiRequest(`/api/sales-orders/${id}/fulfill`, {
          method: "POST",
          body: { lines },
        });
        await Promise.all([loadAll(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to fulfill sales order" };
      }
    },
    [loadAll, refreshInventory]
  );

  const nextInvoiceNo = useCallback(() => `INV-${String(invoices.length + 1).padStart(4, "0")}`, [invoices.length]);

  const createInvoice = useCallback<SalesContextType["createInvoice"]>(
    async (data) => {
      const linkedSo = data.salesOrderId ? salesOrders.find((o) => o.id === data.salesOrderId) : undefined;
      const branchId = resolveBranchId(data.branchId ?? linkedSo?.branchId);
      try {
        const res = await apiRequest<{ invoice: { id: string; invoiceNumber: string; createdAt: string; updatedAt: string } }>(
          "/api/sales-invoices",
          {
            method: "POST",
            body: {
              customerId: data.customerId,
              branchId,
              soId: data.salesOrderId ?? null,
              status: "Sent",
              invoiceDate: data.invoiceDate,
              dueDate: data.dueDate,
              notes: data.notes ?? "",
              lines: data.items.map((i) => ({
                productId: i.productId || null,
                description: i.product_name,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                taxRate: i.taxPercent,
                ...(i.lotAllocations && i.lotAllocations.length > 0 ? { lotAllocations: i.lotAllocations } : {}),
                ...(i.serialNumbers && i.serialNumbers.length > 0 ? { serialNumbers: i.serialNumbers } : {}),
              })),
            },
          }
        );
        await Promise.all([loadAll(), refreshInventory()]);
        const subtotal = data.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
        const totalTax = data.items.reduce((s, i) => s + (i.quantity * i.unitPrice * i.taxPercent) / 100, 0);
        return {
          ok: true,
          invoice: {
            id: res.invoice.id,
            invoiceNumber: res.invoice.invoiceNumber,
            customerId: data.customerId,
            customerName: data.customerName,
            branchId,
            salesOrderId: data.salesOrderId,
            soNumber: data.soNumber,
            invoiceDate: data.invoiceDate,
            dueDate: data.dueDate,
            status: "Sent",
            items: data.items.map((i, idx) => ({
              id: `${res.invoice.id}-${idx}`,
              ...i,
              amount: i.quantity * i.unitPrice * (1 + i.taxPercent / 100),
            })),
            subtotal,
            totalTax,
            grandTotal: subtotal + totalTax,
            amountPaid: 0,
            notes: data.notes,
            createdAt: res.invoice.createdAt,
            updatedAt: res.invoice.updatedAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create invoice" };
      }
    },
    [salesOrders, resolveBranchId, loadAll, refreshInventory]
  );

  const sendInvoice = useCallback<SalesContextType["sendInvoice"]>(
    async (id) => {
      try {
        await apiRequest(`/api/sales-invoices/${id}/send`, { method: "POST" });
        await Promise.all([loadAll(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to send invoice" };
      }
    },
    [loadAll, refreshInventory]
  );

  const cancelInvoice = useCallback<SalesContextType["cancelInvoice"]>(
    async (id, reason = "Voided by user") => {
      try {
        await apiRequest(`/api/sales-invoices/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await Promise.all([loadAll(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void invoice" };
      }
    },
    [loadAll, refreshInventory]
  );

  const deleteInvoice = useCallback<SalesContextType["deleteInvoice"]>(
    async (id) => cancelInvoice(id, "Voided by user"),
    [cancelInvoice]
  );

  const nextReceiptNo = useCallback(
    () => `RP-${String(receivedPayments.length + 1).padStart(4, "0")}`,
    [receivedPayments.length]
  );

  const createReceivedPayment = useCallback<SalesContextType["createReceivedPayment"]>(
    async (input) => {
      try {
        const res = await apiRequest<{ payment: { id: string; paymentNumber: string; createdAt: string } }>(
          "/api/received-payments",
          {
            method: "POST",
            body: {
              customerId: input.customerId,
              branchId: activeBranchId !== "all" ? activeBranchId : null,
              paymentDate: input.paymentDate,
              amount: input.amount,
              paymentMethod: input.method,
              reference: input.reference ?? "",
              notes: input.notes ?? "",
              allocations: input.allocations,
            },
          }
        );
        await loadAll();
        const allocSum = input.allocations.reduce((s, a) => s + a.amount, 0);
        return {
          ok: true,
          payment: {
            id: res.payment.id,
            paymentNumber: res.payment.paymentNumber,
            customerId: input.customerId,
            customerName: customers.find((c) => c.id === input.customerId)?.displayName ?? "",
            paymentDate: input.paymentDate,
            method: input.method,
            reference: input.reference,
            amount: input.amount,
            unapplied: Math.max(0, input.amount - allocSum),
            status: "Posted",
            allocations: input.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              invoiceNumber: invoices.find((i) => i.id === a.invoiceId)?.invoiceNumber ?? "",
              amount: a.amount,
            })),
            notes: input.notes,
            createdAt: res.payment.createdAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to record payment" };
      }
    },
    [activeBranchId, customers, invoices, loadAll]
  );

  const recordInvoicePayment = useCallback<SalesContextType["recordInvoicePayment"]>(
    async (id, amount) => {
      const inv = invoices.find((i) => i.id === id);
      if (!inv) return { ok: false, error: "Invoice not found" };
      const res = await createReceivedPayment({
        customerId: inv.customerId,
        paymentDate: new Date().toISOString().slice(0, 10),
        method: "bank",
        amount,
        allocations: [{ invoiceId: inv.id, amount }],
      });
      return res.ok ? { ok: true } : res;
    },
    [invoices, createReceivedPayment]
  );

  const voidReceivedPayment = useCallback<SalesContextType["voidReceivedPayment"]>(
    async (id, reason) => {
      try {
        await apiRequest(`/api/received-payments/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void payment" };
      }
    },
    [loadAll]
  );

  const customerCredit = useCallback(
    (customerId: string) => {
      const unappliedPay = receivedPayments
        .filter((p) => p.customerId === customerId && p.status !== "Voided")
        .reduce((s, p) => s + p.unapplied, 0);
      const openCreditNotes = salesReturns
        .filter((r) => r.customerId === customerId)
        .reduce((s, r) => s + Math.max(0, r.creditTotal - r.creditApplied), 0);
      return unappliedPay + openCreditNotes;
    },
    [receivedPayments, salesReturns]
  );

  const nextReturnNo = useCallback(
    () => `SRTN-${String(salesReturns.length + 1).padStart(4, "0")}`,
    [salesReturns.length]
  );

  const returnedQtyForInvoice = useCallback(
    (invoiceId: string) => {
      const counts: Record<string, number> = {};
      for (const sr of salesReturns.filter((r) => r.invoiceId === invoiceId)) {
        for (const item of sr.items) {
          counts[item.productId] = (counts[item.productId] ?? 0) + item.returnQty;
        }
      }
      return counts;
    },
    [salesReturns]
  );

  const createSalesReturn = useCallback<SalesContextType["createSalesReturn"]>(
    async (input) => {
      const restockItems = input.items.some((i) => i.disposition === "restock");
      try {
        const res = await apiRequest<{
          salesReturn: { id: string; returnNumber: string; creditNoteNumber: string; totalAmount: string; createdAt: string };
        }>("/api/sales-returns", {
          method: "POST",
          body: {
            customerId: input.customerId,
            branchId: input.branchId,
            invoiceId: input.invoiceId ?? null,
            returnDate: input.returnDate,
            reason: input.reason,
            restockItems,
            notes: input.notes ?? "",
            lines: input.items.map((i) => ({
              productId: i.productId,
              quantity: i.returnQty,
              unitPrice: i.unitPrice,
              taxRate: i.taxPercent,
            })),
          },
        });
        await Promise.all([loadAll(), refreshInventory()]);
        return {
          ok: true,
          salesReturn: {
            id: res.salesReturn.id,
            returnNumber: res.salesReturn.returnNumber,
            creditNoteNumber: res.salesReturn.creditNoteNumber,
            customerId: input.customerId,
            customerName: customers.find((c) => c.id === input.customerId)?.displayName ?? "",
            invoiceId: input.invoiceId,
            branchId: input.branchId,
            branchName: branches.find((b) => b.branchId === input.branchId)?.branch_name ?? "",
            returnDate: input.returnDate,
            reason: input.reason,
            items: [],
            creditTotal: Number(res.salesReturn.totalAmount ?? 0),
            creditApplied: 0,
            notes: input.notes,
            createdAt: res.salesReturn.createdAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create sales return" };
      }
    },
    [customers, branches, loadAll, refreshInventory]
  );

  const creditNoteBalance = useCallback(
    (ret: SalesReturn) => Math.max(0, ret.creditTotal - ret.creditApplied),
    []
  );

  const applyCreditNoteToInvoice = useCallback<SalesContextType["applyCreditNoteToInvoice"]>(
    async (returnId, invoiceId, amount) => {
      try {
        await apiRequest(`/api/sales-returns/${returnId}/apply`, {
          method: "POST",
          body: { invoiceId, amount },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to apply credit note" };
      }
    },
    [loadAll]
  );

  const nextRetainerNo = useCallback(
    () => `RET-${String(retainers.length + 1).padStart(4, "0")}`,
    [retainers.length]
  );

  const retainerAvailable = useCallback(
    (r: RetainerInvoice) => Math.max(0, r.amountPaid - r.amountApplied),
    []
  );

  const createRetainer = useCallback<SalesContextType["createRetainer"]>(
    async (input) => {
      try {
        const res = await apiRequest<{ retainer: { id: string; retainerNumber: string; createdAt: string } }>(
          "/api/retainer-invoices",
          {
            method: "POST",
            body: {
              customerId: input.customerId,
              branchId: input.branchId ?? (activeBranchId !== "all" ? activeBranchId : null),
              status: "Sent",
              issueDate: input.retainerDate,
              amount: input.amount,
              notes: input.notes ?? "",
            },
          }
        );
        await loadAll();
        return {
          ok: true,
          retainer: {
            id: res.retainer.id,
            retainerNumber: res.retainer.retainerNumber,
            customerId: input.customerId,
            customerName: customers.find((c) => c.id === input.customerId)?.displayName ?? "",
            retainerDate: input.retainerDate,
            status: "Sent",
            amount: input.amount,
            amountPaid: 0,
            amountApplied: 0,
            notes: input.notes,
            createdAt: res.retainer.createdAt,
            updatedAt: res.retainer.createdAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create retainer" };
      }
    },
    [activeBranchId, customers, loadAll]
  );

  const sendRetainer = useCallback<SalesContextType["sendRetainer"]>(
    async (id) => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/send`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to send retainer" };
      }
    },
    [loadAll]
  );

  const cancelRetainer = useCallback<SalesContextType["cancelRetainer"]>(
    async (id) => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/cancel`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel retainer" };
      }
    },
    [loadAll]
  );

  const deleteRetainer = useCallback<SalesContextType["deleteRetainer"]>(
    async (id) => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}`, { method: "DELETE" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete retainer" };
      }
    },
    [loadAll]
  );

  const recordRetainerPayment = useCallback<SalesContextType["recordRetainerPayment"]>(
    async (id) => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/record-payment`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to record retainer payment" };
      }
    },
    [loadAll]
  );

  const applyRetainerToInvoice = useCallback<SalesContextType["applyRetainerToInvoice"]>(
    async (retainerId, invoiceId, amount) => {
      try {
        await apiRequest(`/api/retainer-invoices/${retainerId}/apply`, {
          method: "POST",
          body: { invoiceId, amount },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to apply retainer" };
      }
    },
    [loadAll]
  );

  const value = useMemo<SalesContextType>(
    () => ({
      customers,
      getCustomer,
      addCustomer,
      updateCustomer,
      deleteCustomer,
      customerReceivables,
      salesOrders,
      getSalesOrder,
      nextSoNumber,
      createSalesOrder,
      updateSalesOrder,
      deleteSalesOrder,
      confirmSalesOrder,
      cancelSalesOrder,
      fulfillSalesOrder,
      invoices,
      nextInvoiceNo,
      invoiceBalance,
      createInvoice,
      sendInvoice,
      cancelInvoice,
      deleteInvoice,
      recordInvoicePayment,
      receivedPayments,
      nextReceiptNo,
      createReceivedPayment,
      voidReceivedPayment,
      customerCredit,
      salesReturns,
      nextReturnNo,
      returnedQtyForInvoice,
      createSalesReturn,
      creditNoteBalance,
      applyCreditNoteToInvoice,
      retainers,
      nextRetainerNo,
      retainerAvailable,
      createRetainer,
      sendRetainer,
      cancelRetainer,
      deleteRetainer,
      recordRetainerPayment,
      applyRetainerToInvoice,
      refreshSales: loadAll,
    }),
    [
      customers,
      getCustomer,
      addCustomer,
      updateCustomer,
      deleteCustomer,
      customerReceivables,
      salesOrders,
      getSalesOrder,
      nextSoNumber,
      createSalesOrder,
      updateSalesOrder,
      deleteSalesOrder,
      confirmSalesOrder,
      cancelSalesOrder,
      fulfillSalesOrder,
      invoices,
      nextInvoiceNo,
      invoiceBalance,
      createInvoice,
      sendInvoice,
      cancelInvoice,
      deleteInvoice,
      recordInvoicePayment,
      receivedPayments,
      nextReceiptNo,
      createReceivedPayment,
      voidReceivedPayment,
      customerCredit,
      salesReturns,
      nextReturnNo,
      returnedQtyForInvoice,
      createSalesReturn,
      creditNoteBalance,
      applyCreditNoteToInvoice,
      retainers,
      nextRetainerNo,
      retainerAvailable,
      createRetainer,
      sendRetainer,
      cancelRetainer,
      deleteRetainer,
      recordRetainerPayment,
      applyRetainerToInvoice,
      loadAll,
    ]
  );

  return <SalesContext.Provider value={value}>{children}</SalesContext.Provider>;
}

export function useSales() {
  const ctx = useContext(SalesContext);
  if (!ctx) throw new Error("useSales must be used within a SalesProvider");
  return ctx;
}
