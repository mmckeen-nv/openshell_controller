#!/usr/bin/env bash
# Install the OpenShell/NemoClaw versions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.36}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
NEMOCLAW_INSTALL_TAG="${NEMOCLAW_INSTALL_TAG:-v0.0.56}"
NEMOCLAW_ZIP_URL="${NEMOCLAW_ZIP_URL:-https://github.com/NVIDIA/NemoClaw/archive/refs/tags/${NEMOCLAW_INSTALL_TAG}.zip}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.5.20}"
NEMOCLAW_BASE_IMAGE="${NEMOCLAW_BASE_IMAGE:-ghcr.io/nvidia/nemoclaw/sandbox-base:latest}"
NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
NEMOCLAW_NON_INTERACTIVE="${NEMOCLAW_NON_INTERACTIVE:-1}"
NEMOCLAW_EXPERIMENTAL="${NEMOCLAW_EXPERIMENTAL:-1}"
NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-vllm}"

SKIP_OPENSHELL=0
SKIP_NEMOCLAW=0

usage() {
  cat <<EOF
Versioned OpenShell/NemoClaw installer

Usage:
  ./install_versioned_nemoclaw_openshell.sh [options]

Options:
  --nvidia-api-key KEY   Pass NVIDIA_API_KEY to the NemoClaw installer
  --skip-openshell       Do not install OpenShell
  --skip-nemoclaw        Do not install NemoClaw
  --help                 Show this help

Defaults:
  OPENSHELL_VERSION=$OPENSHELL_VERSION
  NEMOCLAW_INSTALL_TAG=$NEMOCLAW_INSTALL_TAG
  OPENCLAW_VERSION=$OPENCLAW_VERSION
  NEMOCLAW_BASE_IMAGE=$NEMOCLAW_BASE_IMAGE
  NEMOCLAW_EXPERIMENTAL=$NEMOCLAW_EXPERIMENTAL
  NEMOCLAW_PROVIDER=$NEMOCLAW_PROVIDER

Environment overrides:
  OPENSHELL_VERSION
  OPENSHELL_INSTALL_URL
  NEMOCLAW_INSTALL_TAG
  NEMOCLAW_ZIP_URL
  OPENCLAW_VERSION
  NEMOCLAW_BASE_IMAGE
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE
  NEMOCLAW_NON_INTERACTIVE
  NEMOCLAW_EXPERIMENTAL
  NEMOCLAW_PROVIDER
  OPENSHELL_GATEWAY_HOST
  OPENSHELL_GATEWAY_PORT
  OPENSHELL_GATEWAY_URL
  NVIDIA_API_KEY
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvidia-api-key)
      [[ $# -ge 2 ]] || { echo -e "${RED}ERROR:${NC} --nvidia-api-key requires a value" >&2; exit 1; }
      export NVIDIA_API_KEY="$2"
      shift 2
      ;;
    --skip-openshell)
      SKIP_OPENSHELL=1
      shift
      ;;
    --skip-nemoclaw)
      SKIP_NEMOCLAW=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}ERROR:${NC} Unknown option: $1" >&2
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

extract_zip() {
  local zip_path="$1"
  local dest_dir="$2"

  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$zip_path" -d "$dest_dir"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$zip_path" "$dest_dir"
    return
  fi

  fail "unzip or python3 is required to extract NemoClaw."
}

install_openshell() {
  require_command curl
  require_command sh
  log "Installing OpenShell $OPENSHELL_VERSION"
  curl -LsSf "$OPENSHELL_INSTALL_URL" | OPENSHELL_VERSION="$OPENSHELL_VERSION" sh
}

install_nemoclaw() {
  require_command curl
  require_command sh
  require_command docker

  local work_dir zip_path source_dir
  work_dir="$(mktemp -d)"
  zip_path="$work_dir/nemoclaw-${NEMOCLAW_INSTALL_TAG}.zip"
  trap 'rm -rf "$work_dir"' RETURN

  log "Downloading NemoClaw $NEMOCLAW_INSTALL_TAG"
  curl -LsSf "$NEMOCLAW_ZIP_URL" -o "$zip_path"
  extract_zip "$zip_path" "$work_dir"

  source_dir="$(find "$work_dir" -maxdepth 1 -type d -name 'NemoClaw-*' | head -n 1)"
  [[ -n "$source_dir" && -f "$source_dir/install.sh" ]] || fail "Could not find NemoClaw install.sh in downloaded archive."

  # NemoClaw upstream Dockerfile/Dockerfile.base pin Debian package versions
  # (procps=2:4.0.4-9, e2fsprogs=1.47.2-3+b11, tmux=3.5a-3) even though the
  # base image is Ubuntu 24.04 noble, where those exact versions don't exist.
  # The pinned `apt-get install` then fails with exit 100, breaking every
  # `nemoclaw onboard` on a freshly-deployed VPS. Unpin them so apt picks
  # whatever's available in noble.
  for _dockerfile in "$source_dir/Dockerfile" "$source_dir/Dockerfile.base"; do
    if [[ -f "$_dockerfile" ]]; then
      sed -i.bak \
        -e 's/procps=2:4\.0\.4-9/procps/g' \
        -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
        -e 's/tmux=3\.5a-3/tmux/g' \
        "$_dockerfile" && rm -f "${_dockerfile}.bak"
    fi
  done

  if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
    warn "NVIDIA_API_KEY is not set. NemoClaw may require it for non-local provider setup."
  fi

  log "Installing NemoClaw $NEMOCLAW_INSTALL_TAG"
  (
    cd "$source_dir"
    NEMOCLAW_INSTALL_TAG="$NEMOCLAW_INSTALL_TAG" \
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="$NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE" \
      NEMOCLAW_NON_INTERACTIVE="$NEMOCLAW_NON_INTERACTIVE" \
      NEMOCLAW_EXPERIMENTAL="$NEMOCLAW_EXPERIMENTAL" \
      NEMOCLAW_PROVIDER="$NEMOCLAW_PROVIDER" \
      NVIDIA_API_KEY="${NVIDIA_API_KEY:-}" \
      ./install.sh
  )

  log "Building NemoClaw stock base image with OpenClaw $OPENCLAW_VERSION"
  docker build \
    -f "$source_dir/Dockerfile.base" \
    -t "$NEMOCLAW_BASE_IMAGE" \
    --build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION" \
    "$source_dir"
}

echo -e "${GREEN}=== Versioned OpenShell/NemoClaw Installer ===${NC}"
echo "OpenShell: $OPENSHELL_VERSION"
echo "NemoClaw:  $NEMOCLAW_INSTALL_TAG"
echo "OpenClaw:  $OPENCLAW_VERSION"
echo "Base image: $NEMOCLAW_BASE_IMAGE"
echo "Provider:   $NEMOCLAW_PROVIDER (experimental=$NEMOCLAW_EXPERIMENTAL)"
echo ""

if [[ "$SKIP_OPENSHELL" -eq 0 ]]; then
  install_openshell
else
  warn "Skipping OpenShell install"
fi

if [[ "$SKIP_NEMOCLAW" -eq 0 ]]; then
  install_nemoclaw
else
  warn "Skipping NemoClaw install"
fi

echo ""
echo -e "${GREEN}=== Versioned Install Complete ===${NC}"
echo "Run ./install.sh afterward to install or refresh the dashboard."
