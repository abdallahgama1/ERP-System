#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/backup-db.sh [BACKUP_DIR]

Creates a compressed PostgreSQL custom-format backup (.dump) with SHA-256 checksum
and applies retention pruning.

Environment variables:
  DATABASE_URL           PostgreSQL connection URL (falls back to backend/.env if unset)
  BACKUP_DIR             Output directory (default: ./backups)
  BACKUP_RETENTION_DAYS  Delete backups older than N days (default: 14, 0 disables pruning)
  BACKUP_MIN_KEEP        Minimum number of most recent backups to keep (default: 3)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

for cmd in pg_dump pg_restore; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' not found in PATH." >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD=(shasum -a 256)
else
  echo "Error: neither 'sha256sum' nor 'shasum' found in PATH." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/backend/.env" ]]; then
  RAW_LINE="$(grep -E '^[[:space:]]*DATABASE_URL=' "$REPO_ROOT/backend/.env" | tail -n 1 || true)"
  if [[ -n "$RAW_LINE" ]]; then
    RAW_VAL="${RAW_LINE#*=}"
    RAW_VAL="${RAW_VAL#"${RAW_VAL%%[![:space:]]*}"}"
    RAW_VAL="${RAW_VAL%"${RAW_VAL##*[![:space:]]}"}"
    if [[ ( "$RAW_VAL" == \"*\" && "$RAW_VAL" == *\" ) || ( "$RAW_VAL" == \'*\' && "$RAW_VAL" == *\' ) ]]; then
      RAW_VAL="${RAW_VAL:1:${#RAW_VAL}-2}"
    fi
    DATABASE_URL="$RAW_VAL"
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set and could not be read from backend/.env." >&2
  exit 1
fi

BACKUP_DIR="${1:-${BACKUP_DIR:-$REPO_ROOT/backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MIN_KEEP="${BACKUP_MIN_KEEP:-3}"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || ! [[ "$MIN_KEEP" =~ ^[0-9]+$ ]]; then
  echo "Error: BACKUP_RETENTION_DAYS and BACKUP_MIN_KEEP must be non-negative integers." >&2
  exit 1
fi

REDACTED_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#(postgres(ql)?://[^:/@]+):[^@]+@#\1:[REDACTED]@#')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="erp_backup_${TIMESTAMP}.dump"
BACKUP_FILE="${BACKUP_DIR}/${FILENAME}"
TMP_FILE="${BACKUP_FILE}.tmp"

umask 077
mkdir -p "$BACKUP_DIR"

cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

echo "Starting PostgreSQL backup -> $REDACTED_TARGET"
pg_dump -Fc --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$TMP_FILE"

if [[ ! -s "$TMP_FILE" ]]; then
  echo "Error: backup dump file is empty: $TMP_FILE" >&2
  exit 1
fi

echo "Validating archive table of contents with pg_restore -l..."
pg_restore -l "$TMP_FILE" >/dev/null

mv -f "$TMP_FILE" "$BACKUP_FILE"
(
  cd "$BACKUP_DIR"
  "${SHA256_CMD[@]}" "$FILENAME" > "${FILENAME}.sha256"
)

CHECKSUM="$(awk '{print $1}' "${BACKUP_FILE}.sha256")"
SIZE_BYTES="$(wc -c < "$BACKUP_FILE" | tr -d '[:space:]')"

echo "Backup completed:"
echo "  File:     $BACKUP_FILE"
echo "  Size:     ${SIZE_BYTES} bytes"
echo "  SHA-256:  $CHECKSUM (${BACKUP_FILE}.sha256)"

if (( RETENTION_DAYS > 0 )); then
  mapfile -t ALL_BACKUPS < <(ls -1t "$BACKUP_DIR"/erp_backup_*.dump 2>/dev/null || true)
  TOTAL_COUNT="${#ALL_BACKUPS[@]}"
  if (( TOTAL_COUNT > MIN_KEEP )); then
    PRUNED=0
    for (( idx=MIN_KEEP; idx<TOTAL_COUNT; idx++ )); do
      CANDIDATE="${ALL_BACKUPS[$idx]}"
      if find "$CANDIDATE" -maxdepth 0 -mtime +"$RETENTION_DAYS" | grep -q .; then
        rm -f "$CANDIDATE" "${CANDIDATE}.sha256"
        PRUNED=$((PRUNED + 1))
      fi
    done
    if (( PRUNED > 0 )); then
      echo "Pruned $PRUNED backup(s) older than ${RETENTION_DAYS} days (kept at least ${MIN_KEEP} most recent)."
    fi
  fi
fi
