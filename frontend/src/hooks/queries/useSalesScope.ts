import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useBranch } from "@/contexts/BranchContext";
import { erpQueryKeys } from "./queryKeys";
import { useProductsQuery } from "./useInventoryQueries";
import {
  useCustomersQuery,
  useReceivedPaymentsQuery,
  useRetainerInvoicesQuery,
  useSalesInvoicesQuery,
  useSalesOrdersQuery,
  useSalesReturnsQuery,
} from "./useSalesQueries";
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

export interface SalesScopeOptions {
  customers?: boolean;
  salesOrders?: boolean;
  invoices?: boolean;
  receivedPayments?: boolean;
  salesReturns?: boolean;
  retainers?: boolean;
  products?: boolean;
}

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

export function useSalesScope(options: SalesScopeOptions = {}) {
  const queryClient = useQueryClient();
  const { branches: shellBranches, activeBranchId } = useBranch();

  const customersQuery = useCustomersQuery(Boolean(options.customers));
  const salesOrdersQuery = useSalesOrdersQuery(Boolean(options.salesOrders));
  const invoicesQuery = useSalesInvoicesQuery(Boolean(options.invoices));
  const paymentsQuery = useReceivedPaymentsQuery(Boolean(options.receivedPayments));
  const returnsQuery = useSalesReturnsQuery(Boolean(options.salesReturns));
  const retainersQuery = useRetainerInvoicesQuery(Boolean(options.retainers));
  const productsQuery = useProductsQuery(Boolean(options.products));

  const refreshSales = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.sales.all });
  }, [queryClient]);

  const refreshInventory = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
  }, [queryClient]);

  const { customers, salesOrders, invoices, receivedPayments, salesReturns, retainers } = useMemo(() => {
    const prodMap = new Map((productsQuery.data?.products ?? []).map((p) => [p.id, p]));
    const brMap = new Map(shellBranches.map((b) => [b.id, b]));
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
      etaReceiverType: c.etaReceiverType ?? (c.company || c.taxNumber ? "B" : "P"),
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
      branchName: brMap.get(so.branchId)?.name ?? "",
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
          product_name: p?.name ?? "",
          product_sku: p?.sku ?? "",
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
      branchName: brMap.get(inv.branchId)?.name ?? "",
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
          product_name: p?.name ?? l.description ?? "",
          product_sku: p?.sku ?? "",
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
      branchName: brMap.get(sr.branchId)?.name ?? "",
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
          product_name: p?.name ?? "",
          product_sku: p?.sku ?? "",
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
    productsQuery.data,
    shellBranches,
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
      (activeBranchId !== "all"
        ? activeBranchId
        : (shellBranches.find((b) => b.isDefault)?.id ?? shellBranches[0]?.id)) ||
      "",
    [activeBranchId, shellBranches]
  );

  const invoiceBalance = useCallback(
    (invoice: Invoice) =>
      invoice.status === "Cancelled" ? 0 : Math.max(0, invoice.grandTotal - invoice.amountPaid),
    []
  );

  const getCustomer = useCallback((id: string) => customers.find((c) => c.id === id), [customers]);

  const addCustomer = useCallback(
    async (data: CustomerInput): Promise<string | null> => {
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
            ...(data.etaReceiverType ? { etaReceiverType: data.etaReceiverType } : {}),
            currency: data.currency,
            paymentTermsDays: daysFromTerms(data.paymentTerms),
            creditLimit: data.creditLimit ?? null,
            notes: data.notes ?? "",
          },
        });
        await refreshSales();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to add customer";
      }
    },
    [refreshSales]
  );

  const updateCustomer = useCallback(
    async (id: string, data: CustomerInput): Promise<string | null> => {
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
            ...(data.etaReceiverType ? { etaReceiverType: data.etaReceiverType } : {}),
            currency: data.currency,
            paymentTermsDays: daysFromTerms(data.paymentTerms),
            creditLimit: data.creditLimit ?? null,
            notes: data.notes ?? "",
          },
        });
        await refreshSales();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to update customer";
      }
    },
    [refreshSales]
  );

  const deleteCustomer = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/customers/${id}`, { method: "DELETE" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete customer" };
      }
    },
    [refreshSales]
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

  const createSalesOrder = useCallback(
    async (data: SalesOrderInput): Promise<{ ok: true; order: SalesOrder } | { ok: false; error: string }> => {
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
        await refreshSales();
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
    [refreshSales]
  );

  const updateSalesOrder = useCallback(
    async (id: string, data: SalesOrderInput): Promise<{ ok: true } | { ok: false; error: string }> => {
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
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update sales order" };
      }
    },
    [refreshSales]
  );

  const deleteSalesOrder = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-orders/${id}`, { method: "DELETE" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete sales order" };
      }
    },
    [refreshSales]
  );

  const confirmSalesOrder = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-orders/${id}/confirm`, { method: "POST" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to confirm sales order" };
      }
    },
    [refreshSales]
  );

  const cancelSalesOrder = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-orders/${id}/cancel`, { method: "POST" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel sales order" };
      }
    },
    [refreshSales]
  );

  const fulfillSalesOrder = useCallback(
    async (id: string, lines: Array<{ itemId: string; qty: number }>): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-orders/${id}/fulfill`, {
          method: "POST",
          body: { lines },
        });
        await Promise.all([refreshSales(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to fulfill sales order" };
      }
    },
    [refreshSales, refreshInventory]
  );

  const nextInvoiceNo = useCallback(() => `INV-${String(invoices.length + 1).padStart(4, "0")}`, [invoices.length]);

  const createInvoice = useCallback(
    async (data: InvoiceInput): Promise<{ ok: true; invoice: Invoice } | { ok: false; error: string }> => {
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
        await Promise.all([refreshSales(), refreshInventory()]);
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
    [salesOrders, resolveBranchId, refreshSales, refreshInventory]
  );

  const sendInvoice = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-invoices/${id}/send`, { method: "POST" });
        await Promise.all([refreshSales(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to send invoice" };
      }
    },
    [refreshSales, refreshInventory]
  );

  const cancelInvoice = useCallback(
    async (id: string, reason = "Voided by user"): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-invoices/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await Promise.all([refreshSales(), refreshInventory()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void invoice" };
      }
    },
    [refreshSales, refreshInventory]
  );

  const deleteInvoice = useCallback(
    async (id: string) => cancelInvoice(id, "Voided by user"),
    [cancelInvoice]
  );

  const nextReceiptNo = useCallback(
    () => `RP-${String(receivedPayments.length + 1).padStart(4, "0")}`,
    [receivedPayments.length]
  );

  const createReceivedPayment = useCallback(
    async (
      input: ReceivedPaymentInput
    ): Promise<{ ok: true; payment: ReceivedPayment } | { ok: false; error: string }> => {
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
        await refreshSales();
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
    [activeBranchId, customers, invoices, refreshSales]
  );

  const recordInvoicePayment = useCallback(
    async (id: string, amount: number): Promise<{ ok: true } | { ok: false; error: string }> => {
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

  const voidReceivedPayment = useCallback(
    async (id: string, reason: string, _actor?: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/received-payments/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void payment" };
      }
    },
    [refreshSales]
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

  const createSalesReturn = useCallback(
    async (
      input: SalesReturnInput
    ): Promise<{ ok: true; salesReturn: SalesReturn } | { ok: false; error: string }> => {
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
        await Promise.all([refreshSales(), refreshInventory()]);
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
            branchName: shellBranches.find((b) => b.id === input.branchId)?.name ?? "",
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
    [customers, shellBranches, refreshSales, refreshInventory]
  );

  const creditNoteBalance = useCallback(
    (ret: SalesReturn) => Math.max(0, ret.creditTotal - ret.creditApplied),
    []
  );

  const applyCreditNoteToInvoice = useCallback(
    async (returnId: string, invoiceId: string, amount: number): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/sales-returns/${returnId}/apply`, {
          method: "POST",
          body: { invoiceId, amount },
        });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to apply credit note" };
      }
    },
    [refreshSales]
  );

  const nextRetainerNo = useCallback(
    () => `RET-${String(retainers.length + 1).padStart(4, "0")}`,
    [retainers.length]
  );

  const retainerAvailable = useCallback(
    (r: RetainerInvoice) => Math.max(0, r.amountPaid - r.amountApplied),
    []
  );

  const createRetainer = useCallback(
    async (
      input: RetainerInput
    ): Promise<{ ok: true; retainer: RetainerInvoice } | { ok: false; error: string }> => {
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
        await refreshSales();
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
    [activeBranchId, customers, refreshSales]
  );

  const sendRetainer = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/send`, { method: "POST" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to send retainer" };
      }
    },
    [refreshSales]
  );

  const cancelRetainer = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/cancel`, { method: "POST" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel retainer" };
      }
    },
    [refreshSales]
  );

  const deleteRetainer = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}`, { method: "DELETE" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete retainer" };
      }
    },
    [refreshSales]
  );

  const recordRetainerPayment = useCallback(
    async (id: string, _amount?: number): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/retainer-invoices/${id}/record-payment`, { method: "POST" });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to record retainer payment" };
      }
    },
    [refreshSales]
  );

  const applyRetainerToInvoice = useCallback(
    async (retainerId: string, invoiceId: string, amount: number): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/retainer-invoices/${retainerId}/apply`, {
          method: "POST",
          body: { invoiceId, amount },
        });
        await refreshSales();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to apply retainer" };
      }
    },
    [refreshSales]
  );

  return {
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
    refreshSales,
  };
}
