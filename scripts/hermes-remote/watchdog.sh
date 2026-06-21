#!/bin/bash
# Self-heal every exposed Hermes sandbox. Run by hermes-remote-watchdog.timer
# every 2 minutes. Covers plan risk #11: sandbox restarts change the gateway
# PID/netns, killing the dashboard; launch.sh re-discovers and relaunches.
# Forwards are systemd-supervised already, but we nudge any that wedged.
#
# BYOVPS gateway-crash recovery (#2478):
# The Hermes gateway cannot self-recover from abrupt crashes (SIGKILL / OOM /
# Python exception) because gateway-recovery only forks on graceful SIGTERM.
# When the gateway dies abruptly AND /tmp/nemoclaw-proxy-env.sh exists (as it
# always does on BYOVPS after the first startup), gateway-recovery refuses to
# restart because NODE_OPTIONS lacks the "safety-net preload" that NemoClaw
# expects on cloud installs. The workaround: remove proxy-env.sh so the
# "missing" code path is taken (which starts the gateway without guards), then
# run `nemoclaw recover` to trigger the restart.

TAG="[hermes-remote-watchdog]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# Attempt to restart a dead gateway using `nemoclaw recover`.
# Removes /tmp/nemoclaw-proxy-env.sh first so gateway-recovery takes the
# "missing" code path (bypassing the NODE_OPTIONS safety-net check, #2478).
recover_dead_gateway() {
  local name="$1" container="$2"
  log "gateway dead for '$name' — attempting nemoclaw recover (BYOVPS #2478 workaround)"

  # Remove proxy-env.sh so gateway-recovery starts without the NODE_OPTIONS guard.
  docker exec "$container" sh -c \
    'chmod u+w /tmp/nemoclaw-proxy-env.sh 2>/dev/null; rm -f /tmp/nemoclaw-proxy-env.sh' \
    2>/dev/null || true

  # nemoclaw lives in the nvm bin dir which is not in systemd's PATH
  local nemoclaw_bin
  nemoclaw_bin=$(command -v nemoclaw 2>/dev/null \
    || ls /root/.nvm/versions/node/*/bin/nemoclaw 2>/dev/null | sort -t/ -k8 -V | tail -1 \
    || true)
  if [ -z "$nemoclaw_bin" ]; then
    warn "nemoclaw not found — cannot auto-recover gateway for '$name'"
    return 1
  fi

  "$nemoclaw_bin" "$name" recover 2>/dev/null || true
  sleep 8  # give the gateway time to start up

  # Verify the gateway came up
  local pid
  pid=$(find_gateway_pid "$container")
  if [ -n "$pid" ]; then
    log "gateway for '$name' recovered at PID $pid"
    return 0
  else
    warn "gateway for '$name' still dead after recover attempt"
    return 1
  fi
}

shopt -s nullglob
for f in "$ACCESS_DIR"/*.json; do
  name=$(basename "$f" .json)

  CONTAINER=$(find_sandbox_container "$name")
  if [ -z "$CONTAINER" ]; then
    log "sandbox '$name' has no running container — skipping (unexpose if deleted)"
    continue
  fi

  # If the Hermes gateway process is dead, try to recover it before launch.sh
  # attempts to (re)launch the dashboard — launch.sh exits immediately if it
  # can't find a live gateway PID.
  if [ -z "$(find_gateway_pid "$CONTAINER")" ]; then
    recover_dead_gateway "$name" "$CONTAINER" || true
  fi

  "$SCRIPT_DIR/launch.sh" "$name" || warn "launch failed for '$name'"

  if ! systemctl is-active --quiet "hermes-remote-forward@${name}.service"; then
    log "restarting forward unit for '$name'"
    systemctl restart "hermes-remote-forward@${name}.service" 2>/dev/null \
      || warn "forward unit restart failed for '$name'"
  fi
done
