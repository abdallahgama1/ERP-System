# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for clean Docker layer caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --workspace=@erp/shared --workspace=erp-backend --include-workspace-root=false

COPY packages/shared ./packages/shared
COPY backend ./backend

RUN npm --prefix packages/shared run typecheck \
  && npm --prefix backend run build

FROM node:22-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --omit=dev --workspace=@erp/shared --workspace=erp-backend --include-workspace-root=false \
  && npm cache clean --force

COPY --from=builder --chown=node:node /app/backend/dist ./backend/dist
COPY --from=builder --chown=node:node /app/backend/drizzle/migrations ./backend/drizzle/migrations

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    TRUST_PROXY=true \
    RUN_MIGRATIONS=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health/live >/dev/null || exit 1

CMD ["sh", "-c", "if [ \"${RUN_MIGRATIONS:-true}\" = \"true\" ]; then node backend/dist/migrate.mjs; fi && exec node backend/dist/server.mjs"]
