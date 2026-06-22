# Runbook — Fresh VPS first-time setup

> Indexed from CLAUDE.md §4 (Runbooks index). Reach for this on a
> brand-new VPS (BYOVPS or cloud). For incremental deploys to an
> already-installed VPS, use the Deploy procedure in CLAUDE.md §2.

`install.sh` is intentionally a dev installer — it doesn't write the
systemd unit, doesn't open firewall ports, doesn't create the
openshell-gateway DB parent dir, and doesn't install the needrestart
guard. The full sequence on a brand-new VPS is:

```bash
# 1. Wipe (if redeploying on a host that already had an install)
bash manidae-cloud/docs/purge-agent-stack.sh   # interactive — answer N to
                                                # "Komodo stack" prompts if you
                                                # want to preserve Pangolin/Traefik

# 2. Versioned openshell + NemoClaw + OpenClaw bring-up
git clone https://github.com/ivobrett/openshell_controller.git /opt/openshell-controller
cd /opt/openshell-controller && git checkout gatewaydashboard
mkdir -p /root/.local/state/nemoclaw/openshell-docker-gateway  # else gateway crashes on first start
NVIDIA_API_KEY=nvapi-...
bash install_versioned_nemoclaw_openshell.sh --nvidia-api-key "$NVIDIA_API_KEY"

# 3. Controller build + production wiring
scp .env.local root@<vps>:/opt/openshell-controller/.env.local
PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH npm install
PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH node_modules/.bin/next build
bash scripts/setup/install-production.sh    # writes systemd unit, UFW rules,
                                            # needrestart guard, DB parent dir,
                                            # linger, then starts the service

# 4. NemoClaw onboarding (creates the first OpenClaw sandbox + brings the
#    gateway online for sandbox creation)
NEMOCLAW_PROVIDER=build \
NEMOCLAW_NON_INTERACTIVE=1 \
NVIDIA_INFERENCE_API_KEY="$NVIDIA_API_KEY" \
NVIDIA_API_KEY="$NVIDIA_API_KEY" \
nemoclaw onboard --fresh --non-interactive --yes-i-accept-third-party-software \
                 --no-gpu --no-sandbox-gpu
```

`scripts/setup/install-production.sh` is idempotent — safe to re-run
after every deploy. It owns the four host-side concerns that the dev
`install.sh` doesn't:

| Concern | Why it can't be in install.sh |
|---|---|
| systemd unit at `/etc/systemd/system/openshell-controller.service` | `install.sh` is documented as dev-mode; production unit needs `HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS` for ssh-via-openshell-gateway to work, which only matters under systemd |
| `/etc/needrestart/conf.d/openshell-controller.conf` | Only relevant on production hosts using `unattended-upgrades`. See `docs/runbooks/byovps-architecture.md` § "needrestart vs the controller" for the underlying incident |
| `/root/.local/state/nemoclaw/openshell-docker-gateway/` | The DB parent dir is wiped by `purge-agent-stack.sh` and never recreated by NemoClaw's onboard; gateway crash-loops without it |
| UFW allow `from 172.0.0.0/8 to any port 8080,18789 proto tcp` | Sandbox containers on the openshell-docker bridge can't reach the gateway without these |
