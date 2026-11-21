import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { PosCheckoutInput } from "@erp/shared";

export interface PosCatalogProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  nameAr: string;
  category: string;
  unit: string;
  sellingPrice: number;
  costPrice: number;
  qtyOnHand: number;
  itemType: "stock" | "non_stock" | "service" | "manufactured";
  trackingMode: "none" | "lot" | "serial";
  taxRate: number;
  isTaxInclusive: boolean;
}

export interface PosCatalogCustomer {
  id: string;
  code: string;
  name: string;
  phone: string;
  taxNumber: string;
  isWalkIn: boolean;
}

export interface PosReceiptPreview {
  id: string;
  invoiceNumber: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  customerId: string;
  customerName: string;
  cashierUserId: string;
  cashierName: string;
  invoiceDate: string;
  currency: string;
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  paidAmount: number;
  totalChangeGiven: number;
  syncStatus: "synced" | "reconciled_conflict" | "offline_pending";
  offlineClientTxId: string | null;
  icv: number | null;
  qrTlv: string | null;
  etaDocumentUuid: string | null;
  etaReceiptStatus: string;
  eInvoiceStatus: string;
  lines: Array<{
    productId: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRate: number;
    taxAmount: number;
    lineTotal: number;
  }>;
  tenders: Array<{
    method: "cash" | "card" | "mobile_wallet";
    amount: number;
    tenderedAmount: number;
    changeGiven: number;
    reference: string;
  }>;
}

export interface OfflineOutboxRecord {
  offlineClientTxId: string;
  terminalId: string;
  offlineCreatedAt: string;
  payload: PosCheckoutInput;
  localReceipt: PosReceiptPreview;
  status: "pending" | "syncing" | "failed";
  attempts: number;
  lastError?: string;
}

export interface PosSessionStateRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

interface ErpPosDbSchema extends DBSchema {
  catalog_products: {
    key: string;
    value: PosCatalogProduct;
    indexes: {
      by_barcode: string;
      by_sku: string;
    };
  };
  catalog_customers: {
    key: string;
    value: PosCatalogCustomer;
  };
  pos_session_state: {
    key: string;
    value: PosSessionStateRecord;
  };
  offline_sales_outbox: {
    key: string;
    value: OfflineOutboxRecord;
    indexes: {
      by_created: string;
      by_terminal: string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<ErpPosDbSchema>> | null = null;

export function getPosDb(): Promise<IDBPDatabase<ErpPosDbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ErpPosDbSchema>("erp_pos_db", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("catalog_products")) {
          const prodStore = db.createObjectStore("catalog_products", { keyPath: "id" });
          prodStore.createIndex("by_barcode", "barcode");
          prodStore.createIndex("by_sku", "sku");
        }
        if (!db.objectStoreNames.contains("catalog_customers")) {
          db.createObjectStore("catalog_customers", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("pos_session_state")) {
          db.createObjectStore("pos_session_state", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("offline_sales_outbox")) {
          const outbox = db.createObjectStore("offline_sales_outbox", { keyPath: "offlineClientTxId" });
          outbox.createIndex("by_created", "offlineCreatedAt");
          outbox.createIndex("by_terminal", "terminalId");
        }
      },
    });
  }
  return dbPromise;
}

export function resetPosDbInstance(): void {
  dbPromise = null;
}

export async function savePosCatalogCache(
  products: PosCatalogProduct[],
  customers: PosCatalogCustomer[],
  meta: {
    branchId: string;
    currency: string;
    einvoicingMode: string;
    companyName: string;
    taxRegistrationNumber: string;
    syncedAt: string;
  }
): Promise<void> {
  const db = await getPosDb();
  const tx = db.transaction(["catalog_products", "catalog_customers", "pos_session_state"], "readwrite");
  await tx.objectStore("catalog_products").clear();
  for (const p of products) {
    await tx.objectStore("catalog_products").put(p);
  }
  await tx.objectStore("catalog_customers").clear();
  for (const c of customers) {
    await tx.objectStore("catalog_customers").put(c);
  }
  await tx.objectStore("pos_session_state").put({
    key: "catalog_meta",
    value: meta,
    updatedAt: new Date().toISOString(),
  });
  await tx.done;
}

export async function loadPosCatalogCache(): Promise<{
  products: PosCatalogProduct[];
  customers: PosCatalogCustomer[];
  meta: {
    branchId: string;
    currency: string;
    einvoicingMode: string;
    companyName: string;
    taxRegistrationNumber: string;
    syncedAt: string;
  } | null;
}> {
  const db = await getPosDb();
  const [products, customers, metaRow] = await Promise.all([
    db.getAll("catalog_products"),
    db.getAll("catalog_customers"),
    db.get("pos_session_state", "catalog_meta"),
  ]);
  return {
    products,
    customers,
    meta: (metaRow?.value as {
      branchId: string;
      currency: string;
      einvoicingMode: string;
      companyName: string;
      taxRegistrationNumber: string;
      syncedAt: string;
    }) ?? null,
  };
}

export async function savePosState<T>(key: string, value: T): Promise<void> {
  const db = await getPosDb();
  await db.put("pos_session_state", {
    key,
    value,
    updatedAt: new Date().toISOString(),
  });
}

export async function loadPosState<T>(key: string): Promise<T | null> {
  const db = await getPosDb();
  const row = await db.get("pos_session_state", key);
  return row ? (row.value as T) : null;
}

export async function listOfflineOutbox(terminalId?: string): Promise<OfflineOutboxRecord[]> {
  const db = await getPosDb();
  const rows = terminalId
    ? await db.getAllFromIndex("offline_sales_outbox", "by_terminal", terminalId)
    : await db.getAll("offline_sales_outbox");
  return rows.sort((a, b) => a.offlineCreatedAt.localeCompare(b.offlineCreatedAt));
}
