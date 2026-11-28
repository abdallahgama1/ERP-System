#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${REPO_ROOT}/.env"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
OVERLAY_COMPOSE_FILE=""
PROJECT_NAME=""
BACKEND_IMAGE_ARG=""
FRONTEND_IMAGE_ARG=""
RUN_BUILD=false
SKIP_BACKUP=false
SKIP_PUBLIC_CHECK=false
RUN_SMOKE_TEST=auto
DO_ROLLBACK=false
WAIT_TIMEOUT=60

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy.sh [options]

Safely deploys Count It Keep It ERP using docker-compose.prod.yml (plus an optional
staging overlay) with env validation, pre-deploy pg_dump backup, migrations,
health + smoke verification (health, ready, login, reconciliation), and automatic
or manual rollback to the previous image tags.

Options:
  --env-file <path>              Path to .env file (default: <repo>/.env)
  --compose-file <path>          Base Compose file (default: <repo>/docker-compose.prod.yml)
  --overlay-compose-file <path>  Optional Compose overlay (e.g. docker-compose.staging.yml)
  --project-name <name>          Optional Docker Compose project name (e.g. count-it-keep-it-staging)
  --backend-image <ref>          Pin and deploy a specific backend container image
  --frontend-image <ref>         Pin and deploy a specific frontend container image
  --build                        Build images locally on VPS instead of pulling
  --skip-backup                  Skip pre-deploy PostgreSQL backup
  --skip-public-check            Skip public https://SITE_ADDRESS/api/health/ready check
  --smoke-test                   Require running scripts/smoke-test.mjs (fails if creds missing)
  --skip-smoke-test              Skip scripts/smoke-test.mjs even if SMOKE_ADMIN_* is set
  --rollback                     Roll back to the previous known-good image tags from .last-good-images
  --timeout <seconds>            Compose health wait timeout in seconds (default: 60)
  -h, --help                     Show this help message
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "Error: --env-file requires a value." >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --compose-file)
      [[ $# -ge 2 ]] || { echo "Error: --compose-file requires a value." >&2; exit 2; }
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --overlay-compose-file)
      [[ $# -ge 2 ]] || { echo "Error: --overlay-compose-file requires a value." >&2; exit 2; }
      OVERLAY_COMPOSE_FILE="$2"
      shift 2
      ;;
    --project-name)
      [[ $# -ge 2 ]] || { echo "Error: --project-name requires a value." >&2; exit 2; }
      PROJECT_NAME="$2"
      shift 2
      ;;
    --backend-image)
      [[ $# -ge 2 ]] || { echo "Error: --backend-image requires a value." >&2; exit 2; }
      BACKEND_IMAGE_ARG="$2"
      shift 2
      ;;
    --frontend-image)
      [[ $# -ge 2 ]] || { echo "Error: --frontend-image requires a value." >&2; exit 2; }
      FRONTEND_IMAGE_ARG="$2"
      shift 2
      ;;
    --build)
      RUN_BUILD=true
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=true
      shift
      ;;
    --skip-public-check)
      SKIP_PUBLIC_CHECK=true
      shift
      ;;
    --smoke-test)
      RUN_SMOKE_TEST=true
      shift
      ;;
    --skip-smoke-test)
      RUN_SMOKE_TEST=false
      shift
      ;;
    --rollback)
      DO_ROLLBACK=true
      shift
      ;;
    --timeout)
      [[ $# -ge 2 ]] || { echo "Error: --timeout requires a value." >&2; exit 2; }
      WAIT_TIMEOUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]] || (( WAIT_TIMEOUT < 5 )); then
  echo "Error: --timeout must be an integer >= 5." >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: environment file not found: $ENV_FILE" >&2
  echo "Tip: copy .env.prod.example to .env, chmod 600 .env, and set production values." >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Error: compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [[ -n "$OVERLAY_COMPOSE_FILE" && ! -f "$OVERLAY_COMPOSE_FILE" ]]; then
  echo "Error: overlay compose file not found: $OVERLAY_COMPOSE_FILE" >&2
  exit 1
fi

read_env_var() {
  local file="$1"
  local key="$2"
  local raw_line val
  raw_line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$raw_line" ]]; then
    return 0
  fi
  val="${raw_line#*=}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ ( "$val" == \"* && "$val" == *\" ) || ( "$val" == \'* && "$val" == *\' ) ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp "${file}.tmp.XXXXXX")"
  UPSERT_KEY="$key" UPSERT_VAL="$value" awk '
    BEGIN {
      k = ENVIRON["UPSERT_KEY"]
      v = ENVIRON["UPSERT_VAL"]
      found = 0
    }
    $0 ~ "^[[:space:]]*" k "=" {
      if (!found) {
        print k "=" v
        found = 1
      }
      next
    }
    { print }
    END {
      if (!found) {
        print k "=" v
      }
    }
  ' "$file" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "$file"
  chmod 600 "$file"
}

SITE_ADDRESS="$(read_env_var "$ENV_FILE" "SITE_ADDRESS")"
DATABASE_URL_VAL="$(read_env_var "$ENV_FILE" "DATABASE_URL")"
DIRECT_DATABASE_URL_VAL="$(read_env_var "$ENV_FILE" "DIRECT_DATABASE_URL")"
AUTH_COOKIE_SECRET_VAL="$(read_env_var "$ENV_FILE" "AUTH_COOKIE_SECRET")"
PRE_DEPLOY_BACKUP_VAL="$(read_env_var "$ENV_FILE" "PRE_DEPLOY_BACKUP")"
REQUIRE_PRE_DEPLOY_BACKUP_VAL="$(read_env_var "$ENV_FILE" "REQUIRE_PRE_DEPLOY_BACKUP")"
BACKUP_DIR_VAL="$(read_env_var "$ENV_FILE" "BACKUP_DIR")"
BACKUP_RETENTION_DAYS_VAL="$(read_env_var "$ENV_FILE" "BACKUP_RETENTION_DAYS")"
BACKUP_MIN_KEEP_VAL="$(read_env_var "$ENV_FILE" "BACKUP_MIN_KEEP")"

if [[ -z "$SITE_ADDRESS" ]]; then
  echo "Error: SITE_ADDRESS must be set in $ENV_FILE." >&2
  exit 1
fi

if [[ -z "$DATABASE_URL_VAL" || "$DATABASE_URL_VAL" == *"USER:PASSWORD@"* ]]; then
  echo "Error: DATABASE_URL must be set to a real PostgreSQL URL in $ENV_FILE." >&2
  exit 1
fi

AUTH_SECRET_LOWER="$(printf '%s' "$AUTH_COOKIE_SECRET_VAL" | tr '[:upper:]' '[:lower:]')"
if [[ -z "$AUTH_COOKIE_SECRET_VAL" || ${#AUTH_COOKIE_SECRET_VAL} -lt 32 || "$AUTH_SECRET_LOWER" == *"replace-with"* || "$AUTH_SECRET_LOWER" == *"change-me"* ]]; then
  echo "Error: AUTH_COOKIE_SECRET in $ENV_FILE must be a real random string of at least 32 characters." >&2
  exit 1
fi

for cmd in docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

COMPOSE_ARGS=()
if [[ -n "$PROJECT_NAME" ]]; then
  COMPOSE_ARGS+=(-p "$PROJECT_NAME")
fi
COMPOSE_ARGS+=(-f "$COMPOSE_FILE")
if [[ -n "$OVERLAY_COMPOSE_FILE" ]]; then
  COMPOSE_ARGS+=(-f "$OVERLAY_COMPOSE_FILE")
fi
COMPOSE_ARGS+=(--env-file "$ENV_FILE")

HISTORY_FILE="${ENV_FILE}.last-good-images"

get_running_service_image() {
  local service="$1"
  local cid
  cid="$(docker compose "${COMPOSE_ARGS[@]}" ps -q "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || true
  fi
}

PREV_BACKEND_IMAGE="$(get_running_service_image backend)"
PREV_FRONTEND_IMAGE="$(get_running_service_image frontend)"

if [[ "$DO_ROLLBACK" == "true" ]]; then
  if [[ ! -f "$HISTORY_FILE" ]]; then
    echo "Error: no rollback history file found at $HISTORY_FILE." >&2
    exit 1
  fi
  ROLLBACK_BACKEND="$(read_env_var "$HISTORY_FILE" "PREV_BACKEND_IMAGE")"
  ROLLBACK_FRONTEND="$(read_env_var "$HISTORY_FILE" "PREV_FRONTEND_IMAGE")"
  if [[ -z "$ROLLBACK_BACKEND" || -z "$ROLLBACK_FRONTEND" ]]; then
    echo "Error: $HISTORY_FILE does not contain both PREV_BACKEND_IMAGE and PREV_FRONTEND_IMAGE." >&2
    exit 1
  fi
  echo "==> Manual rollback to previous known-good images:"
  echo "    Backend:  $ROLLBACK_BACKEND"
  echo "    Frontend: $ROLLBACK_FRONTEND"
  export BACKEND_IMAGE="$ROLLBACK_BACKEND"
  export FRONTEND_IMAGE="$ROLLBACK_FRONTEND"
  upsert_env_var "$ENV_FILE" "BACKEND_IMAGE" "$ROLLBACK_BACKEND"
  upsert_env_var "$ENV_FILE" "FRONTEND_IMAGE" "$ROLLBACK_FRONTEND"
  docker compose "${COMPOSE_ARGS[@]}" pull backend frontend
  RUN_MIGRATIONS=false docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"
  echo "==> Manual rollback completed (RUN_MIGRATIONS=false). Verify /api/health/ready and reconciliation."
  exit 0
fi

if [[ -n "$BACKEND_IMAGE_ARG" ]]; then
  export BACKEND_IMAGE="$BACKEND_IMAGE_ARG"
  upsert_env_var "$ENV_FILE" "BACKEND_IMAGE" "$BACKEND_IMAGE_ARG"
fi

if [[ -n "$FRONTEND_IMAGE_ARG" ]]; then
  export FRONTEND_IMAGE="$FRONTEND_IMAGE_ARG"
  upsert_env_var "$ENV_FILE" "FRONTEND_IMAGE" "$FRONTEND_IMAGE_ARG"
fi

TARGET_BACKEND_IMAGE="${BACKEND_IMAGE:-$(read_env_var "$ENV_FILE" "BACKEND_IMAGE")}"
TARGET_FRONTEND_IMAGE="${FRONTEND_IMAGE:-$(read_env_var "$ENV_FILE" "FRONTEND_IMAGE")}"

PRE_BACKUP_LOWER="$(printf '%s' "${PRE_DEPLOY_BACKUP_VAL:-true}" | tr '[:upper:]' '[:lower:]')"
REQ_BACKUP_LOWER="$(printf '%s' "${REQUIRE_PRE_DEPLOY_BACKUP_VAL:-false}" | tr '[:upper:]' '[:lower:]')"

if [[ "$SKIP_BACKUP" == "false" && "$PRE_BACKUP_LOWER" != "false" ]]; then
  BACKUP_SCRIPT="${REPO_ROOT}/scripts/backup-db.sh"
  BACKUP_TARGET_DIR="${BACKUP_DIR_VAL:-/var/backups/count-it-keep-it}"
  EFFECTIVE_BACKUP_URL="${DIRECT_DATABASE_URL_VAL:-$DATABASE_URL_VAL}"
  if [[ -f "$BACKUP_SCRIPT" ]] && command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
    echo "==> Running pre-deploy PostgreSQL backup..."
    DATABASE_URL="$EFFECTIVE_BACKUP_URL" \
      BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS_VAL:-14}" \
      BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP_VAL:-5}" \
      bash "$BACKUP_SCRIPT" "$BACKUP_TARGET_DIR"
  else
    if [[ "$REQ_BACKUP_LOWER" == "true" ]]; then
      echo "Error: REQUIRE_PRE_DEPLOY_BACKUP=true but pg_dump/pg_restore or backup-db.sh is unavailable." >&2
      exit 1
    fi
    echo "Warning: pg_dump/pg_restore unavailable on host; skipping pre-deploy database backup." >&2
  fi
fi

ROLLING_BACK=false
rollback() {
  local reason="$1"
  if [[ "$ROLLING_BACK" == "true" ]]; then
    exit 1
  fi
  ROLLING_BACK=true
  echo "Error: deployment failed ($reason)." >&2
  echo "==> Recent backend container logs:" >&2
  docker compose "${COMPOSE_ARGS[@]}" logs --tail=50 backend >&2 || true

  if [[ -n "$PREV_BACKEND_IMAGE" && -n "$PREV_FRONTEND_IMAGE" ]]; then
    echo "==> Rolling back to previous container images..." >&2
    export BACKEND_IMAGE="$PREV_BACKEND_IMAGE"
    export FRONTEND_IMAGE="$PREV_FRONTEND_IMAGE"
    upsert_env_var "$ENV_FILE" "BACKEND_IMAGE" "$PREV_BACKEND_IMAGE"
    upsert_env_var "$ENV_FILE" "FRONTEND_IMAGE" "$PREV_FRONTEND_IMAGE"

    if RUN_MIGRATIONS=false docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"; then
      echo "==> Rollback completed successfully (RUN_MIGRATIONS=false)." >&2
    else
      echo "Critical: automatic rollback also failed; manual intervention required." >&2
    fi
  else
    echo "Warning: no previous running backend/frontend images detected for automatic rollback." >&2
  fi
  exit 1
}

if [[ "$RUN_BUILD" == "true" ]]; then
  echo "==> Building backend and frontend images from source..."
  docker compose "${COMPOSE_ARGS[@]}" build --pull backend frontend
  echo "==> Pulling proxy image and starting stack..."
  docker compose "${COMPOSE_ARGS[@]}" pull caddy
  if ! docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"; then
    rollback "docker compose up --wait returned non-zero"
  fi
else
  echo "==> Pulling container images..."
  docker compose "${COMPOSE_ARGS[@]}" pull backend frontend caddy
  echo "==> Updating containers and waiting up to ${WAIT_TIMEOUT}s for healthchecks..."
  if ! docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"; then
    rollback "docker compose up --wait returned non-zero"
  fi
fi

echo "==> Verifying in-container /api/health/live..."
LIVE_BODY="$(docker compose "${COMPOSE_ARGS[@]}" exec -T backend wget -qO- http://127.0.0.1:3001/api/health/live 2>/dev/null || true)"
if ! printf '%s' "$LIVE_BODY" | grep -q '"live"'; then
  rollback "in-container /api/health/live check failed"
fi

echo "==> Verifying in-container /api/health/ready..."
READY_OK=false
for _ in $(seq 1 5); do
  READY_BODY="$(docker compose "${COMPOSE_ARGS[@]}" exec -T backend wget -qO- http://127.0.0.1:3001/api/health/ready 2>/dev/null || true)"
  if printf '%s' "$READY_BODY" | grep -q '"ready"' && printf '%s' "$READY_BODY" | grep -q '"ok"'; then
    READY_OK=true
    break
  fi
  sleep 3
done
if [[ "$READY_OK" != "true" ]]; then
  rollback "in-container /api/health/ready check failed"
fi

if [[ "$SKIP_PUBLIC_CHECK" == "false" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    rollback "curl not found for public HTTPS health check (pass --skip-public-check if intentional)"
  fi
  echo "==> Verifying public HTTPS endpoint https://${SITE_ADDRESS}/api/health/ready..."
  PUBLIC_OK=false
  for _ in $(seq 1 10); do
    if curl -fsS --max-time 10 "https://${SITE_ADDRESS}/api/health/ready" | grep -q '"ready"'; then
      PUBLIC_OK=true
      break
    fi
    sleep 3
  done
  if [[ "$PUBLIC_OK" != "true" ]]; then
    rollback "public https://${SITE_ADDRESS}/api/health/ready check failed"
  fi
fi

SMOKE_EMAIL_VAL="$(read_env_var "$ENV_FILE" "SMOKE_ADMIN_EMAIL")"
SMOKE_PASS_VAL="$(read_env_var "$ENV_FILE" "SMOKE_ADMIN_PASSWORD")"
SMOKE_SCRIPT="${REPO_ROOT}/scripts/smoke-test.mjs"
if [[ "$RUN_SMOKE_TEST" == "true" || ( "$RUN_SMOKE_TEST" == "auto" && -n "$SMOKE_EMAIL_VAL" && -n "$SMOKE_PASS_VAL" ) ]]; then
  if [[ ! -f "$SMOKE_SCRIPT" ]] || ! command -v node >/dev/null 2>&1; then
    rollback "smoke-test requested but node or scripts/smoke-test.mjs is unavailable"
  fi
  if [[ -z "$SMOKE_EMAIL_VAL" || -z "$SMOKE_PASS_VAL" ]]; then
    rollback "--smoke-test requested but SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD are empty in $ENV_FILE"
  fi
  echo "==> Running post-deploy smoke test (health, ready, login, reconciliation, setup-health, audit chain)..."
  if ! SMOKE_BASE_URL="https://${SITE_ADDRESS}" \
       SMOKE_ADMIN_EMAIL="$SMOKE_EMAIL_VAL" \
       SMOKE_ADMIN_PASSWORD="$SMOKE_PASS_VAL" \
       node "$SMOKE_SCRIPT"; then
    rollback "post-deploy smoke test failed"
  fi
fi

# Persist previous and current image refs for one-command --rollback
{
  echo "PREV_BACKEND_IMAGE=${PREV_BACKEND_IMAGE:-${TARGET_BACKEND_IMAGE:-}}"
  echo "PREV_FRONTEND_IMAGE=${PREV_FRONTEND_IMAGE:-${TARGET_FRONTEND_IMAGE:-}}"
  echo "CURRENT_BACKEND_IMAGE=${TARGET_BACKEND_IMAGE:-}"
  echo "CURRENT_FRONTEND_IMAGE=${TARGET_FRONTEND_IMAGE:-}"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${HISTORY_FILE}.tmp"
chmod 600 "${HISTORY_FILE}.tmp"
mv -f "${HISTORY_FILE}.tmp" "$HISTORY_FILE"

docker image prune -f >/dev/null 2>&1 || true

cat <<EOF

Deployment succeeded:
  Site:           https://${SITE_ADDRESS}
  Backend image:  ${TARGET_BACKEND_IMAGE:-<local build>}
  Frontend image: ${TARGET_FRONTEND_IMAGE:-<local build>}
  Health:         live + ready OK
EOF
