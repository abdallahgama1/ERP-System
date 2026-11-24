import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { posSyncBatchSchema } from "@erp/shared";
import { idempotencyKeys, posTerminals, salesInvoices } from "../../drizzle/schema.ts";
import { AppError } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { createModuleLogger } from "../logging/logger.ts";
import { executePosCheckoutTx, type PosReceiptDto } from "./pos.service.ts";
import { actorCompanyId, type RequestActor } from "./stock-locks.ts";

const log = createModuleLogger("pos-sync");

export interface PosSyncItemResult {
  clientTxId: string;
  status: "synced" | "reconciled_conflict" | "deduplicated" | "failed";
  receipt?: PosReceiptDto;
  error?: string;
}

export async function syncOfflinePosBatch(
  db: AppDatabase,
  actor: RequestActor,
  data: z.infer<typeof posSyncBatchSchema>,
  ipAddress?: string
): Promise<{ results: PosSyncItemResult[] }> {
  const companyId = actorCompanyId(actor);
  const ordered = [...data.sales].sort((a, b) => {
    const ta = a.offlineCreatedAt ? new Date(a.offlineCreatedAt).getTime() : 0;
    const tb = b.offlineCreatedAt ? new Date(b.offlineCreatedAt).getTime() : 0;
    return ta - tb;
  });

  const results: PosSyncItemResult[] = [];
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  for (const txInput of ordered) {
    const clientTxId = txInput.offlineClientTxId ?? `auto-${txInput.shiftId}-${txInput.offlineCreatedAt ?? Date.now()}`;
    const idempotencyKey = `pos:${txInput.terminalId}:${clientTxId}`;

    try {
      const outcome = await db.transaction(async (tx) => {
        // 0. Ensure terminal belongs to active company before reading idempotency cache
        const [terminal] = await tx
          .select({ id: posTerminals.id })
          .from(posTerminals)
          .where(and(eq(posTerminals.id, txInput.terminalId), eq(posTerminals.companyId, companyId)))
          .limit(1);
        if (!terminal) {
          throw new AppError(404, "POS terminal not found", "TERMINAL_NOT_FOUND");
        }

        // 1. Check idempotency key store first
        const [existingKey] = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.method, "POST"),
              eq(idempotencyKeys.path, "/api/pos/sync"),
              eq(idempotencyKeys.key, idempotencyKey)
            )
          )
          .limit(1);

        if (existingKey) {
          return {
            clientTxId,
            status: "deduplicated" as const,
            receipt: existingKey.responseBody as PosReceiptDto,
          };
        }

        // 2. Fallback check on unique (posTerminalId, offlineClientTxId)
        const [existingInv] = await tx
          .select({ id: salesInvoices.id, invoiceNumber: salesInvoices.invoiceNumber })
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.companyId, companyId),
              eq(salesInvoices.posTerminalId, txInput.terminalId),
              eq(salesInvoices.offlineClientTxId, clientTxId)
            )
          )
          .limit(1);

        if (existingInv) {
          return {
            clientTxId,
            status: "deduplicated" as const,
          };
        }

        // 3. Execute atomic checkout with offline reconciliation enabled
        const receipt = await executePosCheckoutTx(tx, actor, txInput, {
          allowOfflineNegativeStock: true,
          allowClosedShiftReconcile: true,
          ipAddress,
        });

        await tx
          .insert(idempotencyKeys)
          .values({
            userId: actor.id,
            key: idempotencyKey,
            method: "POST",
            path: "/api/pos/sync",
            posTerminalId: txInput.terminalId,
            statusCode: 201,
            responseBody: receipt,
            expiresAt,
          })
          .onConflictDoNothing();

        return {
          clientTxId,
          status: receipt.syncStatus,
          receipt,
        };
      });

      results.push(outcome);
    } catch (err) {
      log.warn(
        { clientTxId, terminalId: txInput.terminalId, err },
        "pos.sync.item_failed"
      );
      results.push({
        clientTxId,
        status: "failed",
        error: err instanceof Error ? err.message : "Failed to sync transaction",
      });
    }
  }

  return { results };
}
