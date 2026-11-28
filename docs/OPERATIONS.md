# Production Operations Guide — Count It, Keep It ERP

This document is the single consolidated operations reference for running **Count It, Keep It** in a single-company production deployment. Detailed procedures and deep-dive checklists are linked in the companion runbooks below:

- [PRODUCTION_DEPLOYMENT_RUNBOOK.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md) — VPS provisioning, Docker Compose + Caddy HTTPS deployment, and CI/CD.
- [BACKUP_RESTORE_AND_ROLLBACK.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/BACKUP_RESTORE_AND_ROLLBACK.md) — Step-by-step `pg_dump`/`pg_restore`, `erp_uploads` archive recovery, and rollback runbook.
- [SETUP_AND_OPERATIONS_GUIDE.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/SETUP_AND_OPERATIONS_GUIDE.md) — Local development, test runners, and module walkthroughs.
- [ACCOUNTANT_REVIEW.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/ACCOUNTANT_REVIEW.md) — General Ledger auto-posting rules, subledger-to-GL reconciliation, COA mapping health, and fiscal year close/reopen.
- [GO_LIVE.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/GO_LIVE.md) — Go-live cutover plan, CSV import order, re-import semantics, and rollback runbook.
- [UAT_SCRIPT.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/UAT_SCRIPT.md) — Step-by-step full-day user acceptance testing script in EGP for pre-go-live rehearsal.
- [INCIDENT_RUNBOOK.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/INCIDENT_RUNBOOK.md) — Production outage, DB corruption, key leak, bad migration, and disaster-recovery restore playbooks.
- [ETA_GO_LIVE.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/ETA_GO_LIVE.md) — ETA Egypt CAdES-BES signer bridge HTTP contract, local mock signer, `eta:preprod-smoke`, retry backoff, and preprod-to-live checklist.

---

## 1. Health & Readiness Endpoints

| Endpoint | Purpose | Checks Performed | Expected Response | Used By |
| :--- | :--- | :--- | :--- | :--- |
| `GET /health` (alias `/api/health/live`) | Liveness probe | Process event loop is responsive (`uptimeSeconds`) | `200 OK` `{ "ok": true, "status": "ok" }` | Load balancers, uptime monitors |
| `GET /ready` (aliases `/api/health/ready`, `/api/health`) | Readiness probe | PostgreSQL `SELECT 1` **and** attachment storage reachability (`STORAGE_LOCAL_DIR` read/write or S3 `HeadBucket`) | `200 OK` when both DB and storage pass; `503 Service Unavailable` when either fails | `backend/Dockerfile`, `docker-compose.yml`, `docker-compose.prod.yml` healthchecks |
| `GET /api/metrics` | Prometheus metrics | Requires `Authorization: Bearer <METRICS_TOKEN>` (`404` when unset, `401` on mismatch) | Prometheus text format | Prometheus / Grafana |
| `GET /api/audit-logs/verify` | Tamper-evidence check | Admin-only; verifies SHA-256 hash chain across `audit_logs` | `200 OK` `{ "valid": true, ... }` | Security audits & post-restore drills |
| `GET /api/accounting/setup-health` | GL mapping health | Admin-only; verifies all 28 `DEFAULT_COA` control mappings exist, are active, and have valid `account_type` | `200 OK` `{ "healthy": true, "issues": [] }` | Post-upgrade / onboarding checks |
| `GET /api/accounting/reports/reconciliation` | Subledger-to-GL reconciliation | Admin-only; checks AR, AP, Inventory, Output VAT, Input VAT, Fixed Assets, and Treasury vs GL | `200 OK` `{ "allReconciled": true, ... }` | Period-end close & CI (`npm run demo:ledger`) |
| `GET /api/imports/cutover-readiness` | Cutover readiness gate | Admin-only, read-only; verifies all 8 reconciliation controls, accounting setup health, and audit-log hash chain | `200 OK` `{ "ready": true, "status": "PASS", ... }` | Go-live cutover checklist & `/admin/imports` |
| `GET /api/admin/backups/freshness` | Backup freshness check | Admin-only; reports age of last successful backup from `BACKUP_STATUS_FILE` (or off-site S3 `latest.json`), flagging stale when `> BACKUP_MAX_AGE_HOURS` (default `26h`); pass `?strict=true` for HTTP `503` when stale/missing | `200 OK` `{ "ok": true, "status": "fresh", "ageHours": ... }` | Monitoring, alerting & `/api/metrics` gauges |

All HTTP requests receive a sanitized `x-request-id` correlation header echoed in responses and Pino JSON logs. Sensitive fields (`password`, `token`, `pin`, `mfaEncryptionKey`, `smtpPass`, `s3SecretAccessKey`, connection strings) are scrubbed automatically ([logger.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/logging/logger.ts)).

---

## 2. Scheduled Backups, Off-Site Encryption, Freshness Alerting & Monthly Restore Drills

1. **Automated Daily Backups + Off-Site Encrypted S3 Sync ([backup-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/backup-db.sh), [backup-offsite.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/backup-offsite.mjs)):**
   - Dumps PostgreSQL in custom format (`pg_dump -Fc`) with SHA-256 checksums, archives `erp_uploads` (`/app/uploads` or `STORAGE_LOCAL_DIR`) into a checksummed `.tar.gz`, applies local retention (`BACKUP_RETENTION_DAYS` / `BACKUP_MIN_KEEP`), and writes `last-backup-status.json`.
   - When `BACKUP_S3_BUCKET` is set (Cloudflare R2, MinIO, or AWS S3), encrypts both artifacts client-side with authenticated **AES-256-GCM** using your customer-held `BACKUP_ENCRYPTION_KEY`, uploads `.enc` objects + signed manifests (`manifests/backup_<ts>.json` and `latest.json`), and enforces off-site retention (`BACKUP_OFFSITE_RETENTION_DAYS` / `BACKUP_OFFSITE_MIN_KEEP`).
   - Schedule via host systemd timer ([count-it-keep-it-backup.timer](file:///c:/Users/mohamed/Desktop/count-it-keep-it/deploy/systemd/count-it-keep-it-backup.timer) installed by `scripts/vps-setup.sh`), cron, or the containerized `--profile backup` Compose service in `docker-compose.prod.yml`.
   - Always use `DIRECT_DATABASE_URL` (non-pooler) when backing up managed Neon/PgBouncer instances.
2. **Backup Freshness Check & 26-Hour Alerting:**
   - **Admin API:** `GET /api/admin/backups/freshness` (add `?strict=true` to return HTTP `503` whenever age exceeds `BACKUP_MAX_AGE_HOURS`, default `26`).
   - **Prometheus Alertmanager Rule** (scraped from `/api/metrics`):
     ```yaml
     groups:
       - name: erp-backups
         rules:
           - alert: ErpBackupStaleOrMissing
             expr: erp_backup_freshness_ok == 0 or erp_backup_age_seconds > 93600
             for: 10m
             labels:
               severity: critical
             annotations:
               summary: "ERP backup is missing or older than 26 hours"
               description: "Last successful backup age is {{ $value }}s (threshold 93600s / 26h). Inspect count-it-keep-it-backup.timer and /var/log/erp-backup.log."
     ```
3. **Restore & Verification ([restore-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/restore-db.sh)):**
   - Validates `.sha256` checksums (and transparently decrypts `.enc` files when `BACKUP_ENCRYPTION_KEY` is set) before restoring into a target database and uploads directory.
4. **Monthly Off-Site Restore Drill (`npm run drill:restore` / [monthly-restore-drill.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/monthly-restore-drill.mjs)):**
   - Downloads the latest encrypted off-site backup from S3/R2/MinIO (or `--local-dir <dir>`), decrypts with `BACKUP_ENCRYPTION_KEY`, verifies SHA-256 checksums, restores into an ephemeral scratch PostgreSQL 18 container, runs Drizzle migrations, and verifies **all 8 reconciliation controls**, **accounting setup health (28/28)**, and the **audit-log SHA-256 hash chain**.
   - Scheduled monthly via [count-it-keep-it-restore-drill.timer](file:///c:/Users/mohamed/Desktop/count-it-keep-it/deploy/systemd/count-it-keep-it-restore-drill.timer) or run manually: `npm run drill:restore`.
5. **CI Backup/Restore Upgrade Gate (`npm run test:restore` / [test-backup-restore.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/test-backup-restore.mjs)):**
   - Runs automatically in CI on every push/PR against Postgres 18.

---

## 3. MFA Encryption Key Rotation

TOTP secrets in `user_mfa` are encrypted with AES-256-GCM and tagged with `key_version` ([mfa.service.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/services/mfa.service.ts), [rotate-mfa-key.mjs](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/rotate-mfa-key.mjs)).

1. Generate a new 32-byte key: `openssl rand -hex 32`.
2. Update `.env`:
   - Move the current key into `MFA_ENCRYPTION_PREVIOUS_KEYS="1:<old-64-hex>"` (or JSON `{"1":"<old-64-hex>"}`).
   - Set `MFA_ENCRYPTION_KEY="<new-64-hex>"` and increment `MFA_ENCRYPTION_KEY_VERSION=2`.
3. Restart the backend so existing v1 users continue logging in seamlessly while new enrollments use v2.
4. Dry-run and then execute rotation:
   ```bash
   npm run mfa:rotate-key -- --dry-run
   npm run mfa:rotate-key
   ```
5. Confirm all `user_mfa` rows have `key_version = 2`, remove the retired key from `MFA_ENCRYPTION_PREVIOUS_KEYS`, and restart.

---

## 4. Upgrades & Rollback

1. **Pre-Upgrade:**
   - `scripts/deploy.sh` takes a pre-deploy backup automatically when `PRE_DEPLOY_BACKUP=true`.
   - Never edit already-applied SQL migrations (`backend/drizzle/migrations/0000`–`0012`). All schema changes are forward-only.
2. **Deploy & Migrate:**
   - With `RUN_MIGRATIONS=true`, the backend container runs `node dist/migrate.mjs` under a dedicated-connection PostgreSQL advisory lock (`MIGRATION_ADVISORY_LOCK_KEY = 749207`) before binding HTTP.
   - Verify `GET /health`, `GET /ready`, `GET /api/accounting/setup-health`, and `GET /api/audit-logs/verify`.
3. **Rollback:**
   - **App-only rollback (no destructive DDL):** Pin `BACKEND_IMAGE` and `FRONTEND_IMAGE` to the prior release tag and re-run `docker compose -f docker-compose.prod.yml up -d`.
   - **Schema + data rollback:** Stop app containers, restore the pre-deploy `pg_dump` and `erp_uploads` archive via [restore-db.sh](file:///c:/Users/mohamed/Desktop/count-it-keep-it/scripts/restore-db.sh), re-pin the prior image tags, and restart. Full checklist in [BACKUP_RESTORE_AND_ROLLBACK.md](file:///c:/Users/mohamed/Desktop/count-it-keep-it/docs/BACKUP_RESTORE_AND_ROLLBACK.md).

---

## 5. Sentry Error Reporting

- **Backend ([backend/src/observability/sentry.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/backend/src/observability/sentry.ts)):** Disabled (zero network traffic) unless `SENTRY_DSN` is set. Automatically scrubs `authorization`/`cookie` headers, URL query parameters, connection strings, passwords, PINs, MFA keys, recovery codes, and SMTP/S3/ETA secrets via `scrubSentryEvent()` and `scrubSentryBreadcrumb()`.
- **Frontend ([frontend/src/lib/observability/sentry.ts](file:///c:/Users/mohamed/Desktop/count-it-keep-it/frontend/src/lib/observability/sentry.ts)):** Disabled unless `VITE_SENTRY_DSN` is set at build time; dynamically loaded so it adds zero bytes to the initial bundle.

---

## 6. Complete Environment Variables Reference

### Core Runtime, Database & Proxy

| Variable | Default | Required (Prod) | Purpose |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `development` | Yes (`production`) | Runtime mode; enforces strict cookie/MFA/secret checks in production |
| `HOST` | `127.0.0.1` | No (`0.0.0.0` in Docker) | HTTP bind address |
| `PORT` | `3001` | No | Backend HTTP listen port |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | No | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `DATABASE_URL` | `""` | **Yes** | PostgreSQL connection URL (pooled or direct) |
| `DIRECT_DATABASE_URL` | `""` | Recommended | Direct (non-pooler) PostgreSQL URL for `pg_dump`/`pg_restore` |
| `RUN_MIGRATIONS` | `false` (`true` in prod compose) | Recommended | Run Drizzle migrations on container boot before starting API |
| `TRUST_PROXY` | `false` (`true` behind Caddy/Nginx) | Yes behind proxy | Trust `X-Forwarded-For` / `X-Forwarded-Proto` headers |
| `CORS_ORIGIN` | `http://localhost:8080` | **Yes** | Comma-separated exact origin allow-list (`*` is rejected) |
| `APP_BASE_URL` | First `CORS_ORIGIN` | Recommended | Public base URL used in password-reset links and emails |
| `SITE_ADDRESS` | `erp.example.com` | Yes (Caddy) | Public HTTPS hostname for Caddy automatic TLS |
| `BACKEND_IMAGE` / `FRONTEND_IMAGE` | GHCR `:latest` | Yes (prod compose) | Pinned Docker image tags for production deploys |

### Authentication, Sessions, Rate Limits & MFA

| Variable | Default | Required (Prod) | Purpose |
| :--- | :--- | :--- | :--- |
| `AUTH_COOKIE_SECRET` | dev placeholder | **Yes** (`>= 32` chars) | Cryptographic secret for cookie signing (`:?` enforced in compose) |
| `SESSION_COOKIE_NAME` | `erp_session` | No | HTTP-only session cookie name |
| `SESSION_TTL_DAYS` | `30` | No | Session sliding expiration in days |
| `COOKIE_SECURE` | `auto` | No | `true`, `false`, or `auto` (sets `Secure` in prod over HTTPS) |
| `MFA_ENCRYPTION_KEY` | dev HKDF fallback | **Yes** (64-hex or 32-byte base64) | Active AES-256-GCM key for TOTP secrets (`:?` enforced in compose) |
| `MFA_ENCRYPTION_KEY_VERSION` | `1` | No | Integer version tag for newly encrypted/rotated MFA secrets |
| `MFA_ENCRYPTION_PREVIOUS_KEYS` | `""` | During rotation | Retired keys (`"1:<hex>,2:<hex>"` or JSON) for zero-downtime decryption |
| `DISABLE_RATE_LIMIT` | `false` | Never `true` in prod | Disables Fastify rate limits (test-only escape hatch) |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `20` / `60000` | No | Login & signup rate limit |
| `AUTH_MFA_RATE_LIMIT_MAX` / `AUTH_MFA_RATE_LIMIT_WINDOW_MS` | `10` / `60000` | No | MFA verify, enroll, disable & recovery-codes rate limit |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_MAX` / `AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS` | `10` / `900000` | No | Forgot-password & reset-password rate limit |
| `AUTH_LOCKOUT_MAX_ATTEMPTS` | `5` | No | Failed attempts before DB-backed temporary lockout (`429 ACCOUNT_LOCKED`) |
| `AUTH_LOCKOUT_WINDOW_MS` | `900000` | No | Sliding failure counting window (15 min) |
| `AUTH_LOCKOUT_DURATION_MS` | `900000` | No | Temporary lockout duration (15 min) |

### Storage, Attachments & Virus Scanning

| Variable | Default | Required (Prod) | Purpose |
| :--- | :--- | :--- | :--- |
| `STORAGE_DRIVER` | `local` | No | Attachment backend: `local` or `s3` |
| `STORAGE_LOCAL_DIR` | `/app/uploads` (prod) / `backend/uploads` (dev) | No | Local filesystem root for randomized attachment keys |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | `""` / `us-east-1` / `""` | If `STORAGE_DRIVER=s3` | S3-compatible bucket & endpoint settings |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` | `""` / `""` / `false` | If `STORAGE_DRIVER=s3` | S3 credentials and path-style toggle (MinIO/R2) |
| `ATTACHMENT_VIRUS_SCAN_ENABLED` | `false` | No | Enables ClamAV `zINSTREAM` scanning on uploads |
| `ATTACHMENT_VIRUS_SCAN_CLAMAV_HOST` / `PORT` / `TIMEOUT_MS` / `FAIL_CLOSED` | `127.0.0.1` / `3310` / `10000` / `true` | If scan enabled | ClamAV daemon connection and fail-closed policy (`503` if unreachable) |
| `CSV_IMPORT_MAX_ROWS` | `10000` | No | Maximum data rows accepted per CSV import file (`400 CSV_ROW_LIMIT_EXCEEDED` above limit) |
| `CSV_IMPORT_MAX_BYTES` | `5242880` (5 MiB) | No | Maximum UTF-8 byte size accepted per CSV import payload (`413 CSV_TOO_LARGE` above limit) |

### Observability, Email, ETA Egypt & Backups

| Variable | Default | Required (Prod) | Purpose |
| :--- | :--- | :--- | :--- |
| `METRICS_TOKEN` | `""` | Recommended | Bearer token protecting `/api/metrics` (`404` when unset) |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` | `""` / `NODE_ENV` / `0` | No | Backend Sentry DSN, environment tag, and trace sampling rate (`0..1`) |
| `VITE_API_BASE_URL` / `VITE_SENTRY_DSN` / `VITE_SENTRY_ENVIRONMENT` | `""` / `""` / `production` | No | Frontend build-time API origin override and Sentry config |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | `""` / `587` / `false` / `""` / `""` / no-reply | If emailing docs | Outbound SMTP for document emailing and password resets |
| `ETA_CLIENT_ID` / `ETA_CLIENT_SECRET` | `""` | If ETA live | Egyptian Tax Authority OAuth2 client credentials |
| `ETA_ID_BASE_URL` / `ETA_TOKEN_URL` / `ETA_API_BASE_URL` | ETA Preprod URLs | If ETA live | ETA Identity & Invoicing API endpoints (switch to prod URLs for live) |
| `ETA_INVOICE_VERSION` | `1.0` | No | B2B e-Invoice schema version (`1.0` signed or `0.9` unsigned preprod) |
| `ETA_SIGNER_URL` / `ETA_SIGNER_TOKEN` / `ETA_SIGNER_TIMEOUT_MS` | `""` / `""` / `10000` | If `ETA_INVOICE_VERSION=1.0` | Local CAdES-BES USB token signer bridge URL & auth token |
| `PRE_DEPLOY_BACKUP` / `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` / `BACKUP_MIN_KEEP` | `true` / `/var/backups/count-it-keep-it` / `14` / `5` | Recommended | Used by `scripts/deploy.sh` and `scripts/backup-db.sh` |
| `BACKUP_STATUS_FILE` / `BACKUP_MAX_AGE_HOURS` | `/var/backups/count-it-keep-it/last-backup-status.json` / `26` | Recommended | Freshness status JSON file and stale threshold (hours) checked by `/api/admin/backups/freshness` & `/api/metrics` |
| `BACKUP_S3_BUCKET` / `ENDPOINT` / `REGION` / `PREFIX` / `FORCE_PATH_STYLE` | `""` / `""` / `auto` / `backups/count-it-keep-it` / `false` | Recommended (off-site) | S3-compatible off-site backup target (Cloudflare R2, MinIO, AWS S3) |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | `""` | If `BACKUP_S3_BUCKET` set | Off-site backup bucket credentials |
| `BACKUP_ENCRYPTION_KEY` | `""` | **Yes** if off-site | Customer-held 32-byte key (64 hex or base64) for client-side AES-256-GCM encryption of off-site backups |
| `BACKUP_OFFSITE_RETENTION_DAYS` / `BACKUP_OFFSITE_MIN_KEEP` / `BACKUP_OFFSITE_REQUIRED` | `30` / `7` / `false` | No | Off-site S3 retention policy and strict off-site requirement toggle |
| `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` | `""` | Optional | Admin credentials used by `scripts/smoke-test.mjs` and post-deploy smoke verification in `scripts/deploy.sh` |
| `TEST_DATABASE_URL` / `USE_REMOTE_TEST_DB` / `TEST_PG_PORT` / `RESTORE_TEST_ADMIN_URL` | Local Docker PG 18 (`5439`) | Test/CI only | Test runner DB overrides (`scripts/run-with-local-test-db.mjs`, `test-backup-restore.mjs`) |
