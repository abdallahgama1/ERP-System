# Backup, Restore & Migration 0007 Rollback Guide

This runbook documents production and local procedures for backing up and restoring PostgreSQL and the `erp_uploads` attachment store, running the automated restore verification test, and executing a safe rollback of Migration `0007_enterprise_foundation.sql` (or any forward-only release).

> [!IMPORTANT]
> Never edit applied migration files `0000`–`0007` in `backend/drizzle/migrations/`. All schema changes are forward-only; database rollback is performed by restoring a verified pre-upgrade `pg_dump` snapshot paired with its `erp_uploads` archive.
>
> **PostgreSQL client version requirement:** `pg_dump` must be at least the same major version as the target PostgreSQL server (e.g., `postgresql-client-18` or `postgres:18-alpine` when dumping a Neon PostgreSQL 18 instance).

---

## 1. What Must Be Backed Up Together

When `STORAGE_DRIVER=local` (the default in `docker-compose.yml` and `docker-compose.prod.yml`), operational durability requires **two paired artifacts** from the same point in time:

1. **PostgreSQL custom-format dump (`erp_backup_<UTC>.dump` + `.sha256`)** — created via `pg_dump -Fc --no-owner --no-privileges` and validated with `pg_restore -l`.
2. **Uploads archive (`erp_uploads_<UTC>.tar.gz` + `.sha256`)** — tar-gzip archive of the Docker volume `erp_uploads` (mounted at `/app/uploads`) or local `STORAGE_LOCAL_DIR`, validated with `gzip -t`.

When `STORAGE_DRIVER=s3`, attachments live in S3/R2/MinIO (enable bucket versioning and lifecycle/replication rules there); set `BACKUP_UPLOADS=false` if no local uploads volume is used.

---

## 2. Creating a Verified Backup (`scripts/backup-db.sh`)

### Production VPS (Docker Compose + `erp_uploads` volume)

```bash
# Uses DATABASE_URL (or DIRECT_DATABASE_URL for Neon) and auto-detects the *erp_uploads Docker volume
DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
BACKUP_DIR=/var/backups/count-it-keep-it \
BACKUP_UPLOADS=true \
BACKUP_RETENTION_DAYS=14 \
BACKUP_MIN_KEEP=5 \
bash scripts/backup-db.sh
```

What `scripts/backup-db.sh` does:
1. Runs `pg_dump -Fc --no-owner --no-privileges` to a `.tmp` file (`umask 077`).
2. Validates the archive Table of Contents with `pg_restore -l` before moving it into place.
3. Generates `erp_backup_<UTC>.dump.sha256`.
4. Archives the `erp_uploads` Docker volume (or `STORAGE_LOCAL_DIR` fallback) into `erp_uploads_<UTC>.tar.gz`, verifies with `gzip -t`, and writes `erp_uploads_<UTC>.tar.gz.sha256`.
5. Prunes both `.dump` and `erp_uploads_*.tar.gz` files older than `BACKUP_RETENTION_DAYS` while always keeping at least `BACKUP_MIN_KEEP` most recent snapshots.

### Local Development

```bash
# Reads DATABASE_URL from backend/.env if unset in environment
STORAGE_LOCAL_DIR=./backend/uploads bash scripts/backup-db.sh ./backups
```

---

## 3. Restoring a Backup (`scripts/restore-db.sh`)

> [!WARNING]
> `scripts/restore-db.sh` runs `pg_restore --clean --if-exists --single-transaction --exit-on-error` (destructive). It intentionally refuses to auto-read `backend/.env` and requires `TARGET_DATABASE_URL` (or `DATABASE_URL`) in the environment plus `--yes`, `RESTORE_CONFIRM=YES`, or typing `RESTORE` interactively.

### Full Production Restore (Database + `erp_uploads` Volume)

```bash
# 1. Stop backend & background workers so no writes occur during restore
docker compose -f docker-compose.prod.yml stop backend

# 2. Restore PostgreSQL and the paired erp_uploads Docker volume
TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
bash scripts/restore-db.sh \
  --uploads /var/backups/count-it-keep-it/erp_uploads_YYYYMMDDTHHMMSSZ.tar.gz \
  --uploads-volume erp_uploads \
  /var/backups/count-it-keep-it/erp_backup_YYYYMMDDTHHMMSSZ.dump

# 3. Start backend and verify readiness
docker compose -f docker-compose.prod.yml up -d backend
curl -fsS http://127.0.0.1:3001/api/health/ready
```

### Restoring into a Local Directory (`STORAGE_LOCAL_DIR`)

```bash
TARGET_DATABASE_URL="postgresql://erp:password@127.0.0.1:5432/erp_scratch" \
bash scripts/restore-db.sh \
  --uploads ./backups/erp_uploads_YYYYMMDDTHHMMSSZ.tar.gz \
  --uploads-dir ./backend/uploads \
  ./backups/erp_backup_YYYYMMDDTHHMMSSZ.dump
```

---

## 4. Automated Restore & Migration 0007 Test (`npm run test:restore`)

The repository includes an automated verification script at `scripts/test-backup-restore.mjs` wired into GitHub Actions (`.github/workflows/ci.yml`):

```bash
# Runs locally (uses ephemeral postgres:17-alpine via Docker if native pg_dump is absent)
npm run test:restore

# Also dumps the current dev DATABASE_URL into an isolated scratch DB and verifies it
node scripts/test-backup-restore.mjs --dev-copy
```

What `npm run test:restore` proves on every run:
1. Applies migrations `0000`–`0006` (strictly pre-`0007`) to a clean scratch database.
2. Seeds realistic multi-module pre-`0007` data (`users`, `user_roles`, `branches`, `company_settings`, `products`, `branch_products`, `customers`, `vendors`, `purchase_orders`, `sales_invoices`, `stock_movements`, `chart_of_accounts`, balanced posted `journal_entries` + `journal_lines`, and `audit_logs`) plus a sample attachment file in a simulated `erp_uploads` directory.
3. Captures pre-`0007` row counts and posted Trial Balance (`SUM(debit_base) = SUM(credit_base)`).
4. Runs `pg_dump -Fc`, validates with `pg_restore -l`, archives uploads with `tar -czf`, verifies SHA-256 checksums, and restores both into a clean destination scratch database and destination uploads directory.
5. Applies `0007_enterprise_foundation.sql` (and confirms re-running the full Drizzle migration journal is an idempotent no-op).
6. Asserts:
   - Exact row-count preservation across all seeded tables.
   - Default company `COMP-01` (`00000000-0000-4000-8000-000000000001`) created and marked `is_default = true`.
   - Zero `NULL` `company_id` values across all company-scoped tables, with 100% of migrated rows backfilled to `COMP-01`.
   - `user_companies` backfilled for all existing users.
   - Posted Trial Balance remains balanced and matches pre-`0007` totals to the cent.
   - Restored attachment file SHA-256 matches byte-for-byte.

---

## 5. Rollback Procedure for Migration `0007` (and Forward-Only Releases)

### Why Rollback Uses Snapshot Restore (Not `DOWN` SQL)

Migration `0007_enterprise_foundation.sql` introduces multi-company tables (`companies`, `user_companies`, `custom_roles`, `custom_role_permissions`, `user_mfa`, `document_attachments`, `user_saved_views`, `print_templates`), adds `company_id NOT NULL` columns and composite unique indexes across 48 existing tables, and backfills `COMP-01`. Dropping those columns/constraints in-place risks partial failure, orphaned multi-company data, and broken Drizzle migration checksums.

Therefore, **rollback MUST be executed via pre-upgrade snapshot restore + image rollback**.

### Pre-Upgrade Gate (Required Before Deploying `0007`)

1. Record the currently running image tags (e.g., `BACKEND_IMAGE=ghcr.io/...:sha-<PREV>` and `FRONTEND_IMAGE=ghcr.io/...:sha-<PREV>`).
2. Stop scheduled cron/worker jobs or enter a brief maintenance window.
3. Take a verified pre-upgrade backup (`DATABASE_URL` + `erp_uploads`):
   ```bash
   BACKUP_UPLOADS=true bash scripts/backup-db.sh /var/backups/count-it-keep-it
   ```
4. Confirm both `.sha256` files exist and test-restore into a scratch database if upgrading a production tenant for the first time.

### Executing Rollback

If an issue is detected during or after deploying `0007`:

1. **Quiesce traffic and stop backend:**
   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. **Restore the pre-`0007` database dump and companion `erp_uploads` archive:**
   ```bash
   TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
   bash scripts/restore-db.sh \
     --uploads /var/backups/count-it-keep-it/erp_uploads_<PRE_0007_TS>.tar.gz \
     --uploads-volume erp_uploads \
     /var/backups/count-it-keep-it/erp_backup_<PRE_0007_TS>.dump
   ```
   *(If using Neon managed PostgreSQL, you may alternatively restore via Neon Point-in-Time Recovery / branch restore to the timestamp immediately before the deploy, then restore the matching `erp_uploads` archive.)*
3. **Pin containers back to the pre-`0007` release images and start:**
   ```bash
   BACKEND_IMAGE="ghcr.io/abdallahgama1/erp-system-backend:sha-<PREV>" \
   FRONTEND_IMAGE="ghcr.io/abdallahgama1/erp-system-frontend:sha-<PREV>" \
   docker compose -f docker-compose.prod.yml up -d --no-build
   ```
   *(Or run `bash scripts/deploy.sh --tag sha-<PREV> --skip-backup` if deploying via the CD script.)*
4. **Run Post-Rollback Verification:**
   ```sql
   -- 1. Confirm migration journal is back at 0006 (7 rows: 0000..0006)
   SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY id;

   -- 2. Confirm balanced Trial Balance on posted journal entries
   SELECT
     COALESCE(SUM(jl.debit_base), 0) AS total_debit,
     COALESCE(SUM(jl.credit_base), 0) AS total_credit,
     COALESCE(SUM(jl.debit_base), 0) - COALESCE(SUM(jl.credit_base), 0) AS diff
   FROM public.journal_lines jl
   INNER JOIN public.journal_entries je ON je.id = jl.entry_id
   WHERE je.status = 'posted';

   -- 3. Spot-check core row counts
   SELECT
     (SELECT count(*) FROM public.users) AS users,
     (SELECT count(*) FROM public.branches) AS branches,
     (SELECT count(*) FROM public.products) AS products,
     (SELECT count(*) FROM public.sales_invoices) AS sales_invoices,
     (SELECT count(*) FROM public.journal_entries) AS journal_entries;
   ```
5. **Verify HTTP health and login:**
   ```bash
   curl -fsS http://127.0.0.1:3001/api/health/live
   curl -fsS http://127.0.0.1:3001/api/health/ready
   ```
   Confirm an existing user can sign in and load Dashboard, Products, and Trial Balance without errors.
