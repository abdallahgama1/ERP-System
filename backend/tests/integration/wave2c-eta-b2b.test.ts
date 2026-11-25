import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

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
                value: "CADES-BES-BASE64-SIGNATURE-MOCK-VALUE",
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
          { signatureType: "I", value: "CADES-BES-BASE64-SIGNATURE-MOCK-VALUE" },
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
  }
);
