#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/restore-db.sh [--yes|-y] [--uploads <uploads.tar.gz>] [--uploads-volume <vol> | --uploads-dir <dir>] <backup-file>

Restores a PostgreSQL backup (.dump, .sql.gz, or .sql) into TARGET_DATABASE_URL
or DATABASE_URL, and optionally restores a companion erp_uploads (.tar.gz) archive
into a Docker volume or local directory. Verifies SHA-256 checksums and archive
integrity before performing any destructive restore.

Safety guards (one required to proceed with destructive --clean restore):
  --yes / -y             Skip interactive prompt
  RESTORE_CONFIRM=YES    Non-interactive confirmation environment variable
  Interactive TTY        Type exact 'RESTORE' when prompted

Required environment variable:
  TARGET_DATABASE_URL    Target PostgreSQL URL (falls back to DATABASE_URL in env;
                         intentionally does NOT auto-read backend/.env)

Optional uploads restore options/env vars:
  --uploads <file>       Companion erp_uploads_*.tar.gz archive (or UPLOADS_ARCHIVE)
  --uploads-volume <vol> Target Docker volume name (or UPLOADS_VOLUME; auto-detects *erp_uploads)
  --uploads-dir <dir>    Target host directory (or STORAGE_LOCAL_DIR)
EOF
}

AUTO_YES=false
BACKUP_FILE=""
UPLOADS_ARCHIVE="${UPLOADS_ARCHIVE:-}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-}"
UPLOADS_DIR="${STORAGE_LOCAL_DIR:-}"

while (( $# > 0 )); do
  case "$1" in
    --yes|-y)
      AUTO_YES=true
      shift
      ;;
    --uploads)
      UPLOADS_ARCHIVE="${2:-}"
      shift 2
      ;;
    --uploads-volume)
      UPLOADS_VOLUME="${2:-}"
      shift 2
      ;;
    --uploads-dir)
      UPLOADS_DIR="${2:-}"
      shift 2
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

if [[ -n "$UPLOADS_ARCHIVE" ]]; then
  if [[ ! -f "$UPLOADS_ARCHIVE" || ! -s "$UPLOADS_ARCHIVE" ]]; then
    echo "Error: uploads archive does not exist or is empty: $UPLOADS_ARCHIVE" >&2
    exit 1
  fi
  UPLOADS_SHA_FILE="${UPLOADS_ARCHIVE}.sha256"
  if [[ ! -f "$UPLOADS_SHA_FILE" ]]; then
    echo "Error: uploads checksum file missing: $UPLOADS_SHA_FILE" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (
      cd "$(dirname "$UPLOADS_ARCHIVE")"
      sha256sum -c "$(basename "$UPLOADS_SHA_FILE")"
    )
  else
    (
      cd "$(dirname "$UPLOADS_ARCHIVE")"
      shasum -a 256 -c "$(basename "$UPLOADS_SHA_FILE")"
    )
  fi
  gzip -t "$UPLOADS_ARCHIVE"
fi

REDACTED_TARGET="$(printf '%s' "$TARGET_URL" | sed -E 's#(postgres(ql)?://[^:/@]+):[^@]+@#\1:[REDACTED]@#')"

echo "WARNING: Destructive restore (--clean --if-exists) about to run:"
echo "  Backup: $BACKUP_FILE"
if [[ -n "$UPLOADS_ARCHIVE" ]]; then
  echo "  Uploads: $UPLOADS_ARCHIVE"
fi
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

if [[ -n "$UPLOADS_ARCHIVE" ]]; then
  UPLOADS_ARCHIVE_ABS="$(cd "$(dirname "$UPLOADS_ARCHIVE")" && pwd)/$(basename "$UPLOADS_ARCHIVE")"
  if [[ -n "$UPLOADS_DIR" ]]; then
    echo "Restoring uploads archive into local directory '$UPLOADS_DIR'..."
    mkdir -p "$UPLOADS_DIR"
    find "$UPLOADS_DIR" -mindepth 1 -delete
    tar -xzf "$UPLOADS_ARCHIVE_ABS" -C "$UPLOADS_DIR"
  else
    RESOLVED_VOLUME="$UPLOADS_VOLUME"
    if [[ -z "$RESOLVED_VOLUME" ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      RESOLVED_VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)erp_uploads$' | head -n 1 || true)"
    fi
    if [[ -z "$RESOLVED_VOLUME" ]]; then
      echo "Error: specify --uploads-volume <vol> or --uploads-dir <dir> to restore $UPLOADS_ARCHIVE." >&2
      exit 1
    fi
    echo "Restoring uploads archive into Docker volume '$RESOLVED_VOLUME'..."
    docker run --rm \
      -v "${RESOLVED_VOLUME}:/uploads" \
      -v "$(dirname "$UPLOADS_ARCHIVE_ABS"):/backups:ro" \
      alpine:3.21 \
      sh -c "find /uploads -mindepth 1 -delete && tar -xzf \"/backups/$(basename "$UPLOADS_ARCHIVE_ABS")\" -C /uploads"
  fi
  echo "Uploads archive restored successfully."
fi

echo "Database restore completed successfully into $REDACTED_TARGET"
