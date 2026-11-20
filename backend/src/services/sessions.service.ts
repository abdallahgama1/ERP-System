import { asc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { createSessionSchema, patchSessionSchema, upsertSessionItemsSchema } from "@erp/shared";
import {
  branchProducts,
  products,
  stockAdjustmentLines,
  stockAdjustments,
  stockMovements,
  stockSessionItems,
  stockSessions,
} from "../../drizzle/schema.ts";
import { AppError, nextDocNumber, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { postMappedJournal } from "./gl.service.ts";
import { groupByKey, listBranchScoped } from "./query-helpers.ts";
import { lockBranchProduct, type RequestActor } from "./stock-locks.ts";

export async function listSessions(db: AppDatabase, actor: RequestActor) {
  const headers = (await listBranchScoped(
    db,
    stockSessions,
    stockSessions.branchId,
    stockSessions.createdAt,
    actor
  )) as Array<typeof stockSessions.$inferSelect>;
  if (headers.length === 0) return [];

  const items = await db
    .select()
    .from(stockSessionItems)
    .where(inArray(stockSessionItems.sessionId, headers.map((h) => h.id)));
  const itemsBySession = groupByKey(items, (i) => i.sessionId);

  return headers.map((s) => ({
    id: s.id,
    sessionNumber: s.sessionNumber,
    branchId: s.branchId,
    name: s.name,
    status: s.status,
    notes: s.notes,
    adjustmentId: s.adjustmentId,
    createdByUserId: s.createdByUserId,
    createdByName: s.createdByName,
    completedAt: s.completedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    items: (itemsBySession.get(s.id) ?? []).map((i) => ({
      id: i.id,
      productId: i.productId,
      expectedQty: num(i.expectedQty),
      countedQty: num(i.countedQty),
      variance: num(i.variance),
      scannedCount: i.scannedCount,
      notes: i.notes,
    })),
  }));
}

export async function createSession(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof createSessionSchema>,
  ipAddress?: string
) {
  assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const sessionNumber = await nextDocNumber(tx, "SESS", "CNT-");
    const [session] = await tx
      .insert(stockSessions)
      .values({
        sessionNumber,
        branchId: data.branchId,
        name: data.name,
        status: "In Progress",
        notes: data.notes,
        createdByUserId: actor.id,
        createdByName: actor.name,
      })
      .returning();

    const targetProducts = data.productIds?.length
      ? await tx.select().from(products).where(inArray(products.id, data.productIds))
      : await tx.select().from(products).where(eq(products.isActive, true));

    const bpRows = await tx.select().from(branchProducts).where(eq(branchProducts.branchId, data.branchId));
    const qtyMap = new Map(bpRows.map((bp) => [bp.productId, num(bp.qtyOnHand)]));

    if (targetProducts.length > 0) {
      await tx.insert(stockSessionItems).values(
        targetProducts.map((p) => {
          const expected = qtyMap.get(p.id) ?? 0;
          return {
            sessionId: session.id,
            productId: p.id,
            expectedQty: toNumeric(expected, 4),
            countedQty: "0",
            variance: toNumeric(-expected, 4),
            scannedCount: 0,
          };
        })
      );
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: data.branchId,
      action: "session.created",
      entityType: "sessions",
      entityId: session.id,
      entityLabel: `${session.name} (${session.sessionNumber})`,
      ipAddress,
    });

    return session;
  });
}

export async function updateSession(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  data: z.infer<typeof patchSessionSchema>,
  ipAddress?: string
) {
  if (data.branchId) assertBranchAccess(actor, data.branchId);

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(stockSessions).where(eq(stockSessions.id, id)).limit(1);
    if (!current) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, current.branchId);
    if (current.status === "Completed") {
      throw new AppError(400, "Completed stock-take sessions are immutable", "SESSION_IMMUTABLE");
    }

    const [res] = await tx
      .update(stockSessions)
      .set({
        name: data.name ?? current.name,
        notes: data.notes ?? current.notes,
        branchId: data.branchId ?? current.branchId,
        status: data.status ?? current.status,
        updatedAt: new Date(),
      })
      .where(eq(stockSessions.id, id))
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: res.branchId,
      action: "session.updated",
      entityType: "sessions",
      entityId: id,
      entityLabel: res.sessionNumber,
      ipAddress,
    });
    return res;
  });
}

export async function removeSessionItem(
  db: AppDatabase,
  actor: RequestActor,
  sessionId: string,
  productId: string
) {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(stockSessions).where(eq(stockSessions.id, sessionId)).limit(1);
    if (!session) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, session.branchId);
    if (session.status !== "In Progress") {
      throw new AppError(400, "Cannot remove items from a closed session", "SESSION_IMMUTABLE");
    }
    await tx
      .delete(stockSessionItems)
      .where(sql`${stockSessionItems.sessionId} = ${sessionId} AND ${stockSessionItems.productId} = ${productId}`);
  });
}

export async function upsertSessionItems(
  db: AppDatabase,
  actor: RequestActor,
  sessionId: string,
  data: z.infer<typeof upsertSessionItemsSchema>
) {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(stockSessions).where(eq(stockSessions.id, sessionId)).limit(1);
    if (!session) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, session.branchId);
    if (session.status !== "In Progress") {
      throw new AppError(400, "Cannot modify counts on a closed or cancelled session", "SESSION_IMMUTABLE");
    }

    const bpRows = await tx.select().from(branchProducts).where(eq(branchProducts.branchId, session.branchId));
    const qtyMap = new Map(bpRows.map((bp) => [bp.productId, num(bp.qtyOnHand)]));

    for (const item of data.items) {
      const expected = qtyMap.get(item.productId) ?? 0;
      const variance = item.countedQty - expected;

      await tx
        .insert(stockSessionItems)
        .values({
          sessionId,
          productId: item.productId,
          expectedQty: toNumeric(expected, 4),
          countedQty: toNumeric(item.countedQty, 4),
          variance: toNumeric(variance, 4),
          scannedCount: item.scannedCount ?? 0,
          notes: item.notes ?? "",
        })
        .onConflictDoUpdate({
          target: [stockSessionItems.sessionId, stockSessionItems.productId],
          set: {
            countedQty: toNumeric(item.countedQty, 4),
            variance: toNumeric(variance, 4),
            ...(item.scannedCount !== undefined ? { scannedCount: item.scannedCount } : {}),
            ...(item.notes !== undefined ? { notes: item.notes } : {}),
            updatedAt: new Date(),
          },
        });
    }

    await tx.update(stockSessions).set({ updatedAt: new Date() }).where(eq(stockSessions.id, sessionId));
  });
}

export async function completeSession(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const sRows = await tx.execute<{
      id: string;
      session_number: string;
      branch_id: string;
      name: string;
      status: string;
    }>(sql`SELECT id, session_number, branch_id, name, status FROM stock_sessions WHERE id = ${id} FOR UPDATE`);
    const session = sRows[0];
    if (!session) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, session.branch_id);

    if (session.status !== "In Progress") {
      throw new AppError(400, "Only In Progress sessions can be completed", "SESSION_NOT_IN_PROGRESS");
    }

    const items = await tx
      .select()
      .from(stockSessionItems)
      .where(eq(stockSessionItems.sessionId, id))
      .orderBy(asc(stockSessionItems.productId));

    const deltas: Array<{
      productId: string;
      bpId: string;
      previousQty: number;
      countedQty: number;
      delta: number;
      unitCost: number;
    }> = [];

    for (const item of items) {
      const [prod] = await tx.select().from(products).where(eq(products.id, item.productId)).limit(1);
      if (!prod) continue;
      const bp = await lockBranchProduct(tx, session.branch_id, item.productId, num(prod.costPrice));
      const counted = num(item.countedQty);
      const delta = counted - bp.qtyOnHand;
      if (delta !== 0) {
        deltas.push({
          productId: item.productId,
          bpId: bp.id,
          previousQty: bp.qtyOnHand,
          countedQty: counted,
          delta,
          unitCost: bp.avgCost > 0 ? bp.avgCost : num(prod.costPrice),
        });
      }
    }

    let adjustmentId: string | null = null;
    if (deltas.length > 0) {
      const adjNumber = await nextDocNumber(tx, "ADJ", "ADJ-");
      const [adj] = await tx
        .insert(stockAdjustments)
        .values({
          adjustmentNumber: adjNumber,
          branchId: session.branch_id,
          reason: "stock_take",
          status: "Posted",
          notes: `Stock-take reconciliation for ${session.name} (${session.session_number})`,
          createdBy: actor.id,
          createdByName: actor.name,
        })
        .returning();

      adjustmentId = adj.id;

      for (const d of deltas) {
        await tx
          .update(branchProducts)
          .set({ qtyOnHand: toNumeric(d.countedQty, 4), updatedAt: new Date() })
          .where(eq(branchProducts.id, d.bpId));

        await tx.insert(stockAdjustmentLines).values({
          adjustmentId: adj.id,
          productId: d.productId,
          qtyDelta: toNumeric(d.delta, 4),
          unitCost: toNumeric(d.unitCost, 4),
          previousQty: toNumeric(d.previousQty, 4),
          newQty: toNumeric(d.countedQty, 4),
          notes: `Stock-take ${session.session_number}`,
        });

        await tx.insert(stockMovements).values({
          branchId: session.branch_id,
          productId: d.productId,
          movementType: "stock_take",
          qtyDelta: toNumeric(d.delta, 4),
          unitCost: toNumeric(d.unitCost, 4),
          balanceAfter: toNumeric(d.countedQty, 4),
          avgCostAfter: toNumeric(d.unitCost, 4),
          referenceType: "session",
          referenceId: id,
          referenceNumber: session.session_number,
          notes: `Stock-take variance applied (${d.previousQty} -> ${d.countedQty})`,
          createdBy: actor.id,
        });
      }

      const netVarianceVal = deltas.reduce((sum, d) => sum + d.delta * d.unitCost, 0);
      if (Math.abs(netVarianceVal) > 0.0001) {
        const absVal = Math.abs(netVarianceVal);
        await postMappedJournal(tx, {
          branchId: session.branch_id,
          sourceType: "stock_session",
          sourceId: id,
          referenceNumber: session.session_number,
          memo: `Stock-take reconciliation ${session.session_number}`,
          createdBy: actor.id,
          lines:
            netVarianceVal > 0
              ? [
                  { mappingKey: "inventory_asset", debit: absVal },
                  { mappingKey: "inventory_adjustment", credit: absVal },
                ]
              : [
                  { mappingKey: "inventory_adjustment", debit: absVal },
                  { mappingKey: "inventory_asset", credit: absVal },
                ],
        });
      }
    }

    const [res] = await tx
      .update(stockSessions)
      .set({
        status: "Completed",
        adjustmentId,
        completedBy: actor.id,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stockSessions.id, id))
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: session.branch_id,
      action: "session.completed",
      entityType: "sessions",
      entityId: id,
      entityLabel: `${session.name} (${session.session_number})`,
      details: { adjustedSkus: deltas.length, adjustmentId },
      ipAddress,
    });

    return res;
  });
}

export async function cancelSession(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(stockSessions).where(eq(stockSessions.id, id)).limit(1);
    if (!session) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, session.branchId);
    if (session.status === "Completed") {
      throw new AppError(400, "Completed stock-take sessions are immutable", "SESSION_IMMUTABLE");
    }

    const [res] = await tx
      .update(stockSessions)
      .set({ status: "Cancelled", updatedAt: new Date() })
      .where(eq(stockSessions.id, id))
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: session.branchId,
      action: "session.cancelled",
      entityType: "sessions",
      entityId: id,
      entityLabel: `${session.name} (${session.sessionNumber})`,
      ipAddress,
    });

    return res;
  });
}

export async function deleteSession(
  db: AppDatabase,
  actor: RequestActor,
  id: string,
  ipAddress?: string
) {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(stockSessions).where(eq(stockSessions.id, id)).limit(1);
    if (!session) throw new AppError(404, "Session not found", "NOT_FOUND");
    assertBranchAccess(actor, session.branchId);
    if (session.status === "Completed") {
      throw new AppError(400, "Completed stock-take sessions cannot be deleted", "SESSION_IMMUTABLE");
    }

    await tx.delete(stockSessions).where(eq(stockSessions.id, id));
    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: session.branchId,
      action: "session.deleted",
      entityType: "sessions",
      entityId: id,
      entityLabel: `${session.name} (${session.sessionNumber})`,
      ipAddress,
    });
  });
}
