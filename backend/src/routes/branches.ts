import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { branchInputSchema, updateBranchSchema } from "@erp/shared";
import {
  branches,
  branchProducts,
  companies,
  companySettings,
  DEFAULT_COMPANY_ID,
  purchaseOrders,
  salesOrders,
  stockMovements,
  stockSessions,
  stockTransfers,
} from "../../drizzle/schema.ts";
import { ensureSeededDefaults } from "../auth/permissions.ts";
import { AppError, nextDocNumber, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requireAuth, requirePermission } from "../middleware/auth.ts";
import { actorCompanyId } from "../services/stock-locks.ts";

export async function branchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/branches", { preHandler: requireAuth }, async (req) => {
    const query = req.query as { scope?: string };
    const actor = req.authUser!;
    const companyId = actorCompanyId(actor);
    const db = getDb();

    if (query.scope === "directory") {
      const fetchDirectory = () =>
        db
          .select({
            id: branches.id,
            code: branches.code,
            name: branches.name,
            branchType: branches.branchType,
            location: branches.location,
            isDefault: branches.isDefault,
            isActive: branches.isActive,
          })
          .from(branches)
          .where(and(eq(branches.companyId, companyId), eq(branches.isActive, true)))
          .orderBy(asc(branches.createdAt));

      let list = await fetchDirectory();
      if (list.length === 0 && companyId === DEFAULT_COMPANY_ID) {
        const anyBranch = await db
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.companyId, companyId))
          .limit(1);
        if (anyBranch.length === 0) {
          await ensureSeededDefaults(db);
          list = await fetchDirectory();
        }
      }
      return { branches: list };
    }

    if (actor.role === "admin" || actor.branchScopeMode === "all") {
      let list = await db
        .select()
        .from(branches)
        .where(eq(branches.companyId, companyId))
        .orderBy(asc(branches.createdAt));
      if (list.length === 0 && companyId === DEFAULT_COMPANY_ID) {
        await ensureSeededDefaults(db);
        list = await db
          .select()
          .from(branches)
          .where(eq(branches.companyId, companyId))
          .orderBy(asc(branches.createdAt));
      }
      return { branches: list };
    }

    if (actor.branchIds.length === 0) {
      return { branches: [] };
    }

    const list = await db
      .select()
      .from(branches)
      .where(and(eq(branches.companyId, companyId), inArray(branches.id, actor.branchIds)))
      .orderBy(asc(branches.createdAt));

    return { branches: list };
  });

  app.post("/api/branches", { preHandler: requirePermission("branches", "create") }, async (req, reply) => {
    const parsed = branchInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid branch input", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const companyId = actorCompanyId(actor);
    const db = getDb();

    const created = await db.transaction(async (tx) => {
      if (companyId === DEFAULT_COMPANY_ID) {
        await ensureSeededDefaults(tx);
      }
      const code = (parsed.data.code || (await nextDocNumber(tx, "BR", "BR-", null, companyId))).trim();

      const existing = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.companyId, companyId), sql`lower(btrim(${branches.code})) = lower(btrim(${code}))`))
        .limit(1);
      if (existing.length > 0) {
        throw new AppError(409, `Branch code '${code}' already exists`, "DUPLICATE_BRANCH_CODE", {
          field: "code",
          messageEn: `A branch with code '${code}' already exists in your company.`,
          messageAr: `يوجد فرع بنفس الكود '${code}' بالفعل في شركتك.`,
        });
      }

      const existingName = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(
          and(
            eq(branches.companyId, companyId),
            sql`lower(btrim(${branches.name})) = lower(btrim(${parsed.data.name}))`
          )
        )
        .limit(1);
      if (existingName.length > 0) {
        throw new AppError(409, `Branch name '${parsed.data.name}' already exists`, "DUPLICATE_BRANCH_NAME", {
          field: "name",
          messageEn: `A branch with name '${parsed.data.name}' already exists in your company.`,
          messageAr: `يوجد فرع بنفس الاسم '${parsed.data.name}' بالفعل في شركتك.`,
        });
      }

      if (parsed.data.isDefault) {
        await tx
          .update(branches)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)));
      }

      const [row] = await tx
        .insert(branches)
        .values({
          companyId,
          code,
          name: parsed.data.name,
          branchType: parsed.data.branchType,
          location: parsed.data.location,
          address: parsed.data.address,
          phone: parsed.data.phone,
          email: parsed.data.email,
          managerName: parsed.data.managerName,
          etaBranchId: parsed.data.etaBranchId ?? "0",
          country: parsed.data.country ?? "EG",
          governorate: parsed.data.governorate ?? "",
          regionCity: parsed.data.regionCity ?? "",
          street: parsed.data.street ?? "",
          buildingNumber: parsed.data.buildingNumber ?? "",
          postalCode: parsed.data.postalCode ?? "",
          isDefault: parsed.data.isDefault,
          isActive: parsed.data.isActive,
        })
        .returning();

      if (row.isDefault) {
        await tx
          .update(companies)
          .set({ defaultBranchId: row.id, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
        if (companyId === DEFAULT_COMPANY_ID) {
          await tx
            .update(companySettings)
            .set({ defaultBranchId: row.id, updatedAt: new Date() })
            .where(eq(companySettings.id, 1));
        }
      }

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        branchId: row.id,
        action: "branch.created",
        entityType: "branches",
        entityId: row.id,
        entityLabel: row.name,
        details: { code: row.code, branchType: row.branchType },
        ipAddress: req.ip,
      });

      return row;
    });

    eventBroadcaster.broadcast("branches_updated", { branchId: created.id }, companyId);
    return reply.status(201).send({ branch: created });
  });

  app.put("/api/branches/:id", { preHandler: requirePermission("branches", "edit") }, async (req) => {
    const branchId = (req.params as { id: string }).id;
    const parsed = updateBranchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid branch payload", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const companyId = actorCompanyId(actor);
    assertBranchAccess(actor, branchId);
    const db = getDb();

    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)))
        .limit(1);
      if (!current) {
        throw new AppError(404, "Branch not found", "NOT_FOUND");
      }

      if (parsed.data.code && parsed.data.code.trim().toLowerCase() !== current.code.trim().toLowerCase()) {
        const dup = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.companyId, companyId),
              sql`lower(btrim(${branches.code})) = lower(btrim(${parsed.data.code}))`
            )
          )
          .limit(1);
        if (dup.length > 0) {
          throw new AppError(409, `Branch code '${parsed.data.code}' is already in use`, "DUPLICATE_BRANCH_CODE", {
            field: "code",
            messageEn: `A branch with code '${parsed.data.code}' already exists in your company.`,
            messageAr: `يوجد فرع بنفس الكود '${parsed.data.code}' بالفعل في شركتك.`,
          });
        }
      }

      if (parsed.data.name && parsed.data.name.trim().toLowerCase() !== current.name.trim().toLowerCase()) {
        const dupName = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.companyId, companyId),
              sql`${branches.id} <> ${branchId}`,
              sql`lower(btrim(${branches.name})) = lower(btrim(${parsed.data.name}))`
            )
          )
          .limit(1);
        if (dupName.length > 0) {
          throw new AppError(409, `Branch name '${parsed.data.name}' is already in use`, "DUPLICATE_BRANCH_NAME", {
            field: "name",
            messageEn: `A branch with name '${parsed.data.name}' already exists in your company.`,
            messageAr: `يوجد فرع بنفس الاسم '${parsed.data.name}' بالفعل في شركتك.`,
          });
        }
      }

      if (parsed.data.isDefault === true) {
        await tx
          .update(branches)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)));
      }

      const [row] = await tx
        .update(branches)
        .set({
          code: parsed.data.code ?? current.code,
          name: parsed.data.name ?? current.name,
          branchType: parsed.data.branchType ?? current.branchType,
          location: parsed.data.location ?? current.location,
          address: parsed.data.address ?? current.address,
          phone: parsed.data.phone ?? current.phone,
          email: parsed.data.email ?? current.email,
          managerName: parsed.data.managerName ?? current.managerName,
          etaBranchId: parsed.data.etaBranchId ?? current.etaBranchId,
          country: parsed.data.country ?? current.country,
          governorate: parsed.data.governorate ?? current.governorate,
          regionCity: parsed.data.regionCity ?? current.regionCity,
          street: parsed.data.street ?? current.street,
          buildingNumber: parsed.data.buildingNumber ?? current.buildingNumber,
          postalCode: parsed.data.postalCode ?? current.postalCode,
          isDefault: parsed.data.isDefault ?? current.isDefault,
          isActive: parsed.data.isActive ?? current.isActive,
          updatedAt: new Date(),
        })
        .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)))
        .returning();

      if (row.isDefault) {
        await tx
          .update(companies)
          .set({ defaultBranchId: row.id, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
        if (companyId === DEFAULT_COMPANY_ID) {
          await tx
            .update(companySettings)
            .set({ defaultBranchId: row.id, updatedAt: new Date() })
            .where(eq(companySettings.id, 1));
        }
      }

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        branchId: row.id,
        action: "branch.updated",
        entityType: "branches",
        entityId: row.id,
        entityLabel: row.name,
        ipAddress: req.ip,
      });

      return row;
    });

    eventBroadcaster.broadcast("branches_updated", { branchId: updated.id }, companyId);
    return { branch: updated };
  });

  app.delete("/api/branches/:id", { preHandler: requirePermission("branches", "delete") }, async (req) => {
    const branchId = (req.params as { id: string }).id;
    const actor = req.authUser!;
    const companyId = actorCompanyId(actor);
    assertBranchAccess(actor, branchId);
    const db = getDb();

    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)))
        .limit(1);
      if (!current) {
        throw new AppError(404, "Branch not found", "NOT_FOUND");
      }
      if (current.isDefault) {
        throw new AppError(400, "Cannot delete the company default branch", "DEFAULT_BRANCH_PROTECTED");
      }

      const [{ stockCount }] = await tx
        .select({ stockCount: sql<number>`count(*)::int` })
        .from(branchProducts)
        .where(
          and(
            eq(branchProducts.companyId, companyId),
            eq(branchProducts.branchId, branchId),
            sql`${branchProducts.qtyOnHand} <> 0`
          )
        );

      const [{ moveCount }] = await tx
        .select({ moveCount: sql<number>`count(*)::int` })
        .from(stockMovements)
        .where(and(eq(stockMovements.companyId, companyId), eq(stockMovements.branchId, branchId)));

      const [{ sessCount }] = await tx
        .select({ sessCount: sql<number>`count(*)::int` })
        .from(stockSessions)
        .where(and(eq(stockSessions.companyId, companyId), eq(stockSessions.branchId, branchId)));

      const [{ poCount }] = await tx
        .select({ poCount: sql<number>`count(*)::int` })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.branchId, branchId)));

      const [{ soCount }] = await tx
        .select({ soCount: sql<number>`count(*)::int` })
        .from(salesOrders)
        .where(and(eq(salesOrders.companyId, companyId), eq(salesOrders.branchId, branchId)));

      const [{ trCount }] = await tx
        .select({ trCount: sql<number>`count(*)::int` })
        .from(stockTransfers)
        .where(
          and(
            eq(stockTransfers.companyId, companyId),
            or(eq(stockTransfers.fromBranchId, branchId), eq(stockTransfers.toBranchId, branchId))
          )
        );

      if (stockCount > 0 || moveCount > 0 || sessCount > 0 || poCount > 0 || soCount > 0 || trCount > 0) {
        throw new AppError(
          409,
          "Cannot delete branch with existing stock, movements, transfers, sessions, or orders. Deactivate it instead.",
          "BRANCH_HAS_HISTORY"
        );
      }

      await tx.delete(branches).where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)));

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "branch.deleted",
        entityType: "branches",
        entityId: branchId,
        entityLabel: current.name,
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("branches_updated", { branchId }, companyId);
    return { ok: true };
  });
}
