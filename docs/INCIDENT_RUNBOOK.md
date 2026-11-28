# Production Incident Runbook — Count It, Keep It ERP

This runbook provides copy-pasteable containment, recovery, and verification procedures for production incidents on a single-company VPS deployment (`docker-compose.prod.yml` + Caddy TLS + PostgreSQL 18 + encrypted off-site S3 backups).

> [!IMPORTANT]
> Before any destructive database action, stop writers (`docker compose -f docker-compose.prod.yml stop backend`), verify which environment you are targeting (`SITE_ADDRESS` and `DATABASE_URL`), and record timestamps in UTC for post-incident review.

---

## Quick Triage (Run First)

```bash
cd /opt/count-it-keep-it
date -u
docker compose -f docker-compose.prod.yml ps
df -h / /var/backups/count-it-keep-it
free -h
curl -fsS --max-time 5 https://${SITE_ADDRESS}/api/health/live || echo "LIVE FAILED"
curl -fsS --max-time 5 https://${SITE_ADDRESS}/api/health/ready || echo "READY FAILED"
docker compose -f docker-compose.prod.yml logs --tail=100 backend caddy
```

---

## 1. Incident: Application Is Down (502 / 503 / Unreachable)

### Symptoms
- Users see HTTP 502/503/504, connection refused, or TLS errors.
- `/api/health/live` or `/api/health/ready` fails.

### Step-by-Step Recovery
1. **Check container state and exit codes / OOM kills:**
   ```bash
   cd /opt/count-it-keep-it
   docker compose -f docker-compose.prod.yml ps -a
   docker inspect --format '{{.Name}} state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' \
     $(docker compose -f docker-compose.prod.yml ps -q)
   ```
2. **Inspect internal container probes (isolates Caddy vs backend vs DB/storage):**
   ```bash
   docker compose -f docker-compose.prod.yml exec -T backend wget -qO- http://127.0.0.1:3001/health
   docker compose -f docker-compose.prod.yml exec -T backend wget -qO- http://127.0.0.1:3001/ready
   ```
   - If `/health` fails or `backend` is crash-looping: inspect `docker compose -f docker-compose.prod.yml logs --tail=200 backend`.
   - If `/ready` returns `503`: read the JSON body — `"db": "error"` points to PostgreSQL reachability/credentials/connection limits; `"storage": "error"` points to full disk on `/app/uploads` or S3 credential/bucket failure.
   - If `/ready` passes inside the container but external `https://${SITE_ADDRESS}` fails: inspect Caddy logs (`docker compose -f docker-compose.prod.yml logs --tail=150 caddy`), verify DNS A/AAAA records, and verify ports `80/443` are open (`sudo ufw status`).
3. **Check disk space (common cause of silent Postgres/uploads/Docker crashes):**
   ```bash
   df -h
   docker system df
   # If safe, prune unused old images (NEVER run docker volume prune!):
   docker image prune -f
   ```
4. **Restart the affected service or roll back if the outage followed a deployment:**
   ```bash
   # Clean restart of app stack:
   docker compose -f docker-compose.prod.yml up -d --wait

   # If outage started right after a deploy (application-only rollback):
   bash ./scripts/deploy.sh --rollback
   ```
5. **Verify recovery:**
   ```bash
   SMOKE_BASE_URL="https://${SITE_ADDRESS}" node scripts/smoke-test.mjs
   ```

---

## 2. Incident: Database Is Corrupted

### Symptoms
- PostgreSQL logs `invalid page in block`, `checksum failure`, `could not read block`, or unexpected missing/corrupt financial rows.
- `GET /api/accounting/reports/reconciliation` or `GET /api/audit-logs/verify` fails unexpectedly.

### Step-by-Step Recovery
1. **Stop all writers immediately to prevent further corruption or bad accounting postings:**
   ```bash
   cd /opt/count-it-keep-it
   docker compose -f docker-compose.prod.yml stop backend
   # Pause scheduled backup timer so a corrupt DB does not overwrite the latest good manifest:
   sudo systemctl stop count-it-keep-it-backup.timer 2>/dev/null || true
   ```
2. **Capture forensic evidence before touching data:**
   ```bash
   mkdir -p /var/backups/forensics
   docker compose -f docker-compose.prod.yml logs --since=24h backend > /var/backups/forensics/backend_$(date -u +%Y%m%dT%H%M%SZ).log
   # If using managed Postgres (Neon/RDS), take a manual snapshot/branch of the damaged state before restoring.
   ```
3. **Choose recovery source:**
   - **Option A — Managed PostgreSQL PITR (Neon / AWS RDS):** Restore a branch/instance to the last known clean timestamp immediately before corruption, then update `DATABASE_URL` / `DIRECT_DATABASE_URL` in `.env` (or swap endpoints).
   - **Option B — Verified Encrypted Off-Site S3 Backup (or local `.dump`):** Follow **Section 5 (Backup Restore)** below using the latest verified backup prior to corruption.
4. **Start backend and run full integrity verification:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --wait backend
   SMOKE_BASE_URL="https://${SITE_ADDRESS}" \
     SMOKE_ADMIN_EMAIL="<admin-email>" \
     SMOKE_ADMIN_PASSWORD="<admin-password>" \
     node scripts/smoke-test.mjs
   ```
   Confirm `reconciliation.allReconciled === true` (8/8 controls), `setupHealth.healthy === true`, and `auditChain.valid === true`.
5. **Re-enable scheduled backups** once clean:
   ```bash
   sudo systemctl start count-it-keep-it-backup.timer 2>/dev/null || true
   ```

---

## 3. Incident: A Secret or Encryption Key Leaks

Treat every leaked credential as compromised immediately. Follow the matching playbook below, then audit `/api/audit-logs` and `GET /api/audit-logs/verify` for unauthorized activity.

### 3A. `AUTH_COOKIE_SECRET` Leaked
Impact: Signed cookies and short-lived MFA challenge tokens could be forged.
```bash
cd /opt/count-it-keep-it
# 1. Generate a new 32+ byte secret and update AUTH_COOKIE_SECRET in .env
openssl rand -hex 32
nano .env

# 2. Revoke all active user sessions in PostgreSQL (forces clean re-login for all users)
source .env
psql "${DIRECT_DATABASE_URL:-$DATABASE_URL}" -c \
  "UPDATE public.user_sessions SET revoked_at = now() WHERE revoked_at IS NULL;"

# 3. Restart backend
docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend
```

### 3B. `MFA_ENCRYPTION_KEY` Leaked (Zero-Downtime Key Rotation)
Impact: If an attacker also obtained the `user_mfa` table, they could decrypt TOTP seeds.
```bash
cd /opt/count-it-keep-it
# 1. Generate a new 32-byte (64-hex) key
openssl rand -hex 32

# 2. In .env, move the leaked key into MFA_ENCRYPTION_PREVIOUS_KEYS, bump version, and set new key:
#    MFA_ENCRYPTION_KEY=<new-64-hex-key>
#    MFA_ENCRYPTION_KEY_VERSION=2
#    MFA_ENCRYPTION_PREVIOUS_KEYS=1:<leaked-64-hex-key>
nano .env

# 3. Restart backend so new version is active while existing rows remain decryptable
docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend

# 4. Dry-run and execute re-encryption of all user_mfa rows
set -a && source .env && set +a
node scripts/rotate-mfa-key.mjs --dry-run
node scripts/rotate-mfa-key.mjs

# 5. Remove the leaked key from MFA_ENCRYPTION_PREVIOUS_KEYS in .env and restart backend
nano .env
docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend
# Note: If the database itself was also exfiltrated, force affected admins/users to re-enroll MFA.
```

### 3C. `BACKUP_ENCRYPTION_KEY` Leaked
Impact: Off-site `.enc` backups in S3/R2/MinIO could be decrypted if the attacker also has bucket read access.
```bash
cd /opt/count-it-keep-it
# 1. Immediately rotate BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY at R2/MinIO/AWS.
# 2. Generate a brand-new 32-byte BACKUP_ENCRYPTION_KEY and save it offline in your password manager:
openssl rand -hex 32
nano .env

# 3. Run an immediate fresh encrypted backup under the new key:
sudo /usr/local/bin/count-it-keep-it-backup

# 4. Verify the new off-site backup restores cleanly with the new key:
set -a && source .env && set +a
npm run drill:restore

# 5. Delete legacy off-site objects encrypted under the leaked key from the S3/R2 bucket once the new drill passes.
```

### 3D. `DATABASE_URL` / Postgres Password Leaked
```bash
# 1. Rotate the PostgreSQL role password in Neon / AWS RDS (or ALTER USER in local-db).
# 2. Update DATABASE_URL and DIRECT_DATABASE_URL in /opt/count-it-keep-it/.env (chmod 600 .env).
# 3. Restart backend and verify /api/health/ready:
cd /opt/count-it-keep-it
docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend
curl -fsS https://${SITE_ADDRESS}/api/health/ready
```

### 3E. `METRICS_TOKEN`, `S3_*`, `SMTP_PASS`, or `ETA_*` Leaked
1. Issue a new credential at the provider (or `openssl rand -hex 24` for `METRICS_TOKEN`).
2. Update `.env`, restart backend (`docker compose -f docker-compose.prod.yml up -d --force-recreate --wait backend`), and verify `GET /ready` (checks S3 reachability) and `GET /api/metrics`.
3. Revoke the old credential at the provider immediately.

---

## 4. Incident: A Bad Migration Is Deployed

> [!CAUTION]
> Drizzle migrations in `backend/drizzle/migrations/` are **forward-only**. Never edit applied SQL files or run ad-hoc `DROP COLUMN` statements on production. Always recover by restoring the pre-deploy snapshot + rolling back container images.

### Step-by-Step Recovery
1. **Stop backend immediately to prevent new writes against a half-applied or broken schema:**
   ```bash
   cd /opt/count-it-keep-it
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. **Inspect migration state and recent backend error logs:**
   ```bash
   docker compose -f docker-compose.prod.yml logs --tail=150 backend
   set -a && source .env && set +a
   psql "${DIRECT_DATABASE_URL:-$DATABASE_URL}" -c \
     "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 10;"
   ```
3. **Restore the pre-deploy backup taken by `scripts/deploy.sh` (or Neon/RDS PITR to the timestamp right before deploy):**
   ```bash
   ls -lt /var/backups/count-it-keep-it/erp_backup_*.dump | head -n 5
   TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
   bash ./scripts/restore-db.sh \
     --uploads /var/backups/count-it-keep-it/erp_uploads_<PRE_DEPLOY_TS>.tar.gz \
     --uploads-volume erp_uploads \
     /var/backups/count-it-keep-it/erp_backup_<PRE_DEPLOY_TS>.dump
   ```
4. **Roll back container images to the previous known-good release (`RUN_MIGRATIONS=false`):**
   ```bash
   bash ./scripts/deploy.sh --rollback
   ```
   *(Or explicitly pin `--backend-image` and `--frontend-image` with `RUN_MIGRATIONS=false`.)*
5. **Verify health, login, reconciliation (8/8), setup health, and audit hash chain:**
   ```bash
   SMOKE_BASE_URL="https://${SITE_ADDRESS}" \
     SMOKE_ADMIN_EMAIL="<admin-email>" \
     SMOKE_ADMIN_PASSWORD="<admin-password>" \
     node scripts/smoke-test.mjs
   ```

---

## 5. Incident: A Backup Restore Is Needed

### 5A. Restoring from Local On-Server Backup
```bash
cd /opt/count-it-keep-it
set -a && source .env && set +a

# 1. Stop backend to close active connections and prevent writes
docker compose -f docker-compose.prod.yml stop backend

# 2. Pick the desired paired .dump and .tar.gz timestamp
ls -lh /var/backups/count-it-keep-it/

# 3. Run verified checksum + single-transaction restore
TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
bash ./scripts/restore-db.sh \
  --uploads /var/backups/count-it-keep-it/erp_uploads_<TS>.tar.gz \
  --uploads-volume erp_uploads \
  /var/backups/count-it-keep-it/erp_backup_<TS>.dump

# 4. Restart backend and verify
docker compose -f docker-compose.prod.yml up -d --wait backend
curl -fsS https://${SITE_ADDRESS}/api/health/ready
```

### 5B. Restoring from Encrypted Off-Site S3 / R2 / MinIO Backup (Disaster Recovery)
Use this procedure when the VPS disk is lost or local backups are unusable. You only need `.env` (specifically `BACKUP_S3_*` and your offline copy of `BACKUP_ENCRYPTION_KEY`).

```bash
cd /opt/count-it-keep-it
set -a && source .env && set +a

# 1. Stop backend
docker compose -f docker-compose.prod.yml stop backend

# 2. Download, decrypt (AES-256-GCM), and SHA-256 verify the latest off-site backup set
RESTORE_TMP="$(mktemp -d /tmp/erp-dr-XXXXXX)"
chmod 700 "$RESTORE_TMP"
node scripts/backup-offsite.mjs download-latest --out-dir "$RESTORE_TMP"
ls -lh "$RESTORE_TMP"

# 3. Restore DB dump and companion uploads archive
DUMP_FILE="$(ls -1 "$RESTORE_TMP"/erp_backup_*.dump | head -n 1)"
UPLOADS_FILE="$(ls -1 "$RESTORE_TMP"/erp_uploads_*.tar.gz 2>/dev/null | head -n 1 || true)"

if [[ -n "$UPLOADS_FILE" ]]; then
  TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
  bash ./scripts/restore-db.sh \
    --uploads "$UPLOADS_FILE" \
    --uploads-volume erp_uploads \
    "$DUMP_FILE"
else
  TARGET_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}" \
  bash ./scripts/restore-db.sh "$DUMP_FILE"
fi

# 4. Clean up temporary plaintext restore files immediately
rm -rf "$RESTORE_TMP"

# 5. Start backend (applies any forward-only migrations cleanly) and run full smoke verification
docker compose -f docker-compose.prod.yml up -d --wait backend
SMOKE_BASE_URL="https://${SITE_ADDRESS}" \
  SMOKE_ADMIN_EMAIL="<admin-email>" \
  SMOKE_ADMIN_PASSWORD="<admin-password>" \
  node scripts/smoke-test.mjs
```

### Post-Restore Sign-Off Checklist
- [ ] `GET /api/health/live` and `GET /api/health/ready` return `200 OK` (`db: "ok"`, `storage: "ok"`).
- [ ] `GET /api/accounting/reports/reconciliation` passes all 8/8 controls (`allReconciled: true`).
- [ ] `GET /api/accounting/setup-health` reports `healthy: true` (0 issues).
- [ ] `GET /api/audit-logs/verify` reports `valid: true`.
- [ ] Sample attachment download works from the UI.
- [ ] Scheduled backup timer (`count-it-keep-it-backup.timer`) is active and `GET /api/admin/backups/freshness` reports fresh after the next backup run.
