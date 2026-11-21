#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/restore-db.sh [--yes|-y] <backup-file>

Restores a PostgreSQL backup (.dump, .sql.gz, or .sql) into TARGET_DATABASE_URL
or DATABASE_URL. Verifies SHA-256 checksum and archive integrity before restoring.

Safety guards (one required to proceed with destructive --clean restore):
  --yes / -y             Skip interactive prompt
  RESTORE_CONFIRM=YES    Non-interactive confirmation environment variable
  Interactive TTY        Type exact 'RESTORE' when prompted

Required environment variable:
  TARGET_DATABASE_URL    Target PostgreSQL URL (falls back to DATABASE_URL in env;
                         intentionally does NOT auto-read backend/.env)
EOF
}

AUTO_YES=false
BACKUP_FILE=""

while (( $# > 0 )); do
  case "$1" in
    --yes|-y)
      AUTO_YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$BACKUP_FILE" ]]; then
        echo "Error: unexpected extra argument '$1'" >&2
        usage >&2
        exit 2
      fi
      BACKUP_FILE="$1"
      shift
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$BACKUP_FILE" || ! -s "$BACKUP_FILE" ]]; then
  echo "Error: backup file does not exist or is empty: $BACKUP_FILE" >&2
  exit 1
fi

TARGET_URL="${TARGET_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$TARGET_URL" ]]; then
  echo "Error: TARGET_DATABASE_URL (or DATABASE_URL) must be explicitly set in environment." >&2
  echo "Refusing to auto-read backend/.env for destructive restore." >&2
  exit 1
fi

SHA_FILE="${BACKUP_FILE}.sha256"
if [[ ! -f "$SHA_FILE" ]]; then
  echo "Error: checksum file missing: $SHA_FILE" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$(dirname "$BACKUP_FILE")"
    sha256sum -c "$(basename "$SHA_FILE")"
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "$(dirname "$BACKUP_FILE")"
    shasum -a 256 -c "$(basename "$SHA_FILE")"
  )
else
  echo "Error: neither 'sha256sum' nor 'shasum' found in PATH." >&2
  exit 1
fi

FORMAT=""
case "$BACKUP_FILE" in
  *.dump)
    FORMAT="custom"
    if ! command -v pg_restore >/dev/null 2>&1; then
      echo "Error: 'pg_restore' not found in PATH." >&2
      exit 1
    fi
    echo "Validating custom-format archive TOC..."
    pg_restore -l "$BACKUP_FILE" >/dev/null
    ;;
  *.sql.gz)
    FORMAT="sql_gz"
    for cmd in gunzip psql; do
      if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: '$cmd' not found in PATH." >&2
        exit 1
      fi
    done
    echo "Validating gzip archive integrity..."
    gzip -t "$BACKUP_FILE"
    ;;
  *.sql)
    FORMAT="sql"
    if ! command -v psql >/dev/null 2>&1; then
      echo "Error: 'psql' not found in PATH." >&2
      exit 1
    fi
    ;;
  *)
    echo "Error: unsupported backup extension (expected .dump, .sql.gz, or .sql): $BACKUP_FILE" >&2
    exit 1
    ;;
esac

REDACTED_TARGET="$(printf '%s' "$TARGET_URL" | sed -E 's#(postgres(ql)?://[^:/@]+):[^@]+@#\1:[REDACTED]@#')"

echo "WARNING: Destructive restore (--clean --if-exists) about to run:"
echo "  Backup: $BACKUP_FILE"
echo "  Target: $REDACTED_TARGET"
echo "  Tip:    Stop backend containers/workers first (e.g., docker compose -f docker-compose.prod.yml stop backend)."

if [[ "$AUTO_YES" == "true" || "${RESTORE_CONFIRM:-}" == "YES" ]]; then
  :
elif [[ -t 0 ]]; then
  read -r -p "Type RESTORE to confirm destructive database restore: " REPLY
  if [[ "$REPLY" != "RESTORE" ]]; then
    echo "Restore aborted by operator." >&2
    exit 1
  fi
else
  echo "Error: refusing destructive restore without --yes, RESTORE_CONFIRM=YES, or interactive confirmation." >&2
  exit 1
fi

case "$FORMAT" in
  custom)
    pg_restore \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --single-transaction \
      --exit-on-error \
      --dbname="$TARGET_URL" \
      "$BACKUP_FILE"
    ;;
  sql_gz)
    gunzip -c "$BACKUP_FILE" | psql -v ON_ERROR_STOP=1 --single-transaction "$TARGET_URL"
    ;;
  sql)
    psql -v ON_ERROR_STOP=1 --single-transaction "$TARGET_URL" -f "$BACKUP_FILE"
    ;;
esac

echo "Database restore completed successfully into $REDACTED_TARGET"
