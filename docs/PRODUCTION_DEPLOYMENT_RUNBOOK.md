# Production Deployment Runbook — Count It Keep It ERP

This runbook covers production provisioning, deployment, backup/restore, rollback, and observability for **Count It Keep It ERP** on a single VPS (Docker Compose + Caddy automatic HTTPS) backed by Managed PostgreSQL (Neon or AWS RDS with Point-In-Time Recovery).

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

### Initial Provisioning & Boot
1. Clone the repository on the VPS (e.g., `/opt/count-it-keep-it`).
2. Create root `.env` (permissions `chmod 600 .env`, never commit to git) with all required production variables:
   ```bash
   SITE_ADDRESS=erp.example.com
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
   AUTH_COOKIE_SECRET=<output of: openssl rand -hex 32>
   CORS_ORIGIN=https://erp.example.com
   APP_BASE_URL=https://erp.example.com
   COOKIE_SECURE=auto
   METRICS_TOKEN=<output of: openssl rand -hex 24>
   ```
3. Build and start the production stack:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
4. Verify container health and endpoints:
   ```bash
   docker compose -f docker-compose.prod.yml ps
   curl -fsS https://erp.example.com/api/health/live
   curl -fsS https://erp.example.com/api/health/ready
   ```
5. **First-user Admin Bootstrap**: Immediately after initial deployment, sign up the first administrator account at `https://erp.example.com/signup`. The backend serializes signup with `pg_advisory_xact_lock` so the very first registered user receives `admin` role + `'all'` branch scope automatically.

---

## 4. Production Environment Variables Reference

All variable names below match `backend/src/config.ts`, `backend/.env.example`, and `docker-compose.prod.yml`.

> **Important:** This application uses `AUTH_COOKIE_SECRET`, `CORS_ORIGIN`, and `APP_BASE_URL` — **not** `SESSION_SECRET` or `APP_ORIGIN`.

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `SITE_ADDRESS` | Yes (Compose/Caddy) | — | Public domain for Caddy ACME HTTPS (e.g., `erp.example.com`). |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection URL (`?sslmode=require`). |
| `AUTH_COOKIE_SECRET` | **Yes** | — | Random secret (>= 32 chars). Backend refuses startup in `production` if unset, placeholder, or `< 32` chars. |
| `NODE_ENV` | Yes | `production` | Must be `production` in prod deployments. |
| `HOST` | No | `0.0.0.0` | Bind host inside container. |
| `PORT` | No | `3001` | Backend HTTP listen port inside container. |
| `LOG_LEVEL` | No | `info` | Pino structured log level (`fatal\|error\|warn\|info\|debug\|trace`). |
| `TRUST_PROXY` | Yes (behind Caddy) | `true` | Enables reading `X-Forwarded-*` headers from Caddy. |
| `CORS_ORIGIN` | **Yes** | `https://${SITE_ADDRESS}` | Comma-separated allowed browser origins (`https://...` triggers `Secure` cookies in `COOKIE_SECURE=auto`). |
| `APP_BASE_URL` | **Yes** | `https://${SITE_ADDRESS}` | Canonical external URL used in password-reset emails & links. |
| `SESSION_COOKIE_NAME` | No | `erp_session` | HTTP-only session cookie name. |
| `SESSION_TTL_DAYS` | No | `30` | Session expiration window in days. |
| `COOKIE_SECURE` | No | `auto` | `auto` (Secure when `NODE_ENV=production` & `CORS_ORIGIN` starts with `https://`), `true`, or `false`. |
| `RUN_MIGRATIONS` | No | `true` | Runs `node backend/dist/migrate.mjs` before starting `server.mjs`. Set `false` for secondary replicas. |
| `METRICS_TOKEN` | Recommended | `""` | Bearer token for `GET /api/metrics`. Returns `404` in production if unset, `401` if invalid. |
| `SENTRY_DSN` | Optional | `""` | Backend Sentry DSN (PII/tokens/connection strings scrubbed automatically). |
| `SENTRY_ENVIRONMENT` | Optional | `production` | Sentry environment tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | `0` | Sentry performance sample rate (`0`–`1`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Optional | `""` / `587` / `false` | SMTP credentials for password reset & operational alerts. |
| `ETA_CLIENT_ID` / `ETA_CLIENT_SECRET` | Optional | `""` | Egyptian Tax Authority e-Receipt v1.2 OAuth2 client credentials. |
| `ETA_ID_BASE_URL` | Optional | `https://id.preprod.eta.gov.eg` | Use `https://id.eta.gov.eg` in Egypt ETA production. |
| `ETA_API_BASE_URL` | Optional | `https://api.preprod.invoicing.eta.gov.eg` | Use `https://api.invoicing.eta.gov.eg` in Egypt ETA production. |

*Frontend build-time variables* (injected during Vite build if needed): `VITE_API_BASE_URL` (empty default for same-origin `/api`), `VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`.

---

## 5. Backup & Restore Procedures

### Automated Backups (`scripts/backup-db.sh`)
`scripts/backup-db.sh` creates an atomic `pg_dump -Fc --no-owner --no-privileges` dump, validates its table of contents with `pg_restore -l`, writes a portable `.sha256` checksum, and prunes old backups while preserving at least `BACKUP_MIN_KEEP` (default `3`) dumps.

Example daily cron job (store backups outside the git checkout, e.g., `/var/backups/count-it-keep-it`):
```bash
0 2 * * * DATABASE_URL='postgresql://...' BACKUP_RETENTION_DAYS=14 BACKUP_MIN_KEEP=5 /opt/count-it-keep-it/scripts/backup-db.sh /var/backups/count-it-keep-it >> /var/log/erp-backup.log 2>&1
```
Sync `/var/backups/count-it-keep-it` off-site (e.g., S3, Backblaze B2, or encrypted object storage) after each run.

### Verified Restore (`scripts/restore-db.sh`)
`scripts/restore-db.sh` verifies the `.sha256` checksum and archive integrity, requires explicit `TARGET_DATABASE_URL` (or `DATABASE_URL`) in the environment (never auto-reads `backend/.env`), and enforces `--yes`, `RESTORE_CONFIRM=YES`, or interactive `RESTORE` confirmation before running `--clean --if-exists --single-transaction --exit-on-error`.

```bash
# 1. Stop backend workers/API to avoid active locks
docker compose -f docker-compose.prod.yml stop backend

# 2. Restore using direct (non-pooler) PostgreSQL URL
TARGET_DATABASE_URL='postgresql://USER:PASSWORD@DIRECT_HOST:5432/DBNAME?sslmode=require' \
  ./scripts/restore-db.sh /var/backups/count-it-keep-it/erp_backup_20261121T020000Z.dump

# 3. Restart backend and verify readiness
docker compose -f docker-compose.prod.yml start backend
curl -fsS https://erp.example.com/api/health/ready
```

---

## 6. Upgrade & Rollback Procedures

### Standard Upgrade
1. Take a pre-deploy database snapshot via `scripts/backup-db.sh` (or Neon branch / RDS snapshot).
2. Pull new code or tagged container images and deploy:
   ```bash
   git pull --ff-only origin main
   docker compose -f docker-compose.prod.yml up -d --build
   ```
3. Verify `/api/health/live` and `/api/health/ready` return `200`.

### Rollback
- **Application-only rollback** (no backward-incompatible schema changes):
  ```bash
  git checkout <previous-good-sha>
  docker compose -f docker-compose.prod.yml up -d --build --no-deps backend frontend
  ```
- **Schema-affecting rollback**: Drizzle migrations (`0000`–`0006`) are forward-only SQL files. If a release introduced breaking DDL:
  1. Stop `backend` (`docker compose -f docker-compose.prod.yml stop backend`).
  2. Restore the pre-deploy dump via `scripts/restore-db.sh` (or Neon/RDS PITR to the timestamp immediately before migration).
  3. Check out the previous application commit and start the stack with `docker compose -f docker-compose.prod.yml up -d --build`.

---

## 7. ETA Egypt e-Receipt v1.2, Sentry & Prometheus Setup

### ETA Egypt e-Receipt v1.2
1. Set `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_ID_BASE_URL=https://id.eta.gov.eg`, and `ETA_API_BASE_URL=https://api.invoicing.eta.gov.eg` in `.env` (use `preprod` URLs during ETA onboarding).
2. In the ERP UI (**Settings**), configure:
   - `einvoicingMode` = `eta_egypt`
   - Legal Company Name & Egyptian RIN (`taxRegistrationNumber`)
   - Branch codes/addresses & POS Terminal `etaPosSerial` + `etaPosOsVersion`
3. Monitor submissions and trigger manual retries if needed in **Admin → E-Invoice Queue**.

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
