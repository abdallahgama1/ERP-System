# Production Deployment Runbook — Count It Keep It ERP

This runbook covers production provisioning, deployment, backup/restore, rollback, and observability for **Count It Keep It ERP** on a single VPS (Docker Compose + Caddy automatic HTTPS) backed by Managed PostgreSQL (Neon or AWS RDS with Point-In-Time Recovery).

> **Looking for the all-in-one handbook?** See **[docs/SETUP_AND_OPERATIONS_GUIDE.md](./SETUP_AND_OPERATIONS_GUIDE.md)** for **Local Development Setup** (native + Docker Compose), **Production VPS Setup**, **Container Control Commands**, **Background Workers**, and **Troubleshooting** in one document. For **pg_dump + `erp_uploads` volume backups, automated restore testing, and Migration 0007 rollback**, see **[docs/BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md)**.

---

## 1. Architecture Overview

```
Internet (HTTPS :443 / HTTP :80)
        │
        ▼
  ┌───────────┐
  │   Caddy   │  Automatic Let's Encrypt TLS, security baseline, HTTP→HTTPS redirect
  └─────┬─────┘
        ├──── /api/* (including SSE /api/events, flush_interval -1) ──► backend:3001 (Fastify + compiled ESM)
        └──── /* ─────────────────────────────────────────────────────► frontend:80 (Nginx SPA + strict CSP)
                                                                              │
                                                                      backend:3001 ──► Managed PostgreSQL (Neon / RDS)
```

- **No Redis required**: Background schedulers (overdue & lot-expiry sweep, DB housekeeping, ETA e-Receipt retry worker) coordinate via PostgreSQL advisory locks.
- **Compiled backend runtime**: `backend/Dockerfile` compiles `backend/src/index.ts` → `backend/dist/server.mjs` and `backend/src/db/migrate.ts` → `backend/dist/migrate.mjs` (`esbuild`), then installs production-only dependencies (`npm ci --omit=dev`) under non-root user `node`.
- **Deprecated legacy RBAC endpoints**: `GET /api/roles/permissions` (requires `roles.view`) and `PUT /api/roles/permissions` (admin-only) are **deprecated** (`Deprecation: true` header) and retained only for backward compatibility; use `/api/custom-roles` for role management.

---

## 2. Managed PostgreSQL Setup & PITR (Neon / AWS RDS)

### Option A: Neon Serverless Postgres
1. Create a production project in Neon (PostgreSQL 17 recommended).
2. Enable **Point-In-Time Recovery (PITR)** / Branch Restore history (7–30 days depending on plan).
3. Understand **Pooled (`-pooler.`) vs Direct** connection strings:
   - `backend/src/db/index.ts` automatically detects `-pooler.` in `DATABASE_URL` and sets `prepare: false` for PgBouncer transaction-pooling compatibility.
   - Use the **pooled** URL (with `?sslmode=require`) for long-running app traffic if using PgBouncer, OR use the **direct (non-pooler)** URL for `node backend/dist/migrate.mjs`, `pg_dump`, and `pg_restore` (`scripts/backup-db.sh` / `scripts/restore-db.sh`).
   - If running migrations on container boot (`RUN_MIGRATIONS=true`), a direct connection string is preferred so Drizzle's migration lock and DDL execute cleanly without pooler transaction limits.

### Option B: AWS RDS for PostgreSQL
1. Provision PostgreSQL 16/17 (Multi-AZ recommended for production).
2. Enforce SSL in parameter group (`rds.force_ssl=1`) and append `?sslmode=require` to `DATABASE_URL`.
3. Enable **Automated Backups** (retention 7–35 days) to activate AWS RDS PITR.
4. Restrict Security Group inbound `5432/tcp` strictly to the VPS static public/elastic IP.

---

## 3. VPS Docker Compose + Caddy Setup

### Prerequisites
- Ubuntu 22.04 / 24.04 LTS (or Debian 12) with Docker Engine & Docker Compose plugin (`docker compose version`).
- Firewall open on `80/tcp`, `443/tcp`, `443/udp` (and SSH `22/tcp`). Do **not** expose port `3001` or `5432` publicly.
- DNS `A` (and optional `AAAA`) record for `SITE_ADDRESS` (e.g., `erp.example.com`) pointing to the VPS IP.

### Option 1: One-Command Automated Bootstrap (`scripts/vps-setup.sh`)
On a fresh Ubuntu 22.04/24.04 or Debian 12 VPS (with root/`sudo` access):
```bash
curl -fsSLO https://raw.githubusercontent.com/abdallahgama1/ERP-System/main/scripts/vps-setup.sh
sudo bash vps-setup.sh --app-dir /opt/count-it-keep-it --user deploy
```
This idempotently installs Docker Engine + Compose v2, `postgresql-client`, UFW firewall (`22/tcp`, `80/tcp`, `443/tcp`, `443/udp`), clones the repository, copies `.env.prod.example` → `.env` (`chmod 600`), and installs the daily `02:00 UTC` backup cron job + logrotate rule.

### Initial Provisioning & Boot
1. Clone the repository on the VPS (e.g., `/opt/count-it-keep-it`) if you did not use `scripts/vps-setup.sh`.
2. Copy `.env.prod.example` to `.env` (`cp .env.prod.example .env && chmod 600 .env`, never commit to git) and populate required production values:
   ```bash
   SITE_ADDRESS=erp.example.com
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
   AUTH_COOKIE_SECRET=<output of: openssl rand -hex 32>
   CORS_ORIGIN=https://erp.example.com
   APP_BASE_URL=https://erp.example.com
   COOKIE_SECURE=auto
   METRICS_TOKEN=<output of: openssl rand -hex 24>
   ```
3. Build or pull images and deploy safely:
   ```bash
   # Build locally on VPS (first boot on empty DB can pass --skip-backup)
   bash ./scripts/deploy.sh --build --skip-backup
   # Or pull prebuilt GHCR images and deploy with pre-deploy pg_dump + health checks:
   bash ./scripts/deploy.sh
   ```
4. Verify container health and endpoints:
   ```bash
   docker compose -f docker-compose.prod.yml ps
   # Internal container healthchecks (used by Docker HEALTHCHECK):
   docker compose -f docker-compose.prod.yml exec backend wget -qO- http://127.0.0.1:3001/health
   docker compose -f docker-compose.prod.yml exec backend wget -qO- http://127.0.0.1:3001/ready
   # External HTTPS endpoints via Caddy:
   curl -fsS https://erp.example.com/api/health/live
   curl -fsS https://erp.example.com/api/health/ready
   ```
5. **First-user Admin Bootstrap**: Immediately after initial deployment, sign up the first administrator account at `https://erp.example.com/signup`. The backend serializes signup with `pg_advisory_xact_lock` so the very first registered user receives `admin` role + `'all'` branch scope automatically.

---

## 4. Production Environment Variables Reference

All variable names below match `backend/src/config.ts`, `backend/.env.example`, `.env.prod.example`, `docker-compose.yml`, `docker-compose.prod.yml`, and the ops scripts.

> **Important:** This application uses `AUTH_COOKIE_SECRET`, `CORS_ORIGIN`, and `APP_BASE_URL` — **not** `SESSION_SECRET` or `APP_ORIGIN`.

### Core Runtime, Database & HTTP Security

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `NODE_ENV` | **Yes** | `production` | Must be `production` in production deployments (enforces fail-fast secret checks, HSTS, and error sanitization). |
| `HOST` | No | `0.0.0.0` (`127.0.0.1` local) | Bind host inside the backend container. |
| `PORT` | No | `3001` | Backend HTTP listen port inside the container. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection URL (`?sslmode=require`). |
| `DIRECT_DATABASE_URL` | Optional | `""` | Direct (non-pooler) PostgreSQL URL used for `pg_dump`, `pg_restore`, and Neon migrations. |
| `RUN_MIGRATIONS` | No | `true` (`false` local) | Runs `node backend/dist/migrate.mjs` before starting `server.mjs`. Set `false` on secondary replicas. |
| `TRUST_PROXY` | **Yes** (behind Caddy) | `true` (`false` local) | Enables reading `X-Forwarded-For` / `X-Forwarded-Proto` from Caddy. |
| `CORS_ORIGIN` | **Yes** | `https://${SITE_ADDRESS}` | Comma-separated strict CORS allow-list (wildcards `*` are rejected). |
| `APP_BASE_URL` | **Yes** | `https://${SITE_ADDRESS}` | Canonical external URL used in password-reset emails & links. |
| `AUTH_COOKIE_SECRET` | **Yes** | — | Random secret (>= 32 chars). Backend refuses startup in `production` if unset, placeholder, or `< 32` chars. |
| `SESSION_COOKIE_NAME` | No | `erp_session` | HTTP-only session cookie name. |
| `SESSION_TTL_DAYS` | No | `30` | Session expiration window in days. |
| `COOKIE_SECURE` | No | `auto` | `auto` (sets `Secure` when `NODE_ENV=production` & HTTPS origin/protocol), `true`, or `false`. |
| `DISABLE_RATE_LIMIT` | No | `false` | Disables Fastify rate limiting when `true` (test/benchmark only; keep `false` in production). |

### Authentication Rate Limiting & Temporary Lockout

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `AUTH_RATE_LIMIT_MAX` | No | `20` | Max requests per window for `/api/auth/login` and `/api/auth/signup`. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | No | `60000` | Sliding rate-limit window (ms) for login/signup. |
| `AUTH_MFA_RATE_LIMIT_MAX` | No | `10` | Max requests per window for `/api/auth/mfa/*` endpoints. |
| `AUTH_MFA_RATE_LIMIT_WINDOW_MS` | No | `60000` | Sliding rate-limit window (ms) for MFA endpoints. |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_MAX` | No | `10` | Max requests per window for `/api/auth/forgot-password` and `/api/auth/reset-password`. |
| `AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS` | No | `900000` | Sliding rate-limit window (ms) for password-reset endpoints (15 minutes). |
| `AUTH_LOCKOUT_MAX_ATTEMPTS` | No | `5` | Consecutive failed attempts before temporary lockout (`429 ACCOUNT_LOCKED` + `Retry-After`). |
| `AUTH_LOCKOUT_WINDOW_MS` | No | `900000` | Failure counting window in ms (15 minutes). |
| `AUTH_LOCKOUT_DURATION_MS` | No | `900000` | Lockout duration in ms (15 minutes). |

### MFA Encryption & Key Rotation

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `MFA_ENCRYPTION_KEY` | **Yes** | — | Active 32-byte key (64 hex chars or canonical 32-byte base64) for AES-256-GCM TOTP secret encryption. |
| `MFA_ENCRYPTION_KEY_VERSION` | No | `1` | Positive integer version tag stored in `user_mfa.key_version` for new/rotated secrets. |
| `MFA_ENCRYPTION_PREVIOUS_KEYS` | During rotation | `""` | Previous keys for decrypting older `key_version` rows (`"1:<key>,2:<key>"` or JSON `'{"1":"<key>"}'`). |

### Attachment Storage & Virus-Scan Hook

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `STORAGE_DRIVER` | No | `local` | Attachment storage backend: `local` or `s3`. |
| `STORAGE_LOCAL_DIR` | No | `/app/uploads` | Local directory for `STORAGE_DRIVER=local` (backed by `erp_uploads` Docker volume). |
| `S3_BUCKET` | If `STORAGE_DRIVER=s3` | `""` | S3/R2/MinIO bucket name. Verified by `/ready` (`HeadBucket`). |
| `S3_REGION` | No | `us-east-1` | S3 region. |
| `S3_ENDPOINT` | Optional | `""` | Custom S3-compatible endpoint (e.g., Cloudflare R2 or MinIO). |
| `S3_ACCESS_KEY_ID` | If `STORAGE_DRIVER=s3` | `""` | S3 access key ID. |
| `S3_SECRET_ACCESS_KEY` | If `STORAGE_DRIVER=s3` | `""` | S3 secret access key. |
| `S3_FORCE_PATH_STYLE` | No | `false` | Set `true` for MinIO or path-style S3 endpoints. |
| `ATTACHMENT_VIRUS_SCAN_ENABLED` | No | `false` | Enables ClamAV `clamd` upload screening when `true` (**off by default**). |
| `ATTACHMENT_VIRUS_SCAN_CLAMAV_HOST` | No | `127.0.0.1` | ClamAV `clamd` TCP host. |
| `ATTACHMENT_VIRUS_SCAN_CLAMAV_PORT` | No | `3310` | ClamAV `clamd` TCP port. |
| `ATTACHMENT_VIRUS_SCAN_TIMEOUT_MS` | No | `10000` | ClamAV scan timeout in ms. |
| `ATTACHMENT_VIRUS_SCAN_FAIL_CLOSED` | No | `true` | When scanning is enabled, reject uploads with `503` if `clamd` is unreachable. |

### Observability, Logging, SMTP & ETA Egypt

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | No | `info` | Pino structured JSON log level (`fatal\|error\|warn\|info\|debug\|trace`). |
| `METRICS_TOKEN` | Recommended | `""` | Bearer token for `GET /api/metrics`. Returns `404` when unset, `401` when invalid. |
| `SENTRY_DSN` | Optional | `""` | Backend Sentry-compatible DSN. Error reporting is **off** unless set; PII & secrets are scrubbed in `beforeSend`. |
| `SENTRY_ENVIRONMENT` | Optional | `NODE_ENV` | Environment tag attached to Sentry events. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | `0` | Sentry performance trace sample rate (`0`–`1`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Optional | `""` / `587` / `false` | SMTP credentials for password reset & operational alerts. |
| `ETA_CLIENT_ID` / `ETA_CLIENT_SECRET` | Optional | `""` | Egyptian Tax Authority e-Receipt v1.2 & B2B e-Invoice v1.0 OAuth2 client credentials. |
| `ETA_ID_BASE_URL` | Optional | `https://id.preprod.eta.gov.eg` | Use `https://id.eta.gov.eg` in Egypt ETA production. |
| `ETA_TOKEN_URL` | Optional | `${ETA_ID_BASE_URL}/connect/token` | Override ETA OAuth2 token endpoint if needed. |
| `ETA_API_BASE_URL` | Optional | `https://api.preprod.invoicing.eta.gov.eg` | Use `https://api.invoicing.eta.gov.eg` in Egypt ETA production. |
| `ETA_INVOICE_VERSION` | Optional | `1.0` | ETA B2B e-Invoice document version (`1.0` requires CAdES-BES signature via `ETA_SIGNER_URL`; `0.9` submits unsigned in preprod). |
| `ETA_SIGNER_URL` | Optional | `""` | HTTP endpoint of external PKCS#11 / USB hardware token CAdES-BES signing bridge (`POST { canonicalString, canonicalSha256, document } -> { signatureType: "I", value }`). |
| `ETA_SIGNER_TOKEN` | Optional | `""` | Optional Bearer token sent to `ETA_SIGNER_URL` (automatically scrubbed from logs & Sentry). |
| `ETA_SIGNER_TIMEOUT_MS` | Optional | `10000` | Request timeout in ms when calling `ETA_SIGNER_URL`. |

### Frontend Build-Time, Docker Compose & Ops Script Variables

| Variable | Scope | Default | Description |
|---|---|---|---|
| `VITE_API_BASE_URL` | Frontend build | `""` | Optional API origin override baked into Vite assets (keep empty for same-origin `/api`). |
| `VITE_SENTRY_DSN` | Frontend build | `""` | Optional frontend Sentry DSN (off unless set). |
| `VITE_SENTRY_ENVIRONMENT` | Frontend build | `production` | Frontend Sentry environment tag. |
| `SITE_ADDRESS` | `docker-compose.prod.yml` / Caddy | `localhost` | Public domain for Caddy automatic Let's Encrypt HTTPS. |
| `BACKEND_IMAGE` / `FRONTEND_IMAGE` | `docker-compose.prod.yml` | `ghcr.io/...:latest` | Pinned container image references deployed on the VPS. |
| `APP_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `docker-compose.yml` | `8080` / `erp` | Local Docker Compose stack overrides. |
| `PRE_DEPLOY_BACKUP` | `scripts/deploy.sh` | `true` | Runs `scripts/backup-db.sh` before pulling/restarting containers. |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` / `BACKUP_MIN_KEEP` / `BACKUP_UPLOADS` | `scripts/backup-db.sh` | `/var/backups/count-it-keep-it` / `14` / `5` / `true` | Backup storage path, retention policy, and `erp_uploads` archival toggle. |
| `TARGET_DATABASE_URL` / `RESTORE_CONFIRM` | `scripts/restore-db.sh` | — | Explicit restore target DB URL and non-interactive confirmation (`YES`). |
| `TEST_DATABASE_URL` / `TEST_PG_PORT` | Local & CI tests | Local PG 18 (`5439`) | Isolated test database URL or port for `docker-compose.test.yml`. |

---

## 5. Health, Observability & Structured Logging

- **Liveness (`GET /health` and `GET /api/health/live`)**: Confirms the Node.js/Fastify process is up (`200`, `{ ok: true, status: "ok", uptimeSeconds }`). Exempt from rate limiting.
- **Readiness (`GET /ready`, `GET /api/health/ready`, `GET /api/health`)**: Verifies **both** PostgreSQL (`SELECT 1`) **and** attachment storage reachability (writable `STORAGE_LOCAL_DIR` for `local`, `HeadBucket` for `s3`). Returns `200` when both pass and `503` if either is unreachable. Used by `backend/Dockerfile`, `docker-compose.yml`, and `docker-compose.prod.yml` Docker `HEALTHCHECK`s.
- **Structured Request Logs (Pino JSON)**: Every HTTP request receives a sanitized `x-request-id` (`reqId`) echoed in the response header and attached to every log line (`http.request`, `app.rejected`, `app.error`, `http.unhandled_error`) and audit log entry. Passwords, PINs, tokens, cookies, `Authorization` headers, MFA keys/secrets, recovery codes, SMTP/S3 secrets, and PostgreSQL connection-string credentials are automatically scrubbed (`[REDACTED]`).
- **Sentry-Compatible Error Hook**: Disabled by default. Set `SENTRY_DSN` (backend) and/or `VITE_SENTRY_DSN` (frontend build) to enable. Works with Sentry SaaS, self-hosted Sentry, or GlitchTip. All events and breadcrumbs pass through `scrubSentryEvent` / `scrubSentryBreadcrumb` before transmission.

---

## 6. Backup, Restore & Restore Drills

### Automated Backups (`scripts/backup-db.sh`)
`scripts/backup-db.sh` creates an atomic `pg_dump -Fc --no-owner --no-privileges` dump, validates its table of contents with `pg_restore -l`, archives the `erp_uploads` Docker volume (or `STORAGE_LOCAL_DIR`) into `erp_uploads_<UTC>.tar.gz`, writes `.sha256` checksums for both, and prunes old backups while preserving at least `BACKUP_MIN_KEEP` dumps.

Example daily cron job (store backups outside the git checkout, e.g., `/var/backups/count-it-keep-it`):
```bash
0 2 * * * DATABASE_URL='postgresql://...' BACKUP_RETENTION_DAYS=14 BACKUP_MIN_KEEP=5 /opt/count-it-keep-it/scripts/backup-db.sh /var/backups/count-it-keep-it >> /var/log/erp-backup.log 2>&1
```
Sync `/var/backups/count-it-keep-it` off-site (e.g., encrypted S3 or Backblaze B2) after each run.

### Verified Restore (`scripts/restore-db.sh`)
`scripts/restore-db.sh` verifies `.sha256` checksums and archive integrity, requires explicit `TARGET_DATABASE_URL` (or `DATABASE_URL`) in the environment (never auto-reads `backend/.env`), and requires `--yes`, `RESTORE_CONFIRM=YES`, or interactive `RESTORE` confirmation before running `pg_restore --clean --if-exists --single-transaction --exit-on-error`.

```bash
# 1. Stop backend workers/API to avoid active locks
docker compose -f docker-compose.prod.yml stop backend

# 2. Restore PostgreSQL and paired erp_uploads volume using direct (non-pooler) URL
TARGET_DATABASE_URL='postgresql://USER:PASSWORD@DIRECT_HOST:5432/DBNAME?sslmode=require' \
  bash scripts/restore-db.sh \
    --uploads /var/backups/count-it-keep-it/erp_uploads_20261124T020000Z.tar.gz \
    --uploads-volume erp_uploads \
    /var/backups/count-it-keep-it/erp_backup_20261124T020000Z.dump

# 3. Restart backend and verify readiness
docker compose -f docker-compose.prod.yml start backend
curl -fsS https://erp.example.com/api/health/ready
```

### Periodic Restore Drills (Recommended Monthly / Pre-Major Upgrade)
1. **Automated CI/Local Drill**: Run `npm run test:restore` (verifies `pg_dump` → `pg_restore` + `erp_uploads` SHA-256 parity + balanced trial balance + idempotent Drizzle migrations).
2. **Production Snapshot Scratch Drill**:
   - Provision an isolated scratch database (e.g., a temporary Neon branch or local `postgres:18-alpine` container) and a temporary uploads directory `/tmp/drill-uploads`.
   - Restore the latest production `.dump` and `.tar.gz` into the scratch targets:
     ```bash
     TARGET_DATABASE_URL='postgresql://.../erp_drill' \
       bash scripts/restore-db.sh --yes \
         --uploads /var/backups/count-it-keep-it/erp_uploads_LATEST.tar.gz \
         --uploads-dir /tmp/drill-uploads \
         /var/backups/count-it-keep-it/erp_backup_LATEST.dump
     ```
   - Boot a temporary backend container pointing at the scratch DB + `/tmp/drill-uploads` and verify:
     1. `GET /ready` returns `200` (`db: "ok"`, `storage: "ok"`).
     2. `GET /api/audit-logs/verify` (as admin) returns `"valid": true`.
     3. Trial balance (`GET /api/accounting/reports/trial-balance`) is balanced (`isBalanced: true`).
     4. A sample uploaded attachment downloads cleanly with matching SHA-256.
   - Record drill date, elapsed time (RTO), and snapshot age (RPO), then destroy the scratch DB and `/tmp/drill-uploads`.

---

## 7. Key & Secret Rotation Procedures

### Zero-Downtime MFA Encryption Key Rotation (`MFA_ENCRYPTION_KEY`)
Because `user_mfa.key_version` tracks which key encrypted each user's TOTP secret, you can rotate `MFA_ENCRYPTION_KEY` without locking anyone out:
1. Generate a new 32-byte key:
   ```bash
   openssl rand -hex 32
   ```
2. Update `.env` on the VPS, incrementing `MFA_ENCRYPTION_KEY_VERSION` (e.g., `1` → `2`) and moving the old key into `MFA_ENCRYPTION_PREVIOUS_KEYS`:
   ```bash
   MFA_ENCRYPTION_KEY=<new-64-hex-key-v2>
   MFA_ENCRYPTION_KEY_VERSION=2
   MFA_ENCRYPTION_PREVIOUS_KEYS=1:<old-64-hex-key-v1>
   ```
3. Restart `backend` (`docker compose -f docker-compose.prod.yml up -d backend`) and confirm `GET /ready` returns `200`. Existing users on `key_version=1` continue authenticating seamlessly while new enrollments use `key_version=2`.
4. Preview and run the transactional re-encryption script:
   ```bash
   npm run mfa:rotate-key -- --dry-run
   npm run mfa:rotate-key
   ```
   Confirm output shows `"ok": true, "targetVersion": 2` and `"rotated"` matches all legacy rows.
5. Once every row is on `key_version=2`, remove `1:<old-key>` from `MFA_ENCRYPTION_PREVIOUS_KEYS` and restart `backend`.

### Rotating Other Secrets
- **`AUTH_COOKIE_SECRET`**: Generate a new 32+ char secret (`openssl rand -hex 32`), update `.env`, and restart `backend`. Existing signed cookies and in-flight MFA challenge tokens are invalidated (users simply sign in again).
- **`METRICS_TOKEN`**: Update `.env`, restart `backend`, and update Prometheus `authorization.credentials` in lockstep.
- **`SMTP_PASS` / `S3_SECRET_ACCESS_KEY` / `ETA_CLIENT_SECRET`**: Issue a new credential at the provider, update `.env`, restart `backend`, verify `GET /ready` (for S3), then revoke the old credential at the provider.

---

## 8. Upgrade & Rollback Procedures

### Standard Upgrade (Safe Deploy Script)
`scripts/deploy.sh` validates `.env`, records currently running container image refs, runs a pre-deploy `pg_dump` + `erp_uploads` backup (`PRE_DEPLOY_BACKUP=true`), pulls or builds containers, waits for Docker `/ready` healthchecks (`--wait`), verifies `/api/health/live`, `/api/health/ready`, and public `https://${SITE_ADDRESS}/api/health/ready`, and **automatically rolls back** to the previous running container images with `RUN_MIGRATIONS=false` if any check fails:
```bash
git pull --ff-only origin main
bash ./scripts/deploy.sh --build          # When building from source on the VPS
# OR deploy immutable GHCR images built by CI/CD:
bash ./scripts/deploy.sh \
  --backend-image ghcr.io/abdallahgama1/erp-system-backend:sha-<short> \
  --frontend-image ghcr.io/abdallahgama1/erp-system-frontend:sha-<short>
```

### Manual Rollback
- **Application-only rollback** (no backward-incompatible schema changes):
  ```bash
  bash ./scripts/deploy.sh \
    --backend-image ghcr.io/abdallahgama1/erp-system-backend:sha-<previous> \
    --frontend-image ghcr.io/abdallahgama1/erp-system-frontend:sha-<previous>
  ```
- **Schema-affecting rollback**: Drizzle migrations (`0000`–`0008`) are forward-only SQL files and must never be edited retroactively. If a release introduced breaking DDL:
  1. Stop `backend` (`docker compose -f docker-compose.prod.yml stop backend`).
  2. Restore the pre-deploy `pg_dump` + paired `erp_uploads` archive via `scripts/restore-db.sh` (or Neon/RDS PITR to the timestamp immediately before migration). See **[docs/BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md)** for full details.
  3. Deploy the previous good commit/images via `scripts/deploy.sh` with `RUN_MIGRATIONS=false` (or once the schema matches).

---

## 9. ETA Egypt e-Receipt v1.2, Sentry & Prometheus Setup

### ETA Egypt e-Receipt v1.2 & B2B e-Invoice v1.0
1. Set `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_ID_BASE_URL=https://id.eta.gov.eg`, and `ETA_API_BASE_URL=https://api.invoicing.eta.gov.eg` in `.env` (use `preprod` URLs during ETA onboarding).
2. For **B2B e-Invoice v1.0** (`"I"` Sales Invoices and `"C"` Credit Notes submitted to `/api/v1/documentsubmissions`):
   - In **Production** (`ETA_INVOICE_VERSION=1.0`), run a PKCS#11 / Egyptian USB token CAdES-BES signing bridge reachable from the backend and set `ETA_SIGNER_URL` (plus optional `ETA_SIGNER_TOKEN`). If `ETA_SIGNER_URL` is unset while `ETA_INVOICE_VERSION=1.0`, B2B e-Invoices remain safely queued in `pending` status without failing out.
   - In **Pre-Production** without a hardware token, set `ETA_INVOICE_VERSION=0.9` to submit unsigned v0.9 B2B documents.
3. In the ERP UI, configure:
   - **Settings**: `einvoicingMode` = `eta_egypt`, Legal Company Name, and Egyptian RIN (`taxRegistrationNumber`)
   - **Branches**: ETA Branch Code (`etaBranchId`, e.g., `0`), Governorate, City, Street, and Building Number
   - **Products**: ETA Code Type (`EGS` or `GS1`), ETA Item Code (e.g., `EG-123456789-SKU1`), and ETA Unit Type (`EA`, `KGM`, `BX`, etc.)
   - **Customers**: Tax Registration / National ID and ETA Receiver Type (`B` Business, `P` Person, `F` Foreigner)
   - **POS Terminals**: `etaPosSerial` + `etaPosOsVersion` for POS e-Receipts (`"S"` / `"R"` via `/api/v1/receiptsubmissions`)
4. Monitor both e-Receipts (`S`/`R`) and B2B e-Invoices (`I`/`C`) and trigger manual retries in **Admin → E-Invoice Queue**.

### Sentry Error Tracking
1. Create separate Node (backend) and React (frontend) projects in Sentry.
2. Set `SENTRY_DSN`, `SENTRY_ENVIRONMENT=production`, and `SENTRY_TRACES_SAMPLE_RATE` (e.g., `0.1` or `0`) in `.env`.
3. For frontend Sentry, supply `VITE_SENTRY_DSN` and `VITE_SENTRY_ENVIRONMENT` during the Vite frontend build.
4. `frontend/nginx.conf` CSP already permits `https://*.ingest.sentry.io`, `https://*.ingest.us.sentry.io`, and `https://*.ingest.de.sentry.io`.

### Prometheus Scraping
1. Set a strong random `METRICS_TOKEN` in `.env` and restart `backend`.
2. Configure Prometheus (`prometheus.yml`):
   ```yaml
   scrape_configs:
     - job_name: count-it-keep-it-erp
       scheme: https
       metrics_path: /api/metrics
       authorization:
         type: Bearer
         credentials: "<METRICS_TOKEN>"
       static_configs:
         - targets: ["erp.example.com"]
   ```
3. Verify manually:
   ```bash
   curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://erp.example.com/api/metrics | head -n 20
   ```

---

## 10. Automated CI/CD (GHCR + GitHub Actions Deployment)

`.github/workflows/cd.yml` (**Deploy (CD)**) builds, security-scans, publishes immutable multi-stage Docker images to GitHub Container Registry (`ghcr.io`), and optionally deploys to your VPS over SSH using `scripts/deploy.sh`.

### Triggers
1. **Release Tags (`v*.*.*`)**: Pushing a semver tag deploys to the `production` GitHub Environment:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. **Manual Dispatch (`workflow_dispatch`)**: Trigger from **Actions → Deploy (CD) → Run workflow**, choosing `staging` or `production`, whether to execute the SSH deploy (`deploy: true|false`), and whether to skip the pre-deploy backup (`skip_backup`).

### GitHub Environments, Secrets & Variables
Create `staging` and `production` under **Repository Settings → Environments** (enable required reviewers on `production` if desired).

| Name | Kind | Required | Default | Description |
|---|---|---|---|---|
| `VPS_HOST` | Environment Secret | For SSH deploy | — | VPS IP or hostname. If omitted, CD publishes/scans images in GHCR and skips SSH deploy cleanly. |
| `VPS_USER` | Environment Secret | Optional | `deploy` | SSH username on VPS (member of `docker` group). |
| `VPS_SSH_KEY` | Environment Secret | When `VPS_HOST` set | — | Private ED25519 SSH key matching `~/.ssh/authorized_keys` on VPS. |
| `VPS_PORT` | Environment Secret | Optional | `22` | SSH port on VPS. |
| `VPS_SSH_KNOWN_HOSTS` | Environment Secret | Recommended | `ssh-keyscan` | Pinned host key line (`ssh-keyscan -p <port> <host>`) for strict host key verification. |
| `VPS_APP_DIR` | Environment Secret | Optional | `/opt/count-it-keep-it` | Directory containing `.env`, `docker-compose.prod.yml`, `Caddyfile`, and `scripts/`. |
| `GHCR_READ_TOKEN` | Secret | Recommended for private repos | `GITHUB_TOKEN` | Classic PAT / fine-grained token with `read:packages` so the VPS can pull private GHCR images. |
| `VITE_SENTRY_DSN` | Variable | Optional | `""` | Frontend Sentry DSN baked into Vite production assets during GHCR image build. |
| `VITE_API_BASE_URL` | Variable | Optional | `""` | Optional API origin override baked into Vite assets (leave empty for same-origin `/api`). |
