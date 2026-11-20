import type { ApprovalEntityType, upsertApprovalRuleSchema } from "@erp/shared";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  approvalRequests,
  approvalRules,
  notifications,
  products,
  purchaseOrders,
  stockAdjustmentLines,
  stockAdjustments,
  stockTransferLines,
  stockTransfers,
  stockWriteOffLines,
  stockWriteOffs,
  userRoles,
  users,
} from "../../drizzle/schema.ts";
import type { DbOrTx } from "../auth/permissions.ts";
import { AppError, num, toNumeric, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { sendApprovalRequestEmail } from "./email.service.ts";
import { postMappedJournal } from "./gl.service.ts";
import { applyBranchStockMovement, lockBranchProduct, type RequestActor } from "./stock-locks.ts";

const DEFAULT_RULES: Array<{
  entityType: ApprovalEntityType;
  minAmount: string;
  requiredRole: "admin" | "manager" | "user";
  description: string;
}> = [
  {
    entityType: "purchase_order",
    minAmount: "10000",
    requiredRole: "manager",
    description: "Require approval before issuing Purchase Orders at or above threshold.",
  },
  {
    entityType: "stock_transfer",
    minAmount: "5000",
    requiredRole: "manager",
    description: "Require approval before dispatching Stock Transfers at or above threshold.",
  },
  {
    entityType: "stock_adjustment",
    minAmount: "2000",
    requiredRole: "manager",
    description: "Require approval before posting Stock Adjustments at or above threshold.",
  },
  {
    entityType: "stock_write_off",
    minAmount: "1000",
    requiredRole: "manager",
    description: "Require approval before posting Inventory Write-Offs at or above threshold.",
  },
];

export async function ensureApprovalDefaults(tx: DbOrTx): Promise<void> {
  for (const def of DEFAULT_RULES) {
    await tx
      .insert(approvalRules)
      .values({
        entityType: def.entityType,
        minAmount: def.minAmount,
        requiredRole: def.requiredRole,
        isActive: false,
        description: def.description,
      })
      .onConflictDoNothing();
  }
}

export async function listApprovalRules(db: AppDatabase) {
  await ensureApprovalDefaults(db);
  const rows = await db.select().from(approvalRules).orderBy(asc(approvalRules.entityType));
  return rows.map((r) => ({
    ...r,
    minAmount: num(r.minAmount),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function upsertApprovalRule(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof upsertApprovalRuleSchema>,
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(approvalRules)
      .values({
        entityType: data.entityType,
        minAmount: toNumeric(data.minAmount, 4),
        requiredRole: data.requiredRole,
        isActive: data.isActive,
        description: data.description,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: approvalRules.entityType,
        set: {
          minAmount: toNumeric(data.minAmount, 4),
          requiredRole: data.requiredRole,
          isActive: data.isActive,
          description: data.description,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "approval_rule.updated",
      entityType: "settings",
      entityId: row.id,
      entityLabel: `${row.entityType} (${data.isActive ? `>= ${data.minAmount}` : "disabled"})`,
      ipAddress,
    });

    return {
      ...row,
      minAmount: num(row.minAmount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function checkApprovalRequired(
  tx: DbOrTx,
  entityType: ApprovalEntityType,
  amount: number
) {
  const [rule] = await tx
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.entityType, entityType), eq(approvalRules.isActive, true)))
    .limit(1);

  if (!rule) return null;
  if (amount + 0.0001 >= num(rule.minAmount)) {
    return rule;
  }
  return null;
}

export async function createApprovalRequest(
  tx: DbOrTx,
  input: {
    entityType: ApprovalEntityType;
    entityId: string;
    entityNumber: string;
    branchId?: string | null;
    amount: number;
    actor: RequestActor;
    ipAddress?: string;
  }
) {
  const [reqRow] = await tx
    .insert(approvalRequests)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      entityNumber: input.entityNumber,
      branchId: input.branchId ?? null,
      amount: toNumeric(input.amount, 4),
      status: "pending",
      requestedBy: input.actor.id,
      requestedByName: input.actor.name,
    })
    .returning();

  await tx.insert(notifications).values({
    type: "approval_required",
    title: `Approval Required: ${input.entityNumber}`,
    message: `${input.actor.name} submitted ${input.entityType.replace(/_/g, " ")} ${input.entityNumber} (${input.amount.toFixed(2)}) for approval.`,
    branchId: input.branchId ?? null,
    entityType: input.entityType,
    entityId: input.entityId,
  });

  await writeAuditLog(tx, {
    userId: input.actor.id,
    userName: input.actor.name,
    userRole: input.actor.role,
    branchId: input.branchId ?? null,
    action: "approval.requested",
    entityType: "approvals",
    entityId: reqRow.id,
    entityLabel: input.entityNumber,
    details: { entityType: input.entityType, entityId: input.entityId, amount: input.amount },
    ipAddress: input.ipAddress,
  });

  const approverEmails = await tx
    .select({ email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(inArray(userRoles.role, ["admin", "manager"]), eq(users.isActive, true)));

  const recipients = approverEmails.map((u) => u.email).filter(Boolean);
  if (recipients.length > 0) {
    void sendApprovalRequestEmail(recipients, {
      entityType: input.entityType,
      entityNumber: input.entityNumber,
      amount: input.amount,
      requestedByName: input.actor.name,
    });
  }

  return reqRow;
}

export async function listApprovalRequests(db: AppDatabase, actor: RequestActor) {
  await ensureApprovalDefaults(db);

  const cond =
    actor.role === "admin" || actor.branchScopeMode === "all"
      ? undefined
      : actor.branchIds.length > 0
        ? or(
            eq(approvalRequests.requestedBy, actor.id),
            inArray(approvalRequests.branchId, actor.branchIds)
          )
        : eq(approvalRequests.requestedBy, actor.id);

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(cond)
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(200);

  return rows.map((r) => ({
    ...r,
    amount: num(r.amount),
    requestedAt: r.requestedAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
  }));
}

export async function reviewApprovalRequest(
  db: AppDatabase,
  actor: RequestActor,
  requestId: string,
  decision: "approved" | "rejected",
  comment = "",
  ipAddress?: string
) {
  return db.transaction(async (tx) => {
    const reqRows = await tx.execute<{
      id: string;
      entity_type: ApprovalEntityType;
      entity_id: string;
      entity_number: string;
      branch_id: string | null;
      amount: string;
      status: "pending" | "approved" | "rejected";
      requested_by: string | null;
      requested_by_name: string;
    }>(sql`
      SELECT id, entity_type, entity_id, entity_number, branch_id, amount, status, requested_by, requested_by_name
      FROM approval_requests
      WHERE id = ${requestId}
      FOR UPDATE
    `);

    const req = reqRows[0];
    if (!req) throw new AppError(404, "Approval request not found", "NOT_FOUND");
    if (req.status !== "pending") {
      throw new AppError(400, "Approval request has already been decided", "APPROVAL_ALREADY_REVIEWED");
    }

    const [rule] = await tx
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.entityType, req.entity_type))
      .limit(1);

    const requiredRole = rule?.requiredRole ?? "manager";
    if (actor.role !== "admin" && (requiredRole === "admin" || actor.role === "user")) {
      throw new AppError(403, `Requires '${requiredRole}' role or admin to review this request`, "FORBIDDEN");
    }

    let selfApprovedSingleAdmin = false;
    if (req.requested_by && req.requested_by === actor.id) {
      const eligibleRoles = requiredRole === "admin" ? ["admin"] : ["admin", "manager"];
      const [{ approverCount }] = await tx
        .select({ approverCount: sql<number>`count(distinct ${users.id})::int` })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .where(
          and(
            eq(users.isActive, true),
            inArray(userRoles.role, eligibleRoles as Array<"admin" | "manager" | "user">)
          )
        );

      if (approverCount > 1 || actor.role !== "admin") {
        throw new AppError(
          403,
          "Maker-checker violation: requester cannot review their own request while another approver is active",
          "SELF_APPROVAL_FORBIDDEN"
        );
      }
      selfApprovedSingleAdmin = true;
    }

    const now = new Date();
    const [updatedReq] = await tx
      .update(approvalRequests)
      .set({
        status: decision,
        reviewedBy: actor.id,
        reviewedByName: actor.name,
        decisionComment: comment,
        selfApprovedSingleAdmin,
        reviewedAt: now,
      })
      .where(eq(approvalRequests.id, requestId))
      .returning();

    if (decision === "approved") {
      await executeApprovedDocument(tx, req.entity_type, req.entity_id, actor);
    } else {
      await markRejectedDocument(tx, req.entity_type, req.entity_id);
    }

    await writeAuditLog(tx, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: req.branch_id,
      action: decision === "approved" ? "approval.approved" : "approval.rejected",
      entityType: "approvals",
      entityId: requestId,
      entityLabel: req.entity_number,
      details: {
        entityType: req.entity_type,
        entityId: req.entity_id,
        comment,
        selfApprovedSingleAdmin,
      },
      ipAddress,
    });

    return {
      ...updatedReq,
      amount: num(updatedReq.amount),
      requestedAt: updatedReq.requestedAt.toISOString(),
      reviewedAt: updatedReq.reviewedAt?.toISOString() ?? null,
    };
  });
}

async function executeApprovedDocument(
  tx: DbOrTx,
  entityType: ApprovalEntityType,
  entityId: string,
  actor: RequestActor
): Promise<void> {
  if (entityType === "purchase_order") {
    await tx
      .update(purchaseOrders)
      .set({ status: "Issued", approvalStatus: "approved", approvedBy: actor.id, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, entityId));
    return;
  }

  if (entityType === "stock_transfer") {
    const [tr] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, entityId)).limit(1);
    if (!tr || tr.status !== "Draft") return;

    const lines = await tx
      .select()
      .from(stockTransferLines)
      .where(eq(stockTransferLines.transferId, entityId))
      .orderBy(asc(stockTransferLines.productId));

    let totalDispatchedVal = 0;
    for (const line of lines) {
      const qtySent = num(line.qtySent);
      const moved = await applyBranchStockMovement(tx, {
        branchId: tr.fromBranchId,
        productId: line.productId,
        qtyDelta: -qtySent,
        fallbackCost: num(line.unitCost),
        movementType: "transfer_out",
        referenceType: "transfer",
        referenceId: tr.id,
        referenceNumber: tr.transferNumber,
        notes: `Approved & dispatched transfer ${tr.transferNumber}`,
        actorId: actor.id,
      });
      await tx
        .update(stockTransferLines)
        .set({ unitCost: toNumeric(moved.movementCost, 4) })
        .where(eq(stockTransferLines.id, line.id));
      totalDispatchedVal += Math.abs(moved.totalValueDelta);
    }

    if (totalDispatchedVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: tr.fromBranchId,
        sourceType: "stock_transfer",
        sourceId: tr.id,
        referenceNumber: tr.transferNumber,
        memo: `Approved & dispatched transfer ${tr.transferNumber}`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "in_transit_inventory", debit: totalDispatchedVal, branchId: tr.fromBranchId },
          { mappingKey: "inventory_asset", credit: totalDispatchedVal, branchId: tr.fromBranchId },
        ],
      });
    }

    await tx
      .update(stockTransfers)
      .set({
        status: "In Transit",
        approvalStatus: "approved",
        approvedBy: actor.id,
        shippedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stockTransfers.id, entityId));
    return;
  }

  if (entityType === "stock_adjustment") {
    const [adj] = await tx.select().from(stockAdjustments).where(eq(stockAdjustments.id, entityId)).limit(1);
    if (!adj || adj.status !== "Pending Approval") return;

    const lines = await tx
      .select()
      .from(stockAdjustmentLines)
      .where(eq(stockAdjustmentLines.adjustmentId, entityId))
      .orderBy(asc(stockAdjustmentLines.productId));

    let totalPosVal = 0;
    let totalNegVal = 0;
    for (const line of lines) {
      const delta = num(line.qtyDelta);
      if (delta === 0) continue;
      const [prod] = await tx.select().from(products).where(eq(products.id, line.productId)).limit(1);
      const fallback = num(prod?.costPrice ?? line.unitCost);
      const locked = await lockBranchProduct(tx, adj.branchId, line.productId, fallback);
      const unitCost = locked.avgCost > 0 ? locked.avgCost : fallback;

      const moved = await applyBranchStockMovement(tx, {
        branchId: adj.branchId,
        productId: line.productId,
        qtyDelta: delta,
        fallbackCost: unitCost,
        recomputeAvgCost: false,
        movementType: delta > 0 ? "adjustment_in" : "adjustment_out",
        movementUnitCost: unitCost,
        referenceType: "adjustment",
        referenceId: adj.id,
        referenceNumber: adj.adjustmentNumber,
        notes: `Approved adjustment ${adj.adjustmentNumber} (${adj.reason})`,
        actorId: actor.id,
      });

      await tx
        .update(stockAdjustmentLines)
        .set({
          unitCost: toNumeric(unitCost, 4),
          previousQty: toNumeric(moved.previousQty, 4),
          newQty: toNumeric(moved.newQty, 4),
        })
        .where(eq(stockAdjustmentLines.id, line.id));

      if (moved.totalValueDelta > 0) totalPosVal += moved.totalValueDelta;
      else totalNegVal += Math.abs(moved.totalValueDelta);
    }

    const netInvDelta = totalPosVal - totalNegVal;
    if (Math.abs(netInvDelta) > 0.0001) {
      const absVal = Math.abs(netInvDelta);
      await postMappedJournal(tx, {
        branchId: adj.branchId,
        sourceType: "stock_adjustment",
        sourceId: adj.id,
        referenceNumber: adj.adjustmentNumber,
        memo: `Approved stock adjustment ${adj.adjustmentNumber} (${adj.reason})`,
        createdBy: actor.id,
        lines:
          netInvDelta > 0
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

    await tx
      .update(stockAdjustments)
      .set({ status: "Posted", approvalStatus: "approved", approvedBy: actor.id })
      .where(eq(stockAdjustments.id, entityId));
    return;
  }

  if (entityType === "stock_write_off") {
    const [wo] = await tx.select().from(stockWriteOffs).where(eq(stockWriteOffs.id, entityId)).limit(1);
    if (!wo || wo.status !== "Pending Approval") return;

    const lines = await tx
      .select()
      .from(stockWriteOffLines)
      .where(eq(stockWriteOffLines.writeOffId, entityId))
      .orderBy(asc(stockWriteOffLines.productId));

    let totalWriteOffVal = 0;
    for (const line of lines) {
      const qty = num(line.quantity);
      const moved = await applyBranchStockMovement(tx, {
        branchId: wo.branchId,
        productId: line.productId,
        qtyDelta: -qty,
        fallbackCost: num(line.unitCost),
        movementType: "write_off",
        referenceType: "write_off",
        referenceId: wo.id,
        referenceNumber: wo.writeOffNumber,
        notes: `Approved write-off ${wo.writeOffNumber} (${wo.reason})`,
        actorId: actor.id,
      });

      const totalVal = Math.abs(moved.totalValueDelta);
      totalWriteOffVal += totalVal;
      await tx
        .update(stockWriteOffLines)
        .set({ unitCost: toNumeric(moved.movementCost, 4), totalValue: toNumeric(totalVal, 4) })
        .where(eq(stockWriteOffLines.id, line.id));
    }

    if (totalWriteOffVal > 0.0001) {
      await postMappedJournal(tx, {
        branchId: wo.branchId,
        sourceType: "write_off",
        sourceId: wo.id,
        referenceNumber: wo.writeOffNumber,
        memo: `Approved stock write-off ${wo.writeOffNumber} (${wo.reason})`,
        createdBy: actor.id,
        lines: [
          { mappingKey: "write_off_expense", debit: totalWriteOffVal },
          { mappingKey: "inventory_asset", credit: totalWriteOffVal },
        ],
      });
    }

    await tx
      .update(stockWriteOffs)
      .set({ status: "Posted", approvalStatus: "approved", approvedBy: actor.id })
      .where(eq(stockWriteOffs.id, entityId));
  }
}

async function markRejectedDocument(
  tx: DbOrTx,
  entityType: ApprovalEntityType,
  entityId: string
): Promise<void> {
  if (entityType === "purchase_order") {
    await tx
      .update(purchaseOrders)
      .set({ status: "Draft", approvalStatus: "rejected", updatedAt: new Date() })
      .where(eq(purchaseOrders.id, entityId));
  } else if (entityType === "stock_transfer") {
    await tx
      .update(stockTransfers)
      .set({ status: "Draft", approvalStatus: "rejected", updatedAt: new Date() })
      .where(eq(stockTransfers.id, entityId));
  } else if (entityType === "stock_adjustment") {
    await tx
      .update(stockAdjustments)
      .set({ status: "Rejected", approvalStatus: "rejected" })
      .where(eq(stockAdjustments.id, entityId));
  } else if (entityType === "stock_write_off") {
    await tx
      .update(stockWriteOffs)
      .set({ status: "Rejected", approvalStatus: "rejected" })
      .where(eq(stockWriteOffs.id, entityId));
  }
}
