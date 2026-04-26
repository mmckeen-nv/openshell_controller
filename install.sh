#!/usr/bin/env bash
# OpenShell Control installer
# Development installer for the local OpenShell sandbox control dashboard.

set -euo pipefail
umask 077

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
DO_AUDIT=1
DO_CLEAN_NEXT=0
ALLOW_ROOT=0

usage() {
  cat <<EOF
${APP_NAME} installer

Usage:
  ./install.sh [options]

Options:
  --no-build      Install and configure without running npm run build
  --no-audit      Skip the non-blocking npm audit summary
  --clean-next    Remove .next after a successful build for a clean dev start
  --allow-root    Permit running as root
  --start         Start the development server after install
  --help          Show this help

This project is in development. The installer prepares a local dev/operator
environment; it is not a systemd/production service installer.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      DO_BUILD=0
      shift
      ;;
    --no-audit)
      DO_AUDIT=0
      shift
      ;;
    --clean-next)
      DO_CLEAN_NEXT=1
      shift
      ;;
    --allow-root)
      ALLOW_ROOT=1
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

optional_command() {
  if command -v "$1" >/dev/null 2>&1; then
    log "$2: $(command -v "$1")"
  else
    warn "$2 was not found. Related MCP servers can still be configured, but broker calls will fail until it is installed."
  fi
}

port_owner() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $1 " pid=" $2}'
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | awk 'NR == 2 {print $NF}'
    return
  fi
}

check_port() {
  local port="$1"
  local label="$2"
  local owner
  owner="$(port_owner "$port" || true)"
  if [[ -n "$owner" ]]; then
    warn "Port $port ($label) is already in use by $owner."
    warn "If you use --start, stop the existing process first or expect startup to fail."
  else
    log "Port $port ($label) is available"
  fi
}

find_openshell() {
  if command -v openshell >/dev/null 2>&1; then
    command -v openshell
  elif [[ -x "$HOME/.local/bin/openshell" ]]; then
    printf '%s\n' "$HOME/.local/bin/openshell"
  fi
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

if [[ "${EUID:-$(id -u)}" -eq 0 && "$ALLOW_ROOT" -ne 1 ]]; then
  fail "Refusing to run as root. Rerun as the dashboard user, or pass --allow-root if you really mean it."
fi

require_command node
require_command npm
require_command docker

NODE_MAJOR="$(node_major)"
if [[ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  fail "Node.js ${MIN_NODE_MAJOR}+ is required. Found $(node -v)."
fi

log "Node $(node -v), npm $(npm -v)"
optional_command uvx "uvx MCP package runner"

if ! docker ps >/dev/null 2>&1; then
  fail "Docker is not reachable. Start Docker and rerun the installer."
fi
log "Docker is reachable: $(docker --version)"

OPENSHELL_BIN="$(find_openshell || true)"
if [[ -n "$OPENSHELL_BIN" ]]; then
  log "OpenShell CLI: $("$OPENSHELL_BIN" --version 2>/dev/null || echo "$OPENSHELL_BIN")"
  if "$OPENSHELL_BIN" sandbox list >/dev/null 2>&1; then
    log "OpenShell sandbox inventory command is reachable"
  else
    warn "OpenShell CLI exists, but 'openshell sandbox list' did not complete successfully."
    warn "The dashboard can install, but inventory and lifecycle operations may be degraded."
  fi
else
  warn "OpenShell CLI was not found on PATH or at ~/.local/bin/openshell."
  warn "Sandbox create/delete, policy grants, terminal, and dashboard proxy features require it."
fi

check_port 3000 "dashboard HTTP"
check_port 3001 "OpenClaw dashboard websocket sidecar"
check_port 3011 "operator terminal upstream"

if docker ps --format '{{.Names}}' | grep -Eq '^openshell-cluster-'; then
  log "OpenShell gateway container detected:"
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -E 'openshell-cluster-' || true
else
  warn "No openshell-cluster-* Docker container is currently running."
  warn "Install can continue, but the UI will show limited inventory until OpenShell is started."
fi

if [[ -f package-lock.json ]]; then
  log "Installing npm dependencies with npm ci"
  npm ci
else
  log "Installing npm dependencies with npm install"
  npm install
fi

if [[ "$DO_AUDIT" -eq 1 ]]; then
  log "Running non-blocking npm audit summary"
  if ! npm audit --audit-level=moderate; then
    warn "npm audit reported vulnerabilities. Review the output above before exposing this UI beyond a trusted LAN."
  fi
fi

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
upsert_env "MCP_BROKER_TOKEN_TTL_HOURS" "168"
upsert_env "MCP_BROKER_REQUEST_TIMEOUT_MS" "45000"

chmod 600 "$ENV_FILE" || true

if [[ "$DO_BUILD" -eq 1 ]]; then
  log "Running production build check"
  npm run build
  if [[ "$DO_CLEAN_NEXT" -eq 1 ]]; then
    rm -rf .next
    log "Removed production .next cache because --clean-next was requested"
  fi
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
echo "This installer does not install or manage a systemd service."
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
