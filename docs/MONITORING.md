# Production Monitoring & Alerting Guide — Count It, Keep It ERP

This guide provides a complete, zero-Prometheus monitoring setup for a single-company production VPS deployment. It uses free hosted tools (**UptimeRobot** or **Better Stack**, **Healthchecks.io**, and **Sentry**) to alert the right people via **Email** and **Telegram** when the application goes down, a backup is missed or stale, disk fills up, a TLS certificate nears expiry, or backend errors spike.

Companion runbooks:
- [OPERATIONS.md](./OPERATIONS.md) — Health endpoints, environment variables, and the VPS Secrets & Rotation Checklist.
- [INCIDENT_RUNBOOK.md](./INCIDENT_RUNBOOK.md) — Step-by-step recovery commands for every alert below.
- [BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md) — Off-site backup restore and rollback procedures.

---

## 1. What to Monitor (Five Mandatory Signals)

| Signal | Source / Endpoint | Healthy Condition | Alert Threshold | Tool (Free Tier) |
| :--- | :--- | :--- | :--- | :--- |
| **1. App Uptime & Readiness + Backup Freshness** | `GET https://<SITE_ADDRESS>/api/status` (`Authorization: Bearer <UPTIME_STATUS_TOKEN>`) | HTTP `200` and `{"ready":true,"database":true,"storage":true,"backupFresh":true}` | HTTP `503` / timeout / non-200 for 2 consecutive checks (2–5 min) | UptimeRobot or Better Stack |
| **2. Public Liveness / Readiness** | `GET https://<SITE_ADDRESS>/api/health/ready` | HTTP `200` with `"ready"` | HTTP `503` or connection failure | UptimeRobot or Better Stack |
| **3. Daily Backup & Monthly Restore Drill (Dead-Man's-Switch)** | `HEALTHCHECK_PING_URL` (`backup-db.sh` + `backup-offsite.mjs`) and `RESTORE_DRILL_HEALTHCHECK_PING_URL` (`monthly-restore-drill.mjs`) | Success ping received every 24h (grace 2h) and every 31d (grace 2d) | Missed ping (backup never ran/hung) **or** `/fail` ping with error body | Healthchecks.io (free tier: 20 checks) |
| **4. VPS Disk Space** | Host cron checking `/` and `/var/backups/count-it-keep-it` (`df -P`) | Usage `< 75%` | Warning at `75%`, Critical alert at `>= 85%` | Healthchecks.io ping (or Telegram bot) |
| **5. TLS Certificate Expiry** | `https://<SITE_ADDRESS>` (managed by Caddy Let's Encrypt) | Valid cert with `>= 15` days remaining | Alert at `14` days and `7` days before expiry (Caddy renews at 30d; `<14d` means renewal broke) | Better Stack / UptimeRobot SSL monitor |
| **6. Backend & Frontend Error Rate** | Sentry (`SENTRY_DSN`, `VITE_SENTRY_DSN`) | `0` unhandled `5xx` errors | `>= 5` unhandled `5xx` events in 5 minutes, or any new `fatal` / GL / ETA error | Sentry (free developer tier) |

---

## 2. Step-by-Step: Token-Authenticated `/api/status` & Free Uptime Monitor

### 2.1 Configure `UPTIME_STATUS_TOKEN` on the VPS

1. Generate a 32-byte random token:
   ```bash
   openssl rand -hex 32
   ```
2. Add it to `/opt/count-it-keep-it/.env` (keeping permissions `chmod 600`):
   ```dotenv
   UPTIME_STATUS_TOKEN=<generated-64-hex-token>
   UPTIME_STATUS_RATE_LIMIT_MAX=60
   UPTIME_STATUS_RATE_LIMIT_WINDOW_MS=60000
   ```
3. Restart the backend container:
   ```bash
   cd /opt/count-it-keep-it
   docker compose -f docker-compose.prod.yml up -d backend
   ```
4. Verify the endpoint behavior:
   - **No token** -> HTTP `401`:
     ```bash
     curl -i https://<SITE_ADDRESS>/api/status
     ```
   - **Valid token** -> HTTP `200` (when DB, storage, and backup <= 26h are all healthy) or HTTP `503` (when DB/storage fails OR last backup is missing/older than `BACKUP_MAX_AGE_HOURS`, default `26` hours):
     ```bash
     curl -i -H "Authorization: Bearer ${UPTIME_STATUS_TOKEN}" https://<SITE_ADDRESS>/api/status
     # Expected body (strictly 4 booleans, zero operational data):
     # {"ready":true,"database":true,"storage":true,"backupFresh":true}
     ```
   - Supports either `Authorization: Bearer <token>` or `X-Status-Token: <token>` header (constant-time SHA-256 comparison; never pass tokens in URL query strings).
   - Returns `404` when `UPTIME_STATUS_TOKEN` is unset.

### 2.2 Option A: Better Stack Uptime (Free Tier — supports custom headers + SSL + Email/Telegram)

1. Sign up at `https://betterstack.com/uptime` (free tier includes 10 monitors, 3-minute interval, custom HTTP headers, SSL expiry checks, and Email/Telegram integrations).
2. Create **Monitor 1 — Authenticated Status & Backup Freshness**:
   - **URL:** `https://<SITE_ADDRESS>/api/status`
   - **Alert us when:** URL becomes unavailable (HTTP status other than `200`) **OR** response does not contain `"backupFresh":true`
   - **Request headers:** `Authorization` = `Bearer <UPTIME_STATUS_TOKEN>`
   - **Check frequency:** `3 minutes`
   - **Confirmation period:** `2 consecutive failures` (avoids single-packet transient noise)
   - **SSL expiration alert:** `14 days` before expiration
3. Create **Monitor 2 — Public Readiness (`/api/health/ready`)**:
   - **URL:** `https://<SITE_ADDRESS>/api/health/ready`
   - **Alert us when:** HTTP status is not `200` or body does not contain `"ready"`
   - **Check frequency:** `3 minutes`
4. Connect alert channels under **Integrations**:
   - **Email:** add Primary Ops + Secondary Owner email addresses.
   - **Telegram:** connect the official Better Stack Telegram bot to your private ops group/chat.

### 2.3 Option B: UptimeRobot (Free Tier — 50 monitors, 5-minute interval)

1. Sign up at `https://uptimerobot.com`.
2. Create an **HTTP(s) / Keyword** monitor for `https://<SITE_ADDRESS>/api/health/ready` (keyword `"ready"`, 5-minute interval) — works on all UptimeRobot plans.
3. If your plan includes Custom HTTP Headers, also create a monitor for `https://<SITE_ADDRESS>/api/status` with header `Authorization: Bearer <UPTIME_STATUS_TOKEN>` and keyword `"backupFresh":true` (alerts on HTTP `503` whenever DB, storage, or backup freshness fails).
4. Under **My Settings -> Alert Contacts**, add Email and Telegram contacts and attach them to all monitors.

---

## 3. Step-by-Step: Dead-Man's-Switch Backups with Healthchecks.io (No Prometheus Required)

Why a dead-man's-switch matters: if the VPS freezes, systemd timer is disabled, or cron stops running, a failure-only script never executes and stays silent. **Healthchecks.io** expects a periodic ping and alerts you both when a run **misses its schedule** AND immediately when a script calls `<URL>/fail` with the error message.

### 3.1 Create Checks in Healthchecks.io (Free Tier: 20 Checks)

1. Create a free account at `https://healthchecks.io`.
2. Click **Add Check** for **Daily ERP Backup**:
   - **Name:** `ERP Daily Backup & Off-Site Sync`
   - **Schedule:** Cron `0 2 * * *` (Timezone: `UTC`) — matches `count-it-keep-it-backup.timer` / `BACKUP_CRON_SCHEDULE`
   - **Grace Time:** `2 hours` (if the `02:00 UTC` backup has not completed by `04:00 UTC`, Healthchecks.io fires an alert)
   - Copy the ping URL: `https://hc-ping.com/<daily-backup-uuid>`
3. Click **Add Check** for **Monthly Restore Drill**:
   - **Name:** `ERP Monthly Restore Drill`
   - **Period:** `31 days`, **Grace Time:** `2 days`
   - Copy the ping URL: `https://hc-ping.com/<restore-drill-uuid>`
4. (Optional) Click **Add Check** for **VPS Disk Space**:
   - **Name:** `ERP VPS Disk Space (<85%)`
   - **Period:** `1 hour`, **Grace Time:** `30 minutes`
   - Copy the ping URL: `https://hc-ping.com/<disk-check-uuid>`

### 3.2 Connect Email & Telegram Alerts in Healthchecks.io

1. Go to **Integrations -> Add Integration -> Email**:
   - Add the Primary Ops email and Secondary/Business Owner email.
   - Verify both confirmation links.
2. Go to **Integrations -> Add Integration -> Telegram**:
   - Click **Connect Telegram**, start a chat with `@HealthchecksBot` (or add `@HealthchecksBot` to a private Ops Telegram group), and send `/start` using the link provided by Healthchecks.io.
   - Verify the integration appears as **Active** and is assigned to all 3 checks above.
3. Click **Test** on both Email and Telegram integrations and confirm both primary and backup recipients receive the test message.

### 3.3 Wire the Ping URLs into `/opt/count-it-keep-it/.env`

```dotenv
HEALTHCHECK_PING_URL=https://hc-ping.com/<daily-backup-uuid>
RESTORE_DRILL_HEALTHCHECK_PING_URL=https://hc-ping.com/<restore-drill-uuid>
```

How each script uses these URLs:
- [backup-db.sh](../scripts/backup-db.sh): pings `POST ${HEALTHCHECK_PING_URL}` with timestamp/byte summary when both local backup and off-site upload succeed; on ANY failure (`pg_dump`, `pg_restore -l`, uploads archive, status write, or off-site upload), its `EXIT` trap automatically sends `POST ${HEALTHCHECK_PING_URL}/fail` with the redacted error text.
- [backup-offsite.mjs](../scripts/backup-offsite.mjs): when invoked directly (standalone), pings `HEALTHCHECK_PING_URL` (or `BACKUP_OFFSITE_HEALTHCHECK_PING_URL` if set) on success and `/fail` with the error on failure. When invoked by `backup-db.sh`, `backup-db.sh` owns the single final ping to `HEALTHCHECK_PING_URL` so Healthchecks.io receives exactly one ping per backup run.
- [monthly-restore-drill.mjs](../scripts/monthly-restore-drill.mjs): pings `RESTORE_DRILL_HEALTHCHECK_PING_URL` (falling back to `HEALTHCHECK_PING_URL`) on success with RPO/RTO/reconciliation summary, and `/fail` with the redacted error message on failure.

Test the live backup ping once after editing `.env`:
```bash
sudo systemctl start count-it-keep-it-backup.service
sudo journalctl -u count-it-keep-it-backup.service -n 50 --no-pager
```
Confirm the check turns green in Healthchecks.io and shows the backup summary payload.

---

## 4. Disk Space & TLS Certificate Monitoring

### 4.1 Lightweight Host Disk-Space Check (No Prometheus Required)

Create `/usr/local/bin/erp-disk-check.sh` (`chmod 750`):
```bash
#!/usr/bin/env bash
set -euo pipefail
PING_URL="${DISK_HEALTHCHECK_PING_URL:-}"
THRESHOLD="${DISK_ALERT_PCT:-85}"
REPORT="$(df -P / /var/backups/count-it-keep-it 2>/dev/null | awk 'NR==1 || !seen[$1]++')"
MAX_PCT="$(printf '%s\n' "$REPORT" | awk 'NR>1 {gsub(/%/,"",$5); if ($5+0 > m) m=$5+0} END {print m+0}')"
if (( MAX_PCT >= THRESHOLD )); then
  [[ -n "$PING_URL" ]] && curl -fsS -m 10 -X POST --data-binary "DISK CRITICAL (${MAX_PCT}% >= ${THRESHOLD}%):
${REPORT}" "${PING_URL%/}/fail" >/dev/null || true
  exit 1
fi
[[ -n "$PING_URL" ]] && curl -fsS -m 10 -X POST --data-binary "disk ok (max=${MAX_PCT}%):
${REPORT}" "${PING_URL%/}" >/dev/null || true
```

Add an hourly cron entry (`/etc/cron.d/erp-disk-check`):
```cron
15 * * * * root DISK_HEALTHCHECK_PING_URL="https://hc-ping.com/<disk-check-uuid>" /usr/local/bin/erp-disk-check.sh >/dev/null 2>&1
```

### 4.2 TLS Certificate Expiry Verification

Caddy automatically renews Let's Encrypt certificates ~30 days before expiry. In addition to Better Stack / UptimeRobot SSL expiry alerts (`14d` and `7d`), verify manually at any time:
```bash
echo | openssl s_client -servername <SITE_ADDRESS> -connect <SITE_ADDRESS>:443 2>/dev/null \
  | openssl x509 -noout -dates -subject
```

---

## 5. Sentry Error Rate Alerting

1. Create two projects in Sentry (or one project with environment tags): `erp-backend` (Node.js) and `erp-frontend` (React).
2. Set `SENTRY_DSN` in `/opt/count-it-keep-it/.env` (backend) and `VITE_SENTRY_DSN` in GitHub Actions repository variables (frontend build arg). Sensitive headers, cookies, DB URLs, passwords, PINs, MFA keys, and tokens are scrubbed automatically before leaving the server ([sentry.ts](../backend/src/observability/sentry.ts)).
3. Create **two Sentry Issue Alert rules** routed to Email + Telegram/Slack:
   - **Rule 1 (High Error Rate):** When an issue is seen **>= 5 times in 5 minutes** in `environment: production` -> send immediate notification.
   - **Rule 2 (Critical / Financial Path):** When a **new issue** is first seen with `level: fatal` OR matching route `/api/accounting/*`, `/api/imports/*`, `/api/einvoicing/*`, or `/api/pos/*` -> send immediate notification.

---

## 6. Post-Deploy Smoke Test Authentication & Read-Only Mode

### 6.1 How It Works & Why Admin Login Was Replaced

Previously, `scripts/smoke-test.mjs` logged in with `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` (`POST /api/auth/login`). That had two flaws:
1. **Broken when admin MFA is enabled:** When TOTP MFA is enabled on an admin account, `POST /api/auth/login` returns HTTP `200` with `{ "mfaRequired": true, "mfaChallengeToken": "..." }` and sets **no session cookie**, causing every subsequent check to fail with `401 Unauthorized`.
2. **Excessive privilege:** Storing full `admin` credentials in `.env` or CI secrets exposes full financial/user-management write privileges if the deploy file leaks.

### 6.2 Dedicated Least-Privilege `Smoke Monitor` User

Provision the dedicated service account once per environment:
```bash
npm run smoke:create-user -- --env-file /opt/count-it-keep-it/.env
```
Put the printed `SMOKE_USER_EMAIL` and `SMOKE_USER_PASSWORD` into `/opt/count-it-keep-it/.env` (`chmod 600`).

**Security properties & documented MFA exemption:**
- **Role:** `baseRole = "user"`, custom role `"Smoke Monitor"` (`isSystem = true`).
- **Zero write permissions:** Every module has `create = edit = delete = approve = false`; only `accounting.view`, `audit.view`, and `settings.view` are enabled, with `branchScopeMode = "selected"` and `0` assigned branches.
- **Server-side middleware read-only lock (`smokeMonitorReadOnlyHook`):** Every non-read-only HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) except `POST /api/auth/logout` is unconditionally rejected with `403 SMOKE_USER_READ_ONLY` — including `POST /api/audit-logs`, `POST /api/auth/change-password`, and `POST /api/auth/mfa/enroll`.
- **Production smoke mode (`--mode production`, default):** `scripts/smoke-test.mjs` refuses any `admin` or non-`Smoke Monitor` account, refuses any mutating HTTP call beyond login/logout, explicitly errors if `mfaRequired: true` is returned, verifies `/api/health/live`, `/api/health/ready`, `/api/status` (zero DB writes), `/api/accounting/reports/reconciliation` (8/8), `/api/accounting/setup-health`, `/api/audit-logs/verify`, `/api/admin/backups/freshness`, and revokes its ephemeral session via `POST /api/auth/logout`.
- **Why MFA exemption is safe here:** Automated deploy verification cannot enter interactive TOTP codes (and storing a TOTP seed beside the password in `.env` would negate MFA). Exempting *only* this strictly read-only, zero-branch, non-admin account — while enforcing a high-entropy 32-byte random password in `chmod 600` `.env`, Fastify rate limiting, and DB-backed account lockout — preserves full TOTP MFA on all human admin accounts without sacrificing automated verification.

---

## 7. Alert Routing & On-Call Escalation Matrix (Who Gets Alerted)

Fill in real names, emails, and Telegram handles before go-live and keep a copy in the team password manager.

| Alert | Primary Owner | Backup / Escalation (if unacked > 15m) | Channels | Target Response | Runbook Section |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **App Down / `/api/status` 503 (`ready=false`)** | System Administrator / DevOps Lead | Technical Co-Founder / CTO | Telegram + Email | 15 min | [INCIDENT_RUNBOOK.md §1](./INCIDENT_RUNBOOK.md) |
| **Daily Backup Missed or Failed (`HEALTHCHECK_PING_URL` / `backupFresh=false`)** | System Administrator / DevOps Lead | Finance / Operations Manager | Telegram + Email | Same day (< 4h) | [INCIDENT_RUNBOOK.md §5](./INCIDENT_RUNBOOK.md) |
| **Monthly Restore Drill Failed (`RESTORE_DRILL_HEALTHCHECK_PING_URL`)** | System Administrator / DevOps Lead | Technical Co-Founder / CTO | Email + Telegram | 24 hours | [BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md) |
| **VPS Disk Usage `>= 85%`** | System Administrator / DevOps Lead | Technical Co-Founder / CTO | Telegram + Email | 1 hour | [INCIDENT_RUNBOOK.md §1](./INCIDENT_RUNBOOK.md) |
| **TLS Certificate Expiry `< 14 days`** | System Administrator / DevOps Lead | Technical Co-Founder / CTO | Email + Telegram | 24 hours | [PRODUCTION_DEPLOYMENT_RUNBOOK.md](./PRODUCTION_DEPLOYMENT_RUNBOOK.md) |
| **Sentry 5xx Spike / Fatal Error** | Lead Backend Engineer | System Administrator | Email + Telegram | 30 min (business hours) | [INCIDENT_RUNBOOK.md §1](./INCIDENT_RUNBOOK.md) |
| **Reconciliation Mismatch / Audit Chain Failure / Key Leak** | Finance Manager + System Administrator | Company Director / Auditor | Email + Telegram (Immediate) | Immediate (< 15 min) | [INCIDENT_RUNBOOK.md §2–§3](./INCIDENT_RUNBOOK.md) |
