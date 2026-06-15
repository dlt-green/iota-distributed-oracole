#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NETWORK="auto"
SKIP_GIT=0
SKIP_ENV=0
SKIP_LOCAL_BUILD=0
SKIP_DOCKER=0
INCLUDE_WEBVIEW=1
INCLUDE_TRAEFIK=0
DEVNET_COMPOSE=0
REMOVE_ORPHANS=0

usage() {
  cat <<'EOF'
Usage: ./update.sh [options]
Updates the oracle node checkout, environment values, dependencies, builds, and
Docker services.

Options:
  --network auto|testnet|devnet   Env sync script to run (default: auto)
  --devnet-compose                Use node/docker-compose_devnet.yml for nodes
  --skip-git                      Do not run git pull
  --skip-env                      Do not run move/<network>/update_<network>_envs.sh
  --skip-local-build              Do not run npm ci / npm build locally
  --skip-docker                   Do not rebuild/restart Docker services
  --no-webview                    Do not update the webview Docker service
  --with-traefik                  Also update the traefik Docker service
  --remove-orphans                Remove Compose orphan containers during Docker update
  -h, --help                      Show this help
EOF
}

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    env -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE docker-compose "$@"
  else
    echo "Missing Docker Compose. Install 'docker compose' or 'docker-compose'." >&2
    exit 1
  fi
}

env_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == k {
      value=$0
      sub("^[^=]*=", "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$file"
}

detect_network() {
  local value
  value="$(env_value IOTA_NETWORK node/.env || true)"
  case "${value,,}" in
    testnet) printf 'testnet' ;;
    dev|devnet|local|localnet) printf 'devnet' ;;
    "") printf 'testnet' ;;
    *)
      echo "Unsupported IOTA_NETWORK in node/.env: $value" >&2
      echo "Pass --network testnet or --network devnet explicitly." >&2
      exit 1
      ;;
  esac
}

backup_envs() {
  local backup_dir=".update-backups/$(date '+%Y%m%d-%H%M%S')"
  local copied=0
  for file in node/.env webview/.env client/.env traefik/.env; do
    if [[ -f "$file" ]]; then
      mkdir -p "$backup_dir/$(dirname "$file")"
      cp -p "$file" "$backup_dir/$file"
      copied=1
    fi
  done
  if [[ "$copied" == 1 ]]; then
    echo "Env backup written to $backup_dir"
  fi
}

npm_install_and_build() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || return 0
  log "Installing dependencies in $dir"
  (cd "$dir" && npm ci)
  if (cd "$dir" && npm run | grep -qE '^[[:space:]]+build$|^[[:space:]]+build[[:space:]]'); then
    log "Building $dir"
    (cd "$dir" && npm run build)
  fi
}

docker_up() {
  local compose_file="$1"
  local project_dir="$2"
  local args=(up --build -d)
  if [[ ! -f "$compose_file" ]]; then
    echo "Compose file not found: $compose_file" >&2
    exit 1
  fi
  if [[ "$REMOVE_ORPHANS" == 1 ]]; then
    args+=(--remove-orphans)
  fi
  log "Updating Docker services from $compose_file"
  (cd "$project_dir" && compose -f "$(basename "$compose_file")" "${args[@]}")
}

# =====================================================
# NEU: Docker Secrets vorbereiten (Private Key)
# =====================================================
prepare_docker_secrets() {
  local compose_dir="$1"           # z.B. "node"
  local env_file="${compose_dir}/.env"
  local secret_file="${compose_dir}/privatekey.txt"

  if [[ ! -f "$env_file" ]]; then
    log "⚠️  Keine .env Datei gefunden unter $env_file"
    return 0
  fi

  log "🔐 Bereite Docker Secret für NODE_1_PRIVATEKEY vor..."

  if grep -qE '^NODE_1_PRIVATEKEY=' "$env_file"; then
    # Key extrahieren (alles nach dem ersten =)
    grep -E '^NODE_1_PRIVATEKEY=' "$env_file" | cut -d'=' -f2- > "$secret_file"

    chmod 600 "$secret_file"
    chown root:docker "$secret_file" 2>/dev/null || true

    log "✅ Docker Secret privatekey.txt erstellt (aus .env)"
  else
    log "⚠️  NODE_1_PRIVATEKEY nicht in .env gefunden"
    [[ -f "$secret_file" ]] && rm -f "$secret_file"
  fi
}

# =====================================================
# Hauptlogik
# =====================================================

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      NETWORK="${2:-}"
      shift 2
      ;;
    --devnet-compose)
      DEVNET_COMPOSE=1
      shift
      ;;
    --skip-git)
      SKIP_GIT=1
      shift
      ;;
    --skip-env)
      SKIP_ENV=1
      shift
      ;;
    --skip-local-build)
      SKIP_LOCAL_BUILD=1
      shift
      ;;
    --skip-docker)
      SKIP_DOCKER=1
      shift
      ;;
    --no-webview)
      INCLUDE_WEBVIEW=0
      shift
      ;;
    --with-traefik)
      INCLUDE_TRAEFIK=1
      shift
      ;;
    --remove-orphans)
      REMOVE_ORPHANS=1
      shift
      ;;
    --no-traefik)
      INCLUDE_TRAEFIK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$NETWORK" in
  auto) NETWORK="$(detect_network)" ;;
  testnet|devnet) ;;
  *)
    echo "Invalid network: $NETWORK" >&2
    usage
    exit 1
    ;;
esac

log "Starting update for $NETWORK"

require_cmd git
if [[ "$SKIP_DOCKER" == 0 ]]; then
  require_cmd docker
fi
if [[ "$SKIP_LOCAL_BUILD" == 0 ]]; then
  require_cmd npm
fi

if [[ "$SKIP_GIT" == 0 ]]; then
  log "Pulling latest code"
  git pull --ff-only
fi

backup_envs

if [[ "$SKIP_ENV" == 0 ]]; then
  ENV_SCRIPT="move/${NETWORK}/update_${NETWORK}_envs.sh"
  if [[ -x "$ENV_SCRIPT" || -f "$ENV_SCRIPT" ]]; then
    log "Syncing ${NETWORK} environment values"
    bash "$ENV_SCRIPT"
  else
    echo "Env update script not found: $ENV_SCRIPT" >&2
    exit 1
  fi
fi

if [[ "$SKIP_LOCAL_BUILD" == 0 ]]; then
  npm_install_and_build node
  npm_install_and_build client
  npm_install_and_build webview
fi

if [[ "$SKIP_DOCKER" == 0 ]]; then
  if [[ "$INCLUDE_TRAEFIK" == 1 || "$INCLUDE_WEBVIEW" == 1 ]]; then
    if ! docker network inspect traefik_proxy >/dev/null 2>&1; then
      log "Creating Docker network traefik_proxy"
      docker network create traefik_proxy
    fi
  fi

  if [[ "$INCLUDE_TRAEFIK" == 1 ]]; then
    docker_up "traefik/docker-compose.yml" "traefik"
  fi

  NODE_COMPOSE="docker-compose.yml"
  if [[ "$DEVNET_COMPOSE" == 1 ]]; then
    NODE_COMPOSE="docker-compose_devnet.yml"
  fi

  # === Docker Secrets vorbereiten (Private Key) ===
  prepare_docker_secrets "node"

  docker_up "node/$NODE_COMPOSE" "node"

  if [[ "$INCLUDE_WEBVIEW" == 1 ]]; then
    docker_up "webview/docker-compose.yml" "webview"
  fi

  log "Current containers"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
fi

log "Update completed"
