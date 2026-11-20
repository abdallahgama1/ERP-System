# AGENTS.md

## Architecture

- Project is split into three npm workspaces coordinated from root `package.json`:
  - `packages/shared/` (`@erp/shared`) — Single source of truth for Zod request schemas, domain status constants, role/module permission matrix defaults, and deterministic WMAC/pricing helpers shared across frontend and backend.
  - `backend/` — Fastify + TypeScript + Drizzle ORM + `postgres` (`postgresql://...` via `DATABASE_URL` in `backend/.env`). Organized into thin HTTP adapters (`src/routes/`) delegating to pure transactional domain services (`src/services/`).
  - `frontend/` — Vite + React + TypeScript + Tailwind CSS + shadcn/ui + TanStack Query with lazy route code splitting, `ErrorBoundary`, and targeted SSE invalidation (`src/hooks/queries/queryKeys.ts`).
- Auth lives in `backend/src/auth/` (`node:crypto` `scrypt` + HTTP-only `erp_session` cookie backed by `public.user_sessions`) and `frontend/src/contexts/AuthContext.tsx`. Never reintroduce `@lovable.dev/cloud-auth-js`, mock `src/lib/api/auth.ts`, or Supabase OAuth. Why: 100% self-hosted ownership of authentication and sessions.
- Roles (`admin`, `manager`, `user`) live in `public.user_roles`, module permissions live in `public.role_permissions`, and multi-branch visibility lives in `public.user_branch_scopes` + `public.user_branches`; never store roles on user-editable profile fields. Why: prevents privilege escalation and branch isolation bypasses.
- Multi-branch ERP scope is single-company with multiple branches (`hq_warehouse | warehouse | retail`). Operational writes execute server-side inside `db.transaction()` with `document_sequences` (`SELECT ... FOR UPDATE`) + atomic `branch_products` locks (`applyBranchStockMovement`), appending immutable `stock_movements` and `audit_logs`.
- The first account to sign up becomes `admin` with `'all'` branch scope automatically (serialized via `pg_advisory_xact_lock`); later accounts start as `user` with `'selected'` branch scope. Why: bootstraps admin access safely without a manual seed script.
- Zero runtime demo seeders or hardcoded client fallback catalogs: baseline company settings, HQ branch, tax code, document sequences, and base units of measure are seeded server-side idempotently in `ensureSeededDefaults`.

## Agentic Development Rules

- **Schema & Contracts First:** Add/modify request validation schemas, statuses, and permission constants in `packages/shared/src/`, never duplicating them separately in `backend/` and `frontend/`.
- **Thin Routes / Service Layer:** Keep `backend/src/routes/*.ts` strictly focused on parsing via `parseOrThrow(...)`, middleware auth/permission checks, calling `backend/src/services/*.ts`, broadcasting SSE events, and formatting HTTP responses.
- **Database Migrations:** Keep Drizzle ORM (`backend/drizzle/schema.ts`); run `npm run db:generate` after schema updates before pushing/migrating (`npm run db:migrate`). Never edit applied migration SQL files retroactively.
- **Verification Gate Before Finishing:** Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` after edits.
