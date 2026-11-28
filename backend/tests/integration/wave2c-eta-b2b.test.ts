import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_CMS_DER_SIG_B64 =
  "MIIGCAYJKoZIhvcNAQcCoIIF+TCCBfUCAQExDzANBglghkgBZQMEAgEFADALBgkqhkiG9w0BBwE=";

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

describe.skipIf(!testDbUrl)(
  "Wave 2C Integration: Live ETA Master Fields, B2B e-Invoice v1.0 ('I' & 'C'), Signer Bridge & Queue Worker",
  () => {
    let app: FastifyInstance;
    let adminCookie: string;
    let hqBranchId: string;

    beforeAll(async () => {
      const { buildApp } = await import("../../src/app.ts");
      app = await buildApp({ logger: false });
      await app.ready();

      const expectedDb = new URL(testDbUrl!).pathname.replace(/^\//, "");
      const { getDb } = await import("../../src/db/index.ts");
      const db = getDb();
      const check = await db.execute(sql`SELECT current_database() AS db`);
      const activeDb = (check[0] as { db?: string } | undefined)?.db;
      if (activeDb !== expectedDb) {
        throw new Error(`Refusing destructive reset against '${activeDb}' instead of '${expectedDb}'`);
      }

      const { resetTestDatabase } = await import("../helpers/db-reset.ts");
      await resetTestDatabase(db);

      const signup = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: {
          name: "Wave2C Admin",
          email: "wave2c-admin@test.local",
          password: "Password123!",
        },
      });
      expect(signup.statusCode).toBe(201);
      adminCookie = signup.cookies.find((c) => c.name === "erp_session")!.value;

      const branchesRes = await app.inject({
        method: "GET",
        url: "/api/branches",
        cookies: { erp_session: adminCookie },
      });
      hqBranchId = branchesRes.json().branches[0].id;
    });

    afterAll(async () => {
      if (app) await app.close();
      const { closeDatabase } = await import("../../src/db/index.ts");
      await closeDatabase();
    });

    it("populates ETA master fields into B2B Invoice ('I') & Credit Note ('C'), guards v1.0 when signer is unset, and signs + submits via CAdES-BES bridge", async () => {
      const { env } = await import("../../src/config.ts");
      const { getDb } = await import("../../src/db/index.ts");
      const { processPendingEtaSubmissions } = await import("../../src/services/einvoicing.service.ts");
      const { clearEtaTokenCache } = await import("../../src/services/eta-client.service.ts");

      const origClientId = env.ETA_CLIENT_ID;
      const origSecret = env.ETA_CLIENT_SECRET;
      const origVer = env.ETA_INVOICE_VERSION;
      const origSignerUrl = env.ETA_SIGNER_URL;
      const origSignerTok = env.ETA_SIGNER_TOKEN;

      try {
        env.ETA_INVOICE_VERSION = "1.0";
        env.ETA_SIGNER_URL = "";
        env.ETA_SIGNER_TOKEN = "";

        // 1. Enable ETA Egypt mode in company settings
        const compRes = await app.inject({
          method: "PUT",
          url: "/api/settings/company",
          cookies: { erp_session: adminCookie },
          payload: {
            companyName: "Misr Engineering Corp",
            legalName: "Misr Engineering Corporation SAE",
            taxRegistrationNumber: "310220330",
            baseCurrency: "EGP",
            einvoicingMode: "eta_egypt",
          },
        });
        expect(compRes.statusCode).toBe(200);

        // 2. Configure HQ branch with structured ETA Egypt address
        const brUpdate = await app.inject({
          method: "PUT",
          url: `/api/branches/${hqBranchId}`,
          cookies: { erp_session: adminCookie },
          payload: {
            etaBranchId: "1",
            country: "EG",
            governorate: "Cairo",
            regionCity: "New Cairo",
            street: "90th North Street",
            buildingNumber: "45A",
            postalCode: "11835",
          },
        });
        expect(brUpdate.statusCode).toBe(200);
        expect(brUpdate.json().branch.governorate).toBe("Cairo");
        expect(brUpdate.json().branch.etaBranchId).toBe("1");

        // 3. Create Product with GS1 item code & BX ETA unit type
        const prodRes = await app.inject({
          method: "POST",
          url: "/api/products",
          cookies: { erp_session: adminCookie },
          payload: {
            sku: "PUMP-GS1-01",
            name: "Centrifugal Pump Assembly",
            costPrice: 2000,
            sellingPrice: 3500,
            etaCodeType: "GS1",
            etaItemCode: "6224005006007",
            etaUnitType: "BX",
            initialStock: [{ branchId: hqBranchId, quantity: 10, unitCost: 2000 }],
          },
        });
        expect(prodRes.statusCode).toBe(201);
        const product = prodRes.json().product;
        expect(product.etaCodeType).toBe("GS1");
        expect(product.etaItemCode).toBe("6224005006007");
        expect(product.etaUnitType).toBe("BX");

        // 4. Create B2B Customer with ETA receiverType = 'B' and Egyptian RIN
        const custRes = await app.inject({
          method: "POST",
          url: "/api/customers",
          cookies: { erp_session: adminCookie },
          payload: {
            name: "Alexandria Water Works",
            company: "Alexandria Water Works Co",
            taxNumber: "555777999",
            etaReceiverType: "B",
            currency: "EGP",
            billingAddress: "Corniche Road, Alexandria",
          },
        });
        expect(custRes.statusCode).toBe(201);
        const customer = custRes.json().customer;
        expect(customer.etaReceiverType).toBe("B");

        // 5. Issue a back-office Sales Invoice -> queues ETA B2B Invoice ('I')
        const invRes = await app.inject({
          method: "POST",
          url: "/api/sales-invoices",
          cookies: { erp_session: adminCookie },
          payload: {
            customerId: customer.id,
            branchId: hqBranchId,
            status: "Sent",
            invoiceDate: "2026-11-25",
            dueDate: "2026-12-25",
            currency: "EGP",
            fxRate: 1,
            lines: [
              {
                productId: product.id,
                description: "Centrifugal Pump Assembly",
                quantity: 2,
                unitPrice: 3500,
                taxRate: 14,
              },
            ],
          },
        });
        expect(invRes.statusCode).toBe(201);
        const invoice = invRes.json().invoice;

        // 6. Issue a back-office Sales Return -> queues ETA B2B Credit Note ('C') referencing original invoice UUID
        const retRes = await app.inject({
          method: "POST",
          url: "/api/sales-returns",
          cookies: { erp_session: adminCookie },
          payload: {
            customerId: customer.id,
            branchId: hqBranchId,
            invoiceId: invoice.id,
            returnDate: "2026-11-25",
            reason: "damaged",
            restockItems: true,
            lines: [
              {
                productId: product.id,
                quantity: 1,
                unitPrice: 3500,
                taxRate: 14,
              },
            ],
          },
        });
        expect(retRes.statusCode).toBe(201);
        const salesReturn = retRes.json().salesReturn;
        expect(salesReturn.eInvoiceStatus).toBe("pending_submission");
        expect(salesReturn.etaDocumentUuid).toMatch(/^[a-f0-9]{64}$/);

        // 7. Inspect /api/einvoicing/submissions queue -> both 'I' and 'C' present with live ETA master fields
        const queueRes = await app.inject({
          method: "GET",
          url: "/api/einvoicing/submissions",
          cookies: { erp_session: adminCookie },
        });
        expect(queueRes.statusCode).toBe(200);
        const queueBody = queueRes.json();
        expect(queueBody.items).toHaveLength(2);

        const invSub = queueBody.items.find((i: { invoiceId: string | null }) => i.invoiceId === invoice.id);
        const cnSub = queueBody.items.find(
          (i: { salesReturnId?: string | null }) => i.salesReturnId === salesReturn.id
        );
        expect(invSub).toBeTruthy();
        expect(invSub.documentType).toBe("invoice");
        expect(invSub.etaDocumentTypeCode).toBe("I");
        expect(invSub.signatureStatus).toBe("pending_signature");

        expect(cnSub).toBeTruthy();
        expect(cnSub.documentType).toBe("invoice");
        expect(cnSub.etaDocumentTypeCode).toBe("C");
        expect(cnSub.documentNumber).toBe(salesReturn.creditNoteNumber);

        const detailInv = await app.inject({
          method: "GET",
          url: `/api/einvoicing/submissions/${invSub.id}`,
          cookies: { erp_session: adminCookie },
        });
        const invPayload = detailInv.json().requestPayloadJson;
        expect(invPayload.issuer.address.branchID).toBe("1");
        expect(invPayload.issuer.address.governate).toBe("Cairo");
        expect(invPayload.issuer.address.regionCity).toBe("New Cairo");
        expect(invPayload.receiver.type).toBe("B");
        expect(invPayload.receiver.id).toBe("555777999");
        expect(invPayload.invoiceLines[0].itemType).toBe("GS1");
        expect(invPayload.invoiceLines[0].itemCode).toBe("6224005006007");
        expect(invPayload.invoiceLines[0].unitType).toBe("BX");

        const detailCn = await app.inject({
          method: "GET",
          url: `/api/einvoicing/submissions/${cnSub.id}`,
          cookies: { erp_session: adminCookie },
        });
        expect(detailCn.json().requestPayloadJson.references).toEqual([invSub.documentUuid]);

        // 8. When ETA OAuth is configured on v1.0 WITHOUT ETA_SIGNER_URL, worker keeps items pending (attempts = 0)
        clearEtaTokenCache();
        env.ETA_CLIENT_ID = "live-eta-id";
        env.ETA_CLIENT_SECRET = "live-eta-secret";
        env.ETA_INVOICE_VERSION = "1.0";
        env.ETA_SIGNER_URL = "";

        const noSignerRun = await processPendingEtaSubmissions({ db: getDb() });
        expect(noSignerRun.skipped).toBe(false);
        expect(noSignerRun.processed).toBe(0);
        expect(noSignerRun.failed).toBe(0);

        // 9. Configure CAdES-BES signer bridge + mock ETA /api/v1/documentsubmissions -> signs & accepts both!
        env.ETA_SIGNER_URL = "http://127.0.0.1:5099/sign";
        env.ETA_SIGNER_TOKEN = "dongle-bridge-token";

        const submittedPayloads: Array<Record<string, unknown>> = [];
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/sign")) {
            return new Response(
              JSON.stringify({
                signatureType: "I",
                value: VALID_CMS_DER_SIG_B64,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          if (url.endsWith("/connect/token")) {
            return new Response(
              JSON.stringify({ access_token: "eta-oauth-jwt", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          if (url.endsWith("/api/v1/documentsubmissions")) {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as {
              documents: Array<Record<string, unknown>>;
            };
            const doc = parsed.documents[0];
            submittedPayloads.push(doc);
            return new Response(
              JSON.stringify({
                submissionId: `SUB-${String(doc.internalID)}`,
                acceptedDocuments: [
                  {
                    uuid: `ETA-ACCEPTED-${String(doc.internalID)}`,
                    longId: `LONG-${String(doc.internalID)}`,
                    internalId: String(doc.internalID),
                  },
                ],
                rejectedDocuments: [],
              }),
              { status: 202, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not Found", { status: 404 });
        });

        const signedRun = await processPendingEtaSubmissions({
          db: getDb(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        });
        expect(signedRun.accepted).toBe(2);
        expect(signedRun.rejected).toBe(0);
        expect(signedRun.failed).toBe(0);
        expect(submittedPayloads).toHaveLength(2);
        expect(submittedPayloads[0].signatures).toEqual([
          { signatureType: "I", value: VALID_CMS_DER_SIG_B64 },
        ]);

        // Verify queue now reports both as accepted + signed
        const afterQueue = await app.inject({
          method: "GET",
          url: "/api/einvoicing/submissions",
          cookies: { erp_session: adminCookie },
        });
        expect(afterQueue.json().summary.accepted).toBe(2);
        for (const item of afterQueue.json().items) {
          expect(item.status).toBe("accepted");
          expect(item.signatureStatus).toBe("signed");
        }
      } finally {
        clearEtaTokenCache();
        env.ETA_CLIENT_ID = origClientId;
        env.ETA_CLIENT_SECRET = origSecret;
        env.ETA_INVOICE_VERSION = origVer;
        env.ETA_SIGNER_URL = origSignerUrl;
        env.ETA_SIGNER_TOKEN = origSignerTok;
      }
    });

    it("refuses mock signer signatures (never submits) and retries failed submissions with exponential backoff", async () => {
      const { env } = await import("../../src/config.ts");
      const { getDb } = await import("../../src/db/index.ts");
      const { einvoiceSubmissions } = await import("../../drizzle/schema.ts");
      const { processPendingEtaSubmissions } = await import("../../src/services/einvoicing.service.ts");
      const { clearEtaTokenCache } = await import("../../src/services/eta-client.service.ts");
      const mockSignerUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/eta-mock-signer.mjs")).href;
      const { startMockEtaSignerServer } = (await import(mockSignerUrl)) as {
        startMockEtaSignerServer: (opts: { port?: number; token?: string }) => Promise<{
          url: string;
          close: () => Promise<void>;
        }>;
      };

      const origClientId = env.ETA_CLIENT_ID;
      const origSecret = env.ETA_CLIENT_SECRET;
      const origVer = env.ETA_INVOICE_VERSION;
      const origSignerUrl = env.ETA_SIGNER_URL;
      const origSignerTok = env.ETA_SIGNER_TOKEN;

      const mockSigner = await startMockEtaSignerServer({ port: 0, token: "dev-mock-token" });
      try {
        // Issue a fresh B2B invoice so we have a clean pending submission
        const prodsRes = await app.inject({
          method: "GET",
          url: "/api/products",
          cookies: { erp_session: adminCookie },
        });
        const productId = prodsRes.json().products[0].id;
        const custsRes = await app.inject({
          method: "GET",
          url: "/api/customers",
          cookies: { erp_session: adminCookie },
        });
        const customerId = custsRes.json().customers[0].id;

        const invRes = await app.inject({
          method: "POST",
          url: "/api/sales-invoices",
          cookies: { erp_session: adminCookie },
          payload: {
            customerId,
            branchId: hqBranchId,
            status: "Sent",
            invoiceDate: "2026-11-28",
            dueDate: "2026-12-28",
            currency: "EGP",
            fxRate: 1,
            lines: [{ productId, description: "Mock Guard Item", quantity: 1, unitPrice: 1000, taxRate: 14 }],
          },
        });
        expect(invRes.statusCode).toBe(201);
        const invoice = invRes.json().invoice;

        // 1. Point ETA_SIGNER_URL at the real local mock signer -> MUST refuse and NEVER call ETA!
        clearEtaTokenCache();
        env.ETA_CLIENT_ID = "live-eta-id";
        env.ETA_CLIENT_SECRET = "live-eta-secret";
        env.ETA_INVOICE_VERSION = "1.0";
        env.ETA_SIGNER_URL = mockSigner.url;
        env.ETA_SIGNER_TOKEN = "dev-mock-token";

        let etaSubmitCalled = false;
        const mockAwareFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.startsWith(mockSigner.url)) {
            return globalThis.fetch(input, init);
          }
          etaSubmitCalled = true;
          return new Response("Should never reach ETA when signer is mock!", { status: 500 });
        });

        const mockRun = await processPendingEtaSubmissions({
          db: getDb(),
          fetchImpl: mockAwareFetch as unknown as typeof fetch,
        });
        expect(mockRun.failed).toBe(1);
        expect(mockRun.accepted).toBe(0);
        expect(etaSubmitCalled).toBe(false);

        const db = getDb();
        const [afterMockRow] = await db
          .select()
          .from(einvoiceSubmissions)
          .where(eq(einvoiceSubmissions.invoiceId, invoice.id));
        expect(afterMockRow?.status).toBe("failed");
        expect(afterMockRow?.lastError).toMatch(/Refused mock signature/i);
        expect(afterMockRow?.nextRetryAt).toBeNull(); // non-retryable until operator configures a real signer

        // 2. Re-queue via admin Retry API, then simulate transient ETA 503 -> schedules backoff retry on status='failed'
        const retryApi = await app.inject({
          method: "POST",
          url: `/api/einvoicing/submissions/${afterMockRow!.id}/retry`,
          cookies: { erp_session: adminCookie },
          payload: { resetAttempts: true },
        });
        // Reset state cleanly before running deterministic backoff test with custom fetchImpl
        expect(retryApi.statusCode).toBe(200);
        await db
          .update(einvoiceSubmissions)
          .set({ status: "pending", attempts: 0, nextRetryAt: null, lastError: null })
          .where(eq(einvoiceSubmissions.id, afterMockRow!.id));

        env.ETA_SIGNER_URL = "http://127.0.0.1:59999/real-signer";
        let etaMode: "503" | "accept" = "503";
        const backoffFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/real-signer")) {
            return new Response(
              JSON.stringify({ signatureType: "I", value: VALID_CMS_DER_SIG_B64 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          if (url.endsWith("/connect/token")) {
            return new Response(
              JSON.stringify({ access_token: "eta-backoff-jwt", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          if (url.endsWith("/api/v1/documentsubmissions")) {
            if (etaMode === "503") {
              return new Response(
                JSON.stringify({ error: { message: "ETA gateway temporarily unavailable" } }),
                { status: 503, headers: { "Content-Type": "application/json" } }
              );
            }
            const parsed = JSON.parse(String(init?.body ?? "{}")) as { documents: Array<{ internalID: string }> };
            return new Response(
              JSON.stringify({
                submissionId: "SUB-RETRY-OK",
                acceptedDocuments: [
                  { uuid: "ETA-UUID-AFTER-RETRY", internalId: parsed.documents[0]!.internalID },
                ],
                rejectedDocuments: [],
              }),
              { status: 202, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response("Not Found", { status: 404 });
        });

        const failRun = await processPendingEtaSubmissions({
          db,
          fetchImpl: backoffFetch as unknown as typeof fetch,
        });
        expect(failRun.failed).toBe(1);
        expect(failRun.accepted).toBe(0);

        const [failedRow] = await db
          .select()
          .from(einvoiceSubmissions)
          .where(eq(einvoiceSubmissions.id, afterMockRow!.id));
        expect(failedRow?.status).toBe("failed");
        expect(failedRow?.attempts).toBe(1);
        expect(failedRow?.lastError).toContain("ETA gateway temporarily unavailable");
        expect(failedRow?.nextRetryAt).not.toBeNull();
        expect(failedRow!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);

        // Before backoff expires, worker must NOT retry prematurely
        const earlyRun = await processPendingEtaSubmissions({
          db,
          fetchImpl: backoffFetch as unknown as typeof fetch,
        });
        expect(earlyRun.processed).toBe(0);

        // Once backoff window elapses, worker automatically retries the status='failed' submission & succeeds!
        etaMode = "accept";
        await db
          .update(einvoiceSubmissions)
          .set({ nextRetryAt: new Date(Date.now() - 1000) })
          .where(eq(einvoiceSubmissions.id, afterMockRow!.id));

        const retrySuccessRun = await processPendingEtaSubmissions({
          db,
          fetchImpl: backoffFetch as unknown as typeof fetch,
        });
        expect(retrySuccessRun.accepted).toBe(1);
        expect(retrySuccessRun.failed).toBe(0);

        const [acceptedRow] = await db
          .select()
          .from(einvoiceSubmissions)
          .where(eq(einvoiceSubmissions.id, afterMockRow!.id));
        expect(acceptedRow?.status).toBe("accepted");
        expect(acceptedRow?.attempts).toBe(2);
        expect(acceptedRow?.lastError).toBeNull();
        expect(acceptedRow?.nextRetryAt).toBeNull();
      } finally {
        await mockSigner.close();
        clearEtaTokenCache();
        env.ETA_CLIENT_ID = origClientId;
        env.ETA_CLIENT_SECRET = origSecret;
        env.ETA_INVOICE_VERSION = origVer;
        env.ETA_SIGNER_URL = origSignerUrl;
        env.ETA_SIGNER_TOKEN = origSignerTok;
      }
    });
  }
);
