import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useBranch } from "@/contexts/BranchContext";
import { erpQueryKeys } from "./queryKeys";
import {
  useAdjustmentsQuery,
  useBranchesDirectoryQuery,
  useMovementsQuery,
  useProductsQuery,
  useTransfersQuery,
  useWriteOffsQuery,
  type ApiBranchRow,
  type ApiProductRow,
} from "./useInventoryQueries";
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

export interface InventoryScopeOptions {
  products?: boolean;
  movements?: boolean;
  adjustments?: boolean;
  writeOffs?: boolean;
  transfers?: boolean;
  directoryBranches?: boolean;
}

export function useInventoryScope(options: InventoryScopeOptions = {}) {
  const queryClient = useQueryClient();
  const { branches: shellBranches, activeBranchId, refreshBranches } = useBranch();

  const branchesDirQuery = useBranchesDirectoryQuery(Boolean(options.directoryBranches));
  const productsQuery = useProductsQuery(Boolean(options.products));
  const movementsQuery = useMovementsQuery(undefined, undefined, Boolean(options.movements));
  const adjustmentsQuery = useAdjustmentsQuery(Boolean(options.adjustments));
  const writeOffsQuery = useWriteOffsQuery(Boolean(options.writeOffs));
  const transfersQuery = useTransfersQuery(Boolean(options.transfers));

  const refreshInventory = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.branches }),
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.inventory.all }),
    ]);
  }, [queryClient]);

  const branches = useMemo<Branch[]>(() => {
    const source =
      options.directoryBranches && branchesDirQuery.data?.branches
        ? branchesDirQuery.data.branches
        : shellBranches;
    return source.map((b) => ({
      branchId: b.id,
      branch_name: b.name,
      branch_location: b.location || "",
      contact_number: b.phone || "",
      code: b.code,
      branchType: b.branchType,
      etaBranchId: b.etaBranchId ?? "0",
      country: b.country ?? "EG",
      governorate: b.governorate ?? "",
      regionCity: b.regionCity ?? "",
      street: b.street ?? "",
      buildingNumber: b.buildingNumber ?? "",
      postalCode: b.postalCode ?? "",
      isDefault: b.isDefault,
      isActive: b.isActive,
    }));
  }, [options.directoryBranches, branchesDirQuery.data, shellBranches]);

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
        itemType: p.itemType ?? "stock",
        trackingMode: p.trackingMode ?? "none",
        requiresExpiry: p.requiresExpiry ?? false,
        shelfLifeDays: p.shelfLifeDays ?? null,
        pickingStrategy: p.pickingStrategy ?? "FEFO",
        etaCodeType: p.etaCodeType ?? "EGS",
        etaItemCode: p.etaItemCode ?? "",
        etaUnitType: p.etaUnitType ?? "EA",
        hasBom: p.hasBom ?? false,
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

  const addProduct = useCallback(
    async (
      data: Omit<Product, "productId">
    ): Promise<{ ok: true; product: Product } | { ok: false; error: string }> => {
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
            itemType: data.itemType ?? "stock",
            trackingMode: data.trackingMode ?? "none",
            requiresExpiry: data.requiresExpiry ?? false,
            shelfLifeDays: data.shelfLifeDays ?? null,
            pickingStrategy: data.pickingStrategy ?? "FEFO",
            etaCodeType: data.etaCodeType ?? "EGS",
            etaItemCode: data.etaItemCode ?? "",
            etaUnitType: data.etaUnitType ?? "EA",
            initialStock,
          },
        });
        await refreshInventory();
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
            etaCodeType: res.product.etaCodeType ?? "EGS",
            etaItemCode: res.product.etaItemCode ?? "",
            etaUnitType: res.product.etaUnitType ?? "EA",
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to add product" };
      }
    },
    [activeBranchId, branches, refreshInventory]
  );

  const updateProduct = useCallback(
    async (
      productId: string,
      data: Omit<Product, "productId">
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
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
            itemType: data.itemType ?? "stock",
            trackingMode: data.trackingMode ?? "none",
            requiresExpiry: data.requiresExpiry ?? false,
            shelfLifeDays: data.shelfLifeDays ?? null,
            pickingStrategy: data.pickingStrategy ?? "FEFO",
            etaCodeType: data.etaCodeType ?? "EGS",
            etaItemCode: data.etaItemCode ?? "",
            etaUnitType: data.etaUnitType ?? "EA",
          },
        });
        await refreshInventory();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update product" };
      }
    },
    [refreshInventory]
  );

  const deleteProduct = useCallback(
    async (productId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/products/${productId}`, { method: "DELETE" });
        await refreshInventory();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete product" };
      }
    },
    [refreshInventory]
  );

  const addBranch = useCallback(
    async (
      data: Omit<Branch, "branchId">
    ): Promise<{ ok: true; branch: Branch } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{ branch: ApiBranchRow }>("/api/branches", {
          method: "POST",
          body: {
            name: data.branch_name,
            location: data.branch_location,
            phone: data.contact_number,
            branchType: data.branchType ?? "retail",
            code: data.code,
            etaBranchId: data.etaBranchId ?? "0",
            country: data.country ?? "EG",
            governorate: data.governorate ?? "",
            regionCity: data.regionCity ?? "",
            street: data.street ?? "",
            buildingNumber: data.buildingNumber ?? "",
            postalCode: data.postalCode ?? "",
          },
        });
        await Promise.all([refreshInventory(), refreshBranches()]);
        return {
          ok: true,
          branch: {
            branchId: res.branch.id,
            branch_name: res.branch.name,
            branch_location: res.branch.location,
            contact_number: res.branch.phone,
            code: res.branch.code,
            branchType: res.branch.branchType,
            etaBranchId: res.branch.etaBranchId ?? "0",
            country: res.branch.country ?? "EG",
            governorate: res.branch.governorate ?? "",
            regionCity: res.branch.regionCity ?? "",
            street: res.branch.street ?? "",
            buildingNumber: res.branch.buildingNumber ?? "",
            postalCode: res.branch.postalCode ?? "",
            isDefault: res.branch.isDefault,
            isActive: res.branch.isActive,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to add branch" };
      }
    },
    [refreshInventory, refreshBranches]
  );

  const updateBranch = useCallback(
    async (
      branchId: string,
      data: Omit<Branch, "branchId">
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/branches/${branchId}`, {
          method: "PUT",
          body: {
            name: data.branch_name,
            location: data.branch_location,
            phone: data.contact_number,
            branchType: data.branchType,
            etaBranchId: data.etaBranchId ?? "0",
            country: data.country ?? "EG",
            governorate: data.governorate ?? "",
            regionCity: data.regionCity ?? "",
            street: data.street ?? "",
            buildingNumber: data.buildingNumber ?? "",
            postalCode: data.postalCode ?? "",
          },
        });
        await Promise.all([refreshInventory(), refreshBranches()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to update branch" };
      }
    },
    [refreshInventory, refreshBranches]
  );

  const deleteBranch = useCallback(
    async (branchId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await apiRequest(`/api/branches/${branchId}`, { method: "DELETE" });
        await Promise.all([refreshInventory(), refreshBranches()]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to delete branch" };
      }
    },
    [refreshInventory, refreshBranches]
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

  const assignToBranch = useCallback(
    async (
      productId: string,
      branchId: string,
      quantity: number,
      sellingPrice: number,
      costPrice: number
    ): Promise<boolean> => {
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
        await refreshInventory();
        return true;
      } catch {
        return false;
      }
    },
    [refreshInventory]
  );

  const updateBranchProduct = useCallback(
    async (
      productId: string,
      branchId: string,
      newQuantity: number,
      sellingPrice: number,
      costPrice: number
    ): Promise<boolean> => assignToBranch(productId, branchId, newQuantity, sellingPrice, costPrice),
    [assignToBranch]
  );

  const removeFromBranch = useCallback(
    async (productId: string, branchId: string): Promise<void> => {
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
      await refreshInventory();
    },
    [branchProducts, refreshInventory]
  );

  const createAdjustment = useCallback(
    async (input: {
      productId: string;
      branchId: string;
      newQty: number;
      reason: AdjustmentReason;
      note?: string;
      approver?: string;
      createdBy?: string;
    }): Promise<{ ok: true; adjustment: Adjustment } | { ok: false; error: string }> => {
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
        await refreshInventory();
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
    [products, branches, branchProducts, refreshInventory]
  );

  const createWriteOff = useCallback(
    async (input: {
      productId: string;
      branchId: string;
      quantity: number;
      reason: WriteOffReason;
      note?: string;
      createdBy?: string;
      lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
      serialNumbers?: string[];
    }): Promise<{ ok: true; writeOff: WriteOff } | { ok: false; error: string }> => {
      try {
        const res = await apiRequest<{ writeOff: { id: string; writeOffNumber: string; createdAt: string } }>(
          "/api/write-offs",
          {
            method: "POST",
            body: {
              branchId: input.branchId,
              reason: input.reason,
              notes: input.note ?? "",
              lines: [
                {
                  productId: input.productId,
                  quantity: input.quantity,
                  notes: input.note ?? "",
                  ...(input.lotAllocations && input.lotAllocations.length > 0
                    ? { lotAllocations: input.lotAllocations }
                    : {}),
                  ...(input.serialNumbers && input.serialNumbers.length > 0
                    ? { serialNumbers: input.serialNumbers }
                    : {}),
                },
              ],
            },
          }
        );
        await refreshInventory();
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
    [products, branches, refreshInventory]
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

  const createTransfer = useCallback(
    async (input: {
      sourceBranchId: string;
      destBranchId: string;
      items: Array<{
        productId: string;
        quantity: number;
        lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
        serialNumbers?: string[];
      }>;
      notes?: string;
      createdBy?: string;
    }): Promise<{ ok: true; transfer: Transfer } | { ok: false; error: string }> => {
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
        await refreshInventory();
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
    [branches, products, refreshInventory]
  );

  const dispatchTransfer = useCallback(
    async (transferId: string, _actor?: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await apiRequest(`/api/transfers/${transferId}/dispatch`, { method: "POST" });
        await refreshInventory();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to dispatch transfer" };
      }
    },
    [refreshInventory]
  );

  const receiveTransfer = useCallback(
    async (
      transferId: string,
      receivedMap: Record<string, number>,
      shortageResolution?: TransferShortageResolution,
      _actor?: string
    ): Promise<{ ok: boolean; error?: string }> => {
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
        await refreshInventory();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to receive transfer" };
      }
    },
    [transfers, refreshInventory]
  );

  const cancelTransfer = useCallback(
    async (transferId: string, _actor?: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await apiRequest(`/api/transfers/${transferId}/cancel`, { method: "POST" });
        await refreshInventory();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Failed to cancel transfer" };
      }
    },
    [refreshInventory]
  );

  return {
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
    refreshInventory,
    isLoading:
      productsQuery.isLoading ||
      movementsQuery.isLoading ||
      adjustmentsQuery.isLoading ||
      writeOffsQuery.isLoading ||
      transfersQuery.isLoading,
  };
}
