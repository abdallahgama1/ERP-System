FROM node:22-alpine AS base
WORKDIR /app

# Copy workspace manifests first for clean Docker layer caching
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --workspace=@erp/shared --workspace=erp-backend --include-workspace-root=false

COPY packages/shared ./packages/shared
COPY backend ./backend

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV TRUST_PROXY=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = \"true\" ]; then npm --prefix backend run db:migrate; fi && exec npm --prefix backend run start"]
