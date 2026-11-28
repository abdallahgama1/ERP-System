# Egyptian Tax Authority (ETA) Go-Live Guide

This guide documents the HTTP contract for the CAdES-BES hardware-token signer bridge, all `ETA_*` environment variables, the local mock signer (dev/test only), the preprod smoke suite (`npm run eta:preprod-smoke`), retry behavior, and the step-by-step Preprod → Production go-live checklist.

---

## 1. CAdES-BES Signer Bridge HTTP Contract

Egyptian Tax Authority B2B e-Invoice **v1.0** (`"I"` Invoice, `"C"` Credit Note, `"D"` Debit Note) requires a **CAdES-BES (PKCS#7 / CMS SignedData)** digital signature produced by an accredited Egyptian CA USB token / HSM (Egypt Trust, MCDR, Fixed, etc.) via PKCS#11. Because the Linux ERP server rarely hosts the physical USB token directly, `backend/src/services/eta-signer.service.ts` delegates signing over HTTP to a signer bridge at `ETA_SIGNER_URL`.

### 1.1 Endpoint & Authentication
- **Method & URL:** `POST ${ETA_SIGNER_URL}` (e.g., `http://127.0.0.1:5099/sign` or private VPN/WireGuard URL — **never expose the signer bridge publicly**).
- **Optional Health Endpoint:** `GET /health` → `200 OK` `{ "ok": true }`.
- **Headers Sent by ERP:**
  - `Content-Type: application/json`
  - `Accept: application/json`
  - `Authorization: Bearer <ETA_SIGNER_TOKEN>` (sent whenever `ETA_SIGNER_TOKEN` is non-empty; scrubbed automatically from Pino logs and Sentry events).

### 1.2 Request Body (JSON)
```json
{
  "canonicalString": "\"ISSUER\"\"ADDRESS\"\"BRANCHID\"\"0\"...",
  "canonicalSha256": "a3f1...64-lowercase-hex-chars...",
  "document": {
    "issuer": { "...": "..." },
    "receiver": { "...": "..." },
    "documentType": "I",
    "documentTypeVersion": "1.0",
    "dateTimeIssued": "2026-11-28T10:00:00Z",
    "internalID": "INV-00042",
    "invoiceLines": [ "..." ]
  }
}
```
- `document` is the full ETA v1.0 JSON payload with `signatures` omitted.
- `canonicalString` is serialized using ETA's recursive UPPERCASE-key canonicalization (`serializeEtaCanonicalForSigning()`).
- `canonicalSha256` is the hex SHA-256 digest of `canonicalString` (UTF-8). The bridge should sign `canonicalString` (UTF-8 bytes) with SHA-256 + RSA (CAdES-BES detached/attached CMS `SignedData` per ETA SDK specification).

### 1.3 Success Response (`200 OK`)
```json
{
  "signatureType": "I",
  "value": "MIIG...<Base64-encoded ASN.1 DER CMS SignedData>..."
}
```
- `signatureType`: `"I"` (Issuer, default) or `"S"` (Service Provider).
- `value` (aliases `signatureValue` or `signature` are also accepted): Base64-encoded ASN.1 DER CAdES-BES CMS `ContentInfo` (`SEQUENCE` tag `0x30`, `>= 32` decoded bytes).
- **Strict Real-Signature Enforcement:** The ERP refuses to attach a signature or mark any document as `submitted`/`accepted` if:
  - Response header `X-ETA-Mock-Signer: true` is present, OR
  - Response JSON contains `isMock: true`, `mock: true`, or `signerKind: "mock"`, OR
  - `value` starts with `MOCK` or fails strict Base64 / ASN.1 DER `0x30` validation.

### 1.4 Error Responses & Timeouts
- **Timeout:** Controlled by `ETA_SIGNER_TIMEOUT_MS` (default `10000` ms / 10 seconds via `AbortController`). Timeouts and network errors throw `EtaSignerError(503, retryable=true)`.
- **HTTP Error Body (recommended):** `{ "error": "Human-readable signer error message" }` (or `{ "message": "..." }`).
- **Retry Classification:**

| HTTP Status / Condition | Retryable? | ERP Queue Behavior |
| :--- | :--- | :--- |
| `429` Too Many Requests, `500`–`504`, network timeout / connection refused | **Yes** | Submission marked `failed` with `lastError` and `nextRetryAt` scheduled with exponential backoff (`1m → 5m → 15m → 60m → 6h`, max 5 attempts). |
| `400`, `401`, `403` (bad token, locked PIN, malformed request) | **No** | Submission marked `failed` with `nextRetryAt = null` until operator fixes config and clicks **Retry**. |
| Mock / invalid signature (`MOCK_SIGNATURE_REFUSED` / `INVALID_SIGNATURE`) | **No** | Submission immediately refused, marked `failed` with `nextRetryAt = null`, **never** sent to ETA and **never** marked `submitted`. |

---

## 2. Local Mock Signer Service (Development & Testing Only)

> [!WARNING]
> `scripts/eta-mock-signer.mjs` is **NOT A REAL CAdES-BES SIGNER**. It exists solely to test the HTTP bridge contract, Bearer authentication, canonical SHA-256 verification, and mock-refusal guard locally. The ERP **refuses** to submit mock-signed documents to ETA.

```bash
# Start local mock signer on http://127.0.0.1:5099/sign
ETA_MOCK_SIGNER_PORT=5099 ETA_SIGNER_TOKEN=dev-token npm run eta:mock-signer

# Verify health endpoint
curl -fsS http://127.0.0.1:5099/health
```

---

## 3. Environment Variables Reference

| Variable | Preprod Value | Production Value | Default | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `ETA_CLIENT_ID` | Preprod Portal Client ID | Production Portal Client ID | `""` | ETA OAuth2 `client_id` (worker skips cleanly when unset) |
| `ETA_CLIENT_SECRET` | Preprod Portal Client Secret | Production Portal Client Secret | `""` | ETA OAuth2 `client_secret` (scrubbed from logs/Sentry) |
| `ETA_ID_BASE_URL` | `https://id.preprod.eta.gov.eg` | `https://id.eta.gov.eg` | `https://id.preprod.eta.gov.eg` | ETA Identity server base URL |
| `ETA_TOKEN_URL` | `${ETA_ID_BASE_URL}/connect/token` | `${ETA_ID_BASE_URL}/connect/token` | Derived | Explicit OAuth2 token endpoint override |
| `ETA_API_BASE_URL` | `https://api.preprod.invoicing.eta.gov.eg` | `https://api.invoicing.eta.gov.eg` | `https://api.preprod.invoicing.eta.gov.eg` | ETA e-Invoicing & e-Receipt REST API base URL |
| `ETA_INVOICE_VERSION` | `0.9` (unsigned) or `1.0` (signed) | `1.0` (**required signed**) | `1.0` | B2B e-Invoice document version |
| `ETA_SIGNER_URL` | `http://127.0.0.1:5099/sign` (real token bridge) | Private URL of real CAdES-BES signer bridge | `""` | HTTP endpoint of PKCS#11 / USB token signer |
| `ETA_SIGNER_TOKEN` | Random Bearer token | Random Bearer token (`openssl rand -hex 24`) | `""` | Shared Bearer secret sent to `ETA_SIGNER_URL` |
| `ETA_SIGNER_TIMEOUT_MS` | `10000` | `10000` | `10000` | Signer HTTP request timeout in milliseconds |

**Optional env vars used only by `npm run eta:preprod-smoke`:**
- `ETA_ISSUER_RIN` — Your registered 9-digit Preprod taxpayer RIN (default `100000001`).
- `ETA_PREPROD_RECEIVER_RIN` — Registered Preprod B2B buyer 9-digit RIN (default `200000002`).
- `ETA_PREPROD_ITEM_STANDARD`, `ETA_PREPROD_ITEM_REDUCED`, `ETA_PREPROD_ITEM_ZERO_RATED`, `ETA_PREPROD_ITEM_EXEMPT` — Approved EGS/GS1 item codes on your Preprod taxpayer profile.

---

## 4. Failed Submission Retry Backoff & Queue UI

- The background worker (`processPendingEtaSubmissions`, guarded by PostgreSQL advisory lock `948271/202`) runs every 60 seconds and processes:
  1. Due `pending` submissions (`nextRetryAt IS NULL OR nextRetryAt <= now()`).
  2. Due `failed` submissions eligible for automatic retry (`nextRetryAt <= now()` and `attempts < 5`).
  3. In-flight `submitted` submissions awaiting ETA async status polling (`GET /api/v1/documentsubmissions/:uuid` / `/receiptsubmissions/:uuid`).
- **Exponential Backoff Schedule (`computeNextEtaRetryDelayMs`):**
  - Attempt 1 → **1 minute**
  - Attempt 2 → **5 minutes**
  - Attempt 3 → **15 minutes**
  - Attempt 4 → **60 minutes**
  - Attempt 5 → **6 hours** (after 5 attempts, `nextRetryAt` becomes `null` and operator intervention is required).
- **Queue UI (`/admin/einvoicing`):**
  - Displays each row's full ETA error text and next scheduled retry timestamp in the **ETA Error / Next Retry** column.
  - Clicking **View Payload** opens the detail modal showing the raw error, parsed ETA validation `details[]` (`[code] propertyPath: message`), canonical request payload, and ETA gateway response JSON.
  - Use **Retry** (per row) or **Retry Failed & Rejected** (bulk) after fixing master data or signer/network issues.

---

## 5. Step-by-Step ETA Preprod → Production Go-Live Checklist

### Phase A — ETA Preprod Portal & Master Data
- [ ] Register the ERP system on the ETA Preprod Taxpayer Portal (`https://preprod.invoicing.eta.gov.eg`) and obtain `ETA_CLIENT_ID` and `ETA_CLIENT_SECRET`.
- [ ] Verify your taxpayer RIN (9 digits), activity code (e.g., `4690`), and all branch codes (`etaBranchId`, e.g., `0`, `1`) match the portal.
- [ ] Submit and obtain ETA approval for your EGS (`EG-<RIN>-<SKU>`) or GS1 barcodes on the Preprod portal.
- [ ] Configure ERP **Settings → Company**: set `einvoicingMode = eta_egypt`, Legal Name, and 9-digit `taxRegistrationNumber`.
- [ ] Configure ERP **Branches**: set `etaBranchId`, `country` (`EG`), `governorate`, `regionCity`, `street`, `buildingNumber`, and `postalCode`.
- [ ] Configure ERP **Products**: set `etaCodeType` (`EGS`/`GS1`), approved `etaItemCode`, and valid `etaUnitType` (`EA`, `KGM`, `BX`, etc.).
- [ ] Configure ERP **Customers**: set `etaReceiverType` (`B` Business with 9-digit RIN, `P` Person with 14-digit National ID above ETA B2C threshold, `F` Foreigner).
- [ ] (If using POS e-Receipt v1.2) Register each POS device on ETA Portal and configure `etaPosSerial` and `etaPosOsVersion` in ERP **POS Terminals**.

### Phase B — Signer Bridge & Preprod Smoke Verification
- [ ] Install the accredited Egyptian USB token / PKCS#11 CAdES-BES signer bridge on the signing workstation/host and verify `GET /health` returns `200 OK` (and is **not** the mock signer).
- [ ] Configure `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_ID_BASE_URL=https://id.preprod.eta.gov.eg`, `ETA_API_BASE_URL=https://api.preprod.invoicing.eta.gov.eg`, `ETA_INVOICE_VERSION=1.0`, `ETA_SIGNER_URL`, and `ETA_SIGNER_TOKEN` in `.env` (or `.env.staging`).
- [ ] Preview the 6 smoke payloads without network calls:
  ```bash
  npm run eta:preprod-smoke -- --dry-run
  ```
- [ ] Run the live Preprod 6-document smoke suite (standard 14% invoice, discounted invoice, multi-VAT 14%+5% invoice, zero-rated `V001` invoice, exempt `V003` invoice, and credit note `'C'`):
  ```bash
  ETA_ISSUER_RIN=<your-9-digit-rin> \
  ETA_PREPROD_RECEIVER_RIN=<test-buyer-rin> \
  ETA_PREPROD_ITEM_STANDARD=<approved-egs-code> \
  ETA_PREPROD_ITEM_REDUCED=<approved-egs-code> \
  ETA_PREPROD_ITEM_ZERO_RATED=<approved-egs-code> \
  ETA_PREPROD_ITEM_EXEMPT=<approved-egs-code> \
  npm run eta:preprod-smoke -- --require-credentials
  ```
- [ ] Confirm exit code `0`, `acceptedCount: 6`, `rejectedCount: 0`, and inspect all 6 documents as **Valid** on the ETA Preprod portal. Fix any printed validation errors (`[code] propertyPath — message`) before proceeding.
- [ ] Issue one test Sales Invoice, one Sales Return (Credit Note), and (if POS enabled) one POS Sale & Return inside the staging ERP UI and confirm all reach `accepted` in `/admin/einvoicing`.

### Phase C — Production Cutover
- [ ] Obtain Production `ETA_CLIENT_ID` and `ETA_CLIENT_SECRET` from the live ETA Portal (`https://invoicing.eta.gov.eg`) and ensure all production EGS/GS1 codes are approved.
- [ ] Switch production `.env` to live ETA endpoints:
  ```bash
  ETA_ID_BASE_URL=https://id.eta.gov.eg
  ETA_API_BASE_URL=https://api.invoicing.eta.gov.eg
  ETA_INVOICE_VERSION=1.0
  ETA_SIGNER_URL=<private-url-of-real-cades-bes-signer>
  ETA_SIGNER_TOKEN=<strong-random-bearer-token>
  ```
- [ ] Restart backend (`docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend`) and verify `GET /ready`.
- [ ] Issue the first real B2B invoice, click **Process Queue / Poll ETA** in `/admin/einvoicing`, confirm status transitions to `accepted`, and verify the ETA QR share URL resolves to the Valid document on `invoicing.eta.gov.eg`.
