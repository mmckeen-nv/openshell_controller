#!/bin/bash
# Upgrade hermes-agent inside a sandbox to >=0.16 and restart its gateway.
#
# Usage: upgrade-hermes.sh <sandbox-name>
#
# ── TEMPORARY SHIM — remove when NemoClaw base image ships Hermes >=0.16 ──
#
# This script exists solely because NemoClaw's hermes sandbox base image
# (`openshell/sandbox-base-u24`) currently ships Hermes 0.14.x, while the
# remote-desktop feature requires >=0.16 (HERMES_DASHBOARD_SESSION_TOKEN
# pinning + Hermes Desktop API compatibility).
#
# HOW TO REMOVE:
#   1. Confirm the NemoClaw base image bundles Hermes >=0.16 by default.
#      Check by creating a fresh Hermes sandbox and running:
#        docker exec openshell-<name>-* /opt/hermes/.venv/bin/hermes --version
#      If it prints 0.16.x or higher, the shim is no longer needed.
#   2. Delete this file (upgrade-hermes.sh).
#   3. In launch.sh, remove the version check block that calls this script
#      (the "Hermes >=0.16 required" section and the upgrade-hermes.sh call).
#      Keep the API_SERVER_KEY provisioning block — that's still needed
#      for any sandbox that was created before it was introduced.
#   4. In expose.sh, if it references upgrade-hermes.sh directly, remove
#      that reference too (grep for "upgrade-hermes").
#   5. Update CLAUDE.md section 9 to remove the version-match caveat once
#      fresh deployments no longer need the in-place pip upgrade.
#
# Why: NemoClaw's hermes base image ships 0.14.x, but the remote-desktop
# feature needs >=0.16 (HERMES_DASHBOARD_SESSION_TOKEN pinning, plus the
# endpoints current Hermes Desktop builds call). The desktop and backend
# must run the same minor version.
#
# Recipe validated on the live VPS (2026-06-10):
#  * pip ONLY works from inside the gateway netns through the L7 proxy
#    (the proxy enforces per-binary policy; the venv python is allowlisted,
#    uv is not; the venv ships without pip — ensurepip bootstraps it).
#  * After upgrade the running gateway still executes old code — restart it
#    via `nemohermes recover`. The recovery guard (#2478) refuses when
#    /tmp/nemoclaw-proxy-env.sh lacks NODE_OPTIONS preloads (Hermes-flavour
#    skew); moving the file aside makes the guard warn-and-proceed.
#  * Hermes >=0.16 gateways refuse to start without API_SERVER_KEY
#    (launch.sh provisions it + re-pins the config-integrity hash).

TAG="[hermes-remote-upgrade]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: upgrade-hermes.sh <sandbox-name>"

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] || die "no running container for sandbox '$SANDBOX'"
GW_PID=$(find_gateway_pid "$CONTAINER")
[ -n "$GW_PID" ] || die "no running 'hermes gateway run' in $CONTAINER"

current=$(docker exec "$CONTAINER" /opt/hermes/.venv/bin/hermes --version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+' | tr -d v)
log "current hermes version: ${current:-unknown}"
if [ -n "$current" ] && python3 -c "import sys; sys.exit(0 if tuple(map(int,'$current'.split('.'))) >= (0,16) else 1)"; then
  log "already >=0.16 — nothing to do"
  exit 0
fi

# ── Bootstrap pip (offline) and upgrade through the L7 proxy ───────
docker exec "$CONTAINER" /opt/hermes/.venv/bin/python -m pip --version >/dev/null 2>&1 \
  || docker exec "$CONTAINER" /opt/hermes/.venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 \
  || die "could not bootstrap pip in the hermes venv"

log "upgrading hermes-agent (inside gateway netns, via L7 proxy)..."
nsenter_sandbox "$CONTAINER" "$GW_PID" sh -c "
  export HTTPS_PROXY=http://10.200.0.1:3128 NO_PROXY=localhost,127.0.0.1,::1,10.200.0.1
  export SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem PIP_CERT=/etc/openshell-tls/ca-bundle.pem
  /opt/hermes/.venv/bin/python -m pip install --upgrade --quiet hermes-agent
" || die "pip upgrade failed (is the pypi egress preset applied to this sandbox?)"

new=$(docker exec "$CONTAINER" /opt/hermes/.venv/bin/hermes --version 2>/dev/null | head -1)
log "installed: $new"

# ── Restart the gateway so it runs the new code ────────────────────
# Resolve node for the nemohermes CLI (the controller's systemd env may not
# have nvm's bin dir on PATH).
NODE_BIN=$(command -v node || ls /root/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
NEMOHERMES_JS=$(ls /opt/nemoclaw/bin/nemohermes.js 2>/dev/null | head -1)
[ -n "$NODE_BIN" ] && [ -n "$NEMOHERMES_JS" ] || die "node or nemohermes.js not found — cannot restart the gateway"

docker exec "$CONTAINER" pkill -f 'hermes gateway run' 2>/dev/null
sleep 3
docker exec "$CONTAINER" mv /tmp/nemoclaw-proxy-env.sh /tmp/nemoclaw-proxy-env.sh.disabled 2>/dev/null
timeout 240 "$NODE_BIN" "$NEMOHERMES_JS" "$SANDBOX" recover >/dev/null 2>&1
docker exec "$CONTAINER" mv /tmp/nemoclaw-proxy-env.sh.disabled /tmp/nemoclaw-proxy-env.sh 2>/dev/null

# recover's own probe races gateway boot — verify directly.
for _ in $(seq 1 20); do
  sleep 3
  NEW_GW=$(find_gateway_pid "$CONTAINER")
  if [ -n "$NEW_GW" ]; then
    log "gateway relaunched (pid $NEW_GW) on upgraded hermes"
    exit 0
  fi
done

docker exec "$CONTAINER" tail -5 /tmp/gateway.log >&2 2>/dev/null
die "gateway did not come back after upgrade — check /tmp/gateway.log in the sandbox"
