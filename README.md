# Count It Keep It — Enterprise Multi-Branch ERP

A self-hosted, multi-branch Enterprise Resource Planning (ERP) platform built with **TypeScript**, **Fastify**, **Drizzle ORM**, **PostgreSQL**, **React 18**, **TanStack Query**, **Tailwind CSS**, and **shadcn/ui** with full English (`LTR`) and Arabic (`RTL`) localization.

---

## Architecture

The repository is an npm workspace monorepo:

- **`packages/shared` (`@erp/shared`)** — Single source of truth for Zod validation schemas, domain status constants, role/module permission defaults, GL mapping keys, and deterministic WMAC/pricing helpers.
- **`backend/`** — Fastify 5 API + Drizzle ORM (`69` PostgreSQL tables) with thin HTTP route adapters (`src/routes/`) delegating to transactional domain services (`src/services/`), atomic row locking (`SELECT ... FOR UPDATE`), SSE real-time cache invalidation (`/api/events`), `@fastify/helmet`, `@fastify/rate-limit`, and optional SMTP email delivery (`nodemailer`).
- **`frontend/`** — Vite + React 18 + TanStack Query + shadcn/ui with lazy route code splitting, `ErrorBoundary`, targeted SSE invalidation, PDF generation (`jspdf` + ZATCA QR), and full `en`/`ar` i18n (`RTL`).

---

## Core Modules

- **Self-Hosted Auth & RBAC:** `node:crypto` `scrypt` password hashing, HTTP-only `erp_session` cookies backed by `user_sessions`, first-user serialized admin bootstrap (`pg_advisory_xact_lock`), role/module permission matrix (`admin | manager | user`), and branch-level isolation (`all | selected`).
- **Multi-Branch Inventory & Stock Ops:** WMAC costing, branch transfers with shortage resolution (`return_to_source | write_off_in_transit | backorder`), stock adjustments, write-offs, barcode-enabled stock-take count sessions, and immutable `stock_movements` ledger.
- **Lot/Batch FEFO & Serial Lifecycle Tracking:** `FEFO` / `FIFO` / `LIFO` automatic lot allocation, expired-lot blocking on sales, 30-day expiry alerting, unique serial numbers, transfer re-homing, and full chain-of-custody tracing.
- **Procure-to-Pay (P2P):** Vendors, Purchase Orders, Goods Receipts (`GRNI`), Vendor Bills with proportional Purchase Price Variance (`PPV`) allocation, Payments Made, and Purchase Returns.
- **Order-to-Cash (O2C) & E-Invoicing:** Customers with atomic `FOR UPDATE` credit-limit enforcement (`NULL` unlimited / `0` strict COD / capped), Sales Orders, Invoices with ZATCA Phase-1 Base64 TLV QR + SHA-256 hash chaining (UI + PDF), Received Payments, Retainers, and Sales Returns.
- **Double-Entry General Ledger:** Seeded 16-account Chart of Accounts (`1000..5900` including `1220 WIP Inventory`), fiscal years & period locking (`FISCAL_PERIOD_LOCKED`), manual & automated journals, non-destructive reversals, Trial Balance, Profit & Loss, Balance Sheet, and Account Ledger.
- **Enterprise Controls & Manufacturing:** Opt-in maker-checker approval workflows (`approval_rules`, `approval_requests`), scheduled + admin-triggered Overdue & Lot Expiry Sweep, multi-component Bills of Materials (`BOM`) with DFS cycle detection, and Work Orders (`Issue` → `1220 WIP` → `Complete` / `Cancel`).

---

## Local Quickstart

### Prerequisites
- **Node.js 20+** (22 LTS recommended)
- **PostgreSQL 16+** (local or hosted such as [Neon](https://neon.tech))

### 1. Configure Environment
Copy `backend/.env.example` to `backend/.env` and set `DATABASE_URL` (and optionally `TEST_DATABASE_URL` pointing to an isolated test database):

```bash
cp backend/.env.example backend/.env
```

### 2. Install & Migrate
```bash
npm install
npm run db:migrate
```

### 3. Run Development Servers
```bash
# Cross-platform
npm run dev

# Or on Windows
start.bat
```

- Frontend: `http://localhost:8080`
- Backend API: `http://127.0.0.1:3001` (health check: `GET /api/health`)

> The first account registered via `/signup` automatically becomes `admin` with `'all'` branch scope and seeds default company settings, HQ branch, tax code, Chart of Accounts, fiscal calendar, and document sequences.

---

## Production Deployment (Docker & Compose)

The included [docker-compose.yml](./docker-compose.yml) runs `frontend` (Nginx with SPA routing & `/api` SSE reverse proxy), `backend` (Fastify with auto-migration on boot), and an optional `postgres:17-alpine` container.

### Option A — Self-Contained Stack (Bundled PostgreSQL)
```bash
export AUTH_COOKIE_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build
```
Access the ERP at `http://localhost:8080`.

### Option B — External Managed PostgreSQL (Neon / RDS / Supabase)
Set `DATABASE_URL` and `AUTH_COOKIE_SECRET` (32+ random chars) in your environment or `.env`, then start only `backend` and `frontend`:
```bash
export DATABASE_URL="postgresql://USER:PASS@HOST/DB?sslmode=require"
export AUTH_COOKIE_SECRET="$(openssl rand -hex 32)"
docker compose up -d --build backend frontend
```

---

## Verification & Testing

```bash
# TypeScript typechecking across @erp/shared, backend, and frontend
npm run typecheck

# ESLint across all workspaces (0 errors, 0 warnings)
npm run lint

# Vitest unit + PostgreSQL integration tests (uses TEST_DATABASE_URL)
npm test

# Full-stack Playwright E2E suite (Auth, P2P, O2C, ZATCA QR, GL, Approvals, Tracking, BOM/WO & Arabic RTL)
npm run test:e2e

# Production build
npm run build
```

### Database Migration Workflow
```bash
# After editing backend/drizzle/schema.ts
npm run db:generate
npm run db:migrate
```
