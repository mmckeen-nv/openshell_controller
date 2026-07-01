# Upstream Divergence Audit — Security Triage

**Snapshot date:** 2026-06-22
**Fork:** `ivobrett/openshell_controller`, branch `gatewaydashboard`
**Upstream:** `mmckeen-nv/openshell_controller`, branch `main`
**Merge base:** `511d313c` (94 commits ahead, 0 behind)
**Change size:** ~73 files changed, +7,372 / −351 lines

This document is an as-of-today catalog of every meaningful divergence from
upstream, grouped by area, with a security risk rating and a note on whether
the change is likely to become obsolete once NVIDIA's `openshell` and
`NemoClaw` projects ship their next round of updates.

> **Purpose.** When upstream updates land, walk this list in priority order
> and ask, for each item: "is the underlying capability now available in
> upstream NemoClaw/OpenShell, and can we drop our workaround?" Items tagged
> **HIGHLY upstream-fixable** are the first to revisit.

---

## Risk legend

| Tier | Meaning |
|---|---|
| **🔴 HIGH** | Either (a) actively touches sandbox isolation, public network exposure, or auth-bypass surface, or (b) silently regressing it would create a real incident. Review carefully on every merge; lock in invariants with tests. |
| **🟠 MEDIUM** | Touches authenticated paths or modifies sandbox-internal files. Bugs here would degrade defence-in-depth but not by themselves let an attacker in. |
| **🟢 LOW** | Operational hygiene, docs, UI, installer scripts. Low likelihood of contributing to a security incident. |

| Tag | Meaning |
|---|---|
| **OURS — permanent** | Project-specific feature; upstream is unlikely to add this. Will stay in the fork indefinitely. |
| **OURS — could upstream** | Generally useful; we could PR upstream and remove the fork-local copy. |
| **HIGHLY upstream-fixable** | A direct workaround for a NemoClaw / OpenShell limitation. A version bump should let us delete most of it. |

---

## Prioritized summary (read this first)

| # | Area | Risk | Upstream-fixable? | Bytes ahead-of-upstream (approx) |
|---:|---|:---:|---|---:|
| 1 | [Hermes Remote Desktop public exposure](#7-hermes-remote-desktop-public-exposure) | 🔴 HIGH | OURS — permanent | ~1,200 LoC + 9 shell scripts |
| 2 | [MCP broker + sandbox-side handshake](#5-mcp-broker--inter-sandbox-chat) | 🔴 HIGH | OURS — could upstream | ~600 LoC |
| 3 | [Privileged in-sandbox file writes](#6-privileged-in-sandbox-file-writes) | 🔴 HIGH | **HIGHLY upstream-fixable** | ~250 LoC |
| 4 | [Auth stack: dual-auth + per-sandbox access](#1-authentication--authorization-stack) | 🟠 MEDIUM | OURS — permanent | ~1,000 LoC (auth lib + middleware + server) |
| 5 | [Restore endpoint bypassing Next.js routing](#9-restore-endpoint-bypass) | 🟠 MEDIUM | OURS — could upstream | ~400 LoC in server.mjs |
| 6 | [Dashboard token cookie-wins fix chain](#4-dashboard-token--ws-tunnel-fix-chain) | 🟠 MEDIUM | **HIGHLY upstream-fixable** | ~250 LoC + 2 regression tests |
| 7 | [Auto-approve sandbox network rule for broker URL](#5-mcp-broker--inter-sandbox-chat) | 🟠 MEDIUM | OURS — could upstream | (subset of #2) |
| 8 | [Vendored NemoClaw preloads (safety-net, ciao-guard)](#8-vendored-nemoclaw-preloads) | 🟢 LOW | **HIGHLY upstream-fixable** | 231 LoC |
| 9 | [Hermes auto-upgrade shim at expose time](#10-hermes-in-sandbox-auto-upgrade-shim) | 🟢 LOW | **HIGHLY upstream-fixable** | 103 LoC |
| 10 | [NemoClaw Dockerfile apt-pin unpinning](#11-nemoclaw-dockerfile-apt-unpinning) | 🟢 LOW | **HIGHLY upstream-fixable** | 18 LoC |
| 11 | [Production install script + systemd unit + ensure-mtls safety](#12-production-install--ensure-mtls) | 🟢 LOW | OURS — could upstream | ~200 LoC |
| 12 | [Sandbox-create UX: agent-aware Quick Deploy, gateway-token verify, first-build timeout](#13-sandbox-create-ux--robustness) | 🟢 LOW | Partly upstream-fixable | ~150 LoC |
| 13 | [UI/UX additions (Hermes panel, Security page, terminal fullscreen, activity-log pagination)](#14-uiux-additions) | 🟢 LOW | OURS — permanent | ~450 LoC |

---

## 1. Authentication & Authorization Stack

**What it is:** A consolidated `app/lib/auth/` library (610 LoC across
`policy.mjs`, `edge.ts`, `node.mjs`, `context.ts`, `sandboxAccessStore.ts`,
`policy.d.ts`), a Node-runtime `middleware.ts` (+175 lines vs upstream's
Edge-runtime version), and ~570 lines of WS-upgrade auth in `server.mjs`.
Defines an `AuthContext` discriminated union with kinds
`"operator" | "oauth" | "anonymous" | "disabled"` and dispatches every
request accordingly. Operator session cookie is `openshell_control_session`;
OAuth session cookie is `oauth_session` (renamed from upstream-equivalent
`CF_Authorization`).

**Why we need it:** Upstream ships single-tenant operator-password auth.
We deploy this as a multi-user system behind an OAuth IDP (Pangolin /
mcpauth), so we need both auth modes side-by-side and a way for different
users to be allowed into different sandboxes.

**Security risk:** 🟠 MEDIUM
- The library itself adds protection (verified JWT, fail-closed on missing
  secret, file-backed access map). Bugs here would expose sandboxes to
  unauthorised users; the existing regression tests
  (`tests/control-auth-oauth-check.mjs`, `tests/dashboard-session-check.mjs`)
  catch the obvious failure modes.
- Specific footgun: `server.mjs` strips client-supplied `x-forwarded-user`
  on WS upstream so an attacker can't impersonate a verified user (see
  `copyHeaders()`). Don't weaken that.

**Upstream-fixability:** **OURS — permanent.** Upstream is unlikely to add
multi-IDP support; this stays in the fork.

**Re-evaluation triggers:** None from upstream. Re-audit if we add a new
auth provider, change cookie names, or move middleware back to Edge runtime
(don't — see [Don'ts](#dont-do-this-list)).

**Files:**
- `app/lib/auth/` (whole new directory)
- `app/lib/controlAuth.ts` (now a deprecated re-export shim)
- `middleware.ts` (rewrite)
- `server.mjs` (WS upgrade auth, ~570 LoC of changes)
- `app/api/auth/{login,logout,recover,setup,callback,me}/route.ts`

---

## 2. Per-Sandbox Access Control

**What it is:** A file-backed access store at
`data/sandbox-access.json`, written atomically; allows mapping
{sandbox name → list of OAuth emails} so non-operator users can be
granted access to specific sandboxes. Surfaced as a Security page
(`/setup-account`).

**Why we need it:** Multi-tenant deployments need per-sandbox isolation
between OAuth users. Upstream has nothing in this space.

**Security risk:** 🟠 MEDIUM
- The store is the source of truth for "can this user see this sandbox" —
  bugs would cross-contaminate tenants. Atomic writes already in place.
- An older project memory note flags that we switched from UUID to **name**
  for sandbox identification in access checks; if upstream ever has two
  sandboxes with the same name in different namespaces, our check would
  cross them.

**Upstream-fixability:** **OURS — permanent.**

**Files:**
- `app/lib/auth/sandboxAccessStore.ts`
- `app/api/security/sandbox-access/route.ts`
- `app/setup-account/page.tsx` (+317 LoC, was much smaller upstream)
- `SANDBOX_ACCESS_CONTROL.md` (design doc)

---

## 3. OAuth IDP Integration (commit `46cb197`, `a88aa69`)

**What it is:** End-to-end OAuth2 IDP flow — login URL, callback, JWT
verification, session cookie issuance — with backward-compat reads of
the legacy `MCPAUTH_*` / `CF_Authorization` cookies/env vars.

**Why we need it:** SSO for the controller.

**Security risk:** 🟠 MEDIUM
- Env vars are read in priority order
  `OAUTH_JWT_SECRET > MCPAUTH_JWT_SECRET > CF_AUTH_JWT_SECRET`. Same
  pattern for `_LOGIN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`,
  `_CALLBACK_URL`. The legacy fallback exists to avoid breaking existing
  deployments; new deployments should set `OAUTH_*` only.
- Don't add a fallback secret. The fail-closed-on-missing-secret behaviour
  is intentional (per `getOAuthSecret`).

**Upstream-fixability:** **OURS — permanent.**

**Files:** `app/api/auth/callback/route.ts`, login/me routes, parts of
the auth lib above.

---

## 4. Dashboard Token + WS Tunnel Fix Chain

**What it is:** The four-commit chain (`c35fea5`, `48bbfa5`, `a2e8ddb`,
`b42b323`) plus two regression tests
(`tests/dashboard-token-cookie-wins-check.mjs`,
`tests/dashboard-token-runtime-check.mjs`) and the
`bootstrapScriptResponse` session-storage cleanup
(commit `617bbc3`) that together stop the OpenClaw "Open Dashboard"
flow from replaying a stale token across sandbox-recreate cycles.

**Why we need it:** The OpenClaw dashboard SPA caches the gateway token
in `localStorage` and `sessionStorage` keyed by controller origin. Deleting
and recreating a sandbox with the same name re-uses the same controller
origin, so the cached token bleeds into the new sandbox and authentication
silently fails ("Auth did not match — gateway token mismatch"). The fix
makes the controller's HttpOnly cookie *always* override any client-supplied
`?token=` query and `Authorization: Bearer` header on the WS upstream, and
the bootstrap script wipes scoped sessionStorage entries on load.

**Security risk:** 🟠 MEDIUM — but the change *adds* protection (defends
against stale-token replay). The risk is **regression**: if a future refactor
removes the unconditional override or the sessionStorage cleanup, the bug
returns. Both regression tests will catch a revert.

**Upstream-fixability:** **HIGHLY upstream-fixable.** If upstream OpenShell
delivers a proper per-connection token (e.g. via an authenticated handshake
RPC) instead of asking the SPA to juggle localStorage, the entire chain
becomes unnecessary. **Re-evaluation trigger:** any major OpenShell release
notes mentioning dashboard auth, token handshake, or gateway-WS protocol.

**Files:**
- `server.mjs` (`withDashboardTokenQuery`, `copyDashboardWebSocketHeaders`)
- `app/api/openshell/dashboard/proxy/shared.ts`
- `tests/dashboard-token-*.mjs` (DO NOT DELETE)

---

## 5. MCP Broker + Inter-Sandbox Chat

**What it is:** A controller-side MCP broker (`/api/mcp/broker/{mcp,call,capabilities}`)
that fronts all MCP server access from sandboxes. Each sandbox gets a
bearer token written into its manifest plus an `openshell-control` server
entry in `openclaw.json`. The broker enforces which MCP tools are
available per-sandbox; the underlying servers' credentials never leave the
controller. Inter-Sandbox Chat is one of the baseline MCP servers exposed
through this broker.

Also includes `syncBrokerNetworkAccess` (`app/lib/sandboxPermissions.ts`)
which, when Issue Broker Config runs, **auto-approves any pending OpenShell
L4 network rule whose endpoints match the broker URL**.

**Why we need it:** Without a broker the sandbox would need direct
credentials for each MCP server; that's the inverse of OpenShell's
principle of least privilege. The broker is the choke point that lets us
audit and restrict tool access centrally.

**Security risk:** 🔴 HIGH
- The broker is the single gatekeeper for what tools a sandboxed agent can
  invoke. Bypass = complete loss of MCP-level control.
- `syncBrokerNetworkAccess` **auto-approves** network rules in the
  sandbox's pending queue, which is acceptable because the URL it
  approves is the broker URL it just generated (sandbox-bound bearer
  token, content-validated). Still: the auto-approve writes a permanent
  approval into the sandbox's OpenShell rule store. Any future bug that
  generated the wrong URL here could pre-approve outbound traffic to
  somewhere unintended.
- L7 SSRF block at the sandbox egress proxy (`10.200.0.1:3128`) was the
  unexpected gate that ended up actually blocking end-to-end this session.
  Not our code's fault — that's NemoClaw's egress proxy doing its job.
  The broker URL written into the manifest still points at an internal
  address (`host.docker.internal:3000`), so sandbox-to-broker traffic is
  blocked by design. **This means in-sandbox agents currently CANNOT post
  to the broker** — only operator→sandbox dispatch works. (See open
  question at the end.)

**Upstream-fixability:** **OURS — could upstream.** The broker pattern
itself is reusable; upstream may build one eventually.

**Re-evaluation triggers:**
- If upstream NemoClaw adds a first-class "MCP capability registry" for
  sandboxes, our broker may become redundant.
- If the egress proxy gains a per-URL allowlist API, we can stop trying to
  route via `host.docker.internal` and unblock the in-sandbox→broker path.

**Files:**
- `app/lib/mcpBrokerStore.ts`, `mcpBrokerProtocol.ts`, `mcpBrokerClient.ts`,
  `mcpBrokerUrl.ts`, `mcpServerStore.ts`, `mcpSandboxAutoSync.ts`,
  `mcpPreflight.ts`, `mcpPreflightRepair.ts`
- `app/lib/sandboxPermissions.ts` (auto-approve logic)
- `app/api/mcp/broker/{mcp,call,capabilities}/route.ts`
- `app/api/mcp/health/route.ts`
- `scripts/inter-sandbox-chat-*.mjs` (4 files)

---

## 6. Privileged In-Sandbox File Writes

**What it is:** Helpers in `app/lib/sandboxPrivilegedFiles.ts` and
`app/lib/sandboxOpenClawMcpConfig.ts` that write into sandbox-internal
"protected" paths:
- `/sandbox/openshell_control_mcp.md` (the broker manifest)
- `/sandbox/.openclaw/openclaw.json` (OpenClaw gateway config)
- `/sandbox/.openclaw/.config-hash` (matching sha256)
- `/sandbox/.openclaw/exec-approvals.json` (tool-call approval state)

Upstream calls these helpers via `docker exec openshell-cluster-nemoclaw
kubectl exec -n openshell <sandbox> -- ...`, which runs **as root in the
pod** (kubectl-cluster driver). On a Docker-driver deployment that
container doesn't exist; we migrated to `openshell sandbox exec` which
runs **as the sandbox user**. Because the sandbox user can't `chown
root:root`, the writes now leave the files `444 sandbox:sandbox` instead
of `444 root:root`, and the write strategy uses a 444 temp file + atomic
rename to avoid a transient-writable window.

**Why we need it:** On NemoClaw's Docker-driver deployments, the
controller has no kubectl access; without these helpers, "Issue Broker
Config" fails with `No such container: openshell-cluster-nemoclaw`.

**Security risk:** 🔴 HIGH
- On the kubectl-cluster driver, the openclaw.json + .config-hash pair was
  **root-owned 444** — sandbox user couldn't tamper. NemoClaw verifies the
  config matches the hash before each gateway run.
- On the Docker driver, the file is sandbox-owned 444, which means **the
  sandbox user can `chmod +w` and rewrite both files** (then OpenClaw's
  hash check still passes because the sandbox can recompute the hash too).
- We did **not** weaken the security from what NemoClaw itself ships on
  the Docker driver — the file lands as sandbox-owned 444 from NemoClaw's
  own bootstrap. So our changes match the existing baseline. But the
  baseline on Docker driver is genuinely weaker than the kubectl-cluster
  driver's root-owned 444.
- True tamper-resistance on the Docker driver would require either
  `docker exec -u root` from the controller (couples to driver), an
  immutable-flag (`chattr +i`) approach, or NemoClaw setting the file
  ownership from a root-context bootstrap.

**Upstream-fixability:** **HIGHLY upstream-fixable.** Two paths:
1. **NemoClaw exposes a "register MCP server" API** that takes a URL + token
   and writes the openclaw.json from a root-context bootstrap. The
   controller would call that API instead of poking the file. The entire
   `sandboxOpenClawMcpConfig.ts` + the privileged-file plumbing in
   `sandboxPrivilegedFiles.ts` could be deleted (~250 LoC).
2. **OpenShell's Docker driver gains a `--user root` flag for `sandbox exec`** —
   then we could do the chown-to-root step. Less likely as that subverts
   sandbox isolation by design.

**Re-evaluation triggers:**
- Any NemoClaw release notes mentioning "MCP", "broker", or
  "config-integrity API".
- Any OpenShell release notes mentioning `sandbox exec --user` or similar.

**Files:**
- `app/lib/sandboxPrivilegedFiles.ts` (4 helpers; we changed the writer
  pattern)
- `app/lib/sandboxOpenClawMcpConfig.ts` (sync/revoke + the 444 + atomic
  rename writer)
- `app/lib/sandboxInferenceApply.ts` (same writer pattern for inference
  config)
- `tests/mcp-configuration-page-check.mjs` (guard flipped from "must
  contain kubectl" to "must use openshell sandbox exec")
- `tests/sandbox-lifecycle-check.mjs` (guard updated for atomic rename)

---

## 7. Hermes Remote Desktop Public Exposure

**What it is:** The `/hermes/<sandbox>` public URL on the controller host
that lets the Hermes Desktop app drive a sandbox over WebSocket. Built
from:
- `scripts/hermes-remote/expose.sh` — writes a Traefik file-provider rule,
  opens UFW for the chosen port, installs a per-sandbox systemd `forward`
  unit + a re-run watchdog timer.
- `scripts/hermes-remote/launch.sh` — provisions `API_SERVER_KEY` and
  pins the Hermes session-token gate (`HERMES_DASHBOARD_SESSION_TOKEN`)
  per-sandbox.
- `scripts/hermes-remote/upgrade-hermes.sh` — pip-upgrades in-sandbox
  Hermes from 0.14 (NemoClaw base image) to ≥0.16 at expose time. (See
  #10 — that's a temporary shim.)
- `scripts/hermes-remote/watchdog.sh` — re-runs `launch.sh` every 2 min.
- `scripts/hermes-remote/ensure-recovery-guards.sh` — installs gateway
  recovery guards on the host.
- `scripts/hermes-remote/preloads/{sandbox-safety-net,ciao-network-guard}.js` —
  see #8.
- `app/lib/hermesRemote.ts`, `app/api/sandbox/[sandboxId]/hermes-remote/route.ts`,
  `app/components/HermesRemotePanel.tsx`.

**Why we need it:** Hermes Desktop, the user's preferred client, talks
WebSocket to a sandbox-internal API. Without the public URL it can't
reach the sandbox.

**Security risk:** 🔴 HIGH
- Every exposed sandbox is a new public attack surface on the controller
  host's public hostname. Mitigations:
  - In `desktop` mode the Traefik rule serves **only** `/hermes/<sb>/api/*`,
    not the SPA shell — so the token-embedding HTML is never public. (The
    expose script hard-fails if `GET /` returns non-404.)
  - Per-sandbox `HERMES_DASHBOARD_SESSION_TOKEN` distributed via the
    controller UI/API to authorised users only.
  - UFW restricts gateway-port traffic to the docker bridge.
- The public URL **deliberately bypasses Pangolin/SSO** because the
  desktop's `/api/status` probe can't follow SSO redirects. So the session
  token is the ONLY thing standing between an attacker who guesses the
  URL and access to the sandbox dashboard API.
- Token leakage in the access file is a real risk — the file at
  `/var/lib/openshell-controller/hermes-remote-access.json` (or wherever
  the access store points) contains the gateway session tokens. Lock down
  read perms.

**Upstream-fixability:** **OURS — permanent.** This is product-level
architecture, not a NemoClaw deficiency.

**Re-evaluation triggers:**
- Hermes Desktop adding SSO support (then we can route via Pangolin and
  drop the public-URL bypass).
- Hermes ≥0.16 in the NemoClaw base image (lets us delete `upgrade-hermes.sh`,
  see #10).

**Files (all new):**
- `app/lib/hermesRemote.ts`
- `app/api/sandbox/[sandboxId]/hermes-remote/route.ts`
- `app/components/HermesRemotePanel.tsx`
- `scripts/hermes-remote/*.sh` (8 scripts)
- `HERMES_REMOTE_DESKTOP.md`

---

## 8. Vendored NemoClaw Preloads

**What it is:** Two Node.js `--require` preload scripts copied directly
from NemoClaw under `scripts/hermes-remote/preloads/`:
- `sandbox-safety-net.js` (131 LoC) — installs an `uncaughtException` /
  `unhandledRejection` handler that keeps the in-sandbox gateway alive
  when user code throws (so plugins can't kill the shared gateway).
- `ciao-network-guard.js` (100 LoC) — patches `@homebridge/ciao` mDNS
  library to not crash when `os.networkInterfaces()` fails (which happens
  in restricted sandbox network namespaces).

Both carry NVIDIA Apache-2.0 license headers; we have not modified them.

**Why we need it:** NemoClaw's base image doesn't ship these by default.
Without them, the Hermes gateway crashes inside the sandbox.

**Security risk:** 🟢 LOW
- They don't grant new permissions; they suppress crashes.
- The risk is **drift**: if NemoClaw updates the upstream copies of these
  files (e.g. to patch a real bug), our vendored copy stays stale. There's
  no automation watching for updates.

**Upstream-fixability:** **HIGHLY upstream-fixable.** When NemoClaw's base
image bundles these (or makes them unnecessary), delete the whole
directory.

**Re-evaluation triggers:**
- Any NemoClaw base-image release notes touching the Hermes gateway
  resilience or mDNS handling.

**Files:** `scripts/hermes-remote/preloads/*.js` + a vendoring README.

---

## 9. Restore Endpoint Bypass

**What it is:** The 7 `fix(restore): ...` commits at the top of our
history move the entire `POST /api/sandbox/[id]/restore` path into
`server.mjs` (the custom Next.js server) instead of letting Next.js
handle the route. The reasons accreted: Next.js 15 streams the multipart
body as a Web stream that gets "disturbed" by the hand-rolled parser,
the gRPC layer has a 1 MiB stdin limit so we bypass to `docker cp +
docker exec`, and macOS-created tar archives have metadata that needs
tolerance.

**Why we need it:** Backup/restore is the user's escape hatch — it must
work for archives of any size.

**Security risk:** 🟠 MEDIUM
- The bypass means **the operator session cookie is the only auth check**
  before the restore stream is accepted (see `authVerifyOperatorSession`
  in `server.mjs`). Middleware doesn't get a chance to run — so any
  defence we add in middleware (e.g. rate limiting, audit logging) won't
  apply to restore.
- The restore writes into the sandbox via `docker exec`, which runs as
  root in the container. This is more permission than `openshell sandbox
  exec` would have — by design, since restore needs to overwrite
  arbitrary paths.
- Path validation in `app/lib/sandboxFiles.ts` (`normalizeSandboxPath`)
  restricts targets to `/sandbox` or `/tmp`. **If that validation is
  bypassed or weakened, an authenticated operator could write anywhere
  in the container's filesystem.** Don't relax it.

**Upstream-fixability:** **OURS — could upstream.** The Next.js 15 streaming
bug should eventually get fixed; until then a long-form upload bypass
is the practical answer.

**Re-evaluation triggers:**
- Next.js 16+ release notes on multipart streaming.
- OpenShell gRPC raising the 1 MiB stdin limit.

**Files:**
- `server.mjs` (~400 LoC of restore handling)
- `app/lib/sandboxFiles.ts` (path validation, archive sanity checks)

---

## 10. Hermes In-Sandbox Auto-Upgrade Shim

**What it is:** `scripts/hermes-remote/upgrade-hermes.sh` — at first
`expose.sh` run, `pip install --break-system-packages` upgrades the
in-sandbox Hermes from `0.14` (NemoClaw base image) to `≥0.16` (what the
desktop app needs).

**Why we need it:** Hermes Desktop calls endpoints introduced in 0.16;
the desktop and the in-sandbox backend MUST match minor versions.

**Security risk:** 🟢 LOW
- Runs `pip install` from inside the sandbox, which already has network
  egress via the NemoClaw proxy. Source is PyPI — usual supply-chain
  caveats apply.
- The file already documents its removal conditions at the top.

**Upstream-fixability:** **HIGHLY upstream-fixable.** When NemoClaw's
base image ships Hermes ≥0.16, delete `upgrade-hermes.sh` and the
version-check block in `launch.sh`.

**Re-evaluation triggers:**
- Any NemoClaw base-image release notes touching the Hermes version.
- `docker exec openshell-<name>-* /opt/hermes/.venv/bin/hermes --version`
  reporting ≥0.16 on a fresh sandbox without our shim having run.

**Files:** `scripts/hermes-remote/upgrade-hermes.sh` (103 LoC).

---

## 11. NemoClaw Dockerfile apt Unpinning

**What it is:** `install_versioned_nemoclaw_openshell.sh` runs `sed` over
NemoClaw's extracted `Dockerfile` and `Dockerfile.base` to drop the
Debian-style version pin (`tmux=3.5a-3`, `procps=2:4.0.4-9`,
`e2fsprogs=1.47.2-3+b11`) on three apt packages — those pins target Debian,
but the base image is Ubuntu noble, so apt errors with exit 100.

**Why we need it:** Without this, every fresh-image NemoClaw install hangs
sandbox creation for ~90 s with no usable error.

**Security risk:** 🟢 LOW
- Unpinning means apt picks whatever's in the Ubuntu noble index, which
  could in principle pick up a newer-but-vulnerable version. In practice
  Debian/Ubuntu's stable channels patch fast, and we're unpinning
  long-stable tools (tmux, procps, e2fsprogs).
- The cleanest mitigation is **upstream NemoClaw stops Debian-pinning on
  Ubuntu base** — at which point we delete the sed block.

**Upstream-fixability:** **HIGHLY upstream-fixable** (NemoClaw bug,
not ours).

**Re-evaluation triggers:** Any NemoClaw release where
`grep -E 'apt-get install.*=[0-9]+' Dockerfile` returns nothing.

**Files:** `install_versioned_nemoclaw_openshell.sh` (18 LoC of patches).

---

## 12. Production Install + ensure-mtls Safety

**What it is:**
- `scripts/setup/install-production.sh` (166 LoC) — writes the systemd
  unit, UFW rules for sandbox-bridge ports 8080/18789, the needrestart
  guard, the openshell-gateway DB parent dir, and starts linger.
  Idempotent.
- `scripts/setup/openshell-controller.service` — systemd unit template
  with `HOME` / `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` for
  ssh-via-openshell-gateway support.
- A safety guard in the (host-side) `openshell-gateway-ensure-mtls.sh`
  that **refuses to flip from plaintext to mTLS when any
  `openshell-*` sandbox container is running** — flipping with live
  sandboxes used to orphan their plaintext supervisors permanently
  (2026-06-11 incident).

**Why we need it:** NVIDIA's install.sh is dev-mode. Real deployments need
the systemd unit + UFW + the mTLS guard.

**Security risk:** 🟢 LOW (install-time, not request-time). The mTLS
guard is the most important bit — without it, a controller restart can
silently brick every live sandbox.

**Upstream-fixability:** **OURS — could upstream** (the production install
patterns could be reusable across deployments). The mTLS guard is the
kind of thing NemoClaw might absorb upstream.

**Files:** `scripts/setup/install-production.sh`,
`scripts/setup/openshell-controller.service`,
`tests/production-setup-check.mjs`.

---

## 13. Sandbox-Create UX & Robustness

**What it is:** Several fork-only additions in `app/api/sandbox/create/route.ts`:
- **Agent-aware Quick Deploy** — filters image-redeploy candidates by
  matching agent type (`agentForName` + `agentFilter.ts`).
- **OpenClaw gateway-token verify after create** — `ensureOpenClawGatewayToken`
  polls the in-sandbox gateway WS handshake to confirm the token is live
  before declaring success. Without this, "Open Dashboard" fails immediately
  after create with the §13 token-mismatch error.
- **First-build timeout extended to 20 min** — fresh sandboxes on a clean
  VPS can take that long for the Docker image to build.
- **Pre-build of baseline sandboxes** — surfaces ready-baked
  baseline sandboxes (`baseline-openclaw`, `baseline-hermes`) so the user
  doesn't wait for the first build.
- **Hermes-remote hook** — calls `hermesRemote.expose()` on Hermes
  sandbox create (see #7).
- **NemoClaw registry agent patch** — atomically writes the `agent` field
  into the NemoClaw registry after a verified create (commit `774e32c`).
  Without this, Quick Deploy can't tell which agent type a sandbox uses.

**Why we need it:** Each item targets a specific user-visible failure mode
we hit during fork operation.

**Security risk:** 🟢 LOW. The new code paths run after verified
sandbox creation, behind operator auth.

**Upstream-fixability:** Partly — the gateway-token verify and the
registry-agent patch are working around NemoClaw deficiencies that upstream
could fix. The Quick Deploy filter and baseline pre-build are fork-specific
UX.

**Re-evaluation triggers:**
- NemoClaw populating `agent` in its registry by default → drop the
  registry patch.
- NemoClaw guaranteeing the gateway token is live by the time `nemoclaw
  onboard` returns → drop `ensureOpenClawGatewayToken`.

**Files:**
- `app/api/sandbox/create/route.ts` (+354 LoC vs upstream)
- `app/lib/sandboxCreate/agentFilter.ts`, `policy.ts`
- `tests/openclaw-create-gateway-token-verify-check.mjs`

---

## 14. UI/UX Additions

**What it is:** Operator-facing UI added/changed:
- `app/components/HermesRemotePanel.tsx` (174 LoC) — drawer that exposes
  the Hermes remote-desktop URL + token to authorised users.
- `app/setup-account/page.tsx` (+317 LoC) — Security page for managing
  per-sandbox access (#2) and password rotation.
- `app/components/SandboxList.tsx` (+127 LoC) — Hermes Remote drawer,
  Issue Broker Config button, copy-link icons, file-transfer drawer.
- `app/components/ActivityPanel.tsx` (+49 LoC) — pagination (commit
  `cd7890f`).
- `app/components/WizardPanel.tsx`, `ConfigurationPanel.tsx` (smaller).
- `app/operator-terminal/page.tsx` — terminal fullscreen toggle.

**Security risk:** 🟢 LOW. UI gates on the auth context (operator vs
OAuth user vs anonymous). Drawer reveals (Hermes token, broker token,
sandbox access list) are scoped behind operator session or per-sandbox
access.

**Upstream-fixability:** **OURS — permanent.**

---

## Don't-do-this list

(Pulled from `CLAUDE.md §9` for at-a-glance reference. Each has been tried and rejected.)

- Don't switch middleware back to Edge runtime — Node runtime is required so password rotation takes effect without a service restart.
- Don't rsync source files to the VPS — git only, so every deployed state corresponds to a pushed commit.
- Don't remove the legacy `CF_Authorization` cookie reader from `context.ts` / `server.mjs` without explicit OK — browsers may still hold sessions under that name.
- Don't add a fallback secret to `getOAuthSecret` — fail-closed on missing secret is intentional.
- Don't weaken `server.mjs` `copyHeaders()` stripping of client-supplied `x-forwarded-user` on WS upstream.
- Don't delete or weaken `tests/dashboard-token-cookie-wins-check.mjs` or `tests/dashboard-token-runtime-check.mjs` — they are the only mechanical guards against the 2026-06-13 dashboard regression.
- Don't push to `gatewaydashboard` without `npm run build` + smoke-test on the VPS first. Don't force-push to `gatewaydashboard`.

---

## Open security questions worth resolving

These are real questions the audit surfaced that I don't have answers to yet:

1. **Hermes remote desktop access store ownership/perms.** The file
   storing per-sandbox `HERMES_DASHBOARD_SESSION_TOKEN` values needs to
   be 600 (operator-readable only). Worth verifying on the live VPS.
2. **`data/sandbox-access.json` ownership/perms.** Same concern — this
   determines who can see which sandbox.
3. **`MCPAUTH_WRITE_ALLOWED_PATHS`.** Currently only
   `/api/openshell/terminal/live`. New entries require route-level
   per-sandbox gating; document the discipline anywhere a contributor
   might add an entry.
4. **Restore endpoint rate limiting.** Currently none — an authenticated
   operator could DoS the controller by streaming many large archives.
5. **Hermes-remote URL guessability.** The public URL is
   `/hermes/<sandbox-name>` — sandbox names are operator-chosen and could
   be guessable. The session token is the real gate, but URL discovery
   shortens the attacker's reconnaissance.
6. **Sandbox-to-broker connectivity is currently blocked** by the
   NemoClaw egress SSRF proxy (`10.200.0.1:3128`) — so the broker right
   now is reachable only by the operator-side sidecar dispatch path,
   not by agents inside sandboxes. Decide whether to (a) configure the
   proxy allowlist, (b) route broker traffic via the public controller
   URL, or (c) accept the limitation. (Open per 2026-06-22 session.)

---

## How to use this document

1. **After each upstream merge.** Read it top-to-bottom. For every item
   tagged "HIGHLY upstream-fixable", check whether the underlying
   NemoClaw / OpenShell / Hermes version bump now makes our workaround
   unnecessary. Delete what you can.
2. **Before any change to a 🔴 HIGH-risk area.** Verify the regression
   tests in that section still pass, and that no `Don't-do-this` rule is
   being violated.
3. **When the divergence audit goes stale** (target: every 2 weeks or
   after every upstream merge). Regenerate the file lists:
   ```
   git diff --diff-filter=A --name-only upstream/main...HEAD
   git diff --diff-filter=M --name-only upstream/main...HEAD
   git log --oneline upstream/main..HEAD
   ```
   and update the section bodies + the prioritized summary table.
