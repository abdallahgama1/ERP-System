import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  branchProducts,
  companySettings,
  customers,
  products,
  stockAdjustments,
  stockMovements,
  stockSessions,
  stockTransfers,
  stockWriteOffs,
  taxCodes,
  taxonomyItems,
  userPreferences,
  vendors,
} from "../../drizzle/schema.ts";
import { ensureSeededDefaults } from "../auth/permissions.ts";
import { loadAuthUserById } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { assertBranchAccess, requireAuth, requireRole } from "../middleware/auth.ts";

const updateCompanySchema = z.object({
  companyName: z.string().trim().min(1).max(160).optional(),
  legalName: z.string().trim().max(200).optional(),
  taxRegistrationNumber: z.string().trim().max(80).optional(),
  baseCurrency: z.string().trim().min(3).max(10).optional(),
  einvoicingMode: z.enum(["none", "zatca_qr", "zatca_phase2", "eta_egypt"]).optional(),
  defaultBranchId: z.string().uuid().nullable().optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(60).optional(),
  email: z.string().trim().max(120).optional(),
  settingsJson: z.record(z.unknown()).optional(),
});

const updatePreferencesSchema = z.object({
  language: z.enum(["en", "ar"]).optional(),
  activeBranchId: z.string().uuid().nullable().optional(),
  preferencesJson: z.record(z.unknown()).optional(),
});

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/company", { preHandler: requireAuth }, async () => {
    const db = getDb();
    let [company] = await db.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
    if (!company) {
      await ensureSeededDefaults(db);
      [company] = await db.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
    }
    const taxes = await db.select().from(taxCodes).where(eq(taxCodes.isActive, true));

    return {
      company: company ?? null,
      taxCodes: taxes,
    };
  });

  app.put("/api/settings/company", { preHandler: requireRole("admin") }, async (req) => {
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid company settings", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const db = getDb();

    const updated = await db.transaction(async (tx) => {
      let [current] = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
      if (!current) {
        await ensureSeededDefaults(tx);
        [current] = await tx.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
      }

      if (parsed.data.defaultBranchId) {
        const [branchRow] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.id, parsed.data.defaultBranchId))
          .limit(1);
        if (!branchRow) {
          throw new AppError(400, "Selected default branch does not exist", "INVALID_BRANCH");
        }
      }

      const mergedJson = {
        ...(current?.settingsJson ?? {}),
        ...(parsed.data.settingsJson ?? {}),
      };

      const [row] = await tx
        .update(companySettings)
        .set({
          companyName: parsed.data.companyName ?? current?.companyName ?? "Count It Keep It",
          legalName: parsed.data.legalName ?? current?.legalName ?? "",
          taxRegistrationNumber: parsed.data.taxRegistrationNumber ?? current?.taxRegistrationNumber ?? "",
          baseCurrency: parsed.data.baseCurrency ?? current?.baseCurrency ?? "USD",
          einvoicingMode: parsed.data.einvoicingMode ?? current?.einvoicingMode ?? "none",
          defaultBranchId:
            parsed.data.defaultBranchId !== undefined
              ? parsed.data.defaultBranchId
              : (current?.defaultBranchId ?? null),
          address: parsed.data.address ?? current?.address ?? "",
          phone: parsed.data.phone ?? current?.phone ?? "",
          email: parsed.data.email ?? current?.email ?? "",
          settingsJson: mergedJson,
          updatedAt: new Date(),
        })
        .where(eq(companySettings.id, 1))
        .returning();

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "settings.company_updated",
        entityType: "company_settings",
        entityId: "1",
        details: { updatedFields: Object.keys(parsed.data) },
        ipAddress: req.ip,
      });

      return row;
    });

    eventBroadcaster.broadcast("settings_updated");
    return { company: updated };
  });

  app.get("/api/settings/preferences", { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const actor = req.authUser!;
    const [pref] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, actor.id))
      .limit(1);

    return {
      preferences: pref ?? {
        userId: actor.id,
        language: "en",
        activeBranchId: actor.defaultBranchId,
        preferencesJson: {},
      },
    };
  });

  app.put("/api/settings/preferences", { preHandler: requireAuth }, async (req) => {
    const parsed = updatePreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid preferences", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    if (parsed.data.activeBranchId) {
      assertBranchAccess(actor, parsed.data.activeBranchId);
    }

    const db = getDb();
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, actor.id))
        .limit(1);

      const mergedJson = {
        ...(existing?.preferencesJson ?? {}),
        ...(parsed.data.preferencesJson ?? {}),
      };

      const [row] = await tx
        .insert(userPreferences)
        .values({
          userId: actor.id,
          language: parsed.data.language ?? existing?.language ?? "en",
          activeBranchId:
            parsed.data.activeBranchId !== undefined
              ? parsed.data.activeBranchId
              : (existing?.activeBranchId ?? actor.defaultBranchId),
          preferencesJson: mergedJson,
        })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: {
            language: parsed.data.language ?? existing?.language ?? "en",
            activeBranchId:
              parsed.data.activeBranchId !== undefined
                ? parsed.data.activeBranchId
                : (existing?.activeBranchId ?? actor.defaultBranchId),
            preferencesJson: mergedJson,
            updatedAt: new Date(),
          },
        })
        .returning();

      return row;
    });

    // Reload user only if needed later; preferences change doesn't invalidate auth
    void loadAuthUserById;
    return { preferences: updated };
  });

  app.get("/api/admin/export-backup", { preHandler: requireRole("admin") }, async (req) => {
    const db = getDb();
    const actor = req.authUser!;

    const [
      companyRow,
      branchList,
      productList,
      branchProductList,
      customerList,
      vendorList,
      taxonomyList,
      sessionList,
      adjustmentList,
      writeOffList,
      transferList,
      movementList,
    ] = await Promise.all([
      db.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1),
      db.select().from(branches),
      db.select().from(products),
      db.select().from(branchProducts),
      db.select().from(customers),
      db.select().from(vendors),
      db.select().from(taxonomyItems),
      db.select().from(stockSessions),
      db.select().from(stockAdjustments),
      db.select().from(stockWriteOffs),
      db.select().from(stockTransfers),
      db.select().from(stockMovements),
    ]);

    await writeAuditLog(db, {
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "admin.export_backup",
      entityType: "workspace",
      entityId: "backup",
      ipAddress: req.ip,
    });

    return {
      exportedAt: new Date().toISOString(),
      version: 2,
      company: companyRow[0] ?? null,
      branches: branchList,
      products: productList,
      branchProducts: branchProductList,
      customers: customerList,
      vendors: vendorList,
      taxonomyItems: taxonomyList,
      stockSessions: sessionList,
      stockAdjustments: adjustmentList,
      stockWriteOffs: writeOffList,
      stockTransfers: transferList,
      stockMovements: movementList,
    };
  });
}
