#!/bin/bash
# Tear down an OpenClaw remote-gateway exposure created by expose.sh.
# PARKED POC — see expose.sh header.
#
# Usage: unexpose.sh <sandbox-name>

TAG="[openclaw-remote-unexpose]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hermes-remote/lib.sh
source "$SCRIPT_DIR/../hermes-remote/lib.sh"

ACCESS_DIR="/etc/openshell/openclaw-access"
FORWARD_ENV_DIR="/etc/openshell/openclaw-remote"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: unexpose.sh <sandbox-name>"
[ "$(id -u)" -eq 0 ] || die "must run as root"

PORT=$(grep -oE '"hostPort": *[0-9]+' "$ACCESS_DIR/${SANDBOX}.json" 2>/dev/null | grep -oE '[0-9]+' | head -1)

systemctl disable --now "openclaw-remote-forward@${SANDBOX}.service" >/dev/null 2>&1 || true
RULES_DIR=$(traefik_rules_dir 2>/dev/null || true)
[ -n "$RULES_DIR" ] && rm -f "$RULES_DIR/openclaw-remote-${SANDBOX}.yml"
rm -f "$ACCESS_DIR/${SANDBOX}.json" "$FORWARD_ENV_DIR/${SANDBOX}.env"

if [ -n "$PORT" ] && [ -x /usr/sbin/ufw ] && /usr/sbin/ufw status 2>/dev/null | grep -q '^Status: active'; then
  /usr/sbin/ufw delete allow from 172.0.0.0/8 to any port "$PORT" proto tcp >/dev/null 2>&1 || true
fi

log "unexposed OpenClaw '$SANDBOX'${PORT:+ (freed host port $PORT)}"
