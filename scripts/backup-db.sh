#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/backup-db.sh [BACKUP_DIR]

Creates a compressed PostgreSQL custom-format backup (.dump) with SHA-256 checksum,
optionally archives the erp_uploads volume or local uploads directory (.tar.gz + .sha256),
and applies retention pruning.

Environment variables:
  DATABASE_URL           PostgreSQL connection URL (falls back to backend/.env if unset)
  BACKUP_DIR             Output directory (default: ./backups)
  BACKUP_RETENTION_DAYS  Delete backups older than N days (default: 14, 0 disables pruning)
  BACKUP_MIN_KEEP        Minimum number of most recent backups to keep (default: 3)
  BACKUP_UPLOADS         Backup erp_uploads volume/dir: auto | true | false (default: auto)
  UPLOADS_VOLUME         Docker volume name for attachments (auto-detects *erp_uploads if unset)
  STORAGE_LOCAL_DIR      Host uploads directory fallback when not using a Docker volume
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
BACKUP_UPLOADS="${BACKUP_UPLOADS:-auto}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-}"
STORAGE_LOCAL_DIR="${STORAGE_LOCAL_DIR:-}"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || ! [[ "$MIN_KEEP" =~ ^[0-9]+$ ]]; then
  echo "Error: BACKUP_RETENTION_DAYS and BACKUP_MIN_KEEP must be non-negative integers." >&2
  exit 1
fi

case "$BACKUP_UPLOADS" in
  auto|true|false) ;;
  *)
    echo "Error: BACKUP_UPLOADS must be one of: auto, true, false (got '$BACKUP_UPLOADS')." >&2
    exit 1
    ;;
esac

REDACTED_TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#(postgres(ql)?://[^:/@]+):[^@]+@#\1:[REDACTED]@#')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="erp_backup_${TIMESTAMP}.dump"
BACKUP_FILE="${BACKUP_DIR}/${FILENAME}"
TMP_FILE="${BACKUP_FILE}.tmp"
UPLOADS_FILENAME="erp_uploads_${TIMESTAMP}.tar.gz"
UPLOADS_FILE="${BACKUP_DIR}/${UPLOADS_FILENAME}"
UPLOADS_TMP_FILE="${UPLOADS_FILE}.tmp"

umask 077
mkdir -p "$BACKUP_DIR"

cleanup() {
  rm -f "$TMP_FILE" "$UPLOADS_TMP_FILE"
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

if [[ "$BACKUP_UPLOADS" != "false" ]]; then
  RESOLVED_VOLUME=""
  if [[ -n "$UPLOADS_VOLUME" ]]; then
    if command -v docker >/dev/null 2>&1 && docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1; then
      RESOLVED_VOLUME="$UPLOADS_VOLUME"
    else
      echo "Error: specified UPLOADS_VOLUME '$UPLOADS_VOLUME' does not exist or docker is unavailable." >&2
      exit 1
    fi
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    RESOLVED_VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)erp_uploads$' | head -n 1 || true)"
  fi

  if [[ -n "$RESOLVED_VOLUME" ]]; then
    echo "Backing up Docker uploads volume '$RESOLVED_VOLUME'..."
    docker run --rm \
      -v "${RESOLVED_VOLUME}:/uploads:ro" \
      -v "$(cd "$BACKUP_DIR" && pwd):/backups" \
      alpine:3.21 \
      tar -czf "/backups/$(basename "$UPLOADS_TMP_FILE")" -C /uploads .
    gzip -t "$UPLOADS_TMP_FILE"
    mv -f "$UPLOADS_TMP_FILE" "$UPLOADS_FILE"
    (
      cd "$BACKUP_DIR"
      "${SHA256_CMD[@]}" "$UPLOADS_FILENAME" > "${UPLOADS_FILENAME}.sha256"
    )
    UPLOADS_SHA="$(awk '{print $1}' "${UPLOADS_FILE}.sha256")"
    UPLOADS_SIZE="$(wc -c < "$UPLOADS_FILE" | tr -d '[:space:]')"
    echo "Uploads volume backup completed:"
    echo "  Volume:   $RESOLVED_VOLUME"
    echo "  File:     $UPLOADS_FILE"
    echo "  Size:     ${UPLOADS_SIZE} bytes"
    echo "  SHA-256:  $UPLOADS_SHA (${UPLOADS_FILE}.sha256)"
  elif [[ -n "$STORAGE_LOCAL_DIR" && -d "$STORAGE_LOCAL_DIR" ]]; then
    echo "Backing up local uploads directory '$STORAGE_LOCAL_DIR'..."
    tar -czf "$UPLOADS_TMP_FILE" -C "$STORAGE_LOCAL_DIR" .
    gzip -t "$UPLOADS_TMP_FILE"
    mv -f "$UPLOADS_TMP_FILE" "$UPLOADS_FILE"
    (
      cd "$BACKUP_DIR"
      "${SHA256_CMD[@]}" "$UPLOADS_FILENAME" > "${UPLOADS_FILENAME}.sha256"
    )
    UPLOADS_SHA="$(awk '{print $1}' "${UPLOADS_FILE}.sha256")"
    UPLOADS_SIZE="$(wc -c < "$UPLOADS_FILE" | tr -d '[:space:]')"
    echo "Local uploads backup completed:"
    echo "  Dir:      $STORAGE_LOCAL_DIR"
    echo "  File:     $UPLOADS_FILE"
    echo "  Size:     ${UPLOADS_SIZE} bytes"
    echo "  SHA-256:  $UPLOADS_SHA (${UPLOADS_FILE}.sha256)"
  elif [[ "$BACKUP_UPLOADS" == "true" ]]; then
    echo "Error: BACKUP_UPLOADS=true but neither Docker volume '*erp_uploads' nor STORAGE_LOCAL_DIR was found." >&2
    exit 1
  else
    echo "Note: no Docker '*erp_uploads' volume or STORAGE_LOCAL_DIR found; skipped uploads archive (BACKUP_UPLOADS=auto)."
  fi
fi

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
      echo "Pruned $PRUNED DB backup(s) older than ${RETENTION_DAYS} days (kept at least ${MIN_KEEP} most recent)."
    fi
  fi

  mapfile -t ALL_UPLOADS < <(ls -1t "$BACKUP_DIR"/erp_uploads_*.tar.gz 2>/dev/null || true)
  UPLOADS_COUNT="${#ALL_UPLOADS[@]}"
  if (( UPLOADS_COUNT > MIN_KEEP )); then
    PRUNED_UPLOADS=0
    for (( idx=MIN_KEEP; idx<UPLOADS_COUNT; idx++ )); do
      CANDIDATE="${ALL_UPLOADS[$idx]}"
      if find "$CANDIDATE" -maxdepth 0 -mtime +"$RETENTION_DAYS" | grep -q .; then
        rm -f "$CANDIDATE" "${CANDIDATE}.sha256"
        PRUNED_UPLOADS=$((PRUNED_UPLOADS + 1))
      fi
    done
    if (( PRUNED_UPLOADS > 0 )); then
      echo "Pruned $PRUNED_UPLOADS uploads archive(s) older than ${RETENTION_DAYS} days (kept at least ${MIN_KEEP} most recent)."
    fi
  fi
fi
