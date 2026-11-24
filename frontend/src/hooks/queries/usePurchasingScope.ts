import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useBranch } from "@/contexts/BranchContext";
import { erpQueryKeys } from "./queryKeys";
import { useProductsQuery } from "./useInventoryQueries";
import {
  usePaymentsMadeQuery,
  usePurchaseOrdersQuery,
  usePurchaseReceivesQuery,
  usePurchaseReturnsQuery,
  useVendorBillsQuery,
  useVendorsQuery,
  type ApiVendor,
} from "./usePurchasingQueries";
import type {
  BillMatchStatus,
  PaymentMade,
  PaymentMethod,
  PurchaseOrder,
  PurchaseReceive,
  PurchaseReturn,
  PurchaseReturnReason,
  Vendor,
  VendorBill,
} from "@/types";

export interface PurchasingScopeOptions {
  vendors?: boolean;
  purchaseOrders?: boolean;
  receives?: boolean;
  bills?: boolean;
  payments?: boolean;
  purchaseReturns?: boolean;
  products?: boolean;
}

const daysFromTerms = (terms: "NET15" | "NET30" | "COD"): number =>
  terms === "COD" ? 0 : terms === "NET15" ? 15 : 30;

const termsFromDays = (days: number): "NET15" | "NET30" | "COD" =>
  days <= 0 ? "COD" : days <= 15 ? "NET15" : "NET30";

export function usePurchasingScope(options: PurchasingScopeOptions = {}) {
  const queryClient = useQueryClient();
  const { branches: shellBranches, activeBranchId } = useBranch();

  const vendorsQuery = useVendorsQuery(Boolean(options.vendors));
  const posQuery = usePurchaseOrdersQuery(Boolean(options.purchaseOrders));
  const receivesQuery = usePurchaseReceivesQuery(Boolean(options.receives));
  const billsQuery = useVendorBillsQuery(Boolean(options.bills));
  const paymentsQuery = usePaymentsMadeQuery(Boolean(options.payments));
  const returnsQuery = usePurchaseReturnsQuery(Boolean(options.purchaseReturns));
  const productsQuery = useProductsQuery(Boolean(options.products));

  const refreshPurchases = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.purchases.all });
  }, [queryClient]);

  const refreshInventory = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all });
  }, [queryClient]);

  const { vendors, purchaseOrders, receives, bills, payments, purchaseReturns } = useMemo(() => {
    const prodMap = new Map((productsQuery.data?.products ?? []).map((p) => [p.id, p]));
    const brMap = new Map(shellBranches.map((b) => [b.id, b]));
    const rawVendors = vendorsQuery.data?.vendors ?? [];
    const vendorNameMap = new Map(rawVendors.map((v) => [v.id, v.name]));

    const rawPos = posQuery.data?.purchaseOrders ?? [];
    const poMap = new Map(rawPos.map((po) => [po.id, po]));

    const mappedPos: PurchaseOrder[] = rawPos.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      vendorName: vendorNameMap.get(po.vendorId) ?? "",
      branchId: po.branchId,
      branchName: brMap.get(po.branchId)?.name ?? "",
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
        const p = prodMap.get(l.productId);
        return {
          id: l.id,
          productId: l.productId,
          product_name: p?.name ?? "",
          product_sku: p?.sku ?? "",
          quantity: l.quantity,
          receivedQty: l.receivedQty,
          unitPrice: l.unitCost,
          taxPercent: l.taxRate,
          amount: l.lineTotal,
        };
      }),
    }));

    const rawReceives = receivesQuery.data?.receives ?? [];
    const receiveMap = new Map(rawReceives.map((r) => [r.id, r]));

    const mappedReceives: PurchaseReceive[] = rawReceives.map((r) => {
      const linkedPo = r.poId ? poMap.get(r.poId) : undefined;
      return {
        id: r.id,
        receiveNumber: r.receiveNumber,
        purchaseOrderId: r.poId ?? "",
        poNumber: linkedPo?.poNumber ?? "",
        vendorId: r.vendorId,
        vendorName: vendorNameMap.get(r.vendorId) ?? "",
        branchId: r.branchId,
        branchName: brMap.get(r.branchId)?.name ?? "",
        receiveDate: r.receiveDate.slice(0, 10),
        notes: r.notes || undefined,
        createdAt: r.createdAt,
        items: (r.lines ?? []).map((l) => {
          const p = prodMap.get(l.productId);
          const poLine = linkedPo?.lines.find((pl) => pl.id === l.poLineId || pl.productId === l.productId);
          return {
            id: l.id,
            productId: l.productId,
            product_name: p?.name ?? "",
            product_sku: p?.sku ?? "",
            orderedQty: poLine?.quantity ?? l.quantity,
            previouslyReceivedQty: Math.max(0, (poLine?.receivedQty ?? l.quantity) - l.quantity),
            receivingNow: l.quantity,
            unitPrice: l.unitCost,
          };
        }),
      };
    });

    const rawBills = billsQuery.data?.bills ?? [];
    const billNumberMap = new Map(rawBills.map((b) => [b.id, b.billNumber]));

    const mappedBills: VendorBill[] = rawBills.map((b) => {
      const linkedPo = b.poId ? poMap.get(b.poId) : undefined;
      const linkedReceive = b.receiveId ? receiveMap.get(b.receiveId) : undefined;
      const matchNotes: string[] = [];
      let matchStatus: BillMatchStatus = linkedReceive ? "matched" : "unmatched";

      const items = (b.lines ?? []).map((l) => {
        const p = l.productId ? prodMap.get(l.productId) : undefined;
        const recLine = linkedReceive?.lines.find((rl) => rl.productId === l.productId);
        const poLine = linkedPo?.lines.find((pl) => pl.productId === l.productId);
        if (recLine && Math.abs(l.quantity - recLine.quantity) > 0.001) {
          matchStatus = "qty_mismatch";
          matchNotes.push(`${p?.name ?? "Item"}: billed ${l.quantity}, received ${recLine.quantity}`);
        }
        if (poLine && Math.abs(l.unitCost - poLine.unitCost) > 0.01) {
          if (matchStatus === "matched") matchStatus = "price_mismatch";
          matchNotes.push(`${p?.name ?? "Item"}: bill price ${l.unitCost}, PO price ${poLine.unitCost}`);
        }
        return {
          id: l.id,
          productId: l.productId ?? "",
          product_name: p?.name ?? l.description ?? "",
          product_sku: p?.sku ?? "",
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
        vendorName: vendorNameMap.get(b.vendorId) ?? "",
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
    });

    const mappedPayments: PaymentMade[] = (paymentsQuery.data?.payments ?? []).map((pm) => ({
      id: pm.id,
      paymentNumber: pm.paymentNumber,
      vendorId: pm.vendorId,
      vendorName: vendorNameMap.get(pm.vendorId) ?? "",
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
        billNumber: billNumberMap.get(a.billId) ?? "",
        amount: a.amount,
      })),
    }));

    const mappedReturns: PurchaseReturn[] = (returnsQuery.data?.returns ?? []).map((ret) => {
      const rec = ret.receiveId ? receiveMap.get(ret.receiveId) : undefined;
      const po = rec?.poId ? poMap.get(rec.poId) : undefined;
      return {
        id: ret.id,
        reference: ret.returnNumber,
        receiveId: ret.receiveId ?? "",
        receiveNumber: rec?.receiveNumber ?? "",
        purchaseOrderId: rec?.poId ?? "",
        poNumber: po?.poNumber ?? "",
        vendorId: ret.vendorId,
        vendorName: vendorNameMap.get(ret.vendorId) ?? "",
        branchId: ret.branchId,
        branchName: brMap.get(ret.branchId)?.name ?? "",
        returnDate: ret.returnDate.slice(0, 10),
        reason: ret.reason,
        note: ret.notes || undefined,
        creditAmount: ret.totalAmount,
        createdAt: ret.createdAt,
        items: (ret.lines ?? []).map((l) => {
          const p = prodMap.get(l.productId);
          const recLine = rec?.lines.find((rl) => rl.productId === l.productId);
          return {
            id: l.id,
            productId: l.productId,
            product_name: p?.name ?? "",
            product_sku: p?.sku ?? "",
            receivedQty: recLine?.quantity ?? l.quantity,
            returnQty: l.quantity,
            unitPrice: l.unitCost,
          };
        }),
      };
    });

    const payablesByVendor = new Map<string, number>();
    for (const b of mappedBills) {
      if (b.status === "Cancelled") continue;
      const bal = Math.max(0, b.grandTotal - b.amountPaid);
      payablesByVendor.set(b.vendorId, (payablesByVendor.get(b.vendorId) ?? 0) + bal);
    }

    const mappedVendors: Vendor[] = rawVendors.map((v) => ({
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
      payablesBalance: payablesByVendor.get(v.id) ?? 0,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));

    return {
      vendors: mappedVendors,
      purchaseOrders: mappedPos,
      receives: mappedReceives,
      bills: mappedBills,
      payments: mappedPayments,
      purchaseReturns: mappedReturns,
    };
  }, [
    productsQuery.data,
    shellBranches,
    vendorsQuery.data,
    posQuery.data,
    receivesQuery.data,
    billsQuery.data,
    paymentsQuery.data,
    returnsQuery.data,
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

  const addVendor = useCallback(
    async (
      data: Omit<Vendor, "id" | "createdAt" | "updatedAt" | "payablesBalance">
    ): Promise<{ ok: true; vendor: Vendor } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{ vendor: ApiVendor }>("/api/vendors", {
          method: "POST",
          body: {
            name: data.displayName,
            company: data.companyName ?? "",
            email: data.email ?? "",
            phone: data.phone ?? "",
            address: data.billingAddress ?? "",
            taxNumber: data.taxNumber ?? "",
            currency: data.currency,
            paymentTermsDays: daysFromTerms(data.paymentTerms),
          },
        });
        await refreshPurchases();
        return {
          ok: true,
          vendor: {
            id: res.vendor.id,
            displayName: res.vendor.name,
            currency: data.currency,
            paymentTerms: data.paymentTerms,
            payablesBalance: 0,
            createdAt: res.vendor.createdAt,
            updatedAt: res.vendor.updatedAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to add vendor" };
      }
    },
    [refreshPurchases]
  );

  const updateVendor = useCallback(
    async (
      id: string,
      data: Partial<Omit<Vendor, "id" | "createdAt">>
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/vendors/${id}`, {
          method: "PUT",
          body: {
            ...(data.displayName !== undefined ? { name: data.displayName } : {}),
            ...(data.companyName !== undefined ? { company: data.companyName } : {}),
            ...(data.email !== undefined ? { email: data.email } : {}),
            ...(data.phone !== undefined ? { phone: data.phone } : {}),
            ...(data.billingAddress !== undefined ? { address: data.billingAddress } : {}),
            ...(data.taxNumber !== undefined ? { taxNumber: data.taxNumber } : {}),
            ...(data.currency !== undefined ? { currency: data.currency } : {}),
            ...(data.paymentTerms !== undefined ? { paymentTermsDays: daysFromTerms(data.paymentTerms) } : {}),
          },
        });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update vendor" };
      }
    },
    [refreshPurchases]
  );

  const deleteVendor = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/vendors/${id}`, { method: "DELETE" });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete vendor" };
      }
    },
    [refreshPurchases]
  );

  const createPurchaseOrder = useCallback(
    async (
      data: Omit<PurchaseOrder, "id" | "createdAt" | "updatedAt">
    ): Promise<{ ok: true; order: PurchaseOrder } | { ok: false; error: string }> => {
      try {
        const branchId = resolveBranchId(data.branchId);
        const res = await apiRequest<{ purchaseOrder: { id: string; poNumber: string; createdAt: string; updatedAt: string } }>(
          "/api/purchase-orders",
          {
            method: "POST",
            body: {
              vendorId: data.vendorId,
              branchId,
              status: data.status === "Issued" ? "Issued" : "Draft",
              orderDate: data.orderDate,
              expectedDate: data.expectedDate || null,
              notes: data.internalNotes ?? "",
              lines: data.items.map((i) => ({
                productId: i.productId,
                description: i.product_name,
                quantity: i.quantity,
                unitCost: i.unitPrice,
                taxRate: i.taxPercent,
              })),
            },
          }
        );
        await refreshPurchases();
        return {
          ok: true,
          order: {
            ...data,
            id: res.purchaseOrder.id,
            poNumber: res.purchaseOrder.poNumber,
            createdAt: res.purchaseOrder.createdAt,
            updatedAt: res.purchaseOrder.updatedAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create PO" };
      }
    },
    [resolveBranchId, refreshPurchases]
  );

  const updatePurchaseOrder = useCallback(
    async (
      id: string,
      data: Partial<Omit<PurchaseOrder, "id" | "createdAt">>
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const current = purchaseOrders.find((p) => p.id === id);
        if (!current) return { ok: false, error: "Purchase order not found" };
        if (current.status === "Draft" && data.status === "Issued" && !data.items) {
          await apiRequest(`/api/purchase-orders/${id}/issue`, { method: "POST" });
        } else {
          await apiRequest(`/api/purchase-orders/${id}`, {
            method: "PUT",
            body: {
              vendorId: data.vendorId ?? current.vendorId,
              branchId: resolveBranchId(data.branchId ?? current.branchId),
              status: data.status === "Issued" ? "Issued" : "Draft",
              orderDate: data.orderDate ?? current.orderDate,
              expectedDate: data.expectedDate ?? current.expectedDate,
              notes: data.internalNotes ?? current.internalNotes ?? "",
              lines: (data.items ?? current.items).map((i) => ({
                productId: i.productId,
                description: i.product_name,
                quantity: i.quantity,
                unitCost: i.unitPrice,
                taxRate: i.taxPercent,
              })),
            },
          });
        }
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update PO" };
      }
    },
    [purchaseOrders, resolveBranchId, refreshPurchases]
  );

  const deletePurchaseOrder = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/purchase-orders/${id}`, { method: "DELETE" });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete PO" };
      }
    },
    [refreshPurchases]
  );

  const cancelPurchaseOrder = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/purchase-orders/${id}/cancel`, { method: "POST" });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel PO" };
      }
    },
    [refreshPurchases]
  );

  const applyReceiptToPO = useCallback(() => {
    // Handled atomically server-side inside POST /api/purchase-receives
  }, []);

  const addReceive = useCallback(
    async (
      data: Omit<PurchaseReceive, "id" | "createdAt">
    ): Promise<{ ok: true; receive: PurchaseReceive } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{ receive: { id: string; receiveNumber: string; createdAt: string } }>(
          "/api/purchase-receives",
          {
            method: "POST",
            body: {
              poId: data.purchaseOrderId || null,
              vendorId: data.vendorId,
              branchId: data.branchId,
              receiveDate: data.receiveDate,
              notes: data.notes ?? "",
              lines: data.items
                .filter((i) => i.receivingNow > 0)
                .map((i) => ({
                  productId: i.productId,
                  quantity: i.receivingNow,
                  unitCost: i.unitPrice,
                  ...(i.lotNumber ? { lotNumber: i.lotNumber } : {}),
                  ...(i.expiryDate ? { expiryDate: i.expiryDate } : {}),
                  ...(i.serialNumbers && i.serialNumbers.length > 0 ? { serialNumbers: i.serialNumbers } : {}),
                })),
            },
          }
        );
        await Promise.all([refreshPurchases(), refreshInventory()]);
        return {
          ok: true,
          receive: {
            ...data,
            id: res.receive.id,
            receiveNumber: res.receive.receiveNumber,
            createdAt: res.receive.createdAt,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to post receive" };
      }
    },
    [refreshPurchases, refreshInventory]
  );

  const returnedQtyForReceive = useCallback(
    (receiveId: string) => {
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
    },
    [purchaseReturns, receives]
  );

  const createPurchaseReturn = useCallback(
    async (input: {
      receiveId: string;
      reason: PurchaseReturnReason;
      note?: string;
      createdBy?: string;
      items: Array<{ receiveItemId: string; returnQty: number }>;
    }): Promise<{ ok: true; purchaseReturn: PurchaseReturn } | { ok: false; error: string }> => {
      const rec = receives.find((r) => r.id === input.receiveId);
      if (!rec) return { ok: false, error: "Receive document not found" };

      const lines = input.items
        .filter((i) => i.returnQty > 0)
        .map((i) => {
          const recItem = rec.items.find((ri) => ri.id === i.receiveItemId || ri.productId === i.receiveItemId);
          return {
            productId: recItem?.productId ?? i.receiveItemId,
            quantity: i.returnQty,
            unitCost: recItem?.unitPrice ?? 0,
            taxRate: 0,
          };
        });

      try {
        const res = await apiRequest<{
          purchaseReturn: { id: string; returnNumber: string; totalAmount: string; createdAt: string };
        }>("/api/purchase-returns", {
          method: "POST",
          body: {
            vendorId: rec.vendorId,
            branchId: rec.branchId,
            receiveId: rec.id,
            reason: input.reason,
            notes: input.note ?? "",
            lines,
          },
        });
        await Promise.all([refreshPurchases(), refreshInventory()]);
        const created: PurchaseReturn = {
          id: res.purchaseReturn.id,
          reference: res.purchaseReturn.returnNumber,
          receiveId: rec.id,
          receiveNumber: rec.receiveNumber,
          purchaseOrderId: rec.purchaseOrderId,
          poNumber: rec.poNumber,
          vendorId: rec.vendorId,
          vendorName: rec.vendorName,
          branchId: rec.branchId,
          branchName: rec.branchName,
          returnDate: res.purchaseReturn.createdAt.slice(0, 10),
          reason: input.reason,
          note: input.note,
          items: [],
          creditAmount: Number(res.purchaseReturn.totalAmount ?? 0),
          createdAt: res.purchaseReturn.createdAt,
        };
        return { ok: true, purchaseReturn: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create purchase return" };
      }
    },
    [receives, refreshPurchases, refreshInventory]
  );

  const vendorCredit = useCallback(
    (vendorId: string) =>
      purchaseReturns.filter((r) => r.vendorId === vendorId).reduce((s, r) => s + r.creditAmount, 0),
    [purchaseReturns]
  );

  const createBill = useCallback(
    async (input: {
      vendorId: string;
      receiveId?: string;
      branchId?: string;
      vendorBillReference?: string;
      billDate: string;
      dueDate: string;
      notes?: string;
      createdBy?: string;
      items: Array<{
        productId: string;
        product_name: string;
        product_sku: string;
        quantity: number;
        unitPrice: number;
        taxPercent: number;
        receivedQty?: number;
        orderedUnitPrice?: number;
      }>;
    }): Promise<{ ok: true; bill: VendorBill } | { ok: false; error: string }> => {
      const rec = input.receiveId ? receives.find((r) => r.id === input.receiveId) : undefined;
      const branchId = resolveBranchId(input.branchId ?? rec?.branchId);
      try {
        const res = await apiRequest<{ bill: { id: string; billNumber: string; createdAt: string } }>(
          "/api/vendor-bills",
          {
            method: "POST",
            body: {
              vendorId: input.vendorId,
              branchId,
              receiveId: input.receiveId ?? null,
              poId: rec?.purchaseOrderId || null,
              billDate: input.billDate,
              dueDate: input.dueDate,
              notes: [input.vendorBillReference ? `Ref: ${input.vendorBillReference}` : "", input.notes ?? ""]
                .filter(Boolean)
                .join(" · "),
              lines: input.items.map((i) => ({
                productId: i.productId || null,
                description: i.product_name,
                quantity: i.quantity,
                unitCost: i.unitPrice,
                taxRate: i.taxPercent,
              })),
            },
          }
        );
        await refreshPurchases();
        const subtotal = input.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
        const totalTax = input.items.reduce((s, i) => s + (i.quantity * i.unitPrice * i.taxPercent) / 100, 0);
        const created: VendorBill = {
          id: res.bill.id,
          billNumber: res.bill.billNumber,
          vendorId: input.vendorId,
          vendorName: vendors.find((v) => v.id === input.vendorId)?.displayName ?? "",
          branchId,
          billDate: input.billDate,
          dueDate: input.dueDate,
          status: "Open",
          matchStatus: rec ? "matched" : "unmatched",
          matchNotes: [],
          items: input.items.map((i, idx) => ({
            id: `${res.bill.id}-${idx}`,
            ...i,
            amount: i.quantity * i.unitPrice * (1 + i.taxPercent / 100),
          })),
          subtotal,
          totalTax,
          grandTotal: subtotal + totalTax,
          amountPaid: 0,
          createdAt: res.bill.createdAt,
        };
        return { ok: true, bill: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create vendor bill" };
      }
    },
    [receives, resolveBranchId, vendors, refreshPurchases]
  );

  const voidBill = useCallback(
    async (id: string, reason: string, _actor?: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/vendor-bills/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void bill" };
      }
    },
    [refreshPurchases]
  );

  const deleteBill = useCallback(
    async (id: string) => voidBill(id, "Deleted by user"),
    [voidBill]
  );

  const createPayment = useCallback(
    async (input: {
      vendorId: string;
      paymentDate: string;
      method: PaymentMethod;
      reference?: string;
      notes?: string;
      createdBy?: string;
      amount: number;
      allocations: Array<{ billId: string; amount: number }>;
    }): Promise<{ ok: true; payment: PaymentMade } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{ payment: { id: string; paymentNumber: string; createdAt: string } }>(
          "/api/payments-made",
          {
            method: "POST",
            body: {
              vendorId: input.vendorId,
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
        await refreshPurchases();
        const created: PaymentMade = {
          id: res.payment.id,
          paymentNumber: res.payment.paymentNumber,
          vendorId: input.vendorId,
          vendorName: vendors.find((v) => v.id === input.vendorId)?.displayName ?? "",
          paymentDate: input.paymentDate,
          method: input.method,
          reference: input.reference,
          amount: input.amount,
          status: "Posted",
          allocations: input.allocations.map((a) => ({
            billId: a.billId,
            billNumber: bills.find((b) => b.id === a.billId)?.billNumber ?? "",
            amount: a.amount,
          })),
          notes: input.notes,
          createdAt: res.payment.createdAt,
        };
        return { ok: true, payment: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create payment" };
      }
    },
    [activeBranchId, vendors, bills, refreshPurchases]
  );

  const voidPayment = useCallback(
    async (id: string, reason: string, _actor?: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/payments-made/${id}/void`, {
          method: "POST",
          body: { reason },
        });
        await refreshPurchases();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to void payment" };
      }
    },
    [refreshPurchases]
  );

  const billBalance = useCallback(
    (bill: VendorBill) => Math.max(0, bill.grandTotal - bill.amountPaid),
    []
  );

  const vendorPayables = useCallback(
    (vendorId: number | string) =>
      bills
        .filter((b) => b.vendorId === String(vendorId) && b.status !== "Cancelled")
        .reduce((sum, b) => sum + billBalance(b), 0),
    [bills, billBalance]
  );

  const nextPoNumber = useCallback(
    () => `PO-${String(purchaseOrders.length + 1).padStart(4, "0")}`,
    [purchaseOrders.length]
  );
  const nextReceiveNumber = useCallback(
    () => `RCV-${String(receives.length + 1).padStart(4, "0")}`,
    [receives.length]
  );
  const nextReturnNumber = useCallback(
    () => `PRTN-${String(purchaseReturns.length + 1).padStart(4, "0")}`,
    [purchaseReturns.length]
  );

  return {
    vendors,
    addVendor,
    updateVendor,
    deleteVendor,
    purchaseOrders,
    createPurchaseOrder,
    updatePurchaseOrder,
    deletePurchaseOrder,
    cancelPurchaseOrder,
    applyReceiptToPO,
    receives,
    addReceive,
    purchaseReturns,
    returnedQtyForReceive,
    createPurchaseReturn,
    vendorCredit,
    bills,
    createBill,
    deleteBill,
    voidBill,
    payments,
    createPayment,
    voidPayment,
    vendorPayables,
    billBalance,
    nextPoNumber,
    nextReceiveNumber,
    nextReturnNumber,
    refreshPurchases,
  };
}
