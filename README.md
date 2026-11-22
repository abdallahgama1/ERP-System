# Count It Keep It — Enterprise Multi-Branch ERP & POS

A self-hosted, multi-branch Enterprise Resource Planning (ERP) and Point-of-Sale (POS) platform built with **TypeScript**, **Fastify**, **Drizzle ORM**, **PostgreSQL**, **React 18**, **TanStack Query**, **Tailwind CSS**, and **shadcn/ui** with full English (`LTR`) and Arabic (`RTL`) localization.

> **Complete Handbook:** See **[docs/SETUP_AND_OPERATIONS_GUIDE.md](./docs/SETUP_AND_OPERATIONS_GUIDE.md)** for the full step-by-step guide covering **Local Development**, **Production VPS + Managed Postgres Setup**, **GitHub Actions CI/CD**, **Container Control**, and **Troubleshooting**.

---

## Architecture

The repository is an npm workspace monorepo:

- **`packages/shared` (`@erp/shared`)** — Single source of truth for Zod validation schemas, domain status constants, role/module permission defaults, POS/ETA e-invoicing contracts, offset/cursor pagination helpers, and deterministic WMAC/pricing helpers.
- **`backend/`** — Fastify 5 API + Drizzle ORM (**77** PostgreSQL tables, migrations `0000`–`0006`) with thin HTTP route adapters (`src/routes/`) delegating to transactional domain services (`src/services/`), atomic row locking (`SELECT ... FOR UPDATE`), CSRF origin protection, `/api/health/live` & `/api/health/ready`, bearer-protected Prometheus `/api/metrics`, SSE real-time cache invalidation (`/api/events`), optional Sentry, and advisory-locked schedulers. Compiled via `esbuild` (`backend/dist/server.mjs`, `backend/dist/migrate.mjs`).
- **`frontend/`** — Vite + React 18 + TanStack Query + shadcn/ui PWA (`vite-plugin-pwa`) with lazy route code splitting, `ErrorBoundary`, targeted SSE invalidation, POS Cashier Register Mode (`/pos`), PDF generation (`jspdf` + ZATCA QR), optional lazy Sentry, and full `en`/`ar` i18n (`RTL`).

---

## Core Modules

- **Self-Hosted Auth & RBAC:** `node:crypto` `scrypt` password hashing, HTTP-only `erp_session` cookies backed by `user_sessions`, first-user serialized admin bootstrap (`pg_advisory_xact_lock`), role/module permission matrix (`admin | manager | user`), and branch-level isolation (`all | selected`).
- **POS / Cashier Register Mode (`/pos` PWA):** Terminal binding, shift float open/close reconciliation (`pay_in`, `pay_out`, `safe_drop`), split tenders, camera/keyboard barcode scanning, offline IndexedDB outbox + idempotent sync, recent receipts drawer + 80mm/58mm thermal reprint, atomic POS returns/refunds (`POSR-`) with reversing GL, and manager PIN overrides without switching active cashier sessions.
- **ETA Egypt (مصلحة الضرائب المصرية) & ZATCA E-Invoicing:** ZATCA Phase-1 Base64 TLV QR + SHA-256 hash chaining, plus ETA e-Receipt v1.2 canonical payloads (`'S'` sales & `'R'` return receipts), OAuth2 submission/polling client, exponential-backoff retry worker, and **Admin → E-Invoice Queue** (`/admin/einvoicing`).
- **Multi-Branch Inventory & Stock Ops:** WMAC costing, branch transfers with shortage resolution (`return_to_source | write_off_in_transit | backorder`), stock adjustments, write-offs, barcode-enabled stock-take count sessions, and immutable `stock_movements` ledger.
- **Lot/Batch FEFO & Serial Lifecycle Tracking:** `FEFO` / `FIFO` / `LIFO` automatic lot allocation, expired-lot blocking on sales, 30-day expiry alerting, unique serial numbers, transfer re-homing, and full chain-of-custody tracing.
- **Procure-to-Pay (P2P) & Order-to-Cash (O2C):** Vendors, Purchase Orders, Goods Receipts (`GRNI`), Vendor Bills with proportional Purchase Price Variance (`PPV`), Payments Made, Purchase Returns, Customers with atomic `FOR UPDATE` credit limits, Sales Orders, Invoices, Received Payments, Retainers, and Sales Returns.
- **Double-Entry General Ledger & Enterprise Controls:** Seeded 16-account Chart of Accounts (`1000..5900`), fiscal period locking (`FISCAL_PERIOD_LOCKED`), manual & automated journals, reversals, Trial Balance, P&L, Balance Sheet, maker-checker approvals, BOM & Work Orders (`1220 WIP`), and advisory-locked background sweeps/housekeeping.

---

## Documentation

| Document | Audience & Scope |
|---|---|
| **[docs/SETUP_AND_OPERATIONS_GUIDE.md](./docs/SETUP_AND_OPERATIONS_GUIDE.md)** | **Master handbook**: Local setup (native & Docker), Production VPS bootstrap (`vps-setup.sh`), `.env` secrets, GitHub Actions CI/CD, Docker Compose control commands, backups/restore, ETA/Prometheus/Sentry, and troubleshooting. |
| **[docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md](./docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md)** | Concise production VPS deployment, upgrade/rollback, backup/restore, and GitHub Actions CD reference. |
| **[docs/WALKTHROUGH.md](./docs/WALKTHROUGH.md)** | Hardened production-grade implementation summary and directly observed verification metrics. |

---

## Local Quickstart

### Prerequisites
- **Node.js 22 LTS** (Node 20+ supported)
- **PostgreSQL 16+** (hosted e.g. [Neon](https://neon.tech) or local Postgres / Docker)

> **Windows PowerShell note:** Use `npm.cmd` / `npx.cmd` if Windows execution policy restricts `npm.ps1`.

### 1. Native Hot-Reload Mode
```bash
cp backend/.env.example backend/.env   # Set DATABASE_URL (and optional TEST_DATABASE_URL)
npm install
npm run db:migrate
npm run dev                             # Or run setup.bat then start.bat on Windows
```

- **ERP Web UI:** `http://localhost:8080`
- **POS Cashier Register:** `http://localhost:8080/pos`
- **Backend API Health:** `http://127.0.0.1:3001/api/health/ready`

> The first account registered via `/signup` automatically becomes `admin` with `'all'` branch scope and seeds default company settings, HQ branch, tax code, Chart of Accounts, fiscal calendar, and document sequences.

### 2. Local Docker Compose Stack
```bash
unset DATABASE_URL
export AUTH_COOKIE_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```
*(In PowerShell: `$env:AUTH_COOKIE_SECRET="local-dev-secret-at-least-32-characters"; Remove-Item Env:DATABASE_URL -EA SilentlyContinue; docker compose up -d --build`.)*

Access the containerized stack at `http://localhost:8080`.

---

## Production VPS Deployment (Quick Overview)

See **[docs/SETUP_AND_OPERATIONS_GUIDE.md](./docs/SETUP_AND_OPERATIONS_GUIDE.md#part-3--production-grade-vps--managed-postgresql-setup)** for full instructions:
1. On Ubuntu 22.04/24.04 or Debian 12, run [scripts/vps-setup.sh](./scripts/vps-setup.sh) to install Docker, Compose v2, `postgresql-client`, UFW, `/opt/count-it-keep-it/.env` (from [.env.prod.example](./.env.prod.example)), and daily backup cron.
2. Fill in `SITE_ADDRESS`, `DATABASE_URL` (Managed PostgreSQL with `?sslmode=require`), `AUTH_COOKIE_SECRET`, `CORS_ORIGIN`, `APP_BASE_URL`, and `METRICS_TOKEN`.
3. Deploy and verify via [scripts/deploy.sh](./scripts/deploy.sh) (supports both `--build` and GHCR image tags with pre-deploy `pg_dump` backup, health checks, and automatic rollback), or automate releases via [.github/workflows/cd.yml](./.github/workflows/cd.yml).

---

## Verification & Testing

```bash
# TypeScript typechecking across @erp/shared, backend, and frontend
npm run typecheck

# ESLint across all workspaces (0 errors, 0 warnings)
npm run lint

# Vitest unit tests (no Postgres required)
npm run test:unit

# Full Vitest suite (shared + backend unit & real-Postgres integration via TEST_DATABASE_URL + frontend)
npm test

# Full-stack Playwright browser E2E suite (install Chromium once with: npx playwright install chromium)
npm run test:e2e

# Node 22 load & 20-way POS stock-lock concurrency stress test
npm run test:load

# Compiled backend JS (backend/dist/server.mjs + migrate.mjs) & Vite PWA frontend build
npm run build
```

### Database Migration Workflow
```bash
# After editing backend/drizzle/schema.ts
npm run db:generate
npm run db:migrate
```
