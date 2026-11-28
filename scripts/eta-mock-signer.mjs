#!/usr/bin/env node
/**
 * ============================================================================
 * LOCAL MOCK ETA SIGNER BRIDGE — NOT A REAL CAdES-BES SIGNER (DEV / TEST ONLY)
 * ============================================================================
 *
 * Implements the HTTP contract documented in docs/ETA_GO_LIVE.md so developers
 * and automated tests can verify canonicalization, request/response wiring,
 * auth headers, timeouts, and error handling without a physical USB token.
 *
 * SAFETY GUARANTEE:
 *   - Always responds with header `X-ETA-Mock-Signer: true`, JSON `isMock: true`,
 *     `signerKind: "mock"`, and a `MOCK_SIGNATURE_NOT_FOR_ETA_SUBMISSION:...` value.
 *   - The ERP backend (`eta-signer.service.ts`) strictly REFUSES to accept mock
 *     signatures or mark any document as submitted to ETA unless a real
 *     Base64-encoded ASN.1 DER CAdES-BES signature is returned.
 *
 * Usage:
 *   npm run eta:mock-signer
 *   ETA_MOCK_SIGNER_PORT=5099 ETA_SIGNER_TOKEN=dev-token node scripts/eta-mock-signer.mjs
 */
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MOCK_SIGNER_WARNING =
  "NOT A REAL ETA SIGNER — DEV/TEST ONLY. The ERP refuses to mark documents as submitted with mock signatures.";

function isValidBearer(authHeader, expectedToken) {
  if (!expectedToken) return true;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!match) return false;
  const provided = createHash("sha256").update(match[1].trim(), "utf8").digest();
  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(provided, expected);
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-ETA-Mock-Signer": "true",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export async function startMockEtaSignerServer({
  port = Number.parseInt(process.env.ETA_MOCK_SIGNER_PORT ?? "5099", 10),
  host = "127.0.0.1",
  token = (process.env.ETA_SIGNER_TOKEN ?? "").trim(),
} = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        isMock: true,
        signerKind: "mock",
        warning: MOCK_SIGNER_WARNING,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sign") {
      if (!isValidBearer(req.headers.authorization, token)) {
        sendJson(res, 401, {
          error: "Unauthorized: invalid or missing Bearer token",
          isMock: true,
          signerKind: "mock",
        });
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        totalBytes += chunk.length;
        if (totalBytes > 2 * 1024 * 1024) {
          sendJson(res, 413, { error: "Payload too large", isMock: true, signerKind: "mock" });
          return;
        }
        chunks.push(chunk);
      }

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body", isMock: true, signerKind: "mock" });
        return;
      }

      const canonicalString = typeof body?.canonicalString === "string" ? body.canonicalString : "";
      const canonicalSha256 = typeof body?.canonicalSha256 === "string" ? body.canonicalSha256.trim() : "";
      const document = body?.document && typeof body.document === "object" ? body.document : null;

      if (!canonicalString || !/^[0-9a-f]{64}$/i.test(canonicalSha256) || !document) {
        sendJson(res, 400, {
          error: "Request must include canonicalString (string), canonicalSha256 (64-hex), and document (object).",
          isMock: true,
          signerKind: "mock",
        });
        return;
      }

      const recomputed = createHash("sha256").update(canonicalString, "utf8").digest("hex");
      if (recomputed.toLowerCase() !== canonicalSha256.toLowerCase()) {
        sendJson(res, 400, {
          error: `canonicalSha256 mismatch: expected ${recomputed}, received ${canonicalSha256}`,
          isMock: true,
          signerKind: "mock",
        });
        return;
      }

      const digestB64 = Buffer.from(recomputed, "hex").toString("base64");
      sendJson(res, 200, {
        signatureType: "I",
        value: `MOCK_SIGNATURE_NOT_FOR_ETA_SUBMISSION:${digestB64}`,
        isMock: true,
        signerKind: "mock",
        canonicalSha256: recomputed,
        warning: MOCK_SIGNER_WARNING,
      });
      return;
    }

    sendJson(res, 404, { error: "Not found", isMock: true, signerKind: "mock" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}/sign`,
    healthUrl: `http://${host}:${actualPort}/health`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  startMockEtaSignerServer()
    .then((inst) => {
      console.log("========================================================================");
      console.log("  LOCAL MOCK ETA SIGNER — NOT A REAL CAdES-BES SIGNER (DEV / TEST ONLY) ");
      console.log("========================================================================");
      console.log(`  Sign URL  : ${inst.url}`);
      console.log(`  Health URL: ${inst.healthUrl}`);
      console.log("  Notice    : The ERP refuses to submit mock-signed documents to ETA.");
      console.log("========================================================================");
    })
    .catch((err) => {
      console.error("[eta-mock-signer] Failed to start:", err);
      process.exit(1);
    });
}
