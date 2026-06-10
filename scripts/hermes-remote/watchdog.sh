#!/bin/bash
# Self-heal every exposed Hermes sandbox. Run by hermes-remote-watchdog.timer
# every 2 minutes. Covers plan risk #11: sandbox restarts change the gateway
# PID/netns, killing the dashboard; launch.sh re-discovers and relaunches.
# Forwards are systemd-supervised already, but we nudge any that wedged.

TAG="[hermes-remote-watchdog]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

shopt -s nullglob
for f in "$ACCESS_DIR"/*.json; do
  name=$(basename "$f" .json)

  if [ -z "$(find_sandbox_container "$name")" ]; then
    log "sandbox '$name' has no running container — skipping (unexpose if deleted)"
    continue
  fi

  "$SCRIPT_DIR/launch.sh" "$name" || warn "launch failed for '$name'"

  if ! systemctl is-active --quiet "hermes-remote-forward@${name}.service"; then
    log "restarting forward unit for '$name'"
    systemctl restart "hermes-remote-forward@${name}.service" 2>/dev/null \
      || warn "forward unit restart failed for '$name'"
  fi
done
