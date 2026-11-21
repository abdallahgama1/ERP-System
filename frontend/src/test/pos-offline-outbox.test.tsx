import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listOfflineOutbox,
  loadPosCatalogCache,
  resetPosDbInstance,
  savePosCatalogCache,
  type PosCatalogProduct,
  type PosReceiptPreview,
} from "@/lib/pos/posDb";
import { enqueueOfflineSale, flushPosOutbox } from "@/lib/pos/outboxManager";

describe("POS IndexedDB offline outbox manager", () => {
  beforeEach(async () => {
    resetPosDbInstance();
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
      if (info.name) indexedDB.deleteDatabase(info.name);
    }
  });

  it("queues offline sales, optimistically decrements cached stock, and flushes FIFO on reconnect", async () => {
    const prod: PosCatalogProduct = {
      id: "11111111-1111-4111-8111-111111111111",
      sku: "COF-1",
      barcode: "6220001112223",
      name: "Arabic Coffee",
      nameAr: "قهوة عربية",
      category: "Drinks",
      unit: "pcs",
      sellingPrice: 50,
      costPrice: 20,
      qtyOnHand: 10,
      itemType: "stock",
      trackingMode: "none",
      taxRate: 0,
      isTaxInclusive: false,
    };

    await savePosCatalogCache([prod], [], {
      branchId: "22222222-2222-4222-8222-222222222222",
      currency: "EGP",
      einvoicingMode: "eta_egypt",
      companyName: "Cairo Roasters",
      taxRegistrationNumber: "123456789",
      syncedAt: new Date().toISOString(),
    });

    const terminalId = "33333333-3333-4333-8333-333333333333";
    const shiftId = "44444444-4444-4444-8444-444444444444";
    const preview: PosReceiptPreview = {
      id: "tx-local-1",
      invoiceNumber: "OFFLINE-001",
      branchId: "22222222-2222-4222-8222-222222222222",
      terminalId,
      shiftId,
      customerId: "55555555-5555-4555-8555-555555555555",
      customerName: "Walk-in Customer",
      cashierUserId: "66666666-6666-4666-8666-666666666666",
      cashierName: "Sara",
      invoiceDate: "2026-11-21T09:00:00.000Z",
      currency: "EGP",
      subtotal: 100,
      taxTotal: 0,
      totalAmount: 100,
      paidAmount: 100,
      totalChangeGiven: 0,
      syncStatus: "offline_pending",
      offlineClientTxId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      icv: null,
      qrTlv: null,
      etaDocumentUuid: null,
      etaReceiptStatus: "pending_sync",
      eInvoiceStatus: "pending_sync",
      lines: [],
      tenders: [{ method: "cash", amount: 100, tenderedAmount: 100, changeGiven: 0, reference: "" }],
    };

    await enqueueOfflineSale(
      {
        terminalId,
        shiftId,
        currency: "EGP",
        fxRate: 1,
        notes: "",
        offlineClientTxId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        offlineCreatedAt: "2026-11-21T09:00:00.000Z",
        lines: [
          {
            productId: prod.id,
            description: prod.name,
            quantity: 2,
            unitPrice: 50,
            discount: 0,
            taxRate: 0,
            isTaxInclusive: false,
          },
        ],
        tenders: [{ method: "cash", amount: 100, tenderedAmount: 100, reference: "" }],
      },
      preview
    );

    const cachedAfter = await loadPosCatalogCache();
    expect(cachedAfter.products[0].qtyOnHand).toBe(8);
    expect(await listOfflineOutbox(terminalId)).toHaveLength(1);

    const syncMock = vi.fn().mockResolvedValue({
      results: [
        {
          clientTxId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "synced",
          receipt: { ...preview, syncStatus: "synced", invoiceNumber: "POS-00001" },
        },
      ],
    });

    const summary = await flushPosOutbox(terminalId, syncMock);
    expect(summary.synced).toBe(1);
    expect(summary.failed).toBe(0);
    expect(await listOfflineOutbox(terminalId)).toHaveLength(0);
  });
});
