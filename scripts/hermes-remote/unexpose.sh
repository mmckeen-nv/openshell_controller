#!/bin/bash
# Tear down everything expose.sh created for one sandbox.
# Usage: unexpose.sh <sandbox-name>
# Safe to run repeatedly and on partially-exposed sandboxes (best effort).

TAG="[hermes-remote-unexpose]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: unexpose.sh <sandbox-name>"
[ "$(id -u)" -eq 0 ] || die "must run as root"

PORT=$(read_access_field "$SANDBOX" port || true)

systemctl disable --now "hermes-remote-forward@${SANDBOX}.service" >/dev/null 2>&1
rm -f "$FORWARD_ENV_DIR/${SANDBOX}.env"

if [ -n "$PORT" ]; then
  openshell forward stop "$PORT" "$SANDBOX" >/dev/null 2>&1
  if command -v ufw >/dev/null 2>&1; then
    ufw delete allow from 172.0.0.0/8 to any port "$PORT" proto tcp >/dev/null 2>&1
  fi
fi

RULES_DIR=$(ls -d /etc/komodo/stacks/*/config/traefik/rules 2>/dev/null | head -1)
[ -n "$RULES_DIR" ] && rm -f "$RULES_DIR/hermes-remote-${SANDBOX}.yml"

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] && docker exec "$CONTAINER" pkill -f 'hermes_cli.main dashboard' 2>/dev/null

rm -f "$(access_file "$SANDBOX")"
log "unexposed '$SANDBOX'"
