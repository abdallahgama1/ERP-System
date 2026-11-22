#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/count-it-keep-it"
BACKUP_DIR="/var/backups/count-it-keep-it"
REPO_URL="https://github.com/abdallahgama1/ERP-System.git"
BRANCH="main"
DEPLOY_USER="${SUDO_USER:-deploy}"
SKIP_FIREWALL=false
SKIP_CRON=false

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/vps-setup.sh [options]

Idempotent Ubuntu (22.04/24.04) / Debian (12) VPS provisioning script for
Count It Keep It ERP (Docker Engine + Compose v2 + UFW + Postgres backup cron).

Options:
  --app-dir <path>      Application checkout directory (default: /opt/count-it-keep-it)
  --backup-dir <path>   PostgreSQL backup directory (default: /var/backups/count-it-keep-it)
  --repo <url>          Git repository URL (default: https://github.com/abdallahgama1/ERP-System.git)
  --branch <name>       Git branch to clone (default: main)
  --user <username>     Linux deploy user added to docker group (default: $SUDO_USER or deploy)
  --skip-firewall       Do not configure UFW firewall rules
  --skip-cron           Do not install daily backup cron job or logrotate rule
  -h, --help            Show this help message
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --app-dir)
      [[ $# -ge 2 ]] || { echo "Error: --app-dir requires a value." >&2; exit 2; }
      APP_DIR="$2"
      shift 2
      ;;
    --backup-dir)
      [[ $# -ge 2 ]] || { echo "Error: --backup-dir requires a value." >&2; exit 2; }
      BACKUP_DIR="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Error: --repo requires a value." >&2; exit 2; }
      REPO_URL="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || { echo "Error: --branch requires a value." >&2; exit 2; }
      BRANCH="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || { echo "Error: --user requires a value." >&2; exit 2; }
      DEPLOY_USER="$2"
      shift 2
      ;;
    --skip-firewall)
      SKIP_FIREWALL=true
      shift
      ;;
    --skip-cron)
      SKIP_CRON=true
      shift
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

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Error: this script must be run as root (use sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing base packages..."
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  git \
  ufw \
  lsb-release \
  postgresql-client

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine & Docker Compose plugin..."
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  ARCH="$(dpkg --print-architecture)"
  echo \
    "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y --no-install-recommends \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
else
  echo "==> Docker already installed: $(docker --version)"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable docker >/dev/null 2>&1 || true
  systemctl start docker >/dev/null 2>&1 || true
fi

if [[ "$DEPLOY_USER" != "root" ]]; then
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    echo "==> Creating deploy user '${DEPLOY_USER}'..."
    useradd -m -s /bin/bash "$DEPLOY_USER"
  fi
  usermod -aG docker "$DEPLOY_USER"
  echo "==> Added '${DEPLOY_USER}' to docker group."
fi

if [[ "$SKIP_FIREWALL" == "false" ]]; then
  echo "==> Configuring UFW firewall (SSH 22, HTTP 80, HTTPS 443 TCP/UDP)..."
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable
fi

echo "==> Preparing application and backup directories..."
mkdir -p "$APP_DIR" "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "==> Cloning repository ($BRANCH) into $APP_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  echo "==> Repository already present at $APP_DIR."
fi

if [[ -d "$APP_DIR/scripts" ]]; then
  chmod +x "$APP_DIR"/scripts/*.sh 2>/dev/null || true
fi

if [[ ! -f "$APP_DIR/.env" && -f "$APP_DIR/.env.prod.example" ]]; then
  cp "$APP_DIR/.env.prod.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "==> Created $APP_DIR/.env from .env.prod.example (chmod 600)."
fi

if [[ "$DEPLOY_USER" != "root" ]]; then
  chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$APP_DIR"
fi

if [[ "$SKIP_CRON" == "false" ]]; then
  echo "==> Installing daily database backup cron job (02:00 UTC) and logrotate config..."
  cat > /usr/local/bin/count-it-keep-it-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${APP_DIR}/.env"
BACKUP_SCRIPT="${APP_DIR}/scripts/backup-db.sh"
TARGET_DIR="${BACKUP_DIR}"
EOF
  cat >> /usr/local/bin/count-it-keep-it-backup <<'EOF'

read_env() {
  local key="$1"
  local line val
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  val="${line#*=}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ ( "$val" == \"* && "$val" == *\" ) || ( "$val" == \'* && "$val" == *\' ) ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

if [[ ! -f "$ENV_FILE" || ! -f "$BACKUP_SCRIPT" ]]; then
  exit 0
fi

DIRECT_URL="$(read_env DIRECT_DATABASE_URL)"
PRIMARY_URL="$(read_env DATABASE_URL)"
EFFECTIVE_URL="${DIRECT_URL:-$PRIMARY_URL}"
[[ -n "$EFFECTIVE_URL" ]] || exit 0

RETENTION="$(read_env BACKUP_RETENTION_DAYS)"
MIN_KEEP="$(read_env BACKUP_MIN_KEEP)"
CUSTOM_DIR="$(read_env BACKUP_DIR)"

export DATABASE_URL="$EFFECTIVE_URL"
[[ -z "$RETENTION" ]] || export BACKUP_RETENTION_DAYS="$RETENTION"
[[ -z "$MIN_KEEP" ]] || export BACKUP_MIN_KEEP="$MIN_KEEP"

exec bash "$BACKUP_SCRIPT" "${CUSTOM_DIR:-$TARGET_DIR}"
EOF
  chmod 750 /usr/local/bin/count-it-keep-it-backup

  cat > /etc/cron.d/count-it-keep-it-backup <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 2 * * * root /usr/local/bin/count-it-keep-it-backup >> /var/log/erp-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/count-it-keep-it-backup

  cat > /etc/logrotate.d/count-it-keep-it-backup <<'EOF'
/var/log/erp-backup.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root adm
}
EOF
  chmod 644 /etc/logrotate.d/count-it-keep-it-backup
fi

cat <<EOF

VPS provisioning complete.

Next steps:
  1. Edit ${APP_DIR}/.env with your production domain, managed Postgres URL, and generated secrets:
       openssl rand -hex 32   # AUTH_COOKIE_SECRET
       openssl rand -hex 24   # METRICS_TOKEN
  2. Ensure DNS A/AAAA records for SITE_ADDRESS point to this VPS.
  3. Deploy manually (or configure GitHub Actions CD secrets):
       cd ${APP_DIR}
       docker login ghcr.io
       bash ./scripts/deploy.sh --skip-backup   # on first empty-DB deploy
  4. Verify:
       curl -fsS https://YOUR_SITE_ADDRESS/api/health/ready
EOF
