#!/usr/bin/env bash
# OpenShell Control installer
# Development installer for the local OpenShell sandbox control dashboard.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

APP_NAME="OpenShell Control"
ENV_FILE=".env.local"
OPEN_SHELL_CONTAINER_DEFAULT="openshell-cluster-nemoclaw"
MIN_NODE_MAJOR=20

DO_BUILD=1
DO_START=0

usage() {
  cat <<EOF
${APP_NAME} installer

Usage:
  ./install.sh [options]

Options:
  --no-build      Install and configure without running npm run build
  --start         Start the development server after install
  --help         Show this help

This project is in development. The installer prepares a local dev/operator
environment; it is not a hardened production deployment.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      DO_BUILD=0
      shift
      ;;
    --start)
      DO_START=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      exit 1
      ;;
  esac
done

log() {
  echo -e "${GREEN}==>${NC} $*"
}

warn() {
  echo -e "${YELLOW}WARN:${NC} $*"
}

fail() {
  echo -e "${RED}ERROR:${NC} $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found."
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])"
}

random_token() {
  node -e "console.log(require('node:crypto').randomBytes(Number(process.argv[1])).toString('base64url'))" "$1"
}

upsert_env() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    return
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

echo -e "${GREEN}=== ${APP_NAME} Installer ===${NC}"
echo "Development build: expect sharp edges; do not expose this UI broadly without hardening."
echo ""

require_command node
require_command npm
require_command docker

NODE_MAJOR="$(node_major)"
if [[ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  fail "Node.js ${MIN_NODE_MAJOR}+ is required. Found $(node -v)."
fi

log "Node $(node -v), npm $(npm -v)"

if ! docker ps >/dev/null 2>&1; then
  fail "Docker is not reachable. Start Docker and rerun the installer."
fi
log "Docker is reachable: $(docker --version)"

if command -v openshell >/dev/null 2>&1; then
  log "OpenShell CLI: $(openshell --version 2>/dev/null || echo installed)"
elif [[ -x "$HOME/.local/bin/openshell" ]]; then
  log "OpenShell CLI: $("$HOME/.local/bin/openshell" --version 2>/dev/null || echo "$HOME/.local/bin/openshell")"
else
  warn "OpenShell CLI was not found on PATH or at ~/.local/bin/openshell."
  warn "Sandbox create/delete, policy grants, terminal, and dashboard proxy features require it."
fi

if docker ps --format '{{.Names}}' | grep -Eq '^openshell-cluster-'; then
  log "OpenShell gateway container detected:"
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -E 'openshell-cluster-' || true
else
  warn "No openshell-cluster-* Docker container is currently running."
  warn "Install can continue, but the UI will show limited inventory until OpenShell is started."
fi

log "Installing npm dependencies"
npm install

if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# OpenShell Control local configuration
NEXT_PUBLIC_DASHBOARD_PORT=3000
NEXT_PUBLIC_API_BASE=/api
NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true
OPEN_SHELL_CONTAINER=${OPEN_SHELL_CONTAINER_DEFAULT}
OPENSHELL_GATEWAY=nemoclaw
EOF
else
  log "Keeping existing $ENV_FILE"
fi

upsert_env "NEXT_PUBLIC_DASHBOARD_PORT" "3000"
upsert_env "NEXT_PUBLIC_API_BASE" "/api"
upsert_env "NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS" "true"
upsert_env "OPEN_SHELL_CONTAINER" "$OPEN_SHELL_CONTAINER_DEFAULT"
upsert_env "OPENSHELL_GATEWAY" "nemoclaw"
upsert_env "OPENSHELL_CONTROL_PASSWORD" "$(random_token 18)"
upsert_env "OPENSHELL_CONTROL_AUTH_SECRET" "$(random_token 32)"
upsert_env "OPENSHELL_CONTROL_RECOVERY_TOKEN" "$(random_token 18)"

chmod 600 "$ENV_FILE" || true

if [[ "$DO_BUILD" -eq 1 ]]; then
  log "Running production build check"
  npm run build
  rm -rf .next
  log "Removed production .next cache so npm run dev starts cleanly"
fi

echo ""
echo -e "${GREEN}=== Installation Complete ===${NC}"
echo ""
echo "Local config: $ENV_FILE"
echo "Login password: read OPENSHELL_CONTROL_PASSWORD from $ENV_FILE"
echo "Recovery token: read OPENSHELL_CONTROL_RECOVERY_TOKEN from $ENV_FILE"
echo ""
echo "Start the development server:"
echo "  npm run dev"
echo ""
echo "Open:"
echo "  http://localhost:3000"
echo ""
echo "Ports used by default:"
echo "  3000  dashboard HTTP"
echo "  3001  OpenClaw dashboard websocket sidecar"
echo "  3011  operator terminal upstream"
echo ""

if [[ "$DO_START" -eq 1 ]]; then
  log "Starting development server"
  exec npm run dev
fi
