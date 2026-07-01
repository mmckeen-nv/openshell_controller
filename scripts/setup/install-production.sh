#!/bin/bash
# Production post-install for openshell-controller on a BYOVPS host.
#
# Run this AFTER:
#   1. install_versioned_nemoclaw_openshell.sh has installed OpenShell + NemoClaw.
#   2. `npm install` + `npx next build` have run in /opt/openshell-controller.
#   3. A populated `.env.local` is in place at /opt/openshell-controller/.env.local.
#
# This script does the host-side configuration that install.sh deliberately
# skips (install.sh is documented as a dev installer). All of these were
# discovered the hard way during a fresh-VPS redeploy on 2026-06-21:
#
#   1. Systemd unit (/etc/systemd/system/openshell-controller.service)
#      — must include HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS so the
#        controller's ssh-via-openshell-gateway path works.
#   2. needrestart guard
#      — Ubuntu's unattended-upgrades + needrestart will hammer the
#        controller with restarts on any libssl upgrade, tripping
#        StartLimitBurst. The drop-in file suppresses that. See CLAUDE.md §10
#        "needrestart vs the controller" for the incident that motivated it.
#   3. Gateway DB parent directory
#      — openshell-gateway points OPENSHELL_DB_URL at
#        /root/.local/state/nemoclaw/openshell-docker-gateway/openshell.db.
#        After a purge that parent dir is missing and the gateway crash-loops
#        with "unable to open database file" — manifests as "transport error:
#        tcp connect error: Connection refused" from any openshell CLI call.
#   4. UFW rules
#      — sandbox containers are on the openshell-docker bridge (172.19.0.0/16
#        by default). Without an explicit UFW allow from 172.0.0.0/8 to the
#        gateway port, the sandbox supervisor can't fetch its policy from the
#        openshell-gateway and the sandbox enters Error state at boot.
#
# Safe to re-run: every step is idempotent.

set -euo pipefail
umask 022

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*" >&2; }
die()  { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "Run as root."

# Path to the controller source tree. Override with OPENSHELL_CONTROLLER_DIR
# if you've cloned somewhere other than /opt/openshell-controller.
CONTROLLER_DIR="${OPENSHELL_CONTROLLER_DIR:-/opt/openshell-controller}"
[ -d "$CONTROLLER_DIR" ] || die "controller dir not found: $CONTROLLER_DIR"
[ -f "$CONTROLLER_DIR/server.mjs" ] || die "$CONTROLLER_DIR/server.mjs missing — did install.sh run?"
[ -f "$CONTROLLER_DIR/.env.local" ] || warn ".env.local missing in $CONTROLLER_DIR — controller will start but auth will fail."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/openshell-controller.service"
UNIT_DEST="/etc/systemd/system/openshell-controller.service"
[ -r "$UNIT_SRC" ] || die "unit template not found at $UNIT_SRC"

# ── 1. systemd unit ──────────────────────────────────────────────────────────

if [ -f "$UNIT_DEST" ] && cmp -s "$UNIT_SRC" "$UNIT_DEST"; then
  log "systemd unit already up-to-date at $UNIT_DEST"
else
  log "installing systemd unit at $UNIT_DEST"
  install -m 0644 "$UNIT_SRC" "$UNIT_DEST"
  systemctl daemon-reload
fi

# ── 2. needrestart guard ─────────────────────────────────────────────────────

NEEDRESTART_DROPIN="/etc/needrestart/conf.d/openshell-controller.conf"
if [ -d /etc/needrestart/conf.d ]; then
  if [ ! -f "$NEEDRESTART_DROPIN" ]; then
    log "installing needrestart guard at $NEEDRESTART_DROPIN"
    cat > "$NEEDRESTART_DROPIN" <<'CONF'
# Suppress automatic restart of openshell-controller by unattended-upgrades.
# Repeated restarts on a single upgrade cycle (libssl etc.) trip
# StartLimitBurst and leave the service Failed. See CLAUDE.md §10.
$nrconf{override_rc}{qr(^openshell-controller\.service$)} = 0;
CONF
  else
    log "needrestart guard already present"
  fi
else
  warn "needrestart not installed (no /etc/needrestart/conf.d) — skipping guard"
fi

# ── 3. openshell-gateway DB parent directory ────────────────────────────────
#
# Resolve the path from /root/.config/openshell/gateway.env (where openshell
# itself writes its config). Falls back to the default NemoClaw location if
# the env file isn't there yet.

GATEWAY_ENV="/root/.config/openshell/gateway.env"
DB_URL=""
if [ -r "$GATEWAY_ENV" ]; then
  DB_URL=$(awk -F= '/^OPENSHELL_DB_URL=/ { sub(/^OPENSHELL_DB_URL=/, ""); print; exit }' "$GATEWAY_ENV")
fi
DB_URL="${DB_URL:-sqlite:/root/.local/state/nemoclaw/openshell-docker-gateway/openshell.db}"

# Strip the sqlite: scheme and resolve the parent dir.
DB_PATH="${DB_URL#sqlite:}"
DB_PARENT=$(dirname "$DB_PATH")
if [ ! -d "$DB_PARENT" ]; then
  log "creating gateway DB parent dir $DB_PARENT"
  mkdir -p "$DB_PARENT"
else
  log "gateway DB parent dir already exists: $DB_PARENT"
fi

# ── 4. UFW rules ─────────────────────────────────────────────────────────────
#
# Skip silently if UFW isn't installed (e.g. cloud images that ship with
# iptables or nftables instead). On VPS hosts that DO use UFW, sandbox
# containers can't reach the openshell-gateway without these rules.

UFW=/usr/sbin/ufw
if [ -x "$UFW" ] && "$UFW" status 2>/dev/null | grep -q "^Status: active"; then
  for port in 8080 18789; do
    if ! "$UFW" status 2>/dev/null | grep -q "$port/tcp.*172.0.0.0/8"; then
      log "adding UFW allow from 172.0.0.0/8 to port $port"
      "$UFW" allow from 172.0.0.0/8 to any port "$port" proto tcp >/dev/null 2>&1 || \
        warn "ufw allow for port $port failed (continuing)"
    else
      log "UFW rule for port $port already present"
    fi
  done
else
  log "UFW not active — skipping firewall rules"
fi

# ── 5. Linger for root ──────────────────────────────────────────────────────
#
# The openshell-gateway runs as a USER systemd service under root. Without
# linger, the user manager is torn down when the SSH session ends, killing
# the gateway. Install enables it; purge disables it.

if [ ! -f /var/lib/systemd/linger/root ]; then
  log "enabling systemd linger for root (keeps openshell-gateway alive after logout)"
  loginctl enable-linger root 2>/dev/null || warn "loginctl enable-linger root failed"
else
  log "systemd linger for root already enabled"
fi

# ── 6. Enable + start the controller ─────────────────────────────────────────

systemctl enable openshell-controller >/dev/null 2>&1
if systemctl is-active --quiet openshell-controller; then
  log "openshell-controller is already running — restarting to pick up any changes"
  systemctl restart openshell-controller
else
  log "starting openshell-controller"
  systemctl start openshell-controller
fi

sleep 3
if systemctl is-active --quiet openshell-controller; then
  log "openshell-controller is running ✓"
  # Quick smoke check
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/login 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    log "GET /login -> 200 ✓"
  else
    warn "GET /login -> $code (controller is up but the login page didn't return 200; check the journal)"
  fi
else
  die "openshell-controller failed to start. See: journalctl -u openshell-controller -n 50"
fi
