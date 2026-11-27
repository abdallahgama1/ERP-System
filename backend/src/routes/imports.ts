import type { FastifyInstance } from "fastify";
import {
  CSV_TEMPLATES,
  IMPORT_DATASET_KINDS,
  STANDARD_IMPORT_KINDS,
  csvImportRequestSchema,
  openingBalancesImportSchema,
  renderCsvTemplate,
  reverseOpeningBalancesSchema,
  type ImportDatasetKind,
  type StandardImportKind,
} from "@erp/shared";
import { AppError } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireRole } from "../middleware/auth.ts";
import {
  getCutoverReadiness,
  getOpeningCutoverStatus,
  importOpeningBalances,
  importStandardDataset,
  reverseOpeningBalances,
} from "../services/csv-import.service.ts";
import { actorCompanyId, parseOrThrow } from "../services/stock-locks.ts";

const IMPORT_BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB JSON envelope for large CSV payloads

export async function importRoutes(app: FastifyInstance) {
  app.get(
    "/api/imports/cutover-readiness",
    { preHandler: requireRole("admin") },
    async (req) => {
      return getCutoverReadiness(getDb(), req.authUser!);
    }
  );
  app.get(
    "/api/imports/templates/:kind",
    { preHandler: requireRole("admin") },
    async (req, reply) => {
      const kind = (req.params as { kind: string }).kind as ImportDatasetKind;
      if (!IMPORT_DATASET_KINDS.includes(kind)) {
        throw new AppError(404, `Unknown import template kind '${kind}'`, "NOT_FOUND");
      }
      const def = CSV_TEMPLATES[kind];
      const csv = renderCsvTemplate(kind);
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${def.fileName}"`)
        .send(csv);
    }
  );

  app.get(
    "/api/imports/opening-balances/status",
    { preHandler: requireRole("admin") },
    async (req) => {
      return getOpeningCutoverStatus(getDb(), req.authUser!);
    }
  );

  app.post(
    "/api/imports/opening-balances",
    { preHandler: requireRole("admin"), bodyLimit: IMPORT_BODY_LIMIT },
    async (req) => {
      const data = parseOrThrow(openingBalancesImportSchema, req.body, "Invalid opening balances import payload");
      const result = await importOpeningBalances(getDb(), req.authUser!, data, req.ip);
      if (!data.dryRun && result.valid) {
        const companyId = actorCompanyId(req.authUser!);
        eventBroadcaster.broadcast("accounting_updated", { source: "opening_balance" }, companyId);
        eventBroadcaster.broadcast("sales_updated", { source: "opening_balance" }, companyId);
        eventBroadcaster.broadcast("purchases_updated", { source: "opening_balance" }, companyId);
        eventBroadcaster.broadcast("audit_updated", { source: "opening_balance" }, companyId);
      }
      return result;
    }
  );

  app.post(
    "/api/imports/opening-balances/reverse",
    { preHandler: requireRole("admin") },
    async (req) => {
      const data = parseOrThrow(reverseOpeningBalancesSchema, req.body, "Invalid opening balances reversal payload");
      const result = await reverseOpeningBalances(getDb(), req.authUser!, data, req.ip);
      const companyId = actorCompanyId(req.authUser!);
      eventBroadcaster.broadcast("accounting_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("sales_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("purchases_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("inventory_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("fixed_assets_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("treasury_updated", { source: "opening_balance_reversal" }, companyId);
      eventBroadcaster.broadcast("audit_updated", { source: "opening_balance_reversal" }, companyId);
      return result;
    }
  );

  app.post(
    "/api/imports/:kind",
    { preHandler: requireRole("admin"), bodyLimit: IMPORT_BODY_LIMIT },
    async (req) => {
      const kind = (req.params as { kind: string }).kind as StandardImportKind;
      if (!STANDARD_IMPORT_KINDS.includes(kind)) {
        throw new AppError(404, `Unknown import dataset kind '${kind}'`, "NOT_FOUND");
      }
      const data = parseOrThrow(csvImportRequestSchema, req.body, "Invalid CSV import payload");
      const result = await importStandardDataset(getDb(), req.authUser!, kind, data, req.ip);
      if (!data.dryRun && result.valid) {
        const companyId = actorCompanyId(req.authUser!);
        if (kind === "chart_of_accounts") eventBroadcaster.broadcast("accounting_updated", { kind }, companyId);
        if (kind === "customers") eventBroadcaster.broadcast("sales_updated", { kind }, companyId);
        if (kind === "vendors") eventBroadcaster.broadcast("purchases_updated", { kind }, companyId);
        if (kind === "products" || kind === "opening_stock") eventBroadcaster.broadcast("inventory_updated", { kind }, companyId);
        if (kind === "opening_fixed_assets") eventBroadcaster.broadcast("fixed_assets_updated", { kind }, companyId);
        if (kind === "opening_treasury") eventBroadcaster.broadcast("treasury_updated", { kind }, companyId);
        eventBroadcaster.broadcast("audit_updated", { kind }, companyId);
      }
      return result;
    }
  );
}
