import React, { createContext, useCallback, useContext, useMemo, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";
import {
  useAdjustmentsQuery,
  useBranchesDirectoryQuery,
  useMovementsQuery,
  useProductsQuery,
  useTransfersQuery,
  useWriteOffsQuery,
  type ApiBranchRow,
  type ApiProductRow,
} from "@/hooks/queries/useInventoryQueries";
import { useBranch } from "./BranchContext";
import type {
  Adjustment,
  AdjustmentReason,
  Branch,
  BranchProduct,
  Product,
  StockMovement,
  Transfer,
  TransferShortageResolution,
  WriteOff,
  WriteOffReason,
} from "@/types";

interface InventoryContextType {
  products: Product[];
  addProduct: (data: Omit<Product, "productId">) => Promise<{ ok: true; product: Product } | { ok: false; error: string }>;
  updateProduct: (productId: string, data: Omit<Product, "productId">) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteProduct: (productId: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  branchProducts: BranchProduct[];

  branches: Branch[];
  addBranch: (data: Omit<Branch, "branchId">) => Promise<{ ok: true; branch: Branch } | { ok: false; error: string }>;
  updateBranch: (branchId: string, data: Omit<Branch, "branchId">) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteBranch: (branchId: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  getAvailableQuantity: (productId: string) => number;
  getAssignedQuantity: (productId: string) => number;

  assignToBranch: (
    productId: string,
    branchId: string,
    quantity: number,
    sellingPrice: number,
    costPrice: number
  ) => Promise<boolean>;
  updateBranchProduct: (
    productId: string,
    branchId: string,
    newQuantity: number,
    sellingPrice: number,
    costPrice: number
  ) => Promise<boolean>;
  removeFromBranch: (productId: string, branchId: string) => Promise<void>;

  receiveGoodsToBranch: (
    productId: string,
    branchId: string,
    quantity: number,
    costPrice: number,
    sellingPrice?: number,
    reference?: string,
    createdBy?: string
  ) => Promise<void>;
  returnToVendor: (input: {
    productId: string;
    branchId: string;
    quantity: number;
    reference?: string;
    notes?: string;
    createdBy?: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  shipGoodsFromBranch: (input: {
    productId: string;
    branchId: string;
    quantity: number;
    reference?: string;
    notes?: string;
    createdBy?: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  restockCustomerReturn: (input: {
    productId: string;
    branchId: string;
    quantity: number;
    reference?: string;
    notes?: string;
    createdBy?: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;

  movements: StockMovement[];

  adjustments: Adjustment[];
  createAdjustment: (input: {
    productId: string;
    branchId: string;
    newQty: number;
    reason: AdjustmentReason;
    note?: string;
    approver?: string;
    createdBy?: string;
  }) => Promise<{ ok: true; adjustment: Adjustment } | { ok: false; error: string }>;

  writeOffs: WriteOff[];
  createWriteOff: (input: {
    productId: string;
    branchId: string;
    quantity: number;
    reason: WriteOffReason;
    note?: string;
    createdBy?: string;
  }) => Promise<{ ok: true; writeOff: WriteOff } | { ok: false; error: string }>;

  transfers: Transfer[];
  getInTransitQty: (productId: string) => number;
  createTransfer: (input: {
    sourceBranchId: string;
    destBranchId: string;
    items: Array<{ productId: string; quantity: number }>;
    notes?: string;
    createdBy?: string;
  }) => Promise<{ ok: true; transfer: Transfer } | { ok: false; error: string }>;
  dispatchTransfer: (transferId: string, actor?: string) => Promise<{ ok: boolean; error?: string }>;
  receiveTransfer: (
    transferId: string,
    receivedMap: Record<string, number>,
    shortageResolution?: TransferShortageResolution,
    actor?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  cancelTransfer: (transferId: string, actor?: string) => Promise<{ ok: boolean; error?: string }>;

  refreshInventory: () => Promise<void>;
}

const InventoryContext = createContext<InventoryContextType | undefined>(undefined);

export function InventoryProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { activeBranchId, refreshBranches } = useBranch();

  const branchesQuery = useBranchesDirectoryQuery();
  const productsQuery = useProductsQuery();
  const movementsQuery = useMovementsQuery();
  const adjustmentsQuery = useAdjustmentsQuery();
  const writeOffsQuery = useWriteOffsQuery();
  const transfersQuery = useTransfersQuery();

  const loadAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.branches }),
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all }),
    ]);
  }, [queryClient]);

  const branches = useMemo<Branch[]>(
    () =>
      (branchesQuery.data?.branches ?? []).map((b) => ({
        branchId: b.id,
        branch_name: b.name,
        branch_location: b.location || "",
        contact_number: b.phone || "",
        code: b.code,
        branchType: b.branchType,
        isDefault: b.isDefault,
        isActive: b.isActive,
      })),
    [branchesQuery.data]
  );

  const branchMap = useMemo(() => new Map(branches.map((b) => [b.branchId, b])), [branches]);

  const products = useMemo<Product[]>(
    () =>
      (productsQuery.data?.products ?? []).map((p) => ({
        productId: p.id,
        product_name: p.name,
        product_sku: p.sku,
        quantity: p.totalQuantity,
        sellingPrice: p.sellingPrice,
        costPrice: p.costPrice,
        brand: p.brand,
        category: p.category,
        unit: p.unit,
        minStockLevel: p.minStockLevel,
        barcode: p.barcode,
      })),
    [productsQuery.data]
  );

  const productMap = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products]);

  const branchProducts = useMemo<BranchProduct[]>(
    () =>
      (productsQuery.data?.branchProducts ?? []).map((bp) => {
        const prod = productMap.get(bp.productId);
        return {
          productId: bp.productId,
          branchId: bp.branchId,
          product_name: bp.productName || prod?.product_name || "",
          product_sku: bp.productSku || prod?.product_sku || "",
          quantity: bp.quantity,
          avgCost: bp.avgCost,
          sellingPrice: bp.sellingPrice || prod?.sellingPrice || 0,
          costPrice: bp.avgCost || bp.costPrice || prod?.costPrice || 0,
        };
      }),
    [productsQuery.data, productMap]
  );

  const movements = useMemo<StockMovement[]>(
    () =>
      (movementsQuery.data?.movements ?? []).map((m) => {
        const prod = productMap.get(m.productId);
        const br = branchMap.get(m.branchId);
        return {
          id: m.id,
          productId: m.productId,
          branchId: m.branchId,
          product_name: prod?.product_name ?? "",
          product_sku: prod?.product_sku ?? "",
          branchName: br?.branch_name,
          type: m.type,
          quantity: m.qtyDelta,
          unitCost: m.unitCost,
          reference: m.referenceNumber || undefined,
          notes: m.notes || undefined,
          createdAt: m.createdAt,
          balanceAfter: m.balanceAfter,
        };
      }),
    [movementsQuery.data, productMap, branchMap]
  );

  const adjustments = useMemo<Adjustment[]>(() => {
    const out: Adjustment[] = [];
    for (const h of adjustmentsQuery.data?.adjustments ?? []) {
      const br = branchMap.get(h.branchId);
      for (const l of h.lines ?? []) {
        const prod = productMap.get(l.productId);
        out.push({
          id: `${h.id}:${l.id}`,
          reference: h.adjustmentNumber,
          productId: l.productId,
          product_name: prod?.product_name ?? "",
          product_sku: prod?.product_sku ?? "",
          branchId: h.branchId,
          branchName: br?.branch_name ?? "",
          beforeQty: l.previousQty,
          newQty: l.newQty,
          delta: l.qtyDelta,
          reason: h.reason,
          note: l.notes || h.notes || undefined,
          createdAt: h.createdAt,
          createdBy: h.createdByName,
        });
      }
    }
    return out;
  }, [adjustmentsQuery.data, productMap, branchMap]);

  const writeOffs = useMemo<WriteOff[]>(() => {
    const out: WriteOff[] = [];
    for (const h of writeOffsQuery.data?.writeOffs ?? []) {
      const br = branchMap.get(h.branchId);
      for (const l of h.lines ?? []) {
        const prod = productMap.get(l.productId);
        out.push({
          id: `${h.id}:${l.id}`,
          reference: h.writeOffNumber,
          productId: l.productId,
          product_name: prod?.product_name ?? "",
          product_sku: prod?.product_sku ?? "",
          branchId: h.branchId,
          branchName: br?.branch_name ?? "",
          quantity: l.quantity,
          reason: h.reason,
          note: l.notes || h.notes || undefined,
          costImpact: l.totalValue,
          createdAt: h.createdAt,
          createdBy: h.createdByName,
        });
      }
    }
    return out;
  }, [writeOffsQuery.data, productMap, branchMap]);

  const transfers = useMemo<Transfer[]>(
    () =>
      (transfersQuery.data?.transfers ?? []).map((t) => ({
        id: t.id,
        reference: t.transferNumber,
        sourceBranchId: t.fromBranchId,
        sourceBranchName: branchMap.get(t.fromBranchId)?.branch_name ?? "",
        destBranchId: t.toBranchId,
        destBranchName: branchMap.get(t.toBranchId)?.branch_name ?? "",
        status: t.status === "Partial" ? "In Transit" : t.status,
        shortageResolution:
          t.shortageResolution === "return_to_source" ||
          t.shortageResolution === "write_off_in_transit" ||
          t.shortageResolution === "none"
            ? t.shortageResolution
            : undefined,
        notes: t.notes || undefined,
        createdAt: t.createdAt,
        createdBy: t.createdByName,
        dispatchedAt: t.shippedAt ?? undefined,
        receivedAt: t.receivedAt ?? undefined,
        items: (t.lines ?? []).map((l) => {
          const prod = productMap.get(l.productId);
          return {
            id: l.id,
            productId: l.productId,
            product_name: prod?.product_name ?? "",
            product_sku: prod?.product_sku ?? "",
            quantity: l.qtySent,
            receivedQty: l.qtyReceived,
          };
        }),
      })),
    [transfersQuery.data, branchMap, productMap]
  );

  const addProduct = useCallback<InventoryContextType["addProduct"]>(
    async (data) => {
      try {
        const targetBranchId =
          activeBranchId !== "all"
            ? activeBranchId
            : (branches.find((b) => b.isDefault)?.branchId ?? branches[0]?.branchId);

        const initialStock =
          data.quantity > 0 && targetBranchId
            ? [{ branchId: targetBranchId, quantity: data.quantity, unitCost: data.costPrice }]
            : [];

        const res = await apiRequest<{ product: ApiProductRow }>("/api/products", {
          method: "POST",
          body: {
            sku: data.product_sku,
            name: data.product_name,
            category: data.category,
            brand: data.brand,
            unit: data.unit ?? "pcs",
            costPrice: data.costPrice,
            sellingPrice: data.sellingPrice,
            minStockLevel: data.minStockLevel ?? 0,
            barcode: data.barcode ?? null,
            initialStock,
          },
        });
        await loadAll();
        return {
          ok: true,
          product: {
            productId: res.product.id,
            product_name: res.product.name,
            product_sku: res.product.sku,
            quantity: res.product.totalQuantity,
            sellingPrice: res.product.sellingPrice,
            costPrice: res.product.costPrice,
            brand: res.product.brand,
            category: res.product.category,
            unit: res.product.unit,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to add product" };
      }
    },
    [activeBranchId, branches, loadAll]
  );

  const updateProduct = useCallback<InventoryContextType["updateProduct"]>(
    async (productId, data) => {
      try {
        await apiRequest(`/api/products/${productId}`, {
          method: "PUT",
          body: {
            sku: data.product_sku,
            name: data.product_name,
            category: data.category,
            brand: data.brand,
            unit: data.unit ?? "pcs",
            costPrice: data.costPrice,
            sellingPrice: data.sellingPrice,
            minStockLevel: data.minStockLevel ?? 0,
            barcode: data.barcode ?? null,
          },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update product" };
      }
    },
    [loadAll]
  );

  const deleteProduct = useCallback<InventoryContextType["deleteProduct"]>(
    async (productId) => {
      try {
        await apiRequest(`/api/products/${productId}`, { method: "DELETE" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete product" };
      }
    },
    [loadAll]
  );

  const addBranch = useCallback<InventoryContextType["addBranch"]>(
    async (data) => {
      try {
        const res = await apiRequest<{ branch: ApiBranchRow }>("/api/branches", {
          method: "POST",
          body: {
            name: data.branch_name,
            location: data.branch_location,
            phone: data.contact_number,
            branchType: data.branchType ?? "retail",
            code: data.code,
          },
        });
        await Promise.all([loadAll(), refreshBranches()]);
        return {
          ok: true,
          branch: {
            branchId: res.branch.id,
            branch_name: res.branch.name,
            branch_location: res.branch.location,
            contact_number: res.branch.phone,
            code: res.branch.code,
            branchType: res.branch.branchType,
            isDefault: res.branch.isDefault,
            isActive: res.branch.isActive,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to add branch" };
      }
    },
    [loadAll, refreshBranches]
  );

  const updateBranch = useCallback<InventoryContextType["updateBranch"]>(
    async (branchId, data) => {
      try {
        await apiRequest(`/api/branches/${branchId}`, {
          method: "PUT",
          body: {
            name: data.branch_name,
            location: data.branch_location,
            phone: data.contact_number,
            branchType: data.branchType,
          },
        });
        await Promise.all([loadAll(), refreshBranches()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update branch" };
      }
    },
    [loadAll, refreshBranches]
  );

  const deleteBranch = useCallback<InventoryContextType["deleteBranch"]>(
    async (branchId) => {
      try {
        await apiRequest(`/api/branches/${branchId}`, { method: "DELETE" });
        await Promise.all([loadAll(), refreshBranches()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete branch" };
      }
    },
    [loadAll, refreshBranches]
  );

  const getAssignedQuantity = useCallback(
    (productId: string) =>
      branchProducts.filter((bp) => bp.productId === productId).reduce((sum, bp) => sum + bp.quantity, 0),
    [branchProducts]
  );

  const getAvailableQuantity = useCallback(
    (productId: string) => {
      const prod = products.find((p) => p.productId === productId);
      if (!prod) return 0;
      const assigned = getAssignedQuantity(productId);
      return Math.max(0, prod.quantity - assigned);
    },
    [products, getAssignedQuantity]
  );

  const assignToBranch = useCallback<InventoryContextType["assignToBranch"]>(
    async (productId, branchId, quantity, sellingPrice, costPrice) => {
      try {
        await apiRequest("/api/branch-products/adjust-level", {
          method: "POST",
          body: {
            productId,
            branchId,
            newQuantity: quantity,
            sellingPrice,
            unitCost: costPrice,
            notes: "Assigned stock level to branch",
          },
        });
        await loadAll();
        return true;
      } catch {
        return false;
      }
    },
    [loadAll]
  );

  const updateBranchProduct = useCallback<InventoryContextType["updateBranchProduct"]>(
    async (productId, branchId, newQuantity, sellingPrice, costPrice) => {
      return assignToBranch(productId, branchId, newQuantity, sellingPrice, costPrice);
    },
    [assignToBranch]
  );

  const removeFromBranch = useCallback<InventoryContextType["removeFromBranch"]>(
    async (productId, branchId) => {
      const bp = branchProducts.find((x) => x.productId === productId && x.branchId === branchId);
      await apiRequest("/api/branch-products/adjust-level", {
        method: "POST",
        body: {
          productId,
          branchId,
          newQuantity: 0,
          unitCost: bp?.costPrice,
          notes: "Cleared branch stock",
        },
      });
      await loadAll();
    },
    [branchProducts, loadAll]
  );

  const receiveGoodsToBranch = useCallback<InventoryContextType["receiveGoodsToBranch"]>(
    async () => {
      await loadAll();
    },
    [loadAll]
  );

  const returnToVendor = useCallback<InventoryContextType["returnToVendor"]>(
    async () => {
      await loadAll();
      return { ok: true };
    },
    [loadAll]
  );

  const shipGoodsFromBranch = useCallback<InventoryContextType["shipGoodsFromBranch"]>(
    async () => {
      await loadAll();
      return { ok: true };
    },
    [loadAll]
  );

  const restockCustomerReturn = useCallback<InventoryContextType["restockCustomerReturn"]>(
    async () => {
      await loadAll();
      return { ok: true };
    },
    [loadAll]
  );

  const createAdjustment = useCallback<InventoryContextType["createAdjustment"]>(
    async (input) => {
      try {
        const res = await apiRequest<{ adjustment: { id: string; adjustmentNumber: string; createdAt: string } }>(
          "/api/adjustments",
          {
            method: "POST",
            body: {
              branchId: input.branchId,
              reason: input.reason,
              notes: input.note ?? "",
              lines: [{ productId: input.productId, newQty: input.newQty, notes: input.note ?? "" }],
            },
          }
        );
        await loadAll();
        const prod = products.find((p) => p.productId === input.productId);
        const br = branches.find((b) => b.branchId === input.branchId);
        const beforeQty =
          branchProducts.find((x) => x.productId === input.productId && x.branchId === input.branchId)?.quantity ?? 0;
        const created: Adjustment = {
          id: res.adjustment.id,
          reference: res.adjustment.adjustmentNumber,
          productId: input.productId,
          product_name: prod?.product_name ?? "",
          product_sku: prod?.product_sku ?? "",
          branchId: input.branchId,
          branchName: br?.branch_name ?? "",
          beforeQty,
          newQty: input.newQty,
          delta: input.newQty - beforeQty,
          reason: input.reason,
          note: input.note,
          createdAt: res.adjustment.createdAt,
          createdBy: input.createdBy,
        };
        return { ok: true, adjustment: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create adjustment" };
      }
    },
    [products, branches, branchProducts, loadAll]
  );

  const createWriteOff = useCallback<InventoryContextType["createWriteOff"]>(
    async (input) => {
      try {
        const res = await apiRequest<{ writeOff: { id: string; writeOffNumber: string; createdAt: string } }>(
          "/api/write-offs",
          {
            method: "POST",
            body: {
              branchId: input.branchId,
              reason: input.reason,
              notes: input.note ?? "",
              lines: [{ productId: input.productId, quantity: input.quantity, notes: input.note ?? "" }],
            },
          }
        );
        await loadAll();
        const prod = products.find((p) => p.productId === input.productId);
        const br = branches.find((b) => b.branchId === input.branchId);
        const created: WriteOff = {
          id: res.writeOff.id,
          reference: res.writeOff.writeOffNumber,
          productId: input.productId,
          product_name: prod?.product_name ?? "",
          product_sku: prod?.product_sku ?? "",
          branchId: input.branchId,
          branchName: br?.branch_name ?? "",
          quantity: input.quantity,
          reason: input.reason,
          note: input.note,
          costImpact: (prod?.costPrice ?? 0) * input.quantity,
          createdAt: res.writeOff.createdAt,
          createdBy: input.createdBy,
        };
        return { ok: true, writeOff: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create write-off" };
      }
    },
    [products, branches, loadAll]
  );

  const getInTransitQty = useCallback(
    (productId: string) =>
      transfers
        .filter((t) => t.status === "In Transit")
        .reduce(
          (sum, t) =>
            sum +
            t.items
              .filter((i) => i.productId === productId)
              .reduce((ls, i) => ls + Math.max(0, i.quantity - i.receivedQty), 0),
          0
        ),
    [transfers]
  );

  const createTransfer = useCallback<InventoryContextType["createTransfer"]>(
    async (input) => {
      try {
        const res = await apiRequest<{ transfer: { id: string; transferNumber: string; createdAt: string } }>(
          "/api/transfers",
          {
            method: "POST",
            body: {
              fromBranchId: input.sourceBranchId,
              toBranchId: input.destBranchId,
              status: "In Transit",
              notes: input.notes ?? "",
              lines: input.items,
            },
          }
        );
        await loadAll();
        const src = branches.find((b) => b.branchId === input.sourceBranchId);
        const dst = branches.find((b) => b.branchId === input.destBranchId);
        const created: Transfer = {
          id: res.transfer.id,
          reference: res.transfer.transferNumber,
          sourceBranchId: input.sourceBranchId,
          sourceBranchName: src?.branch_name ?? "",
          destBranchId: input.destBranchId,
          destBranchName: dst?.branch_name ?? "",
          status: "In Transit",
          items: input.items.map((i, idx) => {
            const p = products.find((x) => x.productId === i.productId);
            return {
              id: `${res.transfer.id}-${idx}`,
              productId: i.productId,
              product_name: p?.product_name ?? "",
              product_sku: p?.product_sku ?? "",
              quantity: i.quantity,
              receivedQty: 0,
            };
          }),
          notes: input.notes,
          createdAt: res.transfer.createdAt,
        };
        return { ok: true, transfer: created };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to create transfer" };
      }
    },
    [branches, products, loadAll]
  );

  const dispatchTransfer = useCallback<InventoryContextType["dispatchTransfer"]>(
    async (transferId) => {
      try {
        await apiRequest(`/api/transfers/${transferId}/dispatch`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to dispatch transfer" };
      }
    },
    [loadAll]
  );

  const receiveTransfer = useCallback<InventoryContextType["receiveTransfer"]>(
    async (transferId, receivedMap, shortageResolution) => {
      const tr = transfers.find((t) => t.id === transferId);
      if (!tr) return { ok: false, error: "Transfer not found" };

      const items = tr.items.map((item) => ({
        productId: item.productId,
        qtyReceived: receivedMap[item.productId] ?? receivedMap[item.id] ?? 0,
      }));

      try {
        await apiRequest(`/api/transfers/${transferId}/receive`, {
          method: "POST",
          body: {
            items,
            shortageResolution: shortageResolution ?? "none",
          },
        });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to receive transfer" };
      }
    },
    [transfers, loadAll]
  );

  const cancelTransfer = useCallback<InventoryContextType["cancelTransfer"]>(
    async (transferId) => {
      try {
        await apiRequest(`/api/transfers/${transferId}/cancel`, { method: "POST" });
        await loadAll();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel transfer" };
      }
    },
    [loadAll]
  );

  const value = useMemo<InventoryContextType>(
    () => ({
      products,
      addProduct,
      updateProduct,
      deleteProduct,
      branchProducts,
      branches,
      addBranch,
      updateBranch,
      deleteBranch,
      getAvailableQuantity,
      getAssignedQuantity,
      assignToBranch,
      updateBranchProduct,
      removeFromBranch,
      receiveGoodsToBranch,
      returnToVendor,
      shipGoodsFromBranch,
      restockCustomerReturn,
      movements,
      adjustments,
      createAdjustment,
      writeOffs,
      createWriteOff,
      transfers,
      getInTransitQty,
      createTransfer,
      dispatchTransfer,
      receiveTransfer,
      cancelTransfer,
      refreshInventory: loadAll,
    }),
    [
      products,
      addProduct,
      updateProduct,
      deleteProduct,
      branchProducts,
      branches,
      addBranch,
      updateBranch,
      deleteBranch,
      getAvailableQuantity,
      getAssignedQuantity,
      assignToBranch,
      updateBranchProduct,
      removeFromBranch,
      receiveGoodsToBranch,
      returnToVendor,
      shipGoodsFromBranch,
      restockCustomerReturn,
      movements,
      adjustments,
      createAdjustment,
      writeOffs,
      createWriteOff,
      transfers,
      getInTransitQty,
      createTransfer,
      dispatchTransfer,
      receiveTransfer,
      cancelTransfer,
      loadAll,
    ]
  );

  return <InventoryContext.Provider value={value}>{children}</InventoryContext.Provider>;
}

export function useInventory() {
  const context = useContext(InventoryContext);
  if (context === undefined) {
    throw new Error("useInventory must be used within an InventoryProvider");
  }
  return context;
}
