import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  buildOffsetPageInfo,
  productsListQuerySchema,
  resolveSearchTerm,
  type adjustBranchLevelSchema,
  type createProductSchema,
  type updateProductSchema,
} from "@erp/shared";
import {
  branchProducts,
  products,
  purchaseOrderLines,
  salesOrderLines,
  stockMovements,
} from "../../drizzle/schema.ts";
import { AppError, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal } from "./gl.service.ts";
import { receiveTrackedStock, resolveProductTrackingMode } from "./lots-serials.service.ts";
import { parseOffsetQueryOrThrow } from "./query-helpers.ts";
import {
  actorCompanyId,
  assertBranchInCompany,
  computeWmac,
  lockBranchProduct,
  type RequestActor,
} from "./stock-locks.ts";

function productAuditSnapshot(p: typeof products.$inferSelect): Record<string, unknown> {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    brand: p.brand,
    unit: p.unit,
    costPrice: num(p.costPrice),
    sellingPrice: num(p.sellingPrice),
    minStockLevel: num(p.minStockLevel),
    isActive: p.isActive,
  };
}

export async function listProducts(
  db: AppDatabase,
  actor: RequestActor,
  rawQuery?: Record<string, unknown>
) {
  const companyId = actorCompanyId(actor);
  const query = parseOffsetQueryOrThrow(productsListQuerySchema, rawQuery);
  if (query.branchId) {
    assertBranchAccess(actor, query.branchId);
    await assertBranchInCompany(db, query.branchId, companyId);
  }

  const conds: SQL[] = [eq(products.companyId, companyId)];
  if (query.category) {
    conds.push(eq(products.category, query.category));
  }
  if (query.itemType) {
    conds.push(eq(products.itemType, query.itemType));
  }
  if (query.isActive !== undefined) {
    conds.push(eq(products.isActive, query.isActive === "true"));
  }
  const term = resolveSearchTerm(query);
  if (term) {
    const pattern = `%${term}%`;
    conds.push(
      or(
        ilike(products.name, pattern),
        ilike(products.sku, pattern),
        ilike(products.barcode, pattern),
        ilike(products.category, pattern),
        ilike(products.brand, pattern)
      )!
    );
  }
  const whereClause = and(...conds);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products)
    .where(whereClause);

  const dir = query.sortDir === "asc" ? asc : desc;
  const sortCol =
    query.sortBy === "name"
      ? products.name
      : query.sortBy === "sku"
        ? products.sku
        : query.sortBy === "sellingPrice"
          ? products.sellingPrice
          : query.sortBy === "costPrice"
            ? products.costPrice
            : products.createdAt;

  const prodRows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(dir(sortCol), dir(products.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  let bpRows: Array<typeof branchProducts.$inferSelect> = [];
  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    bpRows = await db.select().from(branchProducts).where(eq(branchProducts.companyId, companyId));
  } else if (actor.branchIds.length > 0) {
    bpRows = await db
      .select()
      .from(branchProducts)
      .where(and(eq(branchProducts.companyId, companyId), inArray(branchProducts.branchId, actor.branchIds)));
  }

  const totalQtyByProduct = new Map<string, number>();
  for (const bp of bpRows) {
    totalQtyByProduct.set(bp.productId, (totalQtyByProduct.get(bp.productId) ?? 0) + num(bp.qtyOnHand));
  }

  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  const missingBpProdIds = [...new Set(bpRows.map((bp) => bp.productId).filter((id) => !prodMap.has(id)))];
  if (missingBpProdIds.length > 0) {
    const extraProds = await db
      .select()
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, missingBpProdIds)));
    for (const ep of extraProds) {
      prodMap.set(ep.id, ep);
    }
  }

  const items = prodRows.map((p) => ({
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    nameAr: p.nameAr,
    description: p.description,
    category: p.category,
    brand: p.brand,
    unit: p.unit,
    tags: p.tags,
    costPrice: num(p.costPrice),
    sellingPrice: num(p.sellingPrice),
    minStockLevel: num(p.minStockLevel),
    itemType: p.itemType,
    trackingMode: resolveProductTrackingMode(p),
    requiresExpiry: p.requiresExpiry,
    shelfLifeDays: p.shelfLifeDays,
    pickingStrategy: p.pickingStrategy,
    trackLots: p.trackLots,
    trackSerials: p.trackSerials,
    etaCodeType: p.etaCodeType,
    etaItemCode: p.etaItemCode,
    etaUnitType: p.etaUnitType,
    hasBom: p.hasBom,
    isActive: p.isActive,
    totalQuantity: totalQtyByProduct.get(p.id) ?? 0,
    createdAt: p.createdAt.toISOString(),
  }));

  const pageInfo = buildOffsetPageInfo(query.page, query.pageSize, total);

  return {
    items,
    products: items,
    branchProducts: bpRows.map((bp) => {
      const prod = prodMap.get(bp.productId);
      return {
        id: bp.id,
        branchId: bp.branchId,
        productId: bp.productId,
        quantity: num(bp.qtyOnHand),
        qtyReserved: num(bp.qtyReserved),
        avgCost: num(bp.avgCost),
        costPrice: prod ? num(prod.costPrice) : num(bp.avgCost),
        sellingPrice: prod ? num(prod.sellingPrice) : 0,
        productName: prod?.name ?? "",
        productSku: prod?.sku ?? "",
      };
    }),
    pageInfo,
  };
}

export async function getProductById(db: AppDatabase, actor: RequestActor, id: string) {
  const companyId = actorCompanyId(actor);
  const [p] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)))
    .limit(1);
  if (!p) throw new AppError(404, "Product not found", "NOT_FOUND");

  let bpRows: Array<typeof branchProducts.$inferSelect> = [];
  if (actor.role === "admin" || actor.branchScopeMode === "all") {
    bpRows = await db
      .select()
      .from(branchProducts)
      .where(and(eq(branchProducts.companyId, companyId), eq(branchProducts.productId, id)));
  } else if (actor.branchIds.length > 0) {
    bpRows = await db
      .select()
      .from(branchProducts)
      .where(
        and(
          eq(branchProducts.companyId, companyId),
          eq(branchProducts.productId, id),
          inArray(branchProducts.branchId, actor.branchIds)
        )
      );
  }

  const totalQuantity = bpRows.reduce((sum, bp) => sum + num(bp.qtyOnHand), 0);

  return {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    nameAr: p.nameAr,
    description: p.description,
    category: p.category,
    brand: p.brand,
    unit: p.unit,
    tags: p.tags,
    costPrice: num(p.costPrice),
    sellingPrice: num(p.sellingPrice),
    minStockLevel: num(p.minStockLevel),
    itemType: p.itemType,
    trackingMode: resolveProductTrackingMode(p),
    requiresExpiry: p.requiresExpiry,
    shelfLifeDays: p.shelfLifeDays,
    pickingStrategy: p.pickingStrategy,
    trackLots: p.trackLots,
    trackSerials: p.trackSerials,
    etaCodeType: p.etaCodeType,
    etaItemCode: p.etaItemCode,
    etaUnitType: p.etaUnitType,
    hasBom: p.hasBom,
    isActive: p.isActive,
    totalQuantity,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function createProduct(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createProductSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  for (const init of data.initialStock) {
    assertBranchAccess(actor, init.branchId);
  }

  const created = await db.transaction(async (tx) => {
    for (const init of data.initialStock) {
      await assertBranchInCompany(tx, init.branchId, companyId);
    }

    const dup = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.sku, data.sku)))
      .limit(1);
    if (dup.length > 0) {
      throw new AppError(409, `SKU '${data.sku}' already exists`, "DUPLICATE_SKU");
    }

    const resolvedTracking = resolveProductTrackingMode({
      trackingMode: data.trackingMode ?? null,
      trackLots: data.trackLots,
      trackSerials: data.trackSerials,
    });

    const [prod] = await tx
      .insert(products)
      .values({
        companyId,
        sku: data.sku,
        barcode: data.barcode ?? null,
        name: data.name,
        nameAr: data.nameAr,
        description: data.description,
        category: data.category,
        brand: data.brand,
        unit: data.unit,
        tags: data.tags,
        costPrice: toNumeric(data.costPrice, 4),
        sellingPrice: toNumeric(data.sellingPrice, 4),
        minStockLevel: toNumeric(data.minStockLevel, 4),
        itemType: data.itemType ?? "stock",
        trackingMode: resolvedTracking,
        requiresExpiry: data.requiresExpiry ?? false,
        shelfLifeDays: data.shelfLifeDays ?? null,
        pickingStrategy: data.pickingStrategy ?? "FEFO",
        trackLots: resolvedTracking === "lot",
        trackSerials: resolvedTracking === "serial",
        etaCodeType: data.etaCodeType ?? "EGS",
        etaItemCode: data.etaItemCode ?? "",
        etaUnitType: data.etaUnitType ?? "EA",
        isActive: true,
      })
      .returning();

    let totalQuantity = 0;
    for (const init of data.initialStock) {
      if (init.quantity <= 0) continue;
      const unitCost = init.unitCost ?? data.costPrice;
      await tx
        .insert(branchProducts)
        .values({
          companyId,
          branchId: init.branchId,
          productId: prod.id,
          qtyOnHand: toNumeric(init.quantity, 4),
          avgCost: toNumeric(unitCost, 4),
        })
        .onConflictDoUpdate({
          target: [branchProducts.branchId, branchProducts.productId],
          set: {
            qtyOnHand: toNumeric(init.quantity, 4),
            avgCost: toNumeric(unitCost, 4),
            updatedAt: new Date(),
          },
        });

      const [mov] = await tx
        .insert(stockMovements)
        .values({
          companyId,
          branchId: init.branchId,
          productId: prod.id,
          movementType: "opening_balance",
          qtyDelta: toNumeric(init.quantity, 4),
          unitCost: toNumeric(unitCost, 4),
          balanceAfter: toNumeric(init.quantity, 4),
          avgCostAfter: toNumeric(unitCost, 4),
          referenceType: "product",
          referenceId: prod.id,
          referenceNumber: prod.sku,
          notes: "Initial opening stock",
          createdBy: actor.id,
        })
        .returning({ id: stockMovements.id });

      await receiveTrackedStock(tx, {
        companyId,
        product: prod,
        branchId: init.branchId,
        quantity: init.quantity,
        unitCost,
        movementId: mov.id,
        lotNumber: init.lotNumber,
        manufactureDate: init.manufactureDate,
        expiryDate: init.expiryDate,
        serialNumbers: init.serialNumbers,
        receivedFromType: "opening_balance",
        receivedFromId: prod.id,
        notes: "Initial opening stock",
      });
      const openingVal = Math.round((init.quantity * unitCost + Number.EPSILON) * 10000) / 10000;
      if (openingVal > 0) {
        await postMappedJournal(tx, {
          companyId,
          branchId: init.branchId,
          sourceType: "product_opening",
          sourceId: prod.id,
          referenceNumber: prod.sku,
          memo: `Opening stock balance for ${prod.name} (${prod.sku})`,
          createdBy: actor.id,
          lines: [
            { mappingKey: "inventory_asset", debit: openingVal },
            { mappingKey: "opening_equity", credit: openingVal },
          ],
        });
      }
      totalQuantity += init.quantity;
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "product.created",
      entityType: "inventory",
      entityId: prod.id,
      entityLabel: `${prod.name} (${prod.sku})`,
      details: { sku: prod.sku, initialTotalQty: totalQuantity },
      before: null,
      after: productAuditSnapshot(prod),
      ipAddress,
    });

    return { ...prod, totalQuantity };
  });

  return {
    id: created.id,
    sku: created.sku,
    barcode: created.barcode,
    name: created.name,
    nameAr: created.nameAr,
    description: created.description,
    category: created.category,
    brand: created.brand,
    unit: created.unit,
    tags: created.tags,
    costPrice: num(created.costPrice),
    sellingPrice: num(created.sellingPrice),
    minStockLevel: num(created.minStockLevel),
    itemType: created.itemType,
    trackingMode: created.trackingMode,
    requiresExpiry: created.requiresExpiry,
    shelfLifeDays: created.shelfLifeDays,
    pickingStrategy: created.pickingStrategy,
    trackLots: created.trackLots,
    trackSerials: created.trackSerials,
    etaCodeType: created.etaCodeType,
    etaItemCode: created.etaItemCode,
    etaUnitType: created.etaUnitType,
    hasBom: created.hasBom,
    isActive: created.isActive,
    totalQuantity: created.totalQuantity,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function updateProduct(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof updateProductSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Product not found", "NOT_FOUND");

    if (data.sku && data.sku !== current.sku) {
      const dup = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, companyId), eq(products.sku, data.sku)))
        .limit(1);
      if (dup.length > 0) {
        throw new AppError(409, `SKU '${data.sku}' is already in use`, "DUPLICATE_SKU");
      }
    }

    const nextTrackingMode =
      data.trackingMode !== undefined
        ? data.trackingMode
        : data.trackSerials !== undefined || data.trackLots !== undefined
          ? resolveProductTrackingMode({
              trackingMode: null,
              trackLots: data.trackLots ?? current.trackLots,
              trackSerials: data.trackSerials ?? current.trackSerials,
            })
          : current.trackingMode;

    const [row] = await tx
      .update(products)
      .set({
        sku: data.sku ?? current.sku,
        barcode: data.barcode !== undefined ? data.barcode : current.barcode,
        name: data.name ?? current.name,
        nameAr: data.nameAr ?? current.nameAr,
        description: data.description ?? current.description,
        category: data.category ?? current.category,
        brand: data.brand ?? current.brand,
        unit: data.unit ?? current.unit,
        tags: data.tags ?? current.tags,
        costPrice: data.costPrice !== undefined ? toNumeric(data.costPrice, 4) : current.costPrice,
        sellingPrice: data.sellingPrice !== undefined ? toNumeric(data.sellingPrice, 4) : current.sellingPrice,
        minStockLevel: data.minStockLevel !== undefined ? toNumeric(data.minStockLevel, 4) : current.minStockLevel,
        itemType: data.itemType ?? current.itemType,
        trackingMode: nextTrackingMode,
        requiresExpiry: data.requiresExpiry ?? current.requiresExpiry,
        shelfLifeDays: data.shelfLifeDays !== undefined ? data.shelfLifeDays : current.shelfLifeDays,
        pickingStrategy: data.pickingStrategy ?? current.pickingStrategy,
        trackLots: nextTrackingMode === "lot",
        trackSerials: nextTrackingMode === "serial",
        etaCodeType: data.etaCodeType ?? current.etaCodeType,
        etaItemCode: data.etaItemCode ?? current.etaItemCode,
        etaUnitType: data.etaUnitType ?? current.etaUnitType,
        isActive: data.isActive ?? current.isActive,
        updatedAt: new Date(),
      })
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "product.updated",
      entityType: "inventory",
      entityId: row.id,
      entityLabel: `${row.name} (${row.sku})`,
      before: productAuditSnapshot(current),
      after: productAuditSnapshot(row),
      ipAddress,
    });

    return row;
  });

  return {
    ...updated,
    costPrice: num(updated.costPrice),
    sellingPrice: num(updated.sellingPrice),
    minStockLevel: num(updated.minStockLevel),
  };
}

export async function deleteProduct(db: AppDatabase, actor: RequestActor, id: string, ipAddress?: string) {
  const companyId = actorCompanyId(actor);
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .limit(1);
    if (!current) throw new AppError(404, "Product not found", "NOT_FOUND");

    const [{ stockCount }] = await tx
      .select({ stockCount: sql<number>`count(*)::int` })
      .from(branchProducts)
      .where(
        and(
          eq(branchProducts.companyId, companyId),
          eq(branchProducts.productId, id),
          sql`${branchProducts.qtyOnHand} <> 0`
        )
      );
    const [{ moveCount }] = await tx
      .select({ moveCount: sql<number>`count(*)::int` })
      .from(stockMovements)
      .where(and(eq(stockMovements.companyId, companyId), eq(stockMovements.productId, id)));
    const [{ poLineCount }] = await tx
      .select({ poLineCount: sql<number>`count(*)::int` })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.productId, id));
    const [{ soLineCount }] = await tx
      .select({ soLineCount: sql<number>`count(*)::int` })
      .from(salesOrderLines)
      .where(eq(salesOrderLines.productId, id));

    if (stockCount > 0 || moveCount > 0 || poLineCount > 0 || soLineCount > 0) {
      throw new AppError(
        409,
        "Cannot delete product with existing stock, movements, or orders. Deactivate it instead.",
        "PRODUCT_HAS_HISTORY"
      );
    }

    await tx.delete(products).where(and(eq(products.id, id), eq(products.companyId, companyId)));
    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "product.deleted",
      entityType: "inventory",
      entityId: id,
      entityLabel: `${current.name} (${current.sku})`,
      before: productAuditSnapshot(current),
      after: null,
      ipAddress,
    });
  });
}

export async function adjustBranchProductLevel(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof adjustBranchLevelSchema>,
  ipAddress?: string
) {
  const companyId = actorCompanyId(actor);
  assertBranchAccess(actor, data.branchId);

  await db.transaction(async (tx) => {
    await assertBranchInCompany(tx, data.branchId, companyId);
    const [prod] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, data.productId), eq(products.companyId, companyId)))
      .limit(1);
    if (!prod) throw new AppError(404, "Product not found", "NOT_FOUND");

    if (data.sellingPrice !== undefined || data.unitCost !== undefined) {
      await tx
        .update(products)
        .set({
          ...(data.sellingPrice !== undefined ? { sellingPrice: toNumeric(data.sellingPrice, 4) } : {}),
          ...(data.unitCost !== undefined ? { costPrice: toNumeric(data.unitCost, 4) } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(products.id, prod.id), eq(products.companyId, companyId)));
    }

    const fallbackCost = data.unitCost ?? num(prod.costPrice);
    const bp = await lockBranchProduct(tx, data.branchId, prod.id, fallbackCost, companyId);
    const delta = data.newQuantity - bp.qtyOnHand;
    const nextAvg =
      delta > 0 ? computeWmac(bp.qtyOnHand, bp.avgCost, delta, fallbackCost) : (bp.avgCost || fallbackCost);

    await tx
      .update(branchProducts)
      .set({
        qtyOnHand: toNumeric(data.newQuantity, 4),
        avgCost: toNumeric(nextAvg, 4),
        updatedAt: new Date(),
      })
      .where(eq(branchProducts.id, bp.id));

    if (delta !== 0) {
      await tx.insert(stockMovements).values({
        companyId,
        branchId: data.branchId,
        productId: prod.id,
        movementType: delta > 0 ? "adjustment_in" : "adjustment_out",
        qtyDelta: toNumeric(delta, 4),
        unitCost: toNumeric(nextAvg, 4),
        balanceAfter: toNumeric(data.newQuantity, 4),
        avgCostAfter: toNumeric(nextAvg, 4),
        referenceType: "branch_stock",
        referenceId: bp.id,
        referenceNumber: prod.sku,
        notes: data.notes,
        createdBy: actor.id,
      });

      const adjVal = Math.round((Math.abs(delta * nextAvg) + Number.EPSILON) * 10000) / 10000;
      if (adjVal > 0) {
        await postMappedJournal(tx, {
          companyId,
          branchId: data.branchId,
          sourceType: "stock_adjustment",
          sourceId: bp.id,
          referenceNumber: prod.sku,
          memo: `Branch stock update for ${prod.name} (${delta > 0 ? `+${delta}` : delta})`,
          createdBy: actor.id,
          lines:
            delta > 0
              ? [
                  { mappingKey: "inventory_asset", debit: adjVal },
                  { mappingKey: "inventory_adjustment", credit: adjVal },
                ]
              : [
                  { mappingKey: "inventory_adjustment", debit: adjVal },
                  { mappingKey: "inventory_asset", credit: adjVal },
                ],
        });
      }
    }

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "branch_product.updated",
      entityType: "inventory",
      entityId: prod.id,
      entityLabel: prod.name,
      details: { previousQty: bp.qtyOnHand, newQty: data.newQuantity },
      ipAddress,
    });
  });
}
