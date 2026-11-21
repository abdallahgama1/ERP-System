import type { PosCheckoutInput } from "@erp/shared";
import { apiRequest } from "@/lib/api-client";
import {
  getPosDb,
  listOfflineOutbox,
  type OfflineOutboxRecord,
  type PosReceiptPreview,
} from "./posDb";

export interface SyncBatchResponse {
  results: Array<{
    clientTxId: string;
    status: "synced" | "reconciled_conflict" | "deduplicated" | "failed";
    receipt?: PosReceiptPreview;
    error?: string;
  }>;
}

export interface FlushOutboxSummary {
  synced: number;
  conflicts: number;
  deduplicated: number;
  failed: number;
  receipts: PosReceiptPreview[];
}

export async function enqueueOfflineSale(
  payload: PosCheckoutInput,
  localReceipt: PosReceiptPreview
): Promise<OfflineOutboxRecord> {
  const offlineClientTxId =
    payload.offlineClientTxId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const offlineCreatedAt = payload.offlineCreatedAt ?? new Date().toISOString();

  const record: OfflineOutboxRecord = {
    offlineClientTxId,
    terminalId: payload.terminalId,
    offlineCreatedAt,
    payload: {
      ...payload,
      offlineClientTxId,
      offlineCreatedAt,
    },
    localReceipt: {
      ...localReceipt,
      offlineClientTxId,
      syncStatus: "offline_pending",
    },
    status: "pending",
    attempts: 0,
  };

  const db = await getPosDb();
  const tx = db.transaction(["offline_sales_outbox", "catalog_products"], "readwrite");
  await tx.objectStore("offline_sales_outbox").put(record);

  // Optimistically decrement cached local branch qty so cashier sees accurate remaining stock offline
  const prodStore = tx.objectStore("catalog_products");
  for (const line of payload.lines) {
    const cached = await prodStore.get(line.productId);
    if (cached && cached.itemType !== "non_stock" && cached.itemType !== "service") {
      await prodStore.put({
        ...cached,
        qtyOnHand: Math.max(0, cached.qtyOnHand - line.quantity),
      });
    }
  }
  await tx.done;

  return record;
}

export async function flushPosOutbox(
  terminalId: string,
  syncFn: (body: { terminalId: string; sales: PosCheckoutInput[] }) => Promise<SyncBatchResponse> = (body) =>
    apiRequest<SyncBatchResponse>("/api/pos/sync", { method: "POST", body })
): Promise<FlushOutboxSummary> {
  const pending = await listOfflineOutbox(terminalId);
  if (pending.length === 0) {
    return { synced: 0, conflicts: 0, deduplicated: 0, failed: 0, receipts: [] };
  }

  const db = await getPosDb();
  const summary: FlushOutboxSummary = {
    synced: 0,
    conflicts: 0,
    deduplicated: 0,
    failed: 0,
    receipts: [],
  };

  const res = await syncFn({
    terminalId,
    sales: pending.map((item) => item.payload),
  });

  const resultMap = new Map(res.results.map((r) => [r.clientTxId, r]));
  const tx = db.transaction("offline_sales_outbox", "readwrite");
  const store = tx.objectStore("offline_sales_outbox");

  for (const item of pending) {
    const outcome = resultMap.get(item.offlineClientTxId);
    if (!outcome) continue;

    if (outcome.status === "synced" || outcome.status === "reconciled_conflict" || outcome.status === "deduplicated") {
      await store.delete(item.offlineClientTxId);
      if (outcome.status === "synced") summary.synced += 1;
      else if (outcome.status === "reconciled_conflict") summary.conflicts += 1;
      else summary.deduplicated += 1;
      if (outcome.receipt) summary.receipts.push(outcome.receipt);
    } else {
      summary.failed += 1;
      await store.put({
        ...item,
        status: "failed",
        attempts: item.attempts + 1,
        lastError: outcome.error ?? "Sync failed",
      });
    }
  }

  await tx.done;
  return summary;
}
