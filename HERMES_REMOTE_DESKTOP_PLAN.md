# Hermes Remote Desktop Plan — Multi-Tenant per-Sandbox Exposure

Status: **draft**
Owner: ivobrett
Last updated: 2026-06-10

## 1. Goal

Allow an end-user running the **Hermes Desktop app** on their laptop to point its "Remote gateway" setting at a public HTTPS URL and drive a Hermes agent running inside a NemoClaw sandbox on a shared, multi-tenant VPS — without any per-sandbox VPS, manual VPN, or SSH tunnel on the client side.

Critically: one VPS hosts many sandboxes, each belonging to a different end-customer. Each sandbox must be reachable at its own URL, with its own auth, and traffic must be isolated.

```
Hermes Desktop (client laptop)
        │
        │  HTTPS  Remote URL = https://openshell-controller.<base>/hermes/<sandbox>
        ▼
Traefik on VPS (TLS + auth + PathPrefix routing)
        │
        ▼
host loopback / docker0 (per-sandbox port, 21000+hash)
        │  SSH tunnel maintained by systemd
        ▼
sandbox container, gateway-process netns
        │
        ▼
hermes dashboard (FastAPI/uvicorn on 0.0.0.0:9119)
        │  uses inference.local → HTTPS_PROXY → outbound LLM
        ▼
upstream LLM provider
```

## 2. Background — what the desktop app actually wants

The "Remote gateway" dialog in Hermes Desktop says:

> Base URL for the remote dashboard backend. Path prefixes are supported, for example `/hermes`.

The desktop app is the Electron shell of the same SPA that `hermes dashboard` serves on **port 9119**. It is **not** the inference gateway (port 8642 inside the sandbox). When the agent answered "localhost:8642/v1" to the question "what is the gateway URL?", it described its own internal LLM client — which is irrelevant here.

Four facts from upstream docs (Hermes "Connecting to a remote backend") reshape the design:

1. **Hermes has built-in auth.** Binding the dashboard to a non-loopback address (e.g. `--host 0.0.0.0`) **automatically engages an auth gate**. Configured providers are username/password (`HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD/SECRET` in `~/.hermes/.env`), OAuth via Nous Portal, or a self-hosted OIDC provider. **Auth lives in Hermes — not in any reverse proxy in front of it.** The desktop app introspects `/api/status` (returns `auth_required` and `auth_providers`) and adapts its sign-in button to whichever provider the backend advertises.
2. **Username/password is for trusted networks only.** The docs warn explicitly: *"never expose a password-protected dashboard directly to the open internet; put it behind a VPN."* For our SaaS, that means basicAuth is acceptable for POC and local-dev only; **production multi-tenant must use OAuth (Nous Portal) or self-hosted OIDC**.
3. **Path prefixes are officially supported.** Quoting the docs: *"path prefixes like `/hermes` work if you front it with a reverse proxy."* Hermes' `web_server.py` `mount_spa()` honours `X-Forwarded-Prefix` and rewrites absolute SPA paths plus sets `window.__HERMES_BASE_PATH__` automatically. **No HTML body rewriting needed on the proxy side** (unlike OpenClaw).
4. **WebSocket endpoints share the same origin/path** as the SPA. Traefik PathPrefix routers tunnel WS transparently — no separate WS router required.

Combined effect: the reverse-proxy layer reduces to **TLS termination + `stripPrefix` + `X-Forwarded-Prefix` injection + TCP forward**. Auth is offloaded entirely to Hermes. That's a tiny Traefik file-provider rule, not a custom Node proxy and not a reused OpenClaw branch.

### Why this overrides the earlier "reuse OpenClaw proxy" analysis

An earlier draft of this plan considered routing Hermes traffic through the existing `openshell-controller` reverse proxy in `server.mjs` (the one that handles OpenClaw dashboards). The main argument for that path was reusing proven auth/cookie machinery and the WebSocket bridge. With Hermes handling auth natively, the proxy is pure transport — Traefik does it better with zero JS code change and per-sandbox failure isolation. **The OpenClaw-reuse path is no longer recommended for Hermes.**

## 3. Current state (what already exists)

| Repo | Already built | Gap |
|---|---|---|
| `manidae-cloud` `startup_hermes_agent.sh.j2` | Standalone `hermes-agent` package: Hermes on host port 9119, Traefik basic-auth at deployment subdomain | Only works for single-tenant `hermes-agent` package, not the multi-sandbox NemoClaw deployment |
| `manidae-cloud` `startup_nemoclaw.sh.j2` | Single-sandbox launcher + SSH tunnel binding `127.0.0.1:9119 → sandbox netns 127.0.0.1:9119`. Spawns dashboard via `nsenter -t <gw_pid> -n ... hermes dashboard --host 0.0.0.0 --port 9119` | Single sandbox only — port is hardcoded. No per-sandbox Traefik rule. Tunnel binds to `127.0.0.1` not `172.17.0.1`. |
| `manidae-cloud` `byovps_bootstrap.py:1140-1200` | Same launcher logic as a pure-Python builder for BYOVPS bootstrap | Same single-sandbox limitation |
| `openshell_controller` `server.mjs:345-413` | OpenClaw multi-sandbox reverse proxy: port = `19000 + hash(sandboxId) % 2000`; resolves to `sandbox-<port>-<id>` instance; WebSocket bridge in `dashboardWss` | No equivalent for Hermes. OpenClaw needs HTML rewriting, Hermes doesn't, so the right Hermes path is "thin Traefik rule", not "extend Node proxy" |
| `openshell_controller` `install.sh` / install scripts | Sets up systemd services for the controller itself | No per-sandbox lifecycle hooks |

## 4. Target architecture (multi-tenant)

### 4.1 Port allocation

Mirror the existing OpenClaw scheme (`server.mjs:358`) but with a different base to avoid collisions:

```
HERMES_DASHBOARD_PORT_BASE = 21000     # OpenClaw uses 19000..20999
HERMES_DASHBOARD_PORT_RANGE = 2000
sandbox_port = 21000 + (hashSandboxId(sandboxId) % 2000)
```

The port is deterministic — same sandbox name always gets the same port across restarts. Collisions inside a single VPS are vanishingly unlikely (mod 2000 with hand-picked names) but the lifecycle hook MUST check `ss -lntp` for actual occupation and rehash if needed (record the chosen port in `/etc/openshell/hermes-ports.json` for the lifetime of the sandbox).

### 4.2 Public URL convention

```
https://openshell-controller.<base-domain>/hermes/<sandbox>
```

Re-using the controller subdomain (already provisioned, already has TLS) — the new content lives under a path prefix. Alternative `https://hermes-<sandbox>.<base-domain>` requires Cloudflare wildcard cert + per-sandbox DNS records and is more moving parts; defer.

### 4.3 Per-sandbox systemd tunnel unit

`/etc/systemd/system/hermes-dashboard-tunnel@.service` (templated; `%i` = sandbox name):

```ini
[Unit]
Description=Hermes Dashboard SSH Tunnel for sandbox %i
After=network-online.target openshell-gateway.service
Wants=network-online.target
StartLimitBurst=10
StartLimitIntervalSec=60

[Service]
Type=simple
EnvironmentFile=/etc/openshell/hermes-tunnel-%i.env
ExecStart=/usr/bin/ssh -N \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o "ProxyCommand=/usr/bin/openshell ssh-proxy --gateway-name nemoclaw --name %i" \
  -L 172.17.0.1:${HERMES_HOST_PORT}:127.0.0.1:9119 \
  sandbox@openshell-%i
Restart=always
RestartSec=5
```

**Critical**: bind `-L 172.17.0.1:...` (docker0 bridge IP), **not** `127.0.0.1`. Traefik runs in a container; loopback binds are unreachable from inside Traefik's network namespace. This is one of the gotchas recorded in `project_hermes_dashboard_via_path_prefix.md`.

### 4.4 Per-sandbox dashboard launcher

Re-use the existing `/usr/local/bin/hermes-dashboard-launch.sh` from `startup_nemoclaw.sh.j2:340-405` but parameterise by sandbox name (drop the hardcoded `SANDBOX_NAME=...`, take it as `$1`) **and inject Hermes-native auth env vars before spawning the dashboard**. The launcher already:

* Locates `openshell-<sandbox>-...` container via `docker ps`
* Finds `hermes gateway run` PID (its netns is the only one that can reach `inference.local`)
* Reads `HERMES_HOME`, `HOME`, `HTTPS_PROXY`, `NEMOCLAW_*` from `/proc/<gw_pid>/environ` (mandatory — otherwise `su` resets HOME and Hermes hits PermissionError on `/root/.hermes/.env`)
* Spawns dashboard via `docker exec -d --privileged ... nsenter -t $GW_PID -n -- ... hermes dashboard --skip-build --host 0.0.0.0 --port 9119 --no-open`
* Polls `http://127.0.0.1:9119/` until ready

**Changes required**:

1. **Drop `--insecure`** — that flag bypasses Hermes' auth gate; we want the gate ON.
2. **Before spawning**, append the auth provider env vars into `~/.hermes/.env` inside the sandbox:

   ```bash
   docker exec "$SB_CONT" bash -c "cat >> /home/sandbox/.hermes/.env <<EOF
   HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${HERMES_USER}
   HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=${HERMES_PW_HASH}
   HERMES_DASHBOARD_BASIC_AUTH_SECRET=${HERMES_SECRET}
   EOF
   chmod 600 /home/sandbox/.hermes/.env"
   ```

   Use `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` (scrypt) rather than plaintext `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` — compute with `python -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password('PW'))"` (the dashboard ships this).

   For OAuth / OIDC mode (Phase 3), instead write the OAuth client_id/secret/issuer env vars per the Hermes docs' "Web Dashboard → Default provider: Nous Research" section.

3. **Verify auth gate is live** after spawn by hitting `/api/status` from inside the netns:

   ```bash
   docker exec --privileged "$SB_CONT" nsenter -t $GW_PID -n -- \
     curl -s http://127.0.0.1:9119/api/status | jq '.auth_required, .auth_providers'
   # Must print: true  ["basic"]   (or ["oauth"] in Phase 3)
   ```

   Loud-fail with `die "auth gate not engaged — refusing to expose"` if `auth_required` is false. **This is the safety interlock that prevents accidentally exposing an unauthenticated dashboard to the internet.**

Wrap in a systemd `hermes-dashboard-launcher@.service` that runs on demand from the sandbox-create hook (oneshot, idempotent).

**Note**: Inside-sandbox port stays 9119 for every sandbox — different sandboxes can't see each other's netns, so no collision. The per-sandbox port we hash is the **host** side of the SSH tunnel.

### 4.5 Per-sandbox Traefik rule

Dropped as a file into the Komodo-managed stack's `traefik/rules/` directory. **No auth middleware** — Hermes handles auth itself, the proxy is pure transport:

```yaml
# /etc/komodo/stacks/<stack>/config/traefik/rules/hermes-dashboard-<sandbox>.yml
http:
  routers:
    99-hermes-dashboard-<sandbox>:
      entryPoints: [websecure]
      priority: 250
      rule: "Host(`openshell-controller.<base>`) && PathPrefix(`/hermes/<sandbox>`)"
      service: 99-hermes-dashboard-<sandbox>-svc
      middlewares:
        - 99-hermes-dashboard-<sandbox>-strip
        - 99-hermes-dashboard-<sandbox>-prefix
      tls: { certResolver: letsencrypt }
  services:
    99-hermes-dashboard-<sandbox>-svc:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:<host_port>"
  middlewares:
    99-hermes-dashboard-<sandbox>-strip:
      stripPrefix:
        prefixes: ["/hermes/<sandbox>"]
    99-hermes-dashboard-<sandbox>-prefix:
      headers:
        customRequestHeaders:
          X-Forwarded-Prefix: "/hermes/<sandbox>"
```

Traefik file-provider watches the directory; no reload needed.

### 4.6 Auth — pick per deployment tier, Hermes-native only

All three options below are configured **inside Hermes** (env vars in `~/.hermes/.env` inside the sandbox); the Traefik rule above is identical regardless.

| Tier | Mechanism | Desktop-app sign-in | When to use |
|---|---|---|---|
| **A. Username/password** (POC + trusted-network only) | `HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD_HASH/SECRET` in `~/.hermes/.env`. Hermes' built-in `basic` provider. | Desktop shows "Sign in" → credential form; enter username + password | POC; local dev; Tailscale-fronted private deploys. **Explicitly NOT for public-internet multi-tenant per Hermes docs.** |
| **B. OAuth via Nous Portal** | `hermes dashboard register` (one-time per sandbox) provisions an OAuth client with the Nous Portal. Hermes' built-in `oauth` provider points at the Portal as issuer. | Desktop shows "Sign in with Nous Research" → browser-based OAuth flow → token persists | **Production default for SaaS multi-tenant.** Recommended by Hermes docs for any public-internet exposure. End-customers need a Nous account. |
| **C. Self-hosted OIDC** | We run our own OIDC provider (candidate: extend Pangolin/Badger, or stand up a dedicated Keycloak/Authentik beside the control plane). Each Hermes dashboard registers as an OIDC client of our IdP. | Desktop shows "Sign in with HostMyAgents" → browser-based OIDC → token persists | When we want end-customer accounts bound to our SaaS identity (not Nous). Adds an IdP service to operate but cleanest UX integration. Likely the long-term answer. |

**Recommendation**:
- **Phase 0 POC**: tier A (username/password) — fastest to validate the IPC chain end-to-end.
- **Phase 1**: still tier A — single-sandbox automation.
- **Phase 2 (multi-tenant)**: still tier A, but with a hard interlock that refuses to expose any sandbox to a Cloudflare-fronted public URL unless tier B or C is configured. Tier A only allowed for VPN/Tailscale-fronted deployments.
- **Phase 3 (production hardening)**: tier B (Nous Portal OAuth) as the default, tier C optional if we decide to own the IdP.

### 4.7 Safety interlock — refuse public exposure of basicAuth

In Phase 2 onwards, before writing a Traefik rule that exposes a sandbox at a Cloudflare-fronted hostname, the lifecycle hook must:

1. Probe `/api/status` and confirm `auth_providers` contains something stronger than `"basic"` for any deployment marked `public_internet: true`.
2. If only `["basic"]` is configured AND the host matches `*.hostmyagents.com` or similar public domain, **refuse to write the Traefik rule** and surface a UI error: "Hermes Desktop requires OAuth or OIDC for public exposure. Run `hermes dashboard register` first."

This interlock enforces the upstream warning at the platform layer so a misconfigured deployment can't accidentally ship a single-password-protected dashboard to the open internet.

## 5. Phase 0 — Proof of Concept (do this FIRST, before any controller changes)

The inter-process chain (Traefik → docker0 → ssh-tunnel → nsenter into gateway netns → uvicorn) has many failure modes. Before touching `openshell_controller` lifecycle code or `manidae-cloud` templates, prove the entire chain end-to-end **by hand** on the live VPS (`167.233.45.113`).

### POC scope

* **One** existing sandbox (`my-first-hermes`, already proven working through the controller's `/operator-terminal` wrapper).
* Use **a second host port** (e.g. 21099) so we don't collide with the existing tunnel on 9119.
* Use **a second URL path** (`/hermes-poc/my-first-hermes`) so the existing controller routes are untouched.
* Don't change any code yet — every step is a shell command we can revert.

### POC steps (run from your laptop, SSH'ing into the VPS)

> **Security note**: this POC uses Hermes' built-in `basic` (username/password) auth provider, which upstream docs say is for trusted networks only. The POC URL is unique-by-path and torn down within an hour. Do NOT leave it live. For sustained public exposure, switch to OAuth in Phase 3.

```bash
ssh -i ~/.ssh/tf_hetzner root@167.233.45.113

# ────── Step 1: confirm dashboard is already running in the sandbox ──────
SB=$(docker ps --format '{{.Names}}' | grep '^openshell-my-first-hermes-' | head -1)
docker exec "$SB" pgrep -f 'hermes dashboard'        # must return a PID
docker exec "$SB" ss -lntp | grep 9119               # must show uvicorn

# Check current auth state
GW_PID=$(docker exec "$SB" pgrep -f 'hermes gateway run' | head -1)
docker exec --privileged "$SB" nsenter -t $GW_PID -n -- \
  curl -s http://127.0.0.1:9119/api/status | jq '.auth_required, .auth_providers'
# Likely shows: false []  (because current launcher uses --insecure)
```

```bash
# ────── Step 2: enable Hermes-native basicAuth and restart the dashboard ──────
# Generate creds
HERMES_USER=poc-admin
HERMES_PW=$(openssl rand -base64 18)
HERMES_SECRET=$(openssl rand -base64 32)

# Compute scrypt hash inside the sandbox (Hermes ships the helper)
HERMES_PW_HASH=$(docker exec "$SB" /opt/hermes/.venv/bin/python -c \
  "from plugins.dashboard_auth.basic import hash_password; print(hash_password('$HERMES_PW'))")

# Write into ~/.hermes/.env inside the sandbox (sandbox user's home)
docker exec "$SB" bash -c "cat >> /home/sandbox/.hermes/.env <<EOF
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=$HERMES_USER
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=$HERMES_PW_HASH
HERMES_DASHBOARD_BASIC_AUTH_SECRET=$HERMES_SECRET
EOF
chmod 600 /home/sandbox/.hermes/.env
chown sandbox:sandbox /home/sandbox/.hermes/.env"

# Kill the existing dashboard so the relaunch picks up new env
docker exec "$SB" pkill -f 'hermes dashboard' || true
sleep 2

# Relaunch via the existing launcher (it will spawn dashboard reading the new .env)
# CRITICAL: relaunch WITHOUT --insecure so the auth gate engages
/usr/local/bin/hermes-dashboard-launch.sh

# Verify auth is now engaged
docker exec --privileged "$SB" nsenter -t $GW_PID -n -- \
  curl -s http://127.0.0.1:9119/api/status | jq '.auth_required, .auth_providers'
# MUST show: true  ["basic"]

# Save creds to print at end
echo "POC creds — user: $HERMES_USER  password: $HERMES_PW"
```

> If the existing launcher hard-codes `--insecure`, edit `/usr/local/bin/hermes-dashboard-launch.sh` to remove that flag for the POC (revert after).

```bash
# ────── Step 3: open a SECOND SSH tunnel on a new port, bound to docker0 ──────
# (this is the line we'll templatise later — for POC, run it in a screen session)
ssh -N \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o "ProxyCommand=/usr/bin/openshell ssh-proxy --gateway-name nemoclaw --name my-first-hermes" \
  -L 172.17.0.1:21099:127.0.0.1:9119 \
  sandbox@openshell-my-first-hermes &

# Verify the tunnel is up
ss -lntp | grep 21099                                # bound on 172.17.0.1
curl -sI http://172.17.0.1:21099/api/status | head -3 # 200 OK from uvicorn (or 401, both prove reachability)
```

```bash
# ────── Step 4: open UFW for docker bridge → host port 21099 ──────
ufw allow from 172.0.0.0/8 to any port 21099 proto tcp
```

```bash
# ────── Step 5: drop a Traefik file-provider rule for the POC path ──────
# Discover the active Komodo stack dir
ls /etc/komodo/stacks/*/config/traefik/rules/ 2>/dev/null
RULES_DIR=/etc/komodo/stacks/$(ls /etc/komodo/stacks)/config/traefik/rules

cat > "$RULES_DIR/hermes-poc-my-first-hermes.yml" <<'YAML'
http:
  routers:
    99-hermes-poc:
      entryPoints: [websecure]
      priority: 250
      rule: "Host(`openshell-controller.ag-6a295262.nemoclaw.dpdns.org`) && PathPrefix(`/hermes-poc/my-first-hermes`)"
      service: 99-hermes-poc-svc
      middlewares: [99-hermes-poc-strip, 99-hermes-poc-prefix]
      tls: { certResolver: letsencrypt }
  services:
    99-hermes-poc-svc:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:21099"
  middlewares:
    99-hermes-poc-strip:
      stripPrefix:
        prefixes: ["/hermes-poc/my-first-hermes"]
    99-hermes-poc-prefix:
      headers:
        customRequestHeaders:
          X-Forwarded-Prefix: "/hermes-poc/my-first-hermes"
YAML

# Traefik picks up file changes automatically; verify in logs
docker logs $(docker ps --format '{{.Names}}' | grep traefik | head -1) 2>&1 | tail -20
```

```bash
# ────── Step 6: validate the public URL serves the Hermes SPA and advertises auth ──────
# (from your laptop, not the VPS)

# /api/status must show auth_required=true with basic provider
curl -s https://openshell-controller.ag-6a295262.nemoclaw.dpdns.org/hermes-poc/my-first-hermes/api/status \
  | jq '.auth_required, .auth_providers'
# Expect: true  ["basic"]

# SPA shell loads with prefixed asset paths
curl -s https://openshell-controller.ag-6a295262.nemoclaw.dpdns.org/hermes-poc/my-first-hermes/ \
  | grep -E '__HERMES_BASE_PATH__|/hermes-poc/my-first-hermes/assets/'
# Expect: prefixed asset paths injected by mount_spa()
```

```bash
# ────── Step 7: validate WebSocket upgrade reaches Hermes ──────
# (from your laptop)
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  https://openshell-controller.ag-6a295262.nemoclaw.dpdns.org/hermes-poc/my-first-hermes/ws
# Expect: 101 Switching Protocols, OR 401 from Hermes (still a pass — upgrade reached upstream).
```

```bash
# ────── Step 8: the only test that matters — point Hermes Desktop at the URL ──────
# In the desktop app:
#   Settings → Gateway → Remote gateway
#   Remote URL: https://openshell-controller.ag-6a295262.nemoclaw.dpdns.org/hermes-poc/my-first-hermes
#   Click Save and reconnect → app should show "Sign in" button
#   Click Sign in → credential form → enter $HERMES_USER + $HERMES_PW (from Step 2)
#   → Session persists; chat tab loads
```

### POC pass criteria

All of:

1. `/api/status` over the public URL returns `auth_required: true` and `auth_providers: ["basic"]`.
2. Desktop app reaches the Sign in screen automatically (it introspects `/api/status`).
3. Sign-in with the generated username/password succeeds.
4. Chat tab loads — list of providers visible.
5. A round-trip chat message (assuming a provider is wired in `~/.hermes/.env` inside the sandbox) returns a response without errors.
6. SPA assets and the WebSocket all stream through the path prefix without 404 or CORS errors visible in the desktop app's `Open logs` diagnostics.
7. Restarting the desktop app keeps the session signed in (proves `HERMES_DASHBOARD_BASIC_AUTH_SECRET` was honoured).

### POC fail-mode debugging cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 from Traefik | host port 21099 not reachable from Traefik container | Confirm tunnel bound on `172.17.0.1` not `127.0.0.1`; check UFW |
| 200 but assets 404 with `__HERMES_BASE_PATH__=""` | `X-Forwarded-Prefix` header missing or stripped | Confirm middleware order: strip BEFORE prefix; check `docker logs traefik` |
| 200 HTML but WS upgrade returns 400 | path-prefix WS not routed | Check that Traefik PathPrefix router covers `/hermes-poc/.../ws` too (it should — PathPrefix is not strict) |
| `/api/status` shows `auth_required: false` | Launcher still uses `--insecure`, or env vars not loaded | Remove `--insecure` from launcher; confirm `/home/sandbox/.hermes/.env` has the three `HERMES_DASHBOARD_BASIC_AUTH_*` vars and is readable by the `sandbox` user; pkill and relaunch |
| `/api/status` shows `auth_required: true` but `auth_providers: []` | Username set but password/hash missing (or vice versa) | Confirm BOTH username AND password (or password_hash) are in `~/.hermes/.env` |
| Desktop app shows "session token" prompt instead of "Sign in" | basic provider not active per the docs' "No Sign in button" troubleshooting | Same as above — fix the env vars |
| Sign-in fails with 401 / "Invalid credentials" | username/password mismatch | Re-check creds you saved from Step 2 |
| Signed out on every desktop restart | `HERMES_DASHBOARD_BASIC_AUTH_SECRET` missing or changes per relaunch | Confirm secret is set and stable across launcher invocations |
| Hermes serves but no chat providers | `~/.hermes/.env` inside sandbox has no LLM API key | Out of scope for POC — confirm SPA chrome loads, defer provider wiring |
| Process dies after a few minutes | Tunnel SSH session dropped | Check `journalctl` for keepalive failures; bump `ServerAliveInterval` |

### POC teardown

```bash
# On VPS
rm "$RULES_DIR/hermes-poc-my-first-hermes.yml"
ufw delete allow from 172.0.0.0/8 to any port 21099 proto tcp
kill %1  # the backgrounded ssh tunnel

# Remove the POC credentials from the sandbox .env (so we revert to no-auth or the prior state)
docker exec "$SB" sed -i '/HERMES_DASHBOARD_BASIC_AUTH_/d' /home/sandbox/.hermes/.env
docker exec "$SB" pkill -f 'hermes dashboard' || true
# Re-run the original launcher (with --insecure if that's the pre-POC state) to restore
/usr/local/bin/hermes-dashboard-launch.sh
```

**Do not proceed to Phase 1 until the POC fully passes including the desktop-app round-trip.** The remaining phases are mostly bookkeeping — the hard "does the chain even work" question is answered here.

## 6. Phase 1 — Single-sandbox automation in `openshell_controller`

After the POC validates the chain, codify it for one sandbox at a time (no lifecycle hooks yet).

### 6.1 New script: `scripts/hermes-remote-expose.sh`

A standalone bash script that takes a sandbox name and auth mode (`basic` for POC/trusted-network, `oauth` for Phase 3 public), and:

1. Computes the host port: `port = 21000 + (hash(sandbox) % 2000)` (steal the JS hash from `server.mjs:350` and re-implement in bash). Verifies the port is free via `ss -lntp`; rehashes with a salt if collision.
2. Records the port in `/etc/openshell/hermes-ports.json` (atomic write with `flock`).
3. **Provisions Hermes auth inside the sandbox** depending on mode:
   - `basic`: generates `HERMES_USER` + `HERMES_PW` (`openssl rand -base64 18`), computes scrypt hash via `python -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password('$HERMES_PW'))"`, appends `HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD_HASH/SECRET` to `/home/sandbox/.hermes/.env`.
   - `oauth`: runs `docker exec "$SB" hermes dashboard register --portal https://portal.nousresearch.com` (or self-hosted equivalent), captures the resulting client_id/secret, writes the OAuth env vars (per Hermes' "Web Dashboard → Default provider: Nous Research" docs).
4. Restarts the dashboard via the launcher (`pkill -f 'hermes dashboard' && /usr/local/bin/hermes-dashboard-launch.sh <sandbox>`) — without `--insecure`, so the auth gate engages.
5. **Probes `/api/status`** through `nsenter` into the gateway netns — refuses to continue unless `auth_required: true` AND `auth_providers` contains the requested mode.
6. Writes `/etc/systemd/system/hermes-dashboard-tunnel@<sandbox>.service` (using the template in §4.3 above) and `systemctl enable --now` it.
7. Adds UFW rule (idempotent: `ufw status | grep -q "<port>" || ufw allow ...`).
8. Writes Traefik rule file at the discovered `$RULES_DIR/hermes-dashboard-<sandbox>.yml` (no auth middleware — Hermes handles it).
9. Writes the public URL + (for basic mode only) credentials to `/etc/openshell/hermes-access/<sandbox>.json` for the controller to read. For oauth mode, writes only the URL and the OAuth issuer.
10. Prints to stdout (JSON): final URL, auth mode, credentials (basic) or "sign in via Nous Portal" (oauth).

A sibling `scripts/hermes-remote-unexpose.sh` reverses everything: stops/removes the systemd unit, deletes the Traefik rule, removes UFW rule, strips the `HERMES_DASHBOARD_*` env vars from the sandbox's `.env`, and removes the `hermes-access/<sandbox>.json` entry.

### 6.2 Wire the launcher into the existing tunnel service

The current single-sandbox tunnel at `manidae-cloud:startup_nemoclaw.sh.j2:420` lives **outside** `openshell_controller`. For Phase 1 we keep it as-is for `my-first-hermes` and write the new per-sandbox unit alongside (different name template, different ports). Phase 2 deletes the legacy unit.

### 6.3 Test plan for Phase 1

Manually on a clean VPS:

```bash
./scripts/hermes-remote-expose.sh my-second-hermes
./scripts/hermes-remote-expose.sh my-third-hermes
# → two distinct ports, two distinct URLs, two distinct credentials,
#   both reachable from the desktop app simultaneously without interfering
```

Failure injection: kill one sandbox's container → confirm the tunnel restarts cleanly when the sandbox comes back (no port collision, no Traefik route flapping).

## 7. Phase 2 — Multi-tenant lifecycle integration

Wire `hermes-remote-expose.sh` / `unexpose.sh` into the sandbox create/destroy events so end-customers get a URL automatically when they provision.

### 7.1 Where the hook lives

`openshell_controller`'s sandbox creation flow ends in `app/api/openshell/sandboxes/create/route.ts` (or similar — confirm during implementation; see `app/components/ConfigurationPanel.tsx` for the call sites). On successful creation:

```ts
if (sandbox.agent === 'hermes') {
  await execHostScript('hermes-remote-expose.sh', [sandbox.name])
}
```

`execHostScript` calls out to a tiny privileged-helper daemon (the controller already needs CAP_SYS_ADMIN-class operations elsewhere; reuse that pattern — likely via the existing `terminal-server.mjs` infrastructure).

On delete, symmetric call to `hermes-remote-unexpose.sh`.

### 7.2 What to surface in the controller UI

In the sandbox detail card (likely `app/components/SandboxList.tsx` or `OperatorTerminalPanel.tsx`), add a "Remote desktop access" pane:

```
Remote URL: https://openshell-controller.<base>/hermes/<sandbox>   [Copy]
Username:   <sandbox>                                              [Copy]
Password:   ●●●●●●●●●●●●●●●●                                       [Reveal] [Copy]
Status:     ● Connected  (last health check 2s ago)
Setup:      Hermes Desktop → Settings → Gateway → Remote gateway
```

Health check polls `https://.../hermes/<sandbox>/` from the controller's own server-side fetcher (Hermes' health endpoint, not via Traefik basicAuth — use a controller-only bypass header or hit `127.0.0.1:<port>` directly from `server.mjs`).

### 7.3 What to surface in manidae-cloud

For end-customers who deploy via the HostMyAgents UI (not the controller directly), the same data must flow up to manidae-cloud so it appears on the deployment detail page. Add a backend endpoint `GET /api/deployments/{id}/hermes-remote-access` that SSH's into the VPS, reads `/etc/openshell/hermes-access/<sandbox>.json`, and returns it.

Frontend lives in `manidae-cloud/frontend/src/pages/DeploymentDetail.tsx` (or the AgentGateway-specific detail card).

## 8. Phase 3 — Auth hardening (move public deployments to OAuth/OIDC)

Per the Hermes docs, basicAuth must never be used for public-internet exposure. Phase 3 introduces OAuth (Nous Portal) as the default, and optionally self-hosted OIDC if we want to own the identity layer.

### 8.1 OAuth via Nous Portal (default for public SaaS)

Provisioning per sandbox:

```bash
# Run inside the sandbox once at expose time
docker exec "$SB" hermes dashboard register \
  --portal https://portal.nousresearch.com \
  --redirect-uri https://openshell-controller.<base>/hermes/<sandbox>/auth/callback
# Captures client_id + client_secret; writes them to ~/.hermes/.env automatically
```

Sandbox `.env` then contains:
```
HERMES_DASHBOARD_OAUTH_PROVIDER=nous
HERMES_DASHBOARD_OAUTH_CLIENT_ID=...
HERMES_DASHBOARD_OAUTH_CLIENT_SECRET=...
HERMES_DASHBOARD_BASIC_AUTH_SECRET=...   # still needed for session signing
```

Restart the dashboard; `/api/status` should now report `auth_providers: ["oauth"]`. Desktop app's "Sign in" button becomes "Sign in with Nous Research".

End-customer UX:
* User opens Hermes Desktop, points at our URL, clicks "Sign in with Nous Research".
* Desktop opens browser → Nous Portal → user logs in (existing Nous account).
* Portal redirects back to Hermes → session token written.
* Desktop is now authenticated.

Required: end-customer must have (or create) a Nous Research account.

### 8.2 Self-hosted OIDC (alternative if we want to own identity)

The Hermes docs note: *"A self-hosted OIDC provider works the same way if you run your own identity provider."* Candidates:

| IdP | Pros | Cons |
|---|---|---|
| **Extend Pangolin/Badger** | Already deployed in our stack; same SSO that gates other dashboards | Pangolin's OIDC issuer support needs verification; may not be a full IdP |
| **Authentik** | Modern, OCI-friendly, ships an OIDC provider out of the box | New service to operate, learn, secure |
| **Keycloak** | Battle-tested, full OIDC | Heavier; older UX |

Recommendation: **defer until we see real demand**. Nous OAuth covers the SaaS case adequately, and we'd be taking on identity-provider operations debt for marginal UX gain. Revisit if a partner explicitly requires non-Nous identity.

### 8.3 Rotation and audit

For both basic (legacy) and oauth modes:

* `POST /api/sandboxes/<sb>/hermes/rotate-secret` regenerates `HERMES_DASHBOARD_BASIC_AUTH_SECRET` (forces all sessions to re-auth).
* `POST /api/sandboxes/<sb>/hermes/rotate-credentials` (basic only) generates a new password.
* `POST /api/sandboxes/<sb>/hermes/rotate-oauth-client` (oauth only) re-registers with the portal, swaps client_secret.
* Hermes dashboard logs each sign-in attempt; ship those into our existing log pipeline.

## 9. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Hermes Desktop doesn't accept arbitrary path-prefix URLs in "Remote URL" field | Low (docs explicitly say "path prefixes like /hermes work") | Show-stopper for Phase 0 | Phase 0 step 8 catches it immediately. Fallback: Cloudflare wildcard + per-sandbox subdomain. |
| 2 | NVIDIA renames `hermes gateway run` or moves `/opt/hermes/.venv` | Medium | Launcher breaks silently | Existing launcher already validates with loud-fail `die` messages — keep that pattern |
| 3 | Port hash collision between two sandboxes on same VPS | Very low (~0.05% per pair at 2000-port range) | Tunnel fails to bind | Lifecycle hook checks `ss -lntp` and rehashes with salt if collision detected |
| 4 | UFW rule survives sandbox deletion → port reused later by another service | Low | Security risk | `unexpose.sh` deletes UFW rule; nightly audit cron in Phase 3 |
| 5 | An operator misconfigures a public-internet sandbox with `basic` auth | Medium without interlock | High — single password protects an LLM-driven shell on the public internet | **§4.7 interlock** refuses to write Traefik rule for public hostnames unless `auth_providers` includes `oauth` or `oidc` |
| 6 | Hermes-stored credentials (`HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH`) leak via sandbox compromise | Low | Attacker has hash; can offline-crack but cannot impersonate without breaking scrypt | Use scrypt hash not plaintext; rotate via `rotate-credentials` endpoint |
| 7 | OAuth (Nous Portal) outage takes down all our customers' sign-in | Low | High during outage window | Document as a known dependency; Nous-Portal SLA matters for production. Self-hosted OIDC (§8.2) eliminates this if it becomes a real concern. |
| 8 | SSH tunnel hangs after network flap, doesn't recover | Medium | Sandbox unreachable until manual restart | `Restart=always` + `ServerAliveInterval=15` + `ExitOnForwardFailure=yes`; controller-side health probe that auto-restarts the tunnel unit on N consecutive failures |
| 9 | Hermes' SPA breaks if it needs to issue absolute-origin URLs (e.g. for downstream provider OAuth callbacks) | Low | OAuth provider setup breaks | Document as a known limitation; for OAuth-heavy provider flows, fall back to subdomain exposure for that sandbox |
| 10 | `inference.local` proxy mechanism inside the gateway netns changes upstream | Low | Dashboard loses LLM inference path | Launcher reads `HTTPS_PROXY` from `/proc/<gw_pid>/environ` at runtime — picks up changes automatically. Loud-fail assertion if `HTTPS_PROXY` missing |
| 11 | A sandbox restarts and the `gateway run` PID changes — netns join becomes stale | Certain (happens on every sandbox restart) | Dashboard goes 502 | Existing `hermes-dashboard.timer` re-runs the launcher periodically. Keep that. Per-sandbox tunnel auto-reconnects via `Restart=always` |
| 12 | `HERMES_DASHBOARD_BASIC_AUTH_SECRET` regenerated on relaunch → all sessions invalidated | Medium without proper persistence | Annoying UX | Persist secret to `~/.hermes/.env` once; launcher reads existing value rather than regenerating each spawn |

## 10. File-by-file change list (after POC passes)

### `openshell_controller`

| File | Change |
|---|---|
| `scripts/hermes-remote-expose.sh` | **NEW** — see §6.1 |
| `scripts/hermes-remote-unexpose.sh` | **NEW** — symmetric teardown |
| `scripts/lib/hermes-port-hash.sh` | **NEW** — pure-bash port hash matching the JS `hashSandboxId` in `server.mjs:350` |
| `server.mjs` | Add a controller-side health-probe endpoint `GET /api/sandboxes/:name/hermes/health` that connects to `127.0.0.1:<sandbox_port>/`. Add `/api/sandboxes/:name/hermes/access` returning the JSON from `/etc/openshell/hermes-access/<sandbox>.json`. |
| `app/api/openshell/sandboxes/create/route.ts` | Call `hermes-remote-expose.sh` after successful create (if agent === 'hermes') |
| `app/api/openshell/sandboxes/delete/route.ts` | Call `hermes-remote-unexpose.sh` before delete |
| `app/components/OperatorTerminalPanel.tsx` (or sandbox detail card) | Render the "Remote desktop access" pane (URL, creds, status) |
| `install.sh` | Ensure `/etc/openshell/{hermes-ports.json,hermes-access/}` exist with `0700` perms |
| `CLAUDE.md` | Add a section documenting the multi-tenant Hermes exposure pattern + the port-base convention |

### `manidae-cloud`

| File | Change |
|---|---|
| `backend/app/core/deployment/terraform_templates/includes/startup_nemoclaw.sh.j2` | (a) Drop `--insecure` from the dashboard launcher (line ~392 / ~397); (b) delete the single-sandbox tunnel + Traefik rule (lines ~417-440) — they're replaced by the controller's `hermes-remote-expose.sh`. Keep the launcher binary but parameterise by sandbox name as `$1`. Add the Hermes auth env-var injection before launch. |
| `backend/app/core/deployment/byovps_bootstrap.py:1140-1280` | Same refactor — single-sandbox launcher becomes parameterised, drop `--insecure`, inject Hermes auth env vars from caller. Lifecycle hooks fire from controller. |
| `backend/app/api/deployments.py` | Add `GET /api/deployments/{id}/hermes-remote-access` endpoint that proxies the controller's `/api/sandboxes/:name/hermes/access` |
| `backend/app/schemas/deployment.py` | Add optional `hermes_auth_mode: Literal['basic','oauth']` field on AgentGateway deployments (default 'oauth' for any deployment exposed at hostmyagents.com domains; 'basic' permitted only for Tailscale/private-network targets) |
| `frontend/src/pages/DeploymentDetail.tsx` | Add "Hermes Remote Desktop" section: shows the Remote URL, the sign-in mode (basic creds vs "Sign in with Nous Research"), and copy-to-clipboard for the URL |
| `backend/tests/test_byovps_bootstrap.py` | Update invariants: assert `--insecure` is NOT in the launcher; assert `hermes-remote-expose.sh` is invoked on sandbox create; assert the public-exposure interlock rejects basic mode for `hostmyagents.com` hosts |

## 11. Test plan (regression matrix)

| Scenario | Verify |
|---|---|
| Two sandboxes on one VPS, both `hermes` agent | Two distinct URLs, two distinct passwords, desktop app can switch between them |
| Sandbox restart (`docker restart openshell-<sb>`) | Dashboard returns to service within 30s without manual intervention; tunnel auto-reconnects |
| Sandbox deleted | URL returns 404; UFW rule gone; systemd unit disabled+removed; entry removed from `hermes-access/` |
| Tunnel killed manually (`systemctl stop hermes-dashboard-tunnel@<sb>`) | Restarts within 5s |
| Controller restart (`systemctl restart openshell-controller`) | All sandbox URLs stay reachable (rules and tunnels are owned by systemd + Traefik, independent of controller process) |
| VPS reboot | All sandbox URLs reachable within 60s of boot completion (units enabled at boot) |
| Password rotation | Old password rejected within 10s of rule file update; new password works |
| Desktop app from cold start | Pointing at saved Remote URL reconnects without manual reauth |

Add these as `tests/regression/hermes-multitenant/*.test.ts` in the controller and `backend/tests/test_hermes_remote_desktop.py` in manidae-cloud.

## 12. Out of scope (for this plan)

* **Hermes Desktop authentication via OAuth/OIDC** — defer until basicAuth is proven insufficient. The desktop dialog mentions OAuth but the UX path is unclear.
* **Cloudflare wildcard cert for per-sandbox subdomains** — path-prefix is sufficient; subdomain is a later option if OAuth callbacks require it.
* **Bandwidth metering / quota per remote desktop session** — billing currently meters at the deployment level, not per-end-user-session; adding per-session telemetry is a separate workstream.
* **Multi-region routing** — single VPS per deployment, single Traefik per VPS. Federation across VPSes is not needed at this stage.
* **Replacing the legacy single-sandbox tunnel for `hermes-agent` standalone package** — Phase 4 if ever; the standalone package already works for its single-tenant use case.

## 13. Open questions

**Resolved by Hermes docs (no investigation needed)**:

* ~~Auth model — basicAuth vs SSO vs token?~~ Hermes-native: `basic` for trusted networks, `oauth` (Nous Portal) for public, `oidc` for self-hosted.
* ~~Path prefix support?~~ Officially supported: *"path prefixes like /hermes work if you front it with a reverse proxy."*
* ~~Detection mechanism for which auth mode to show?~~ Desktop introspects `/api/status` (`auth_required`, `auth_providers`).
* ~~Session persistence across desktop restarts?~~ Stable `HERMES_DASHBOARD_BASIC_AUTH_SECRET` solves it.
* ~~Pre-configure desktop URL?~~ `HERMES_DESKTOP_REMOTE_URL` env var on the desktop machine.

**To resolve during Phase 0**:

1. **Does Hermes Desktop send `Origin` headers** that might trip CORS checks at Hermes? Check `desktop.log` after first connect.
2. **WS endpoint path** — is it `/ws`, `/api/ws`, `/socket`? Check `web_server.py` source or observe what the desktop app requests via Traefik access logs.
3. **Per-sandbox container restart**: does the existing `hermes-dashboard.timer` (5-min cadence) fire fast enough, or should the controller actively re-invoke `hermes-dashboard-launch.sh <sb>` on `docker events` `start` for the sandbox container?
4. **Where does `~/.hermes/.env` actually live inside the sandbox?** The POC assumes `/home/sandbox/.hermes/.env` (sandbox user's home). Confirm — could be `/root/.hermes/.env` if the dashboard runs as root, or `$HERMES_HOME/.env` if overridden. Check `/proc/<gw_pid>/environ` for `HERMES_HOME` or `HOME`.

**To resolve during Phase 3**:

5. **Does `hermes dashboard register` exist as a CLI subcommand**, or is OAuth client provisioning Portal-UI-only (the `/local-dashboards` page mentioned in docs)? If UI-only, we may need to script a headless browser flow or partner with Nous for an API.
6. **Does Nous Portal's OAuth flow support arbitrary `redirect_uri` per dashboard**, or is the redirect URI baked into the OAuth client and we need one client per `https://openshell-controller.<base>/hermes/<sandbox>/auth/callback`? Affects whether we register one client per sandbox or one per deployment.

---

**Next action**: execute Phase 0 (POC) on `167.233.45.113` against the existing `my-first-hermes` sandbox. Estimated effort: 30-60 minutes. Do not proceed to Phase 1 until all POC pass criteria are met.
