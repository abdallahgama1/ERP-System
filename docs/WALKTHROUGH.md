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

- **Compiled Production Backend ([backend/scripts/build.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/scripts/build.mjs), [backend/src/db/migrate.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/db/migrate.ts)):**
  - Bundled `backend/dist/server.mjs` (`659.7 kB`) and `backend/dist/migrate.mjs` (`7.2 kB`) targeting Node 22 ESM with external native/driver packages, eliminating `tsx` from production runtime (`"start": "node dist/server.mjs"`, `"migrate:prod": "node dist/migrate.mjs"`).
- **Multi-Stage Docker, Compose & Reverse Proxies ([backend/Dockerfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/Dockerfile), [frontend/Dockerfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/Dockerfile), [docker-compose.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docker-compose.yml), [docker-compose.prod.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docker-compose.prod.yml), [Caddyfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/Caddyfile), [frontend/nginx.conf](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/nginx.conf)):**
  - Built multi-stage images for non-root `node:22-alpine` backend runtime (with `backend/dist/migrate.mjs` boot migration) and hardened `nginx:1.27-alpine` frontend runtime, plus Caddy v2 automatic HTTPS (`Caddyfile`).
  - Configured `frontend/nginx.conf` and `Caddyfile` with immutable `/assets/*` caching, `no-cache` headers for `/sw.js`, `/registerSW.js`, `/manifest.webmanifest`, and `/index.html`, SSE `proxy_buffering off` + `flush_interval -1` for `/api/events`, and HSTS + strict CSP security headers.
- **Database Backup/Restore Runbooks, VPS Automation & CI/CD ([backup-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/backup-db.sh), [restore-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/restore-db.sh), [vps-setup.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/vps-setup.sh), [deploy.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/deploy.sh), [PRODUCTION_DEPLOYMENT_RUNBOOK.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md), [ci.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/.github/workflows/ci.yml), [cd.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/.github/workflows/cd.yml)):**
  - Added SHA-256 checksummed `pg_dump -Fc` backup and `pg_restore` scripts, idempotent Ubuntu/Debian VPS bootstrap, safe rollback-capable `deploy.sh`, and `.env.prod.example`.
  - Hardened `.github/workflows/ci.yml` with `npm audit --omit=dev` and Docker Buildx + Trivy scans, and added `.github/workflows/cd.yml` for tag/manual GHCR publishing and VPS SSH deployment.

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

- **ETA Egypt OAuth2 & v1.2 Submission Client ([eta-client.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/eta-client.service.ts), [einvoicing.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/einvoicing.service.ts)):**
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

---

## 8. Wave 1 — Enterprise Foundation (M1–M7)

Wave 1 upgrades Count It, Keep It into a multi-company, RBAC-hardened, MFA-secured enterprise ERP platform with lazy data fetching, pluggable attachments, global search, saved views, server-side CSV/XLSX exports, print templates, and document emailing.

### 8.1 M1–M6 Deliverables Summary

- **M1 — Schema, Migration (`0007`) & Shared Contracts ([0007_enterprise_foundation.sql](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/drizzle/migrations/0007_enterprise_foundation.sql), [schema.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/drizzle/schema.ts), [enterprise.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/packages/shared/src/enterprise.ts), [permissions.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/packages/shared/src/permissions.ts)):**
  - Added `companies`, `user_companies`, `custom_roles`, `custom_role_permissions`, `attachments`, `saved_views`, and `print_templates` tables plus `company_id` multi-tenant foreign keys across operational, accounting, POS, and audit tables (preserving migrations `0000`–`0006` untouched).
  - Extended `user_sessions` with `active_company_id`, `user_agent`, `ip_address`, `last_activity_at`; extended `audit_logs` with `before_json`, `after_json`, and `changed_fields`; added TOTP MFA fields (`mfa_enabled`, `mfa_secret_encrypted`, `mfa_recovery_codes_hash`, `mfa_enrolled_at`).
  - Exported shared Zod contracts, 18 permission modules, 8 system role presets, attachment MIME/size validation helpers, and export/search/saved-view/print-template schemas in `@erp/shared`.
- **M2 — Multi-Company Auth, Custom Roles RBAC, RFC 6238 TOTP 2FA, Active Sessions & Audit Diffs ([companies.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/companies.service.ts), [custom-roles.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/custom-roles.service.ts), [mfa.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/mfa.service.ts), [sessions.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/sessions.service.ts), [broadcaster.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/events/broadcaster.ts)):**
  - Implemented company CRUD with automatic per-company seeding (default HQ branch, 8 system role presets, document sequences, company settings, default tax/UoM) and atomic company switching (`POST /api/auth/switch-company`) with global `companies_updated` / `users_updated` SSE broadcasting so connected sessions update their Company Switcher immediately.
  - Implemented dynamic custom roles CRUD, permission matrix resolution (`requirePermission`), AES-256-GCM encrypted RFC 6238 TOTP enrollment/challenge/recovery-code flows, multi-device session listing/revocation, and secret-scrubbed before/after audit diffs.
- **M3 — Full Domain Tenancy, Pluggable Storage/Attachments, Search, Streaming Exports, Saved Views, Print Templates & Document Emailing ([storage.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/storage.service.ts), [attachments.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/attachments.service.ts), [search.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/search.service.ts), [exports.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/exports.service.ts), [saved-views.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/saved-views.service.ts), [print-templates.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/print-templates.service.ts), [email.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/email.service.ts)):**
  - Enforced `activeCompanyId` scoping across inventory, sales, purchasing, accounting, manufacturing, POS, notifications, and audit services.
  - Added pluggable local filesystem + S3-compatible object storage with magic-byte MIME validation and SHA-256 checksums, RBAC-filtered global search (`GET /api/search`), CSV/XLSX streaming exports (`GET /api/exports/:resource`), per-table saved views, print templates, and SMTP document emailing with attachment support.
  - Updated [backend/Dockerfile](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/Dockerfile), [docker-compose.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docker-compose.yml), and [docker-compose.prod.yml](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docker-compose.prod.yml) with the `erp_uploads:/app/uploads` volume and `MFA_ENCRYPTION_KEY` configuration.
- **M4–M6 — Lazy TanStack Query Architecture, Full UI RBAC & Enterprise Components ([App.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/App.tsx), [CompanySwitcher.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/layout/CompanySwitcher.tsx), [CommandPalette.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/CommandPalette.tsx), [EnterpriseDataTable.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/EnterpriseDataTable.tsx), [AttachmentsPanel.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/AttachmentsPanel.tsx), [EmailDocumentDialog.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/EmailDocumentDialog.tsx), [RequirePermission.tsx](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/components/auth/RequirePermission.tsx)):**
  - Retired all 7 eager-fetching legacy React contexts (`AuditLogContext`, `InventoryContext`, `NotificationsContext`, `PurchasesContext`, `SalesContext`, `SessionsContext`, `TaxonomyContext`), reducing initial authenticated login/reload footprint to `<= 5` API GETs with zero heavy chunks preloaded.
  - Enforced `<RequirePermission>` route guards, sidebar navigation filtering, and per-page action button gating across all application modules, plus Command Palette (`Ctrl+K`), `EnterpriseDataTable` (column visibility, saved views, bulk selection, CSV/XLSX export), MFA/Session management UI in Profile/Login, Company/Print Template management in Settings, and before/after Audit Diff viewer.

### 8.2 Wave 1 Verification Gate Results (Directly Observed — M7)

- **`npm run typecheck`**: **Passed** (`0` errors across `@erp/shared`, `backend`, `frontend`)
- **`npm run lint`**: **Passed** (`0` errors, `0` warnings across all 3 workspaces)
- **`npm run build`**: **Passed**
  - `backend/dist/migrate.mjs` (`8.5 kB`) and `backend/dist/server.mjs` (`943.2 kB`)
  - `frontend/dist/index.html` contains **zero** `<link rel="modulepreload">` tags matching `/xlsx|jspdf|html2canvas|zxing|@sentry/i` (only `vendor-react` and `vendor-query` preloaded)
  - Key lazy chunks: `PosRegister` (`63.89 kB` / `18.13 kB` gzip), `Settings` (`45.09 kB` / `11.81 kB` gzip), `Products` (`35.10 kB` / `10.51 kB` gzip), `AttachmentsPanel` (`19.66 kB` / `6.60 kB` gzip), `EInvoiceQueue` (`12.70 kB` / `3.89 kB` gzip), `ar` locale (`47.88 kB` / `19.19 kB` gzip); Workbox SW precache `142 entries` (`4295.90 KiB`)
- **`npm test`**: **95/95 tests passed across 31 test files (100%)**
  - `@erp/shared`: **10 passed** (1 file: `shared-contracts.test.ts`)
  - `backend`: **59 passed** (16 files — 7 real PostgreSQL integration suites including `multi-company-rbac.test.ts` and `attachments-search.test.ts`, plus 9 unit suites including `mfa-totp.test.ts` and `config-mfa.test.ts`)
  - `frontend`: **26 passed** (14 files — including `command-palette-rbac.test.tsx`, `enterprise-components.test.tsx`, and `shell-company-auth.test.tsx`)
- **`npm run test:e2e`**: **9/9 Playwright E2E spec files — 49/49 tests passed (100%, 24.0m)**
  1. `e2e/backoffice-pagination.spec.ts` (1/1 passed)
  2. `e2e/einvoice-queue.spec.ts` (1/1 passed)
  3. `e2e/enterprise-foundation.spec.ts` (38/38 passed — Tier 1 happy paths, Tier 2 boundary/security/IDOR/injection, Tier 3 cross-feature pairwise, Tier 4 real-world enterprise workflows)
  4. `e2e/erp-e2e.spec.ts` (1/1 passed)
  5. `e2e/pagination-lazy-bundles.spec.ts` (1/1 passed)
  6. `e2e/pos-offline-sync.spec.ts` (1/1 passed)
  7. `e2e/pos-register.spec.ts` (1/1 passed)
  8. `e2e/pos-returns-override.spec.ts` (1/1 passed)
  9. `e2e/security-observability.spec.ts` (4/4 passed)
- **`npm run test:load` (`node scripts/load-test.mjs`)**: **Passed**
  - **Benchmark A (60 concurrent reads)**: `errors5xx = 0`; overall `p50 = 1422.67 ms`, `p95 = 2172.78 ms`, `p99 = 2173.63 ms`, `avg = 1569.49 ms`
  - **Benchmark B (20-way concurrent POS checkout on stock=5)**: `succeeded201 = 5`, `rejectedInsufficient4xx = 15`, `errors5xx = 0`, `finalQtyOnHand = 0`, `p50 = 27639.70 ms`, `p95 = 36950.19 ms`, `p99 = 37978.53 ms`, Trial Balance `isBalanced = true` (`totalDebit = 487.5`, `totalCredit = 487.5`)
- **Docker & Compose Validation**:
  - `docker compose -f docker-compose.yml config --quiet` -> **Passed (`exit 0`)** (verified `erp_uploads:/app/uploads` volume and `MFA_ENCRYPTION_KEY`)
  - `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config --quiet` -> **Passed (`exit 0`)** (verified `erp_uploads:/app/uploads` volume and required `MFA_ENCRYPTION_KEY`)
  - Local `docker build` could not run on this workstation because the Docker Desktop Linux engine (`docker-desktop` WSL2 distro) was stopped (`//./pipe/dockerDesktopLinuxEngine` unavailable); multi-stage Dockerfiles (`backend/Dockerfile` and `frontend/Dockerfile`) compile via the exact same `npm run build` pipeline verified above.
