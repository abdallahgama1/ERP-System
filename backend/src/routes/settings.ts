import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_COMPANY_ID,
  branches,
  branchProducts,
  companies,
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
import { assertBranchAccess, requireAuth, requirePermission, requireRole } from "../middleware/auth.ts";

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

function mapCompanyToSettingsDto(comp: typeof companies.$inferSelect) {
  return {
    id: comp.id === DEFAULT_COMPANY_ID ? 1 : comp.id,
    companyId: comp.id,
    code: comp.code,
    companyName: comp.name,
    legalName: comp.legalName,
    taxRegistrationNumber: comp.taxRegistrationNumber,
    baseCurrency: comp.baseCurrency,
    einvoicingMode: comp.einvoicingMode,
    defaultBranchId: comp.defaultBranchId,
    address: comp.address,
    phone: comp.phone,
    email: comp.email,
    settingsJson: comp.settingsJson,
    updatedAt: comp.updatedAt,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/company", { preHandler: requireAuth }, async (req) => {
    const db = getDb();
    const companyId = req.authUser!.activeCompanyId;

    let [comp] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!comp && companyId === DEFAULT_COMPANY_ID) {
      await ensureSeededDefaults(db);
      [comp] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    }

    const taxes = await db
      .select()
      .from(taxCodes)
      .where(and(eq(taxCodes.companyId, companyId), eq(taxCodes.isActive, true)));

    const companyDto = comp ? mapCompanyToSettingsDto(comp) : null;
    return {
      company: companyDto,
      settings: companyDto,
      taxCodes: taxes,
    };
  });

  app.put("/api/settings/company", { preHandler: requirePermission("settings", "edit") }, async (req) => {
    const parsed = updateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid company settings", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const companyId = actor.activeCompanyId;
    const db = getDb();

    const updated = await db.transaction(async (tx) => {
      if (companyId === DEFAULT_COMPANY_ID) {
        await ensureSeededDefaults(tx);
      }

      const [current] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!current) {
        throw new AppError(404, "Active company not found", "COMPANY_NOT_FOUND");
      }

      if (parsed.data.defaultBranchId) {
        const [branchRow] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, parsed.data.defaultBranchId), eq(branches.companyId, companyId)))
          .limit(1);
        if (!branchRow) {
          throw new AppError(400, "Selected default branch does not exist in active company", "INVALID_BRANCH");
        }
      }

      const mergedJson = {
        ...(current.settingsJson ?? {}),
        ...(parsed.data.settingsJson ?? {}),
      };

      const now = new Date();
      const nextName = parsed.data.companyName ?? current.name;
      const nextLegalName = parsed.data.legalName ?? current.legalName;
      const nextTaxReg = parsed.data.taxRegistrationNumber ?? current.taxRegistrationNumber;
      const nextBaseCurrency = parsed.data.baseCurrency
        ? parsed.data.baseCurrency.toUpperCase()
        : current.baseCurrency;
      const nextEinvoicingMode = parsed.data.einvoicingMode ?? current.einvoicingMode;
      const nextDefaultBranchId =
        parsed.data.defaultBranchId !== undefined
          ? parsed.data.defaultBranchId
          : (current.defaultBranchId ?? null);
      const nextAddress = parsed.data.address ?? current.address;
      const nextPhone = parsed.data.phone ?? current.phone;
      const nextEmail = parsed.data.email ?? current.email;

      const [row] = await tx
        .update(companies)
        .set({
          name: nextName,
          legalName: nextLegalName,
          taxRegistrationNumber: nextTaxReg,
          baseCurrency: nextBaseCurrency,
          einvoicingMode: nextEinvoicingMode,
          defaultBranchId: nextDefaultBranchId,
          address: nextAddress,
          phone: nextPhone,
          email: nextEmail,
          settingsJson: mergedJson,
          updatedAt: now,
        })
        .where(eq(companies.id, companyId))
        .returning();

      if (companyId === DEFAULT_COMPANY_ID) {
        await tx
          .update(companySettings)
          .set({
            companyName: row.name,
            legalName: row.legalName,
            taxRegistrationNumber: row.taxRegistrationNumber,
            baseCurrency: row.baseCurrency,
            einvoicingMode: row.einvoicingMode,
            defaultBranchId: row.defaultBranchId,
            address: row.address,
            phone: row.phone,
            email: row.email,
            settingsJson: row.settingsJson,
            updatedAt: now,
          })
          .where(eq(companySettings.id, 1));
      }

      await writeAuditLog(tx, {
        companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: "settings.company_updated",
        entityType: "company_settings",
        entityId: companyId === DEFAULT_COMPANY_ID ? "1" : companyId,
        details: { updatedFields: Object.keys(parsed.data) },
        before: {
          companyName: current.name,
          legalName: current.legalName,
          taxRegistrationNumber: current.taxRegistrationNumber,
          baseCurrency: current.baseCurrency,
          einvoicingMode: current.einvoicingMode,
          defaultBranchId: current.defaultBranchId,
          address: current.address,
          phone: current.phone,
          email: current.email,
          settingsJson: current.settingsJson,
        },
        after: {
          companyName: row.name,
          legalName: row.legalName,
          taxRegistrationNumber: row.taxRegistrationNumber,
          baseCurrency: row.baseCurrency,
          einvoicingMode: row.einvoicingMode,
          defaultBranchId: row.defaultBranchId,
          address: row.address,
          phone: row.phone,
          email: row.email,
          settingsJson: row.settingsJson,
        },
        ipAddress: req.ip,
      });

      return mapCompanyToSettingsDto(row);
    });

    eventBroadcaster.broadcast("settings_updated", { companyId });
    return { company: updated, settings: updated };
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
    const companyId = actor.activeCompanyId;

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
      db.select().from(companies).where(eq(companies.id, companyId)).limit(1),
      db.select().from(branches).where(eq(branches.companyId, companyId)),
      db.select().from(products).where(eq(products.companyId, companyId)),
      db.select().from(branchProducts).where(eq(branchProducts.companyId, companyId)),
      db.select().from(customers).where(eq(customers.companyId, companyId)),
      db.select().from(vendors).where(eq(vendors.companyId, companyId)),
      db.select().from(taxonomyItems).where(eq(taxonomyItems.companyId, companyId)),
      db.select().from(stockSessions).where(eq(stockSessions.companyId, companyId)),
      db.select().from(stockAdjustments).where(eq(stockAdjustments.companyId, companyId)),
      db.select().from(stockWriteOffs).where(eq(stockWriteOffs.companyId, companyId)),
      db.select().from(stockTransfers).where(eq(stockTransfers.companyId, companyId)),
      db.select().from(stockMovements).where(eq(stockMovements.companyId, companyId)),
    ]);

    await writeAuditLog(db, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "admin.export_backup",
      entityType: "workspace",
      entityId: companyId,
      ipAddress: req.ip,
    });

    return {
      exportedAt: new Date().toISOString(),
      version: 2,
      company: companyRow[0] ? mapCompanyToSettingsDto(companyRow[0]) : null,
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
