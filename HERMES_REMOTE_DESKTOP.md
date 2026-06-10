# Hermes Remote Desktop — How It Works and How to Set It Up

Status: **implemented and verified** (2026-06-10)
Owner: ivobrett
Validated against: Hermes v0.16.0 · NemoClaw v0.0.58 · OpenShell v0.0.44

End-users running the **Hermes Desktop app** point its "Remote gateway"
setting at a public HTTPS URL and drive a Hermes agent running inside a
NemoClaw sandbox on a shared, multi-tenant VPS. One VPS hosts many sandboxes;
each is reachable at its own URL with its own credential, with no per-sandbox
VPS, VPN, or client-side SSH tunnel.

This document describes the system **as built**, how a deployment gets it,
how to operate and debug it, and what we learned getting it working. The
original design draft lives in git history (`git log -- HERMES_REMOTE_DESKTOP_PLAN.md`);
§7 summarises where reality diverged from it.

---

## 1. Architecture (as built)

```
Hermes Desktop (client laptop, same hermes-agent minor version as backend)
        │  HTTPS  Remote URL = https://openshell-controller.<base>/hermes/<sandbox>
        │         credential = per-sandbox session token (X-Hermes-Session-Token / ?token=)
        ▼
Traefik on VPS — file-provider rule per sandbox
        │  TLS termination · stripPrefix · X-Forwarded-Prefix injection
        │  desktop mode: matches ONLY /hermes/<sandbox>/api  (see §4 Security)
        ▼
Traefik's compose-bridge gateway IP (typically 172.18.0.1), port 21000+hash
        │  `openshell forward` (gRPC channel through the OpenShell gateway),
        │  supervised by systemd `hermes-remote-forward@<sandbox>.service`
        ▼
sandbox container → gateway-process netns (only place inference.local resolves)
        │
        ▼
hermes dashboard (uvicorn, 0.0.0.0:<same hashed port>, pinned session token)
        │  HTTPS_PROXY → 10.200.0.1:3128 (policy-enforcing L7 proxy)
        ▼
upstream LLM provider
```

Key mechanics:

- **Port scheme** — `port = 21000 + hash(sandboxName) % 2000`, the same
  `hashSandboxId` as OpenClaw's dashboard proxy in `server.mjs` (OpenClaw owns
  19000–20999). The hashed value is **both** the in-sandbox listen port and
  the host bind port, because `openshell forward` maps host:PORT →
  sandbox:PORT with no remapping. Collisions are checked against `ss -lnt`
  and existing access records, rehashing with a salt.
- **Auth** — Hermes' built-in session-token gate. We pin the token per
  sandbox via `HERMES_DASHBOARD_SESSION_TOKEN` (supported in hermes ≥0.16) so
  it survives dashboard restarts and the desktop's saved credential keeps
  working. The desktop sends it as `X-Hermes-Session-Token` on REST and
  `?token=` on WebSockets — both validated with constant-time compares by
  Hermes itself; the proxy is pure transport.
- **Supervision** — the forward runs under a systemd template unit
  (`Restart=always`); a 2-minute `hermes-remote-watchdog.timer` re-runs the
  idempotent launcher for every exposed sandbox, because a sandbox restart
  changes the gateway PID/netns and silently kills the dashboard.
- **State** — one JSON per sandbox at `/etc/openshell/hermes-access/<sb>.json`
  (mode, port, token, URL, hermes version). This is the single source of
  truth read by the launcher, the watchdog, and the controller API/UI.

## 2. Components

Everything lives in **this repo** so deployments pick it up by cloning a
branch — manidae-cloud only sets one env var (see §3).

| Path | Role |
|---|---|
| `scripts/hermes-remote/lib.sh` | Shared helpers: port hash, container/gateway-PID/Traefik-bridge/rules-dir/public-host discovery. No hardcoded IPs or paths — every assumption is discovered or loud-fails. |
| `scripts/hermes-remote/expose.sh <sb> [--mode desktop\|web]` | Idempotent end-to-end setup: port + token, dashboard launch, systemd forward unit, UFW, Traefik rule, watchdog timer, access record. Self-installs its systemd units. Verifies the public URL (status 200, token 200, bogus-token 401, no token leak) before declaring success. |
| `scripts/hermes-remote/unexpose.sh <sb>` | Symmetric best-effort teardown of all of the above. |
| `scripts/hermes-remote/launch.sh <sb>` | Idempotent dashboard (re)launcher. Re-discovers container + gateway PID each run; short-circuits when healthy; provisions `API_SERVER_KEY` (+ config-hash re-pin); auto-upgrades hermes <0.16 via `upgrade-hermes.sh`. |
| `scripts/hermes-remote/upgrade-hermes.sh <sb>` | In-place hermes-agent upgrade inside the sandbox (pip through the L7 proxy from the gateway netns) + gateway restart. |
| `scripts/hermes-remote/watchdog.sh` | Iterates access records; re-runs `launch.sh` and nudges wedged forward units. Run by the timer. |
| `app/lib/hermesRemote.ts` | Controller-side wrapper: `exposeHermesRemote` / `unexposeHermesRemote` / `readHermesRemoteAccess` / `hermesRemoteMode()`. |
| `app/api/sandbox/[sandboxId]/hermes-remote/route.ts` | `GET` returns the access record (URL + token); `POST` (re)exposes on demand. OAuth users must hold per-sandbox access; operators are fully trusted. |
| `app/api/sandbox/create/route.ts` | After a successful Hermes sandbox create (and unless `HERMES_REMOTE_MODE=off`), calls `exposeHermesRemote`; result returned as `hermesRemote` in the response. Non-fatal — a proxy hiccup never fails creation. |
| `app/api/sandbox/delete/route.ts` | Calls `unexposeHermesRemote` before deletion when an access record exists. |
| `app/components/HermesRemotePanel.tsx` | "Remote Desktop Access" drawer: URL/token copy (token masked + reveal), public reachability probe, desktop setup steps, enable/retry button. Rendered in `SandboxList.tsx` for Hermes sandboxes. |

systemd units (written by `expose.sh` on first use, nothing to install by hand):

- `/etc/systemd/system/hermes-remote-forward@.service` — `openshell forward
  start ${BIND}:${PORT} %i` in the foreground, `Restart=always`, env from
  `/etc/openshell/hermes-remote/<sb>.env`.
- `/etc/systemd/system/hermes-remote-watchdog.{service,timer}` — runs
  `watchdog.sh` every 2 minutes, 90 s after boot.

## 3. Setting it up

### Fresh agentgateway deployment (manidae-cloud)

Nothing manual. `startup_agentgateway.sh.j2` writes `HERMES_REMOTE_MODE`
(default `desktop`) into the controller's `.env.local`; the controller repo
branch (settings `OPENSHELL_CONTROLLER_REPO` / `OPENSHELL_CONTROLLER_BRANCH`)
carries everything else. Creating a Hermes sandbox through the controller
automatically:

1. builds/onboards the sandbox (`nemoclaw onboard --agent hermes`),
2. upgrades in-sandbox hermes to ≥0.16 if the base image is older,
3. exposes the dashboard and writes the access record,
4. surfaces URL + token in the sandbox's **Remote Desktop Access** drawer.

Mode selection per deployment (`hermes_remote_mode` template var):

| Mode | Behaviour | Use when |
|---|---|---|
| `desktop` (default) | Public path serves **only `/api/*`**. Token is the credential, distributed solely via the controller UI (behind operator login / Pangolin SSO; OAuth users additionally need per-sandbox access grants). | Enterprises using the Hermes Desktop app. |
| `web` | Additionally serves the dashboard SPA at the path. **The SPA HTML embeds the session token**, so the path must sit behind a Pangolin-gated resource or a trusted network. | Enterprises preferring a browser web UI with SSO-style login. |
| `off` | No automatic exposure. | Air-gapped / policy-restricted deployments. |

### Existing deployment / manual operation

```bash
# Enable for one sandbox (idempotent; safe to re-run any time)
/opt/openshell-controller/scripts/hermes-remote/expose.sh <sandbox>

# Disable + tear everything down
/opt/openshell-controller/scripts/hermes-remote/unexpose.sh <sandbox>

# Read the credential (also shown in the controller UI)
cat /etc/openshell/hermes-access/<sandbox>.json
```

Or through the controller API: `POST /api/sandbox/<sandbox>/hermes-remote`
(expose/repair), `GET` (read URL + token).

### Connecting the desktop app

1. Hermes Desktop → Settings → Gateway → **Remote gateway**
2. Remote URL: `https://openshell-controller.<base>/hermes/<sandbox>`
3. Wait ~1 s for the probe — a **Session token** field appears (the probe sees
   no `auth_required` field and classifies the gateway as token-auth)
4. Paste the token, **Save and reconnect**

The token is stable across dashboard/sandbox restarts (pinned via env), so
the desktop reconnects from cold start without re-entry.

**Version rule (hard requirement):** the desktop and the in-sandbox
hermes-agent must run the same minor version. Newer desktops call endpoints
older backends don't have (e.g. `/api/profiles/sessions`, added ~0.15) and
the request falls through to the SPA route → "Expected JSON … but got HTML".
Older gateways also reject newer embedded-chat TUIs at the WS handshake.
`launch.sh` auto-upgrades the sandbox to the latest PyPI hermes-agent;
"Backend out of date" toasts for a 1-commit delta are cosmetic — do **not**
click "Update Hermes" in the desktop (it would pip-upgrade and restart the
remote dashboard mid-session).

## 4. Security model

- **The `/hermes/<sandbox>` path bypasses Pangolin by design.** The desktop's
  `/api/status` probe and token header flow cannot follow SSO redirects.
  This is safe in `desktop` mode because:
  - only `/api/*` is proxied — the SPA shell, whose HTML embeds
    `window.__HERMES_SESSION_TOKEN__`, is never served on the public path
    (`expose.sh` hard-fails if any response there contains the token);
  - every `/api/*` route except Hermes' small public list (`/api/status`,
    config schema, etc.) requires the token, compared constant-time;
  - the token is only obtainable through the controller (operator session or
    Pangolin/IDP-verified OAuth user with an explicit per-sandbox grant).
- **Token scope** — one token per sandbox, random 33 bytes urlsafe. Rotation:
  delete the `token` field from the access JSON, re-run `expose.sh`, hand out
  the new value (a `rotate` API is future work, §8).
- **Tenant isolation** — per-sandbox URL, port, token, forward unit, and
  Traefik rule; sandboxes cannot see each other's netns. Compromise of one
  token exposes one sandbox's dashboard only.
- **`--insecure` on the dashboard is required and OK** — it permits the
  non-loopback bind *and* disables `_ws_client_is_allowed`, which would
  otherwise reject Traefik-proxied WS upgrades (X-Forwarded-For rewrites the
  client address). The session-token gate stays fully active.
- **Nous OAuth (future)** — hermes ≥0.16 ships `hermes dashboard register`
  (writes an OAuth client for the Nous Portal). When we want SSO-grade login
  on the desktop path, that flips `/api/status` to `auth_required: true` and
  the desktop renders a "Sign in" button instead of the token box. See §8.

## 5. Operating and debugging

State to look at first:

```bash
ls /etc/openshell/hermes-access/                 # which sandboxes are exposed
systemctl status hermes-remote-forward@<sb>      # forward supervision
systemctl list-timers | grep hermes-remote       # watchdog armed?
journalctl -u hermes-remote-forward@<sb> -n 20   # forward errors
docker exec <container> tail -20 /tmp/hermes-dashboard.log
```

Fail-mode cheatsheet (every row was hit for real during bring-up):

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 from Traefik | Forward not bound, or bound on the wrong bridge | `systemctl restart hermes-remote-forward@<sb>`. The bind IP must be **Traefik's compose-bridge gateway** (`docker inspect <traefik> … .Gateway`, typically `172.18.0.1`) — NOT docker0, and `host.docker.internal` does not resolve in this stack. Check UFW allows `172.0.0.0/8 → <port>`. |
| Forward unit flapping with "sandbox is not ready" | OpenShell gateway restarted / sandbox supervisor disconnected | `openshell sandbox list`. If sandboxes sit in Provisioning/Error after a gateway restart, see the **ensure-mtls gotcha** below. |
| Public `/api/status` 200 but desktop gets 401 | Token mismatch (e.g. dashboard restarted unpinned) | `launch.sh <sb>` relaunches with the pinned token from the access record; re-copy the token from the UI. |
| "Expected JSON … but got HTML" in desktop | Version skew — backend older than desktop | `upgrade-hermes.sh <sb>` (launch.sh does this automatically). |
| Chat tab stuck CONNECTING / "gateway websocket connection failed" | Dashboard and `hermes gateway run` on different versions (upgrade without gateway restart) | `upgrade-hermes.sh` restarts the gateway; or kill `hermes gateway run` and run `nemohermes <sb> recover`. |
| 0.16 gateway exits: "API_SERVER_KEY is required" | New 0.16 requirement, absent from 0.14-era `.env` | `launch.sh` provisions it and **re-pins the config-integrity hash** (`sha256sum config.yaml .env > /etc/nemoclaw/hermes.config-hash`, root 444) — without the re-pin the container refuses to boot. |
| `nemohermes recover` refuses: "NODE_OPTIONS missing safety-net preload (#2478)" | Hermes-flavour `/tmp/nemoclaw-proxy-env.sh` lacks the preloads the guard expects | `mv` the file aside → recover (warn-and-proceed) → restore. `upgrade-hermes.sh` does this. recover's success probe also races gateway boot — trust `pgrep -f 'hermes gateway run'`. |
| pip inside sandbox: proxy 403 / "tunnel error" | L7 proxy enforces per-binary + process-tree policy | Run pip **inside the gateway netns** (`nsenter -t <gw_pid> -n`) using the venv python (allowlisted; `uv` is not), with `HTTPS_PROXY=http://10.200.0.1:3128` and the OpenShell CA bundle. The venv ships without pip — `ensurepip` first. |
| Dashboard dies after sandbox restart | Gateway PID/netns changed; old netns join is stale | Expected — the watchdog relaunches within 2 min. Manual: `launch.sh <sb>`. |
| Desktop "Backend stopped / Hermes background process exited" | The app's **local** backend, unrelated to remote | Benign when switching to remote. If the app is stuck connecting locally, kill orphaned local `hermes_cli.main dashboard` processes squatting ports 9120+. |
| Desktop stays in local mode despite saved URL | Token box only renders after the URL probe; saving early silently keeps `mode: local` | Wait for the probe, paste token, then save. Config lives at `~/Library/Application Support/Hermes/connection.json` and accepts a hand-written `{"mode":"remote","remote":{"url":…,"authMode":"token","token":{"encoding":"plain","value":…}}}`. |

**ensure-mtls gotcha (one-time migration hazard):** agentgateway deployments
run `openshell-gateway-ensure-mtls.sh` (hooked to the controller service) to
enforce an mTLS OpenShell gateway. `nemoclaw onboard` rewrites `gateway.env`
to plaintext; the next controller restart re-arms mTLS — and any sandboxes
created during the plaintext window have plaintext supervisors that can never
reconnect (stuck Provisioning/Error). The only fix is recreating those
sandboxes. Fresh deployments are mTLS from provision and immune. Avoid
running `nemoclaw onboard` by hand on agentgateway boxes; create sandboxes
through the controller.

## 6. Verification (what "working" means)

`expose.sh` self-verifies on every run; the full matrix we validated live:

1. Sandbox create via controller → access record + reachable URL, no manual steps
2. Public `/api/status` → 200; authed `/api/config` → 200; bogus token → 401
3. Real WS upgrade (`/api/ws?token=…`) → 101 through the full chain
4. No response on the public path contains `__HERMES_SESSION_TOKEN__`
5. Desktop app connects, lists sessions, chat round-trips via `inference.local`
6. Desktop cold restart reconnects without re-entering the token
7. Sandbox delete via controller → rule, unit, UFW, access record all gone
8. Forward unit and watchdog active (`systemctl`) — survive sandbox restarts

## 7. What changed from the original design (and why)

| Original plan | As built | Why |
|---|---|---|
| SSH tunnels (`ssh -L` + ProxyCommand) in systemd units | `openshell forward` in systemd units | Simpler, no SSH key/known-hosts handling; the gRPC channel is the supported path. Constraint inherited: host port == sandbox port, so the hashed port moved inside the sandbox too (fine — netns-isolated). |
| Bind tunnels on docker0 `172.17.0.1` | Bind on Traefik's compose-bridge gateway (discovered, typically `172.18.0.1`) | Traefik isn't on docker0 in the Komodo stack and `host.docker.internal` doesn't resolve there. |
| Hermes basicAuth (`HERMES_DASHBOARD_BASIC_AUTH_*`) for the POC tier | Pinned session token (`HERMES_DASHBOARD_SESSION_TOKEN`) | The basicAuth env vars described by the docs don't exist in shipped 0.14–0.16; the session-token gate does, and ≥0.16 lets us pin it. The "auth_required/auth_providers introspection" flow exists but only engages for OAuth. |
| Proxy the whole path; rely on Hermes auth for everything | desktop mode proxies `/api/*` only | The SPA HTML hands the session token to any fetcher — serving it publicly would void the credential. API-only proxying is what makes Pangolin-bypass safe. |
| Per-sandbox dashboards all on 9119 inside the sandbox | Hashed port inside the sandbox | `openshell forward` can't remap ports (see row 1). |
| install.sh provisions dirs/units | `expose.sh` self-installs everything | Zero deployment-side setup; the only manidae-cloud change is one env var. |
| (unforeseen) | Auto-upgrade of in-sandbox hermes + `API_SERVER_KEY` + hash re-pin + gateway restart | Desktop/backend version-match is a hard requirement; NemoClaw's base image lags PyPI. |

## 8. Future work

- **Nous Portal OAuth** (`hermes dashboard register`) as an opt-in auth tier
  for enterprises wanting SSO-grade login on the desktop path; flips the
  desktop to a "Sign in" flow automatically. Open questions from the original
  plan (redirect-URI flexibility, headless registration) still apply.
- **Token rotation API** — `POST /api/sandbox/<sb>/hermes-remote/rotate`.
- **manidae-cloud surfacing** — proxy the access record up to the
  HostMyAgents deployment-detail page for end-customers who never see the
  controller UI.
- **Pangolin-gated `web` mode automation** — currently `web` mode writes the
  full-path rule and leaves Pangolin resource creation to the operator.
- **Nightly audit** — cron that reconciles UFW rules / forward units /
  Traefik rules against `/etc/openshell/hermes-access/` and reaps strays.

## 9. Merge-resilience notes

This feature was deliberately kept modular so upstream pulls stay cheap.
All logic lives in **new files**; upstream-shared files carry only minimal
additive hooks:

| Shared file | Footprint |
|---|---|
| `app/api/sandbox/create/route.ts` | 1 import + 1 self-contained `hermesRemote` block (after `hermesDashboardBuild`) + 1 response field |
| `app/api/sandbox/delete/route.ts` | 1 import + 1 teardown block (before `deleteSandbox`) + 1 response field |
| `app/components/SandboxList.tsx` | 1 import + 1 `DrawerKey` variant + 1 state-init entry + 1 `<DrawerSection>` block |

On upstream-merge conflicts in those files: keep upstream's changes and
re-apply our hook block alongside (see CLAUDE.md §3 conflict table).
