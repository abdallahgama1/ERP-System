import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config.ts";
import { computeNextEtaRetryDelayMs } from "../../src/services/einvoicing.service.ts";
import {
  clearEtaTokenCache,
  getEtaAccessToken,
  getEtaSubmissionStatus,
  isEtaConfigured,
  submitEtaReceipts,
} from "../../src/services/eta-client.service.ts";

describe("ETA Egypt e-Receipt v1.2 HTTP Client & Backoff Schedule", () => {
  const originalClientId = env.ETA_CLIENT_ID;
  const originalClientSecret = env.ETA_CLIENT_SECRET;
  const originalTokenUrl = env.ETA_TOKEN_URL;
  const originalApiBaseUrl = env.ETA_API_BASE_URL;

  beforeEach(() => {
    clearEtaTokenCache();
    env.ETA_CLIENT_ID = "test-eta-client-id";
    env.ETA_CLIENT_SECRET = "test-eta-client-secret";
    env.ETA_TOKEN_URL = "https://id.preprod.eta.gov.eg/connect/token";
    env.ETA_API_BASE_URL = "https://api.preprod.invoicing.eta.gov.eg";
  });

  afterEach(() => {
    clearEtaTokenCache();
    env.ETA_CLIENT_ID = originalClientId;
    env.ETA_CLIENT_SECRET = originalClientSecret;
    env.ETA_TOKEN_URL = originalTokenUrl;
    env.ETA_API_BASE_URL = originalApiBaseUrl;
  });

  it("reports isEtaConfigured accurately based on ETA_CLIENT_ID and ETA_CLIENT_SECRET", () => {
    expect(isEtaConfigured()).toBe(true);
    env.ETA_CLIENT_ID = "";
    expect(isEtaConfigured()).toBe(false);
    env.ETA_CLIENT_ID = "client-id";
    env.ETA_CLIENT_SECRET = "";
    expect(isEtaConfigured()).toBe(false);
  });

  it("acquires OAuth2 token with posserial/pososversion headers and caches until expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "eta-jwt-token-123",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const token1 = await getEtaAccessToken({
      posSerial: "EG-POS-001",
      posOsVersion: "Win11-POS",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const token2 = await getEtaAccessToken({
      posSerial: "EG-POS-001",
      posOsVersion: "Win11-POS",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(token1).toBe("eta-jwt-token-123");
    expect(token2).toBe("eta-jwt-token-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://id.preprod.eta.gov.eg/connect/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.posserial).toBe("EG-POS-001");
    expect(headers.pososversion).toBe("Win11-POS");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    expect(String(init.body)).toContain("client_id=test-eta-client-id");
  });

  it("submits receipts to /api/v1/receiptsubmissions and parses accepted and rejected documents", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-abc", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: "sub-uuid-999",
            acceptedDocuments: [
              {
                uuid: "doc-uuid-accepted-1",
                longId: "LONG-1",
                receiptNumber: "POS-00001",
              },
            ],
            rejectedDocuments: [
              {
                uuid: "doc-uuid-rejected-2",
                receiptNumber: "POSR-00001",
                error: {
                  message: "Validation Error",
                  details: [
                    {
                      propertyPath: "header.referenceUUID",
                      message: "Invalid reference UUID",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 202 }
        )
      );

    const res = await submitEtaReceipts(
      [
        { header: { receiptNumber: "POS-00001", uuid: "doc-uuid-accepted-1" } },
        { header: { receiptNumber: "POSR-00001", uuid: "doc-uuid-rejected-2" } },
      ],
      {
        posSerial: "EG-POS-01",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }
    );

    expect(res.submissionUuid).toBe("sub-uuid-999");
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].uuid).toBe("doc-uuid-accepted-1");
    expect(res.accepted[0].receiptNumber).toBe("POS-00001");
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].uuid).toBe("doc-uuid-rejected-2");
    expect(res.rejected[0].errorMessage).toContain("header.referenceUUID: Invalid reference UUID");
  });

  it("polls submission status via GET /api/v1/receiptsubmissions/:submissionUuid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-xyz", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            submissionId: "sub-uuid-555",
            status: "Valid",
            receipts: [{ uuid: "doc-uuid-555", receiptNumber: "POS-00055" }],
          }),
          { status: 200 }
        )
      );

    const statusRes = await getEtaSubmissionStatus("sub-uuid-555", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(statusRes.submissionUuid).toBe("sub-uuid-555");
    expect(statusRes.status).toBe("Valid");
    expect(statusRes.accepted).toHaveLength(1);
    expect(statusRes.accepted[0].uuid).toBe("doc-uuid-555");
  });

  it("computes deterministic exponential backoff retry delays for attempts 1 through 5", () => {
    expect(computeNextEtaRetryDelayMs(1)).toBe(60_000); // 1 min
    expect(computeNextEtaRetryDelayMs(2)).toBe(5 * 60_000); // 5 min
    expect(computeNextEtaRetryDelayMs(3)).toBe(15 * 60_000); // 15 min
    expect(computeNextEtaRetryDelayMs(4)).toBe(60 * 60_000); // 60 min
    expect(computeNextEtaRetryDelayMs(5)).toBe(6 * 60 * 60_000); // 6 hours
    expect(computeNextEtaRetryDelayMs(8)).toBe(6 * 60 * 60_000); // capped at 6 hours
  });
});
