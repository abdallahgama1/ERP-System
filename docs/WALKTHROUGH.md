# Walkthrough: Count It, Keep It — Hardened Production-Grade Multi-Branch ERP & POS

All architectural tracks and all six Hardened Production-Grade milestones (**M1–M6**) have been implemented and verified end-to-end across `@erp/shared`, `backend/`, `frontend/`, `deploy/`, `scripts/`, and `e2e/`.

---

## 1. M1 — Foundation, Shared Contracts & Database Migration (`0006`)

- **Database Schema & Migration ([0006_pos_returns_and_scale_indexes.sql](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/drizzle/migrations/0006_pos_returns_and_scale_indexes.sql), [schema.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/drizzle/schema.ts)):**
  - Extended `pos_shifts` with `total_cash_refunds`, `total_card_refunds`, `total_wallet_refunds`, and `total_refunds_count`.
  - Created `pos_returns`, `pos_return_lines`, and `pos_manager_overrides` tables with foreign keys, check constraints, and composite indexes.
  - Extended `einvoice_submissions` with nullable `invoice_id` and `pos_return_id` so both POS sales (`'S'`) and POS returns (`'R'`) are queued and tracked cleanly.
  - Seeded the `POSR-` document sequence and added composite pagination/search indexes across back-office tables.
- **Shared Zod Schemas & Constants ([pos.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/packages/shared/src/pos.ts), [einvoicing.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/packages/shared/src/einvoicing.ts), [pagination.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/packages/shared/src/pagination.ts)):**
  - Exported `DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT = 10`, `POS_OVERRIDE_ACTIONS`, `posManagerOverrideSchema`, `posReturnLineSchema`, `posReturnSchema`, and `posReceiptsQuerySchema`.
  - Exported `einvoiceSubmissionsQuerySchema`, `einvoiceSubmissionRetrySchema`, and standardized offset/cursor pagination schemas (`offsetPaginationInputSchema`, `buildOffsetPageInfo`).

---

## 2. M2 — Compiled Backend, Multi-Stage Docker, Reverse Proxy, Backups & Hardened CI

- **Compiled Production Backend ([backend/scripts/build.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/scripts/build.mjs), [backend/src/migrate.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/migrate.ts)):**
  - Bundled `backend/dist/server.mjs` (`659.7 kB`) and `backend/dist/migrate.mjs` (`7.2 kB`) targeting Node 22 ESM with external native/driver packages, eliminating `tsx` from production runtime (`"start": "node dist/server.mjs"`, `"db:migrate:prod": "node dist/migrate.mjs"`).
- **Multi-Stage Docker, Compose & Reverse Proxies ([Dockerfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/Dockerfile), [docker-compose.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docker-compose.yml), [Caddyfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/deploy/caddy/Caddyfile), [frontend.conf](file:///c:/Users/mohamed/Desktop/count-it-keep-it/deploy/nginx/frontend.conf)):**
  - Built multi-stage `Dockerfile` (`base`, `deps`, `build-backend`, `build-frontend`, non-root `backend-runtime` with `migrations-runner`, and `frontend-runtime` on `nginx:1.27-alpine`).
  - Configured `frontend.conf` and `Caddyfile` with immutable `/assets/*` caching, `no-cache` headers for `/sw.js`, `/workbox-*.js`, `/registerSW.js`, `/manifest.webmanifest`, and `/index.html`, SSE `proxy_buffering off` for `/api/events`, and internal shielding of `/api/metrics`.
- **Database Backup/Restore Runbooks & CI ([backup-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/backup-db.sh), [restore-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/restore-db.sh), [DEPLOYMENT.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/DEPLOYMENT.md), [ci.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/.github/workflows/ci.yml)):**
  - Added SHA-256 checksummed `pg_dump -Fc` backup and `pg_restore` scripts with post-restore migration runner.
  - Hardened `.github/workflows/ci.yml` with `npm audit --omit=dev --audit-level=high` and Docker Buildx validation for both `backend-runtime` and `frontend-runtime` targets.

---

## 3. M3 — CSRF Protection, Health Split, Prometheus Metrics, Optional Sentry & Housekeeping

- **CSRF Origin / Referer / Sec-Fetch-Site Protection ([csrf.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/middleware/csrf.ts)):**
  - Enforces same-origin validation on cookie-authenticated (`erp_session`) mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`), rejecting cross-site or spoofed-origin mutations with `403 CSRF_ORIGIN_FORBIDDEN`.
- **Health Split & Token-Gated Prometheus Metrics ([events.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/routes/events.ts), [metrics.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/observability/metrics.ts)):**
  - Exposed `/api/health/live` (process liveness without DB check) alongside `/api/health/ready` and `/api/health` (`SELECT 1` DB readiness).
  - Exposed `/api/metrics` (`prom-client` default metrics + `http_request_duration_seconds`, `http_requests_total`, `erp_auth_events_total`, `erp_db_errors_total`, `erp_housekeeping_runs_total`, `erp_housekeeping_purged_rows_total`), returning `404` when `METRICS_TOKEN` is unset and `401` on missing/invalid bearer tokens using constant-time SHA-256 `timingSafeEqual`.
- **Optional PII-Scrubbed Sentry Integration ([backend/src/observability/sentry.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/observability/sentry.ts), [frontend/src/lib/observability/sentry.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/lib/observability/sentry.ts), [ErrorBoundary.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/ErrorBoundary.tsx)):**
  - Zero network activity when `SENTRY_DSN` / `VITE_SENTRY_DSN` is unset; dynamically loads `@sentry/react` on the frontend and scrubs URLs, headers (`cookie`, `authorization`, `x-api-key`), passwords, PINs, reset tokens, and ETA secrets before sending events or breadcrumbs.
- **Advisory-Locked PostgreSQL Housekeeping ([housekeeping.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/housekeeping.service.ts), [admin.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/routes/admin.ts)):**
  - Purges expired or old revoked `user_sessions`, expired/used `password_reset_tokens`, and expired `idempotency_keys` under `pg_try_advisory_xact_lock(882419)`, exposed on boot, periodic timer, and `POST /api/admin/jobs/housekeeping`.

---

## 4. M4 — POS Counter Completeness & Maskable PWA Icons

- **Manager PIN Override ([pos-auth.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/pos-auth.service.ts), [ManagerPinOverrideDialog.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/pos/ManagerPinOverrideDialog.tsx)):**
  - Added `verifyManagerPinOverride` and `POST /api/pos/override/verify` (plus `/api/pos/manager-override`), validating supervisor (`admin` / `manager` or `pos.canApprove`) PINs with 5-attempt lockout, recording `pos_manager_overrides` + `audit_logs`, and **preserving `user_sessions.active_cashier_id` on the current cashier**.
  - Enforced `DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT` (`10%`) in [PosRegister.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/pos/PosRegister.tsx) and `executePosCheckoutTx`.
- **Recent POS Receipts & 80mm/58mm Reprint ([pos.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/pos.service.ts), [RecentReceiptsDrawer.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/pos/RecentReceiptsDrawer.tsx), [ThermalReceiptPrintView.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/pos/ThermalReceiptPrintView.tsx)):**
  - Implemented `GET /api/pos/receipts` and `GET /api/pos/receipts/:id` with per-line returned/remaining quantity tracking and instant 80mm (`w-[310px]`) / 58mm (`w-[235px]`) thermal preview & reprint.
- **Atomic POS Returns, Reversing GL & ETA `'R'` Receipts ([pos.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/pos.service.ts), [PosReturnDialog.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/pos/PosReturnDialog.tsx)):**
  - Implemented `executePosReturnTx` (`POST /api/pos/returns`) locking the original POS invoice row, preventing over-returns across partial refunds, optionally restocking inventory (`pos_return` stock movements), posting balanced reversing GL entries (`DR 4100 Sales Returns & Allowances`, `DR 2100 Tax Payable`, `CR 1010/1020`, plus `DR 1300 Inventory / CR 5000 COGS`), updating shift refund totals & `expectedCash`, and queuing an ETA Egypt `'R'` return receipt referring to the original `'S'` `etaDocumentUuid`.
- **PWA Icons ([manifest.webmanifest](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/public/manifest.webmanifest), [index.html](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/index.html)):**
  - Generated valid `192×192`, `512×512`, and `512×512` maskable PNG icons under `frontend/public/icons/`.

---

## 5. M5 — ETA Egypt e-Receipt v1.2 HTTP Client, Backoff Worker & Admin E-Invoice Queue UI

- **ETA Egypt OAuth2 & v1.2 Submission Client ([eta-client.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/eta-client.ts), [einvoicing.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/einvoicing.service.ts)):**
  - Implemented `acquireEtaAccessToken` (with token caching and 401 eviction), `submitEtaReceiptsBatch`, `getEtaSubmissionStatus`, deterministic exponential backoff (`calculateEtaNextRetryAt`), and `processEtaSubmissionQueue` (safely skipping without network errors when ETA credentials are unconfigured).
- **Admin E-Invoice Queue Endpoints & UI ([einvoicing.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/routes/einvoicing.ts), [EInvoiceQueue.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/admin/EInvoiceQueue.tsx)):**
  - Added `GET /api/einvoicing/submissions`, `GET /api/einvoicing/submissions/summary`, `GET /api/einvoicing/submissions/:id`, `POST /api/einvoicing/submissions/:id/retry`, and `POST /api/einvoicing/process-queue` (mirrored under `/api/admin/einvoicing/*`).
  - Built `/admin/einvoicing` (`EInvoiceQueue.tsx`) with 5 KPI summary cards, unconfigured ETA warning banner, status & receipt-type (`'S'` / `'R'`) badges, canonical JSON payload inspection dialog, per-row retry, and queue processing action.

---

## 6. M6 — Remaining Back-Office Offset Pagination & Node 22 Load/Concurrency Benchmark

- **Server-Side Offset Pagination & Search Across 6 Back-Office Endpoints & Pages:**
  - Updated `GET /api/products`, `GET /api/customers`, `GET /api/vendors`, `GET /api/sales-orders`, `GET /api/purchase-orders`, and `GET /api/vendor-bills` to support `{ page, pageSize, q/search }` with SQL `ILIKE` filtering and `{ items, <legacyKey>, pageInfo }` backward-compatible responses.
  - Wired `<TablePagination />` and server-side search queries in [Products.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/Products.tsx), [Customers.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/sales/Customers.tsx), [Vendors.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/purchases/Vendors.tsx), [SalesOrders.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/sales/SalesOrders.tsx), [PurchaseOrders.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/purchases/PurchaseOrders.tsx), and [VendorBills.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/pages/purchases/VendorBills.tsx).
- **Load & 20-Way POS Stock-Lock Concurrency Benchmark ([scripts/load-test.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/load-test.mjs)):**
  - Benchmark A exercises 60 concurrent read requests across `/api/health/live`, `/api/pos/catalog`, `/api/products`, and `/api/sales-orders` (`0` 5xx errors).
  - Benchmark B fires 20 simultaneous `POST /api/pos/checkout` requests for a SKU with `5` units in stock, proving row-level `FOR UPDATE` stock locking allows exactly `5` checkouts (`201`), rejects `15` (`400 INSUFFICIENT_STOCK`), leaves `qty_on_hand === 0`, and keeps the General Ledger Trial Balance balanced (`487.50 === 487.50`).

---

## 7. Final Verification Gate Results (Directly Observed)

- **`npm run typecheck`**: **Passed** (`0` errors across `@erp/shared`, `backend`, `frontend`)
- **`npm run lint`**: **Passed** (`0` errors, `0` warnings across all 3 workspaces)
- **`npm run build`**: **Passed**
  - `backend/dist/migrate.mjs` (`7.2 kB`) and `backend/dist/server.mjs` (`659.7 kB`)
  - `frontend/dist/index.html` contains **zero** `<link rel="modulepreload">` tags for lazy chunks (`xlsx`, `jspdf`, `qrcode`, `zxing`, `ar`, `sentry`, `html2canvas`, `recharts`)
  - Key lazy chunks: `PosRegister` (`64.00 kB` / `18.16 kB` gzip), `EInvoiceQueue` (`12.81 kB` / `3.93 kB` gzip), `Products` (`33.26 kB` / `9.74 kB` gzip), `ar` locale (`44.62 kB` / `17.78 kB` gzip); Workbox SW precache `128 entries`
- **`npm test`**: **69/69 tests passed across 24 test files (100%)**
  - `@erp/shared`: **8 passed** (1 file)
  - `backend`: **45 passed** (12 files — unit + real PostgreSQL integration including POS returns, manager overrides, ETA client, CSRF/metrics/Sentry, and advisory-locked housekeeping)
  - `frontend`: **16 passed** (11 files — `jsdom` + RTL + `fake-indexeddb`)
- **`npm run test:load` (`node scripts/load-test.mjs`)**: **Passed**
  - **Benchmark A (60 requests)**: `0` 5xx errors; overall `p50 = 671.27 ms`, `p95 = 999.23 ms`, `p99 = 1196.81 ms`
  - **Benchmark B (20-way concurrent POS checkout on stock=5)**: `succeeded201 = 5`, `rejectedInsufficient4xx = 15`, `errors5xx = 0`, `finalQtyOnHand = 0`, `p50 = 21795.37 ms`, `p95 = 30116.52 ms`, `p99 = 31042.01 ms`, Trial Balance `isBalanced = true` (`totalDebit = 487.5`, `totalCredit = 487.5`)
- **`npm run test:e2e`**: **8/8 Playwright E2E spec files (11/11 tests) passed**
  1. `e2e/backoffice-pagination.spec.ts`
  2. `e2e/einvoice-queue.spec.ts`
  3. `e2e/erp-e2e.spec.ts`
  4. `e2e/pagination-lazy-bundles.spec.ts`
  5. `e2e/pos-offline-sync.spec.ts`
  6. `e2e/pos-register.spec.ts`
  7. `e2e/pos-returns-override.spec.ts`
  8. `e2e/security-observability.spec.ts`
