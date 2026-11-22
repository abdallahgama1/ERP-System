# Count It Keep It ERP — Complete Setup, Deployment & Operations Guide

The single authoritative handbook for **Count It Keep It ERP**: covering system/container architecture, local development (native hot-reload and local Docker Compose), production VPS + Managed PostgreSQL deployment, GitHub Actions CI/CD, day-to-day container control, backups/restore, third-party integrations, and troubleshooting.

> **Quick links:** [Repository README](../README.md) · [Production Deployment Runbook](./PRODUCTION_DEPLOYMENT_RUNBOOK.md) · [Verification Walkthrough](./WALKTHROUGH.md)

---

## Table of Contents

1. [Part 1 — System Architecture & Container Topology](#part-1--system-architecture--container-topology)
2. [Part 2 — Local Development Environment Setup](#part-2--local-development-environment-setup)
   - [Option A: Native Hot-Reload Development (`npm run dev`)](#option-a-native-hot-reload-development-npm-run-dev)
   - [Option B: Local Docker Compose (`docker-compose.yml`)](#option-b-local-docker-compose-docker-composeyml)
   - [Database Schema & Drizzle Migration Workflow](#database-schema--drizzle-migration-workflow)
   - [Verification, Testing, Load & Build Gate](#verification-testing-load--build-gate)
3. [Part 3 — Production-Grade VPS & Managed PostgreSQL Setup](#part-3--production-grade-vps--managed-postgresql-setup)
   - [Step 1: Managed PostgreSQL (Neon or AWS RDS with PITR)](#step-1-managed-postgresql-neon-or-aws-rds-with-pitr)
   - [Step 2: VPS & DNS Prerequisites](#step-2-vps--dns-prerequisites)
   - [Step 3: One-Command VPS Bootstrap (`scripts/vps-setup.sh`)](#step-3-one-command-vps-bootstrap-scriptsvps-setupsh)
   - [Step 4: Production `.env` Configuration (`.env.prod.example`)](#step-4-production-env-configuration-envprodexample)
   - [Step 5: First Boot, Health Checks & First-User Admin Bootstrap](#step-5-first-boot-health-checks--first-user-admin-bootstrap)
4. [Part 4 — Automated CI/CD (GitHub Actions + GHCR + VPS SSH Deploy)](#part-4--automated-cicd-github-actions--ghcr--vps-ssh-deploy)
5. [Part 5 — Complete Control & Operations Playbook](#part-5--complete-control--operations-playbook)
   - [Container Lifecycle Commands](#container-lifecycle-commands)
   - [Logs, Live Diagnostics & Resource Monitoring](#logs-live-diagnostics--resource-monitoring)
   - [Safe Upgrades & Rollbacks (`scripts/deploy.sh`)](#safe-upgrades--rollbacks-scriptsdeploysh)
   - [Database Backups, Verification & Restore Drills](#database-backups-verification--restore-drills)
   - [Background Workers & Operational Admin Jobs](#background-workers--operational-admin-jobs)
6. [Part 6 — Integrations & Observability](#part-6--integrations--observability)
7. [Part 7 — Troubleshooting Quick Reference](#part-7--troubleshooting-quick-reference)

---

## Part 1 — System Architecture & Container Topology

### Monorepo Workspaces (`package.json`)
- **`packages/shared` (`@erp/shared`)** — Single source of truth for Zod validation schemas, domain statuses, RBAC module permission defaults, POS / e-invoicing contracts, offset/cursor pagination helpers, and deterministic pricing/WMAC helpers.
- **`backend/` (`erp-backend`)** — Fastify 5 + TypeScript + Drizzle ORM + `postgres` across **77** PostgreSQL tables (`backend/drizzle/schema.ts`, SQL migrations `0000`–`0006`). Compiled for production containers via `esbuild` (`backend/scripts/build.mjs`) into `backend/dist/server.mjs` and `backend/dist/migrate.mjs`.
- **`frontend/` (`erp-frontend`)** — Vite + React 18 + TypeScript + Tailwind CSS + shadcn/ui + TanStack Query + `vite-plugin-pwa`, featuring back-office ERP routes, full English (`LTR`) / Arabic (`RTL`) localization, and offline-capable **POS / Cashier Register Mode** (`/pos`) backed by IndexedDB.

### How the Containers Run (Separate Containers on One Domain)

Frontend (`nginx:1.27-alpine`), backend (`node:22-alpine`), and reverse proxy (`caddy:2-alpine`) run in **separate containers** connected over a private Docker network, not bundled inside one monolithic container:

```text
                        ┌──────────────────────────────────────────────┐
                        │  Managed PostgreSQL (Neon / AWS RDS w/ PITR) │
                        └──────────────────────▲───────────────────────┘
                                               │ TLS (?sslmode=require)
Internet (:80/:443)                            │
   │                                           │
   ▼                                           │
┌─────────────────────────┐    /api/*     ┌────┴──────────────────────────────┐
│  1. caddy container     ├──────────────►│  2. backend container             │
│     (caddy:2-alpine)    │  (API, SSE,   │     (node:22-alpine, non-root)    │
│ • Public ports 80/443   │   metrics)    │ • Internal port 3001 only         │
│ • Auto Let's Encrypt TLS│               │ • Runs migrate.mjs on boot        │
│ • HTTP → HTTPS redirect │               │ • Serves Fastify server.mjs       │
└────────────┬────────────┘               │ • Advisory-locked workers:        │
             │                            │   overdue/expiry, housekeeping,   │
             │ /* (SPA, /pos, assets)     │   ETA e-Receipt v1.2 retry queue  │
             ▼                            └───────────────────────────────────┘
┌─────────────────────────┐
│  3. frontend container  │
│     (nginx:1.27-alpine) │
│ • Internal port 80 only │
│ • Strict CSP + HSTS     │
│ • no-cache PWA headers  │
└─────────────────────────┘
```

Why this separation matters:
- **Zero CORS / Cookie headaches:** Caddy exposes both containers under one public HTTPS origin (`https://<SITE_ADDRESS>`), keeping HTTP-only `erp_session` cookies, CSRF origin enforcement, and SSE `/api/events` strictly same-origin.
- **Minimal runtime footprint:** `frontend` serves only static assets with Nginx (`no-cache` on `/index.html`, `/sw.js`, `/registerSW.js`, `/manifest.webmanifest`), while `backend` runs compiled ESM JavaScript as unprivileged user `node` without Vite or `tsx`.
- **No Redis required:** Scheduled background jobs run inside the backend and coordinate cleanly via PostgreSQL advisory locks (`pg_advisory_xact_lock`).

### Mode Comparison

| Mode | File / Entrypoint | Database | URL | Intended Use |
|---|---|---|---|---|
| **Native Hot-Reload Dev** | `npm run dev` (or `start.bat`) | Local Postgres or Neon (`backend/.env`) | `http://localhost:8080` | Daily feature development, Vite HMR, Fastify `tsx watch` |
| **Local Docker Stack** | `docker-compose.yml` | Bundled `postgres:17-alpine` (or external `DATABASE_URL`) | `http://localhost:8080` | Testing production Dockerfiles, Nginx headers, migrations, and containers locally |
| **Production VPS Stack** | `docker-compose.prod.yml` + `Caddyfile` | Managed PostgreSQL (Neon / AWS RDS w/ PITR) | `https://<SITE_ADDRESS>` | Production & Staging deployments with auto-HTTPS and GHCR images |

---

## Part 2 — Local Development Environment Setup

### Prerequisites
- **Node.js 22 LTS** (Node 20+ minimum; Node 22 matches CI and container runtime).
- **PostgreSQL 16 or 17** — either a hosted serverless Postgres branch (e.g., [Neon](https://neon.tech)) or local Docker (`docker-compose.yml`).
- **Docker Desktop / Docker Engine + Compose v2** — required only if running containers locally (`docker-compose.yml`).

> **Windows PowerShell Note:** If Windows execution policy blocks `npm` (`npm.ps1 cannot be loaded`), invoke **`npm.cmd`** and **`npx.cmd`** (e.g., `npm.cmd run dev`, `npx.cmd playwright test`). Also keep `"rollup": "4.24.0"` pinned in root `package.json` (`devDependencies` + `overrides`) so Windows Application Control does not reject native Rollup bindings.

---

### Option A: Native Hot-Reload Development (`npm run dev`)

1. **Create backend environment config** from [backend/.env.example](../backend/.env.example):
   ```bash
   cp backend/.env.example backend/.env
   ```
   On Windows PowerShell:
   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```
   Edit `backend/.env` and set your PostgreSQL URLs (do **not** wrap values in quotes):
   - `DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require` — development database used by the backend server and Drizzle CLI.
   - `TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/TEST_DBNAME?sslmode=require` — **recommended isolated test database**, because integration and Playwright E2E specs truncate/reset `TEST_DATABASE_URL`.
   - Leave `HOST=127.0.0.1`, `PORT=3001`, `CORS_ORIGIN=http://localhost:8080`, `APP_BASE_URL=http://localhost:8080`, `NODE_ENV=development`.

2. **Install dependencies and apply Drizzle migrations:**
   ```bash
   npm install
   npm run db:migrate
   ```
   *(If `TEST_DATABASE_URL` points to a separate database, migrate it as well by setting `DATABASE_URL` to your test URL for a one-off `npm run db:migrate` run.)*

   **Windows shortcut:** Run [setup.bat](../setup.bat) to install workspace dependencies, typecheck, and verify the frontend build, then edit `backend\.env`, run `npm.cmd run db:migrate`, and start the stack with [start.bat](../start.bat).

3. **Start both Vite frontend and Fastify backend:**
   ```bash
   npm run dev
   ```
   - **ERP Web UI:** `http://localhost:8080` (Vite proxies `/api/*` directly to `http://127.0.0.1:3001`)
   - **POS Cashier Register Mode:** `http://localhost:8080/pos`
   - **Backend Liveness / Readiness:** `http://127.0.0.1:3001/api/health/live` and `http://127.0.0.1:3001/api/health/ready`

4. **Bootstrap the first Admin account:**
   Open `http://localhost:8080/signup` and create the first account. Signup uses `pg_advisory_xact_lock` so the very first registered account automatically receives the `admin` role with `'all'` branch scope and idempotently seeds baseline company settings, HQ branch, tax code, 16-account Chart of Accounts, fiscal periods, and document sequences (`ensureSeededDefaults`).

---

### Option B: Local Docker Compose (`docker-compose.yml`)

Use [docker-compose.yml](../docker-compose.yml) to run the compiled backend and Nginx SPA container locally without Caddy TLS.

#### Sub-option B1 — Fully Self-Contained (Bundled PostgreSQL 17 Container)

Make sure `DATABASE_URL` is **unset** in your current terminal so the `backend` container connects to the internal `postgres` service, and set a 32+ character `AUTH_COOKIE_SECRET` in memory (avoid creating a root `.env` unless ignored cleanly):

- **Windows PowerShell:**
  ```powershell
  $env:AUTH_COOKIE_SECRET = "local-docker-dev-secret-at-least-32-chars"
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  docker compose up -d --build
  ```
- **Linux / macOS / Git Bash:**
  ```bash
  unset DATABASE_URL
  export AUTH_COOKIE_SECRET="$(openssl rand -hex 32)"
  docker compose up -d --build
  ```

Wait for healthchecks (`docker compose ps`), then open **`http://localhost:8080`**. On boot, the backend container runs `node backend/dist/migrate.mjs` (`RUN_MIGRATIONS=true`) before starting `node backend/dist/server.mjs`.

To tear down the local Docker stack (append `-v` if you also want to wipe the `erp_pgdata` volume):
```bash
docker compose down
```

#### Sub-option B2 — Local Docker Containers Against External Managed PostgreSQL

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require"
$env:AUTH_COOKIE_SECRET = "local-docker-dev-secret-at-least-32-chars"
docker compose up -d --build backend frontend
```

*(Change `APP_PORT=8085`, `CORS_ORIGIN=http://localhost:8085`, and `APP_BASE_URL=http://localhost:8085` if port `8080` is already in use locally.)*

---

### Database Schema & Drizzle Migration Workflow

1. Modify tables or indexes in [backend/drizzle/schema.ts](../backend/drizzle/schema.ts).
2. Generate a new forward-only SQL migration:
   ```bash
   npm run db:generate
   ```
3. Apply pending migrations:
   ```bash
   npm run db:migrate
   ```

> **Rule (`AGENTS.md`):** Never edit applied SQL files (`0000`–`0006`) retroactively; always generate a new sequential migration.

---

### Verification, Testing, Load & Build Gate

Run these commands from the repository root (replace `npm` / `npx` with `npm.cmd` / `npx.cmd` in Windows PowerShell):

```bash
# 1. TypeScript compilation across @erp/shared, backend, and frontend
npm run typecheck

# 2. ESLint (must pass with 0 errors and 0 warnings)
npm run lint

# 3. Unit tests only (fast, no Postgres required)
npm run test:unit

# 4. Full Vitest suite (shared + backend unit & real-Postgres integration + frontend RTL/jsdom)
npm test

# 5. Playwright full-stack browser E2E suite (install Chromium once first)
npx playwright install chromium
npm run test:e2e

# 6. Node 22 load & 20-way POS stock-lock concurrency benchmark (scripts/load-test.mjs)
npm run test:load

# 7. Compiled backend (backend/dist/server.mjs + migrate.mjs) & Vite PWA production build
npm run build
```

---

## Part 3 — Production-Grade VPS & Managed PostgreSQL Setup

### Step 1: Managed PostgreSQL (Neon or AWS RDS with PITR)

#### Option 1A: Neon Serverless PostgreSQL (Recommended for lean ops)
1. Create a production project on Neon (PostgreSQL 17 recommended) and enable **Point-In-Time Recovery (PITR)** / Branch Restore retention.
2. Copy **two connection strings** (both ending with `?sslmode=require`):
   - **Pooled connection string** (`-pooler.` hostname): set as `DATABASE_URL` in `.env` for app traffic. (`backend/src/db/index.ts` automatically disables prepared statements when `-pooler.` is present.)
   - **Direct connection string** (non-pooler hostname): set as `DIRECT_DATABASE_URL` in `.env` so `scripts/backup-db.sh`, `scripts/restore-db.sh`, and `pg_dump` bypass PgBouncer transaction-pooling limits.

#### Option 1B: AWS RDS for PostgreSQL
1. Provision PostgreSQL 16 or 17 (Multi-AZ recommended) with **Automated Backups** enabled (7–35 days) for PITR.
2. Enforce TLS in the parameter group (`rds.force_ssl=1`) and append `?sslmode=require` to `DATABASE_URL`.
3. Restrict Security Group inbound `5432/tcp` strictly to the VPS static public IP.

---

### Step 2: VPS & DNS Prerequisites

- **OS:** Ubuntu 22.04 / 24.04 LTS or Debian 12 with SSH access and `sudo` privileges.
- **DNS:** Point `A` (and optional `AAAA`) records for your domain (e.g., `erp.example.com`) to the VPS public IP **before** starting Caddy so Let's Encrypt ACME HTTP-01/TLS-ALPN-01 challenges succeed immediately.
- **Ports:** Allow only `22/tcp` (SSH), `80/tcp` (ACME + HTTPS redirect), `443/tcp` (HTTPS), and `443/udp` (HTTP/3 QUIC). Never expose ports `3001` or `5432` publicly.

---

### Step 3: One-Command VPS Bootstrap (`scripts/vps-setup.sh`)

SSH into your fresh VPS and run [scripts/vps-setup.sh](../scripts/vps-setup.sh):

```bash
curl -fsSLO https://raw.githubusercontent.com/abdallahgama1/ERP-System/main/scripts/vps-setup.sh
sudo bash vps-setup.sh --app-dir /opt/count-it-keep-it --user deploy
```

Supported flags: `--app-dir`, `--backup-dir` (default `/var/backups/count-it-keep-it`), `--repo`, `--branch` (default `main`), `--user` (default `$SUDO_USER` or `deploy`), `--skip-firewall`, `--skip-cron`.

`vps-setup.sh` idempotently performs the following:
1. Installs `ca-certificates`, `curl`, `gnupg`, `git`, `ufw`, `postgresql-client`, Docker Engine, Buildx, and Docker Compose v2 (`docker-compose-plugin`).
2. Creates the `deploy` user (if missing) and adds it to the `docker` group.
3. Enables UFW (`default deny incoming`, allows `22/tcp`, `80/tcp`, `443/tcp`, `443/udp`).
4. Clones the repository into `/opt/count-it-keep-it`, marks `scripts/*.sh` executable, creates `/var/backups/count-it-keep-it` (`chmod 700`), and copies [.env.prod.example](../.env.prod.example) to `/opt/count-it-keep-it/.env` (`chmod 600`).
5. Installs daily `02:00 UTC` automated backups (`/usr/local/bin/count-it-keep-it-backup`, `/etc/cron.d/count-it-keep-it-backup`) and log rotation (`/etc/logrotate.d/count-it-keep-it-backup` for `/var/log/erp-backup.log`).

---

### Step 4: Production `.env` Configuration (`.env.prod.example`)

Generate strong cryptographic secrets on the VPS:
```bash
openssl rand -hex 32   # Use for AUTH_COOKIE_SECRET
openssl rand -hex 24   # Use for METRICS_TOKEN
```

Edit `/opt/count-it-keep-it/.env` (keep permissions `chmod 600 .env`; never commit to git). All keys below match [backend/src/config.ts](../backend/src/config.ts), [.env.prod.example](../.env.prod.example), [docker-compose.prod.yml](../docker-compose.prod.yml), and [scripts/deploy.sh](../scripts/deploy.sh):

> **Important:** The backend reads `AUTH_COOKIE_SECRET`, `CORS_ORIGIN`, and `APP_BASE_URL` (not `SESSION_SECRET` or `APP_ORIGIN`). In `production`, startup is aborted if `AUTH_COOKIE_SECRET` is missing, shorter than 32 characters, or still a placeholder.

| Variable | Required in Prod | Default | Description |
|---|---|---|---|
| `SITE_ADDRESS` | **Yes** | `erp.example.com` | Public domain served by Caddy with automatic Let's Encrypt HTTPS. |
| `BACKEND_IMAGE` | Pull mode | `ghcr.io/abdallahgama1/erp-system-backend:latest` | Backend container image ref (pinned automatically by `scripts/deploy.sh`). |
| `FRONTEND_IMAGE` | Pull mode | `ghcr.io/abdallahgama1/erp-system-frontend:latest` | Frontend container image ref (pinned automatically by `scripts/deploy.sh`). |
| `DATABASE_URL` | **Yes** | — | Managed PostgreSQL URL (`?sslmode=require`). |
| `DIRECT_DATABASE_URL` | Recommended (Neon) | `""` | Non-pooler Postgres URL preferred by `scripts/deploy.sh` & backup cron for `pg_dump`. |
| `AUTH_COOKIE_SECRET` | **Yes** | — | Random secret (`>= 32` chars). |
| `CORS_ORIGIN` | **Yes** | `https://${SITE_ADDRESS}` | Allowed origin(s) for CORS + CSRF validation; `https://...` triggers `Secure` cookies when `COOKIE_SECURE=auto`. |
| `APP_BASE_URL` | **Yes** | `https://${SITE_ADDRESS}` | Canonical public URL for password-reset links. |
| `NODE_ENV` | Yes (Compose sets) | `production` | Must be `production`. |
| `HOST` / `PORT` | No | `0.0.0.0` / `3001` | Internal backend listen host/port inside container. |
| `TRUST_PROXY` | Yes (Compose sets) | `true` | Enables reading `X-Forwarded-*` headers from Caddy. |
| `RUN_MIGRATIONS` | No | `true` | Runs `node backend/dist/migrate.mjs` before starting `server.mjs`. |
| `COOKIE_SECURE` | No | `auto` | `auto`, `true`, or `false`. |
| `LOG_LEVEL` | No | `info` | Pino level (`fatal \| error \| warn \| info \| debug \| trace`). |
| `SESSION_COOKIE_NAME` | No | `erp_session` | HTTP-only session cookie name. |
| `SESSION_TTL_DAYS` | No | `30` | Session lifetime in days. |
| `METRICS_TOKEN` | Recommended | `""` | Bearer token for `GET /api/metrics` (endpoint returns `404` when unset, `401` if invalid). |
| `SENTRY_DSN` | Optional | `""` | Backend Sentry DSN (secrets & tokens scrubbed automatically). |
| `SENTRY_ENVIRONMENT` | Optional | `production` | Backend Sentry environment tag. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | `0` | Trace sample rate (`0`–`1`). |
| `VITE_API_BASE_URL` / `VITE_SENTRY_DSN` / `VITE_SENTRY_ENVIRONMENT` | Optional | `""` / `""` / `production` | Build-time Vite variables (`frontend/Dockerfile`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Optional | `""` / `587` / `false` | SMTP mail delivery for password resets and overdue/expiry alerts. |
| `ETA_CLIENT_ID` / `ETA_CLIENT_SECRET` | Optional | `""` | Egyptian Tax Authority e-Receipt v1.2 OAuth2 client credentials. |
| `ETA_ID_BASE_URL` / `ETA_API_BASE_URL` | Optional | Pre-prod URLs | Use `https://id.eta.gov.eg` & `https://api.invoicing.eta.gov.eg` for ETA live production. |
| `PRE_DEPLOY_BACKUP` / `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` / `BACKUP_MIN_KEEP` | No | `true` / `/var/backups/count-it-keep-it` / `14` / `5` | Used by `scripts/deploy.sh`, `scripts/backup-db.sh`, and daily cron. |

---

### Step 5: First Boot, Health Checks & First-User Admin Bootstrap

Log in as the `deploy` user (or switch with `su - deploy`) and deploy:

```bash
cd /opt/count-it-keep-it

# Option 1: Build images directly on the VPS (pass --skip-backup on a fresh empty database)
bash ./scripts/deploy.sh --build --skip-backup

# Option 2: Pull prebuilt images from GHCR (requires `docker login ghcr.io` for private repos)
docker login ghcr.io
bash ./scripts/deploy.sh --skip-backup
```

Verify the stack and public TLS endpoint:
```bash
docker compose -f docker-compose.prod.yml ps
curl -fsS https://erp.example.com/api/health/live
curl -fsS https://erp.example.com/api/health/ready
```

Then immediately open **`https://erp.example.com/signup`** and register your **first Admin user** (auto-assigned `admin` + `'all'` branch scope + default Company/Branch/GL seed).

---

## Part 4 — Automated CI/CD (GitHub Actions + GHCR + VPS SSH Deploy)

Two GitHub Actions workflows automate quality gates, image publishing, and zero-guesswork VPS deployments:
- **[.github/workflows/ci.yml](../.github/workflows/ci.yml):** Runs on every push/PR to `main` and `erp-main`: `verify` (typecheck, lint, Drizzle migrate, Vitest suite on Postgres 17, build), `security-audit` (`npm audit --omit=dev`), `e2e` (Playwright Chromium full-stack E2E), and `docker-build` (Buildx + `/api/health/live` smoke test + Trivy scan).
- **[.github/workflows/cd.yml](../.github/workflows/cd.yml):** Runs on version tags (`v*.*.*`) or manual **Actions → Deploy (CD) → Run workflow** (`staging` / `production`), executing `verify` → `publish` (multi-stage images tagged with `sha-<short>` & semver pushed to `ghcr.io/<owner>/erp-system-backend` and `erp-system-frontend` + Trivy `CRITICAL` gate) → `deploy` (SSH into VPS and invoke `scripts/deploy.sh`).

### 1. Create a Dedicated SSH Deploy Key (Run Once on VPS or Workstation)
```bash
# Generate an ED25519 key pair for CI deploys
ssh-keygen -t ed25519 -C "github-actions-erp-deploy" -f ~/.ssh/erp_deploy_ed25519 -N ""

# Add the public key to the VPS deploy user's authorized_keys:
#   cat erp_deploy_ed25519.pub >> /home/deploy/.ssh/authorized_keys
#   chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# Capture the VPS SSH host key for strict host verification (VPS_SSH_KNOWN_HOSTS):
ssh-keyscan -p 22 -H YOUR_VPS_IP_OR_HOST
```

### 2. Configure GitHub Environments (`staging` & `production`)
Under **GitHub Repository → Settings → Environments**, create `staging` and `production` (optionally require manual reviewer approval on `production`) and configure:

| Name | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `VPS_HOST` | Secret | For SSH deploy | — | VPS IP or hostname. If left empty, CD publishes & scans GHCR images and skips SSH cleanly. |
| `VPS_USER` | Secret | Optional | `deploy` | SSH login user on the VPS (member of `docker` group). |
| `VPS_SSH_KEY` | Secret | When `VPS_HOST` set | — | Contents of the private key (`erp_deploy_ed25519`). |
| `VPS_PORT` | Secret | Optional | `22` | SSH port on the VPS. |
| `VPS_SSH_KNOWN_HOSTS` | Secret | Recommended | `ssh-keyscan` | Pinned host key output for `StrictHostKeyChecking=yes`. |
| `VPS_APP_DIR` | Secret | Optional | `/opt/count-it-keep-it` | Directory holding `.env`, `docker-compose.prod.yml`, `Caddyfile`, and `scripts/`. |
| `GHCR_READ_TOKEN` | Secret | Private repos | `GITHUB_TOKEN` | GitHub PAT (`read:packages` scope) so the VPS can pull private GHCR images. |
| `VITE_SENTRY_DSN` | Variable | Optional | `""` | Baked into Vite frontend assets at image build time. |
| `VITE_API_BASE_URL` | Variable | Optional | `""` | Optional API origin override baked into Vite assets (empty = same-origin `/api`). |

### 3. Triggering a Release
- **Tag-based production release:**
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
- **Manual staging or production deploy:** In GitHub → **Actions** → **Deploy (CD)** → **Run workflow**, select `staging` or `production`, `deploy: true`, and optionally `skip_backup`.

---

## Part 5 — Complete Control & Operations Playbook

Run all production commands from `/opt/count-it-keep-it` on the VPS (prefix with `-f docker-compose.prod.yml`).

### Container Lifecycle Commands

```bash
# View container states, uptime, ports, and (healthy) status
docker compose -f docker-compose.prod.yml ps

# Start or stop all 3 containers (preserves Caddy /data TLS certs)
docker compose -f docker-compose.prod.yml start
docker compose -f docker-compose.prod.yml stop

# Restart a single service cleanly
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml restart frontend

# Apply .env edits (docker compose restart does NOT reload .env; recreate the container!)
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backend

# Reload Caddy reverse-proxy config with zero downtime after editing Caddyfile
docker compose -f docker-compose.prod.yml exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

# Shut down and remove containers (volumes like caddy_data stay intact UNLESS -v is passed — avoid -v in prod!)
docker compose -f docker-compose.prod.yml down
```

### Logs, Live Diagnostics & Resource Monitoring

```bash
# Follow structured Pino JSON logs from the backend (last 100 lines)
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend

# Filter logs over the last 30 minutes across Nginx and Caddy
docker compose -f docker-compose.prod.yml logs --since=30m frontend caddy

# Live CPU, memory, network, and disk I/O per container
docker stats

# Confirm backend runs unprivileged as uid=1000(node)
docker compose -f docker-compose.prod.yml exec -T backend id

# Test in-container health probes directly (bypassing external DNS/TLS)
docker compose -f docker-compose.prod.yml exec -T backend wget -qO- http://127.0.0.1:3001/api/health/live
docker compose -f docker-compose.prod.yml exec -T backend wget -qO- http://127.0.0.1:3001/api/health/ready

# Run Drizzle migrations manually inside a running backend container if RUN_MIGRATIONS=false
docker compose -f docker-compose.prod.yml exec -T backend node backend/dist/migrate.mjs

# Inspect Docker disk footprint and prune unused dangling images
docker system df
docker image prune -f
```

### Safe Upgrades & Rollbacks (`scripts/deploy.sh`)

[scripts/deploy.sh](../scripts/deploy.sh) handles every upgrade safely:
1. Validates `.env` (`SITE_ADDRESS`, `DATABASE_URL`, `AUTH_COOKIE_SECRET` ≥ 32 chars, non-placeholder).
2. Records `PREV_BACKEND_IMAGE` and `PREV_FRONTEND_IMAGE` from running containers.
3. Runs a pre-deploy `pg_dump` backup via `scripts/backup-db.sh` (using `DIRECT_DATABASE_URL` when configured, unless `--skip-backup` or `PRE_DEPLOY_BACKUP=false`).
4. Pulls new images (or builds with `--build`), updates `.env` `BACKEND_IMAGE`/`FRONTEND_IMAGE` cleanly (`chmod 600`), and waits up to `--timeout` seconds (default `60`) for healthchecks.
5. Verifies `/api/health/live`, `/api/health/ready`, and public `https://$SITE_ADDRESS/api/health/ready` (disable external check during local/staging DNS bring-up with `--skip-public-check`).
6. **Automatic Rollback:** If containers fail to become healthy or health probes fail, `deploy.sh` prints the last 50 backend log lines, restores previous `BACKEND_IMAGE` / `FRONTEND_IMAGE` refs in `.env`, and re-launches the previous healthy images with `RUN_MIGRATIONS=false`.

- **Manual rollback to a previous immutable GHCR release (`sha-<short>`):**
  ```bash
  bash ./scripts/deploy.sh \
    --backend-image ghcr.io/abdallahgama1/erp-system-backend:sha-<previous> \
    --frontend-image ghcr.io/abdallahgama1/erp-system-frontend:sha-<previous>
  ```
- **Schema-affecting rollback:** Because migrations `0000`–`0006` are forward-only SQL, restore your database dump (via `scripts/restore-db.sh`) or use Neon/RDS PITR to the timestamp right before the migration, then deploy the previous application image tag.

### Database Backups, Verification & Restore Drills

- **Scheduled automated backups:** Installed by `scripts/vps-setup.sh` at `02:00 UTC` daily via `/etc/cron.d/count-it-keep-it-backup`; outputs go to `/var/log/erp-backup.log`. Each dump produces `erp_backup_<UTC>.dump` (PostgreSQL custom compressed format validated with `pg_restore -l`) plus `erp_backup_<UTC>.dump.sha256`.
- **Manual on-demand backup:**
  ```bash
  DATABASE_URL='postgresql://USER:PASSWORD@DIRECT_HOST:5432/DBNAME?sslmode=require' \
    ./scripts/backup-db.sh /var/backups/count-it-keep-it
  ```
- **Off-site replication:** Sync `/var/backups/count-it-keep-it` after each cron run to encrypted object storage (S3, Backblaze B2, Cloudflare R2 via `rclone` or `aws s3 sync`) so VPS disk failure cannot lose backups.
- **Full restore drill ([scripts/restore-db.sh](../scripts/restore-db.sh)):**
  ```bash
  # 1. Stop backend API & background workers before restoring
  docker compose -f docker-compose.prod.yml stop backend

  # 2. Verify SHA-256 + TOC and restore atomically (--clean --if-exists --single-transaction)
  TARGET_DATABASE_URL='postgresql://USER:PASSWORD@DIRECT_HOST:5432/DBNAME?sslmode=require' \
    ./scripts/restore-db.sh /var/backups/count-it-keep-it/erp_backup_20261122T020000Z.dump

  # 3. Restart backend (auto-checks migrations) and confirm readiness
  docker compose -f docker-compose.prod.yml start backend
  curl -fsS https://erp.example.com/api/health/ready
  ```
  *(Pass `--yes` or `RESTORE_CONFIRM=YES` only in non-interactive automated restore drills.)*

### Background Workers & Operational Admin Jobs

All background jobs run inside `backend` and lock via PostgreSQL advisory locks (safe even if temporarily overlapped):

| Worker / Job | Schedule (`backend/src/index.ts`) | Manual Trigger | Effect |
|---|---|---|---|
| **Overdue & Lot Expiry Sweep** | Every `6 hours` | `POST /api/admin/jobs/overdue-sweep` (Admin UI button / API) | Marks past-due sales invoices & vendor bills overdue and raises 30-day lot expiry notifications. |
| **Database Housekeeping** | Every `6 hours` | `POST /api/admin/jobs/housekeeping` (`pg_try_advisory_xact_lock(882419)`) | Purges expired/old revoked `user_sessions`, expired/used `password_reset_tokens`, and expired `idempotency_keys`. |
| **ETA e-Receipt v1.2 Queue Worker** | Every `60 seconds` | **Admin → E-Invoice Queue** (`/admin/einvoicing`) or `POST /api/einvoicing/submissions/process-now` | Submits pending `'S'` (sale) and `'R'` (return) receipts and polls `'submitted'` batches with exponential backoff (`1m → 5m → 15m → 60m → 6h`, max 5 attempts) when ETA credentials are configured. |

---

## Part 6 — Integrations & Observability

### 1. Egyptian Tax Authority (`مصلحة الضرائب المصرية` — ETA e-Receipt v1.2)
- While `ETA_CLIENT_ID` and `ETA_CLIENT_SECRET` are unset, checkout and POS returns still compute canonical e-receipt payloads/UUIDs and queue records safely as `'pending'` without failing or making external network calls (`etaConfigured: false` in `/admin/einvoicing`).
- When onboarding to ETA Pre-Prod (or Live Prod):
  1. Set `ETA_CLIENT_ID`, `ETA_CLIENT_SECRET`, `ETA_ID_BASE_URL` (`https://id.preprod.eta.gov.eg` or `https://id.eta.gov.eg`), and `ETA_API_BASE_URL` (`https://api.preprod.invoicing.eta.gov.eg` or `https://api.invoicing.eta.gov.eg`) in `.env` and recreate `backend`.
  2. In **Settings**, set `einvoicingMode` to `eta_egypt` and fill your Legal Company Name & Egyptian RIN (`taxRegistrationNumber`).
  3. On each POS Terminal, configure `etaPosSerial`, `etaPosOsVersion`, and `etaActivityCode`.
  4. Monitor, inspect JSON payloads, and retry failed/rejected receipts in **Administration → E-Invoice Queue** (`/admin/einvoicing`).

### 2. Prometheus Metrics (`/api/metrics`)
- Protected by bearer token using constant-time SHA-256 comparison (`backend/src/observability/metrics.ts`). Returns `404` whenever `METRICS_TOKEN` is unset and `401` on invalid bearer tokens.
- Exports Node/process default metrics plus `http_requests_total`, `http_request_duration_seconds`, `erp_auth_events_total`, `erp_db_errors_total`, `erp_housekeeping_runs_total`, and `erp_housekeeping_purged_rows_total`.
- Example `prometheus.yml` scrape config:
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
- Test manually:
  ```bash
  curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://erp.example.com/api/metrics | head -n 20
  ```

### 3. Sentry Error Tracking (Optional)
- Backend activates `@sentry/node` only when `SENTRY_DSN` is set; frontend lazy-loads `@sentry/react` (`frontend/src/lib/observability/sentry.ts`) only when `VITE_SENTRY_DSN` is baked in at build time.
- Both automatically scrub sensitive headers (`cookie`, `authorization`, `x-api-key`), passwords, PINs, reset tokens, and connection strings. [frontend/nginx.conf](../frontend/nginx.conf) CSP already permits `*.ingest.sentry.io`, `*.ingest.us.sentry.io`, and `*.ingest.de.sentry.io`.

### 4. SMTP Transactional Email (Optional)
- Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` to send forgot-password reset tokens and operational alerts.

---

## Part 7 — Troubleshooting Quick Reference

| Symptom | Likely Cause | Fix |
|---|---|---|
| **`403 CSRF_ORIGIN_FORBIDDEN`** on `POST`/`PUT`/`DELETE` | Browser `Origin`/`Referer` doesn't match `CORS_ORIGIN` or `APP_BASE_URL` (e.g., `http://127.0.0.1` vs `http://localhost`, or missing `https://`). | Set `CORS_ORIGIN` and `APP_BASE_URL` in `.env` to exact `https://<SITE_ADDRESS>` (or `http://localhost:8080` locally), then recreate `backend`. |
| **Backend container exits on boot with `AUTH_COOKIE_SECRET` error** | `NODE_ENV=production` rejects missing, `<32` char, or placeholder cookie secrets. | Run `openssl rand -hex 32`, update `AUTH_COOKIE_SECRET` in `.env`, and run `docker compose -f docker-compose.prod.yml up -d --force-recreate backend`. |
| **`/api/metrics` returns `404`** | `METRICS_TOKEN` is empty/unset in `.env`. | Generate `openssl rand -hex 24`, set `METRICS_TOKEN=...` in `.env`, and force-recreate `backend`. |
| **Caddy fails to issue Let's Encrypt HTTPS certificate** | DNS `A`/`AAAA` does not point to VPS yet, or ports `80`/`443` are blocked by cloud security group/UFW. | Verify DNS propagation (`dig +short erp.example.com`) and UFW/cloud firewall ports `80/tcp`, `443/tcp`, `443/udp`, then check `docker compose -f docker-compose.prod.yml logs caddy`. |
| **Migrations or `pg_dump` fail against Neon `-pooler.` URL** | Transaction pooling restricts advisory/DDL locks or long `pg_dump` snapshots. | Set `DIRECT_DATABASE_URL` (Neon non-pooler host) in `.env` for backups/restore, and use the direct URL when running `migrate.mjs` if pooler limits occur. |
| **Login succeeds then immediately logs out over HTTPS or HTTP** | `COOKIE_SECURE=true` used on plain `http://` localhost, OR `CORS_ORIGIN` uses `http://` behind HTTPS. | Keep `COOKIE_SECURE=auto`, ensure `TRUST_PROXY=true` behind Nginx/Caddy, and match `CORS_ORIGIN` scheme (`https://` in prod, `http://` locally). |
| **Old UI / PWA still cached after deploy** | Browser cache-control or old SW. | Verify `curl -I https://erp.example.com/sw.js` and `/index.html` show `Cache-Control: no-store, no-cache, must-revalidate` (enforced by [frontend/nginx.conf](../frontend/nginx.conf)). |
| **Windows `npm.ps1 cannot be loaded` or `ERR_DLOPEN_FAILED` on Rollup** | PowerShell script execution restriction, or unpinned newer Rollup `.node` binary blocked by Windows App Control. | Always run `npm.cmd` / `npx.cmd` in Windows PowerShell and keep `"rollup": "4.24.0"` pinned in root `package.json`. |
