import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config.ts";
import { LOG_REDACT_PATHS } from "../../src/logging/logger.ts";
import {
  buildEtaB2bInvoicePayload,
  buildEtaEgyptInvoiceShareUrl,
} from "../../src/services/einvoicing.service.ts";
import {
  clearEtaTokenCache,
  getEtaDocumentSubmissionStatus,
  submitEtaDocuments,
} from "../../src/services/eta-client.service.ts";
import {
  EtaSignerError,
  computeEtaDocumentCanonicalDigest,
  isRealCadesBesSignature,
  signEtaInvoiceIfNeeded,
} from "../../src/services/eta-signer.service.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Wave 2C: ETA Egypt B2B e-Invoice v1.0, CAdES-BES Signer Bridge & Document Submissions", () => {
  const origClientId = env.ETA_CLIENT_ID;
  const origClientSecret = env.ETA_CLIENT_SECRET;
  const origInvoiceVer = env.ETA_INVOICE_VERSION;
  const origSignerUrl = env.ETA_SIGNER_URL;
  const origSignerToken = env.ETA_SIGNER_TOKEN;

  beforeEach(() => {
    clearEtaTokenCache();
    env.ETA_CLIENT_ID = "eta-b2b-client";
    env.ETA_CLIENT_SECRET = "eta-b2b-secret";
    env.ETA_INVOICE_VERSION = "1.0";
    env.ETA_SIGNER_URL = "";
    env.ETA_SIGNER_TOKEN = "";
  });

  afterEach(() => {
    clearEtaTokenCache();
    env.ETA_CLIENT_ID = origClientId;
    env.ETA_CLIENT_SECRET = origClientSecret;
    env.ETA_INVOICE_VERSION = origInvoiceVer;
    env.ETA_SIGNER_URL = origSignerUrl;
    env.ETA_SIGNER_TOKEN = origSignerToken;
  });

  it("builds canonical ETA B2B Invoice ('I') and Credit Note ('C') payloads with GS1/EGS, ETA UOMs, and FX conversion", () => {
    const inv = buildEtaB2bInvoicePayload({
      internalId: "INV-0042",
      dateTimeIssuedIso: "2026-11-25T10:30:00.000Z",
      documentType: "I",
      documentTypeVersion: "1.0",
      currency: "USD",
      exchangeRate: 50,
      issuerName: "Nile Industrial Supplies SAE",
      issuerRin: "310220330",
      branchId: "2",
      branchGovernorate: "Giza",
      branchRegionCity: "6th of October",
      branchStreet: "Industrial Zone 4",
      branchBuildingNumber: "18B",
      receiverType: "B",
      receiverId: "500600700",
      receiverName: "Delta Manufacturing Co",
      subtotal: 200, // 200 USD * 50 = 10,000 EGP
      taxTotal: 28, // 28 USD * 50 = 1,400 EGP
      totalAmount: 228, // 11,400 EGP
      lines: [
        {
          description: "Industrial Valve Box",
          internalCode: "VLV-BX-01",
          itemType: "GS1",
          itemCode: "6221234567890",
          unitType: "BX",
          quantity: 2,
          unitPrice: 100,
          taxRate: 14,
          taxAmount: 28,
          lineTotal: 228,
        },
      ],
    });

    expect(inv.etaUuid).toMatch(/^[a-f0-9]{64}$/);
    expect(inv.qrUrl).toBe(buildEtaEgyptInvoiceShareUrl(inv.etaUuid, "2026-11-25T10:30:00Z"));
    expect(inv.payload.documentType).toBe("I");
    expect(inv.payload.documentTypeVersion).toBe("1.0");
    expect((inv.payload.issuer as { id: string }).id).toBe("310220330");
    expect(
      ((inv.payload.issuer as { address: Record<string, string> }).address).governate
    ).toBe("Giza");
    expect((inv.payload.receiver as { type: string; id: string }).type).toBe("B");
    const firstLine = (inv.payload.invoiceLines as Array<Record<string, unknown>>)[0];
    expect(firstLine.itemType).toBe("GS1");
    expect(firstLine.itemCode).toBe("6221234567890");
    expect(firstLine.unitType).toBe("BX");
    expect((firstLine.unitValue as Record<string, unknown>).currencySold).toBe("USD");
    expect((firstLine.unitValue as Record<string, unknown>).amountEGP).toBe(5000);
    expect((firstLine.unitValue as Record<string, unknown>).amountSold).toBe(100);
    expect(inv.payload.totalAmount).toBe(11400);

    const creditNote = buildEtaB2bInvoicePayload({
      internalId: "CN-0007",
      dateTimeIssuedIso: "2026-11-25T12:00:00.000Z",
      documentType: "C",
      documentTypeVersion: "1.0",
      references: [inv.etaUuid],
      currency: "EGP",
      issuerName: "Nile Industrial Supplies SAE",
      issuerRin: "310220330",
      branchId: "2",
      receiverType: "B",
      receiverId: "500600700",
      receiverName: "Delta Manufacturing Co",
      subtotal: 5000,
      taxTotal: 700,
      totalAmount: 5700,
      lines: [
        {
          description: "Returned Valve Box",
          internalCode: "VLV-BX-01",
          itemType: "GS1",
          itemCode: "6221234567890",
          unitType: "BX",
          quantity: 1,
          unitPrice: 5000,
          taxRate: 14,
          taxAmount: 700,
          lineTotal: 5700,
        },
      ],
    });
    expect(creditNote.payload.documentType).toBe("C");
    expect(creditNote.payload.references).toEqual([inv.etaUuid]);
  });

  it("handles v0.9 unsigned pass-through, v1.0 pending_signature safety, and v1.0 HTTP CAdES-BES signing without altering canonical SHA-256", async () => {
    const built = buildEtaB2bInvoicePayload({
      internalId: "INV-SIGN-01",
      dateTimeIssuedIso: "2026-11-25T09:00:00.000Z",
      documentType: "I",
      documentTypeVersion: "1.0",
      currency: "EGP",
      issuerName: "Cairo Tech LLC",
      issuerRin: "111222333",
      branchId: "0",
      receiverType: "B",
      receiverId: "444555666",
      receiverName: "Alexandria Trading",
      subtotal: 1000,
      taxTotal: 140,
      totalAmount: 1140,
      lines: [
        {
          description: "Server Rack",
          internalCode: "SRV-01",
          itemCode: "EG-111222333-SRV01",
          quantity: 1,
          unitPrice: 1000,
          taxRate: 14,
          taxAmount: 140,
          lineTotal: 1140,
        },
      ],
    });

    // 1. v1.0 without ETA_SIGNER_URL stays safely pending_signature
    const pendingRes = await signEtaInvoiceIfNeeded(built.payload);
    expect(pendingRes.signed).toBe(false);
    expect(pendingRes.signatureStatus).toBe("pending_signature");
    expect(pendingRes.pendingReason).toContain("ETA_SIGNER_URL");

    // 2. v0.9 passes through unsigned cleanly
    const v09Doc = { ...built.payload, documentTypeVersion: "0.9" };
    const v09Res = await signEtaInvoiceIfNeeded(v09Doc);
    expect(v09Res.signed).toBe(false);
    expect(v09Res.signatureStatus).toBe("unsigned_v0_9");
    expect(v09Res.document.signatures).toBeUndefined();

    // 3. v1.0 with HTTP CAdES-BES bridge attaches signatures array and preserves canonical digest
    const signerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          signatureType: "I",
          value: "MIIGCAYJKoZIhvcNAQcCoIIF+TCCBfUCAQExDzANBglghkgBZQMEAgEFADALBgkqhkiG9w0BBwE=",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const signedRes = await signEtaInvoiceIfNeeded(built.payload, {
      signerUrl: "http://127.0.0.1:5099/sign",
      signerToken: "super-secret-dongle-token",
      fetchImpl: signerFetch as unknown as typeof fetch,
    });

    expect(signedRes.signed).toBe(true);
    expect(signedRes.signatureStatus).toBe("signed");
    expect(signedRes.canonicalSha256).toBe(built.etaUuid);
    // Re-computing canonical digest over the signed document must exclude `signatures` and match!
    expect(computeEtaDocumentCanonicalDigest(signedRes.document).canonicalSha256).toBe(built.etaUuid);
    expect(signedRes.document.signatures).toEqual([
      {
        signatureType: "I",
        value: "MIIGCAYJKoZIhvcNAQcCoIIF+TCCBfUCAQExDzANBglghkgBZQMEAgEFADALBgkqhkiG9w0BBwE=",
      },
    ]);

    const [calledUrl, calledInit] = signerFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5099/sign");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer super-secret-dongle-token"
    );
  });

  it("submits B2B documents to POST /api/v1/documentsubmissions and polls GET /api/v1/documentsubmissions/:uuid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "b2b-jwt", expires_in: 3600 }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: "SUB-B2B-101",
            acceptedDocuments: [
              {
                uuid: "ETA-REMOTE-DOC-UUID-1",
                longId: "LONG-B2B-1",
                internalId: "INV-0042",
                hashKey: "HASH-1",
              },
            ],
            rejectedDocuments: [],
          }),
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: "SUB-B2B-101",
            overallStatus: "Valid",
            documentSummary: [{ uuid: "ETA-REMOTE-DOC-UUID-1", internalId: "INV-0042" }],
          }),
          { status: 200 }
        )
      );

    const submitRes = await submitEtaDocuments([{ internalID: "INV-0042", documentType: "I" }], {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(submitRes.submissionUuid).toBe("SUB-B2B-101");
    expect(submitRes.accepted).toHaveLength(1);
    expect(submitRes.accepted[0].uuid).toBe("ETA-REMOTE-DOC-UUID-1");
    expect(submitRes.accepted[0].receiptNumber).toBe("INV-0042");

    const pollRes = await getEtaDocumentSubmissionStatus("SUB-B2B-101", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(pollRes.status).toBe("Valid");
    expect(pollRes.accepted[0].uuid).toBe("ETA-REMOTE-DOC-UUID-1");

    expect(LOG_REDACT_PATHS).toContain("etaSignerToken");
    expect(LOG_REDACT_PATHS).toContain("*.etaSignerToken");
  });

  it("refuses mock signer headers, isMock JSON flags, and non-ASN.1-DER signature strings", async () => {
    const validCms = "MIIGCAYJKoZIhvcNAQcCoIIF+TCCBfUCAQExDzANBglghkgBZQMEAgEFADALBgkqhkiG9w0BBwE=";
    expect(isRealCadesBesSignature(validCms)).toBe(true);
    expect(isRealCadesBesSignature("MOCK_SIGNATURE_NOT_FOR_ETA_SUBMISSION:abc")).toBe(false);
    expect(isRealCadesBesSignature("not-base64!!!")).toBe(false);
    expect(isRealCadesBesSignature(Buffer.from("plain text not asn1 der sequence 1234567890").toString("base64"))).toBe(false);

    const sampleDoc = { documentType: "I", documentTypeVersion: "1.0", internalID: "INV-MOCK-REFUSE" };

    // Refuses X-ETA-Mock-Signer header even if value looks like Base64
    const mockHeaderFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ signatureType: "I", value: validCms }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-ETA-Mock-Signer": "true" },
      })
    );
    await expect(
      signEtaInvoiceIfNeeded(sampleDoc, {
        signerUrl: "http://127.0.0.1:5099/sign",
        fetchImpl: mockHeaderFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(EtaSignerError);

    // Refuses isMock: true JSON flag
    const mockBodyFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ signatureType: "I", value: validCms, isMock: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(
      signEtaInvoiceIfNeeded(sampleDoc, {
        signerUrl: "http://127.0.0.1:5099/sign",
        fetchImpl: mockBodyFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(/Refused mock signature/i);
  });

  it("eta:preprod-smoke builds all 6 sample cases, refuses prod URLs & mock signatures, submits cleanly, and formats rejections", async () => {
    const smokeUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/eta-preprod-smoke.mjs")).href;
    const smoke = (await import(smokeUrl)) as {
      buildPreprodSmokeDocuments: (opts?: Record<string, unknown>) => Array<{
        caseName: string;
        document: Record<string, unknown>;
      }>;
      formatEtaValidationErrors: (rejected: unknown[]) => string[];
      runEtaPreprodSmoke: (opts: Record<string, unknown>) => Promise<{
        ok: boolean;
        skipped: boolean;
        mode: string;
        acceptedCount?: number;
        rejectedCount?: number;
        rejectedErrors?: string[];
      }>;
    };

    const docs = smoke.buildPreprodSmokeDocuments({ documentTypeVersion: "1.0", issuerRin: "310220330" });
    expect(docs.map((d) => d.caseName)).toEqual([
      "standard_invoice",
      "discounted_invoice",
      "multi_vat_invoice",
      "zero_rated_invoice",
      "exempt_invoice",
      "credit_note",
    ]);
    // Verify discount, multi-VAT, zero-rated V001, exempt V003, and credit note 'C'
    expect(docs[1]!.document.totalDiscountAmount).toBe(200);
    expect((docs[2]!.document.invoiceLines as Array<Record<string, unknown>>)).toHaveLength(2);
    const zeroTax = ((docs[3]!.document.invoiceLines as Array<{ taxableItems: Array<{ subType: string; rate: number }> }>)[0]!.taxableItems[0]!);
    expect(zeroTax.subType).toBe("V001");
    expect(zeroTax.rate).toBe(0);
    const exemptTax = ((docs[4]!.document.invoiceLines as Array<{ taxableItems: Array<{ subType: string; rate: number }> }>)[0]!.taxableItems[0]!);
    expect(exemptTax.subType).toBe("V003");
    expect(exemptTax.rate).toBe(0);
    expect(docs[5]!.document.documentType).toBe("C");

    // Skips cleanly when credentials are missing
    const skippedRes = await smoke.runEtaPreprodSmoke({ envVars: {} });
    expect(skippedRes.ok).toBe(true);
    expect(skippedRes.skipped).toBe(true);

    // Refuses production ETA URLs unless --allow-prod
    await expect(
      smoke.runEtaPreprodSmoke({
        envVars: {
          ETA_CLIENT_ID: "id",
          ETA_CLIENT_SECRET: "sec",
          ETA_ID_BASE_URL: "https://id.eta.gov.eg",
          ETA_API_BASE_URL: "https://api.invoicing.eta.gov.eg",
        },
      })
    ).rejects.toThrow(/Production URLs/i);

    // Submits all 6 documents cleanly against a mocked ETA preprod server and surfaces rejections clearly
    const validCms = "MIIGCAYJKoZIhvcNAQcCoIIF+TCCBfUCAQExDzANBglghkgBZQMEAgEFADALBgkqhkiG9w0BBwE=";
    const makeMockEtaFetch = (rejectExempt: boolean) =>
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/sign")) {
          return new Response(JSON.stringify({ signatureType: "I", value: validCms }), { status: 200 });
        }
        if (url.endsWith("/connect/token")) {
          return new Response(JSON.stringify({ access_token: "preprod-jwt", expires_in: 3600 }), { status: 200 });
        }
        if (url.endsWith("/api/v1/documentsubmissions")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { documents: Array<{ internalID: string }> };
          const acceptedDocuments: Array<Record<string, unknown>> = [];
          const rejectedDocuments: Array<Record<string, unknown>> = [];
          for (const d of body.documents) {
            if (rejectExempt && d.internalID.includes("EXEMPT")) {
              rejectedDocuments.push({
                internalId: d.internalID,
                error: {
                  code: "ValidationError",
                  message: "Invalid item code",
                  details: [
                    {
                      code: "CF344",
                      propertyPath: "invoiceLines[0].itemCode",
                      message: "EGS item code is not approved for taxpayer",
                    },
                  ],
                },
              });
            } else {
              acceptedDocuments.push({ uuid: `UUID-${d.internalID}`, internalId: d.internalID });
            }
          }
          return new Response(JSON.stringify({ submissionId: "SUB-PREPROD", acceptedDocuments, rejectedDocuments }), {
            status: 202,
          });
        }
        return new Response("Not Found", { status: 404 });
      });

    const passRes = await smoke.runEtaPreprodSmoke({
      envVars: {
        ETA_CLIENT_ID: "preprod-id",
        ETA_CLIENT_SECRET: "preprod-secret",
        ETA_INVOICE_VERSION: "1.0",
        ETA_SIGNER_URL: "http://127.0.0.1:5099/sign",
      },
      fetchImpl: makeMockEtaFetch(false) as unknown as typeof fetch,
    });
    expect(passRes.ok).toBe(true);
    expect(passRes.acceptedCount).toBe(6);
    expect(passRes.rejectedCount).toBe(0);

    const failRes = await smoke.runEtaPreprodSmoke({
      envVars: {
        ETA_CLIENT_ID: "preprod-id",
        ETA_CLIENT_SECRET: "preprod-secret",
        ETA_INVOICE_VERSION: "1.0",
        ETA_SIGNER_URL: "http://127.0.0.1:5099/sign",
      },
      fetchImpl: makeMockEtaFetch(true) as unknown as typeof fetch,
    });
    expect(failRes.ok).toBe(false);
    expect(failRes.rejectedCount).toBe(1);
    expect(failRes.rejectedErrors?.[0]).toContain("invoiceLines[0].itemCode");
    expect(failRes.rejectedErrors?.[0]).toContain("EGS item code is not approved for taxpayer");
  });
});
