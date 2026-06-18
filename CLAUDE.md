# CLAUDE.md — repo guide for agents

This is a working fork of `mmckeen-nv/openshell_controller`. It carries
~25 commits of additional features (dual-auth with operator + OAuth/IDP,
Security page, file-backed sandbox-access store, Hermes Quick Deploy fixes,
terminal fullscreen, copy-link, etc.) on top of upstream. Treat upstream
as a moving target we periodically pull from.

---

## 1. Branches

| Branch | Purpose |
|---|---|
| `gatewaydashboard` | **Production branch.** Origin's default; deployed to the VPS. Always green; only fast-forward or `--no-ff` merges land here. |
| `gatewaydashboard-refactored` | Historical refactor branch (already merged into `gatewaydashboard` via merge commit `328370a`). Safe to delete. |
| `main` | Mirror of upstream/main on origin. Don't commit here; only used to compare diffs. |
| `sync/upstream-YYYY-MM-DD` | Short-lived branches for testing each upstream pull before merging. Delete after the merge lands on `gatewaydashboard`. |
| `scratch/*` | Throwaway. |

Remotes:
- `origin` → `github.com/ivobrett/openshell_controller` (our fork)
- `upstream` → `github.com/mmckeen-nv/openshell_controller`

`git fetch upstream` regularly. The fork can diverge fast.

---

## 2. Deploy / rollback

**VPS:** currently `91.99.224.38` (Hetzner). SSH key at
`~/.ssh/tf_hetzner`, user `root`. Service runs under systemd as
`openshell-controller`.

The **VPS IP changes** when the box is reprovisioned (test-agency
deployments are ephemeral). Past IPs seen in chat history:
`178.105.188.227`, `91.99.224.38`. Always confirm the current IP with
the user before SSHing — don't reuse a stale one from earlier turns.
When the IP (or host key) rotates: run `ssh-keygen -R <ip>` then
reconnect with `-o StrictHostKeyChecking=accept-new`. If `Permission
denied (publickey)` follows, the new VM doesn't have the operator's
public key — coordinate with the user.

### Deploy procedure (apply local commits)

Always work on a branch on your laptop first. Once green:

```bash
git push origin <branch>
ssh -i ~/.ssh/tf_hetzner root@91.99.224.38 'set -e
  cd /opt/openshell-controller
  echo "rollback SHA: $(git rev-parse HEAD)"
  git fetch origin
  git checkout <branch>
  git pull --ff-only
  PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH \
    node_modules/.bin/next build
  systemctl restart openshell-controller
  sleep 6
  curl -sS -o /dev/null -w "/login -> %{http_code}\n" \
    http://127.0.0.1:3000/login'
```

### Rollback

```bash
ssh -i ~/.ssh/tf_hetzner root@91.99.224.38 'set -e
  cd /opt/openshell-controller
  git checkout <previous SHA>
  PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH \
    node_modules/.bin/next build
  systemctl restart openshell-controller'
```

The merge into `gatewaydashboard` was done `--no-ff` (commit `328370a`),
so `git revert -m 1 328370a` rolls the entire refactor back as one
revertable commit. Keep using `--no-ff` for future upstream merges so
the same property holds.

**Do not** use rsync. The user explicitly wants every deployed state to
correspond to a pushed commit. See `memory/feedback_deployment.md`.

---

## 3. Pulling from upstream — the safe procedure

This is the procedure I'd recommend whenever `git fetch upstream` shows
new commits on `upstream/main`. **Always use a sync branch — never merge
into `gatewaydashboard` directly.**

```bash
git fetch upstream
git log --oneline upstream/main..HEAD | wc -l   # ours-ahead
git log --oneline HEAD..upstream/main           # theirs-ahead (review)
git diff --stat upstream/main...HEAD | tail     # files we've touched
git diff --stat HEAD..upstream/main             # files they've touched

# Spin a dated sync branch off gatewaydashboard.
git checkout gatewaydashboard
git pull --ff-only
DATE=$(date +%Y-%m-%d)
git checkout -b "sync/upstream-$DATE"

# Try the merge (no-ff so it stays as a single revertable commit).
git merge --no-commit --no-ff upstream/main
```

If `git merge` reports `Automatic merge failed; fix conflicts`:

1. List conflicting files: `git status --short | grep ^UU` (or run
   `grep -lnE '^<<<<<<<' -r .` from the repo root).
2. For each conflicting file, decide:
   - **Take upstream verbatim** when it's a doc / installer / test the
     upstream author owns (version pinning, README, install scripts).
     Use `git checkout --theirs <file>` then `git add <file>`.
   - **Take ours verbatim** when the file is one of our additions and
     upstream's parallel change is irrelevant. Use
     `git checkout --ours <file>` then `git add <file>`. Rare.
   - **Manually merge hunk-by-hunk** when both sides have real code
     changes. Open the file, find the `<<<<<<<` markers, combine
     both sides while preserving:
     - any new upstream imports
     - any new upstream activity-log / metrics / telemetry calls
     - all of our `app/lib/auth/*`, `app/lib/sandboxCreate/*`, and
       middleware logic
3. After resolution, `npm run build` and `node tests/control-auth-oauth-check.mjs`.
4. Commit the merge with a thorough message listing the resolutions:

```bash
git commit -m "Merge upstream/main into gatewaydashboard (N commits)

Upstream brings:
  <SHA> <subject>
  ...

Conflicts and resolutions:
* <file>: took upstream / took ours / manual merge of <what>
"
```

5. Push the sync branch: `git push -u origin sync/upstream-$DATE`.
6. Deploy the sync branch to the VPS using the Deploy procedure above
   (note the rollback SHA before switching).
7. Run the smoke tests (Section 5). All must pass.
8. Fast-forward `gatewaydashboard` to the sync branch and push:

```bash
git checkout gatewaydashboard
git merge --ff-only "sync/upstream-$DATE"
git push origin gatewaydashboard
git branch -d "sync/upstream-$DATE"
git push origin --delete "sync/upstream-$DATE"
```

### Common conflict patterns and the right resolution

| Pattern | Resolution |
|---|---|
| Upstream changed `README.md` / version pins / installer scripts | `git checkout --theirs` |
| Upstream added new test files | Take theirs (they're additive) |
| Upstream added a new import to `app/api/sandbox/create/route.ts` | Keep both — ours and theirs — and re-order alphabetically if needed |
| Upstream added activity/telemetry calls inside our refactored sections | Keep upstream's call but place it inside our refactored control flow (e.g. inside our readiness re-poll check, not before it) |
| Upstream changed `middleware.ts` to add a new public path | Add it to our `PUBLIC_PATHS` array; keep our dual-auth dispatch |
| Upstream changed cookie names | Don't follow them — our cookie is `oauth_session`. Keep the legacy fallback. |
| Upstream changed `app/api/sandbox/create/route.ts` or `delete/route.ts` near our hermes-remote hooks | Take upstream's changes, then re-apply our hooks: in create, the `hermesRemote` block (after `hermesDashboardBuild`) + import + response field; in delete, the `unexposeHermesRemote` teardown block (before `deleteSandbox`) + import + response field. All hermes-remote logic lives in `app/lib/hermesRemote.ts` + `scripts/hermes-remote/` (ours only, never conflict). |
| Upstream changed `app/components/SandboxList.tsx` | Keep upstream; re-apply our 4 additions: `HermesRemotePanel` import, `'hermesRemote'` in `DrawerKey` + state init, and the "Remote Desktop Access" `<DrawerSection>` before File Transfer. |

---

## 4. Architecture pointers (where the load-bearing code lives)

Read these in this order if you're a new agent picking up the codebase:

1. **`middleware.ts`** — entry point. Uses `resolveAuthContext()` to
   build an `AuthContext` discriminated union, then dispatches per kind.
   Runs on `runtime: "nodejs"` so it can read `process.env` and the
   file-backed access store fresh per request. **Don't switch to Edge
   runtime** — it'll re-introduce the `process.exit(0)` config-reload
   pattern we already removed.
2. **`app/lib/auth/`** — the consolidated auth library.
   - `policy.mjs` (+ `policy.d.ts`) — runtime-agnostic pure logic:
     cookie/JWT splitting, base64url, sandbox-access map parsing.
     Importable from anywhere (Edge, Node, server.mjs).
   - `edge.ts` — Web Crypto HMAC adapter for the Next.js bundle.
   - `node.mjs` — `node:crypto` adapter for `server.mjs`.
   - `context.ts` — `AuthContext` union + `resolveAuthContext()` +
     `isOperator()` + `oauthEmail()`.
   - `sandboxAccessStore.ts` — file-backed access map
     (`data/sandbox-access.json`), atomic writes, env-var CSV fallback.
3. **`app/lib/controlAuth.ts`** — thin compatibility shim. Existing
   imports keep working; new code should import directly from
   `@/app/lib/auth/...`.
4. **`server.mjs`** — custom Next.js server, owns WS upgrade auth.
   Imports policy + crypto from `app/lib/auth/node.mjs`. The custom
   server is required because Next.js's built-in upgrade handler
   conflicts with our dashboard WS proxy (see `app.didWebSocketSetup`).
5. **`app/api/sandbox/create/route.ts`** — sandbox creation. Multiple
   blueprint branches (`nemoclaw-blueprint`, `nemoclaw-hermes`,
   `custom-sandbox`, `redeploy-image-{openclaw,hermes}`). Helpers in
   `app/lib/sandboxCreate/{policy,agentFilter}.ts`.

### Things to remember about the auth design

- `AuthContext.kind` is one of `"operator" | "oauth" | "anonymous" | "disabled"`.
- The OAuth cookie is `oauth_session`; the legacy alias `CF_Authorization`
  is **read** but no longer **written**. Both are cleared on logout.
- Env vars are read in priority order: `OAUTH_JWT_SECRET >
  MCPAUTH_JWT_SECRET > CF_AUTH_JWT_SECRET`. Same pattern for
  `_LOGIN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_CALLBACK_URL`.
- `x-forwarded-user` is set by middleware **only** for verified OAuth
  users. Routes can trust it. `server.mjs`'s WS upstream proxy
  **strips** any client-supplied `x-forwarded-user` (see
  `copyHeaders()`). Never weaken that.
- `MCPAUTH_WRITE_ALLOWED_PATHS` (in middleware.ts) is the allowlist for
  OAuth users to POST. Only `/api/openshell/terminal/live` is in it
  today. Adding new entries requires the route handler itself to gate by
  sandbox access (see how `terminal/live` does it).
- `getCFAuthSecret`, `verifyCFAuthorizationJWT`, `mintCFAuthorizationJWT`
  are kept in `controlAuth.ts` as `@deprecated` re-exports. New code
  imports the OAuth-named versions.
- **Don't** add a `"my-secret-key"` fallback to `getOAuthSecret`. The
  fail-closed-on-missing-secret behaviour is intentional.

---

## 5. Smoke tests (run on the VPS after any deploy)

The full set lives only in chat history; the core ones to run after a
significant change are:

```bash
# Operator login + cookie + GET /
COOKIE=$(curl -sS -i -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"...operator password..."}' \
  | grep -i "set-cookie" | head -1 \
  | sed -E 's/.*openshell_control_session=([^;]+).*/\1/')
curl -sS -o /dev/null -w "GET / -> %{http_code}\n" \
  -b "openshell_control_session=$COOKIE" http://127.0.0.1:3000/

# Auth identity
curl -sS -b "openshell_control_session=$COOKIE" \
  http://127.0.0.1:3000/api/auth/me

# Password rotation should NOT require a restart
curl -sS -X POST http://127.0.0.1:3000/api/auth/setup \
  -H "Content-Type: application/json" \
  -b "openshell_control_session=$COOKIE" \
  -d '{"currentPassword":"old","password":"newpwd1234"}'
# willRestart should be false; /login should still 200 immediately.
```

### Local regression suite (run BEFORE every push)

The repo ships a 20-file source-text + runtime assertion suite covering
auth, middleware, dashboard proxy, sandbox lifecycle, MCP config, and the
load-bearing dashboard token fix chain documented in §11.

```bash
npm test
```

This runs every `tests/*.mjs` and reports `PASS:` / `FAIL:` per file,
exiting non-zero on any failure. Expected baseline:

- **19 PASS / 1 FAIL** — the one failure is `control-auth-cookie-check.mjs`
  (pre-existing TypeScript module resolution issue, unrelated tech debt).
  Any *other* failure means a real regression you must investigate before
  pushing.

Particularly important after touching `server.mjs` or
`app/api/openshell/dashboard/proxy/shared.ts`:

```bash
node tests/dashboard-token-cookie-wins-check.mjs   # source-text guards
node tests/dashboard-token-runtime-check.mjs        # behavioural guards
node tests/control-auth-oauth-check.mjs             # auth invariants
```

If `dashboard-token-runtime-check.mjs` fails with an assertion like
`actual: 'STALE_FROM_LOCALSTORAGE' / expected: 'FRESH_FROM_COOKIE'`,
the cookie-wins invariant from §11 has been broken — do NOT push. See
§11 for the architecture explanation and the four protected commit SHAs.

For WS upgrade tests (when modifying server.mjs auth), see the patterns
in chat history — minimum 3 cases: operator session, OAuth session
(granted), anonymous (must reject with 401).

---

## 6. Memory & past decisions

Persistent memory lives at:
```
~/.claude/projects/-Users-mattercoder-Projects-nvidia-openshell-controller/memory/
```

Key files there to read before changing security-adjacent code:
- `feedback_deployment.md` — *Don't rsync; use git commit → push → pull.*
- `project_password_reset_bug.md` — Edge-runtime middleware snapshotted
  `process.env`, causing freshly-issued login cookies to be rejected.
  Fixed by moving middleware to Node runtime. Don't switch back to Edge.
- `project_sandbox_access_control.md` — Per-sandbox access via the
  `oauth_session` cookie + `SANDBOX_ACCESS_USERS` env var (now
  superseded by `data/sandbox-access.json`).
- `project_sandbox_ssh.md` — `openshell-gateway` is not running on the
  VPS; sandbox shells go via `docker exec` through `openshell-cluster-nemoclaw`.

Update those files when your work would change their accuracy.

---

## 7. Don'ts

These have all been tried and rejected — don't reintroduce them:

- **Don't** call `process.exit(0)` after writing config. The Node-runtime
  middleware refresh covers this.
- **Don't** `rsync` source files to the VPS. Use git.
- **Don't** rename `MCPAUTH_*` env vars in the operator's `.env.local`.
  The fallback reads them; just add `OAUTH_*` for new deployments.
- **Don't** remove the legacy `CF_Authorization` cookie reader from
  `context.ts` / `server.mjs` until the user explicitly OKs it. Existing
  browsers may still hold sessions under that name.
- **Don't** switch middleware back to Edge runtime. The whole
  no-restart-on-config-change machinery depends on the Node runtime
  having a live `process.env` view.
- **Don't** generate or guess URLs for the user.
- **Don't** push to `gatewaydashboard` without running `npm run build`
  AND deploying + smoke-testing on the VPS first. Force-push to
  `gatewaydashboard` is forbidden.
- **Don't** push without running `npm test` first. The suite is fast
  (~2s) and lock-in-place for the dashboard token fix chain (§11),
  auth, middleware, sandbox lifecycle, and MCP config. The baseline is
  19 PASS / 1 known-failing-due-to-tech-debt; any *other* red line is a
  regression. If `npm test` reports new failures, fix the root cause
  rather than relaxing the assertion or marking the test skip — the
  assertions exist because each one has a documented historical
  failure mode behind it.
- **Don't** delete or weaken `tests/dashboard-token-cookie-wins-check.mjs`
  or `tests/dashboard-token-runtime-check.mjs` without understanding
  §11. They are the only mechanical guards against the brittle 2026-06-13
  dashboard regression coming back.

---

## 8. NemoClaw / OpenClaw / OpenShell version bumps

This section exists because of a real outage: bumping `NEMOCLAW_INSTALL_REF`
to `v0.0.56` left every fresh sandbox creation hanging for ~90 s before
the controller declared failure, with no usable error in the UI. Root
cause was a pinned `tmux=3.5a-3` (and friends) in NemoClaw's
`Dockerfile` / `Dockerfile.base` — Debian-version strings against an
Ubuntu noble base. Apt returned exit 100, the docker build died at
step 11 / 86, and the controller's readiness polls never saw a sandbox.

### What can break when a pin changes

NemoClaw upstream's Dockerfiles install:

```bash
apt-get install -y --no-install-recommends \
    procps=2:4.0.4-9 \
    e2fsprogs=1.47.2-3+b11 \
    tmux=3.5a-3 \
    ...
```

…inside a conditional that only fires if the package is missing from the
base image. Most of the time `openshell/sandbox-base-u24` already has
them and the install short-circuits. As soon as upstream bumps a base
or one of those packages, the conditional fires, the Debian-style pin
hits Ubuntu noble's apt index, and the build dies.

We don't notice on a happy-path build because the conditional skips.
We notice loudly when:

1. NemoClaw bumps `NEMOCLAW_INSTALL_REF` or `NEMOCLAW_INSTALL_TAG`
   and re-extracts the source on a fresh VPS.
2. NemoClaw rebuilds `sandbox-base-u24` and one of the pinned tools
   drops out.
3. We rebuild from scratch (e.g. CI in a clean container).

### Where the patch lives

`install_versioned_nemoclaw_openshell.sh` sed-patches the extracted
Dockerfiles to drop the version pin on `procps`, `e2fsprogs`, `tmux`.
Apt then picks whatever is actually available on the running base.

The same patch must also be applied to **already-deployed VPS Dockerfiles**
when the bug surfaces post-install (see "after a version bump on a live
VPS" below).

### Distro robustness

The pin failure does **not** depend on the host's Ubuntu version. The
build happens *inside* the docker image whose base is hard-coded to
`openshell/sandbox-base-u24:latest`. Manidae-cloud's host can be 24.04,
22.04, or BYOVPS with anything — irrelevant for this code path. So a
Hetzner box on 22.04 jammy and a Linode box on 24.04 noble both fail
in exactly the same way, and our patch fixes both.

### How to test a version bump *before* shipping

When bumping `OPENSHELL_VERSION`, `NEMOCLAW_INSTALL_REF`, or
`OPENCLAW_VERSION` in `install_versioned_nemoclaw_openshell.sh`:

```bash
# 1) On a clean VPS (or after `rm -rf /opt/nemoclaw`):
./install_versioned_nemoclaw_openshell.sh
# Should finish without docker build errors.

# 2) Inspect the extracted Dockerfiles for NEW pinned apt installs
#    beyond the three we know about:
grep -nE 'apt-get install.*=[0-9]+' /opt/nemoclaw/Dockerfile /opt/nemoclaw/Dockerfile.base
# Expected output: only `procps`, `e2fsprogs`, `tmux` should still appear
# (with their pin already stripped by the installer's sed).
# Anything else is a new offender — add to the sed block.

# 3) End-to-end smoke test: create a real sandbox through the controller.
COOKIE=$(curl -sS -i -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$OP_PW\"}" \
  | grep -i set-cookie | head -1 \
  | sed -E 's/.*openshell_control_session=([^;]+).*/\1/')
curl -sS --max-time 720 -b "openshell_control_session=$COOKIE" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"blueprint":"nemoclaw-blueprint","sandboxName":"smoke","gpuMode":"none","createInference":{"mode":"auto"}}' \
  http://127.0.0.1:3000/api/sandbox/create \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("created=", d.get("created"), "verified=", d.get("verification",{}).get("verified"))'

# Expect: created=True, verified=True. Then clean up:
openshell sandbox delete smoke
```

### If a new pinned package shows up

If `grep -E 'apt-get install.*=[0-9]+'` finds a package we don't already
handle, extend the sed block in `install_versioned_nemoclaw_openshell.sh`:

```bash
sed -i.bak \
  -e 's/procps=2:4\.0\.4-9/procps/g' \
  -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
  -e 's/tmux=3\.5a-3/tmux/g' \
  -e 's/NEW_PACKAGE_NAME=[^[:space:]\\]*/NEW_PACKAGE_NAME/g' \
  "$_dockerfile" && rm -f "${_dockerfile}.bak"
```

The wildcard form (`s/PKG=[^[:space:]\\]*/PKG/g`) is preferred when you
don't want to chase exact version strings.

### After a version bump on a live VPS

If the failure has already surfaced (sandbox creation hangs and times
out), the Dockerfiles on disk are already stale. Patch them in place
before retrying — the controller doesn't re-extract until the install
script runs again:

```bash
ssh -i ~/.ssh/tf_hetzner root@<vps> '
  for f in /opt/nemoclaw/Dockerfile /opt/nemoclaw/Dockerfile.base; do
    sed -i \
      -e "s/procps=2:4\\.0\\.4-9/procps/g" \
      -e "s/e2fsprogs=1\\.47\\.2-3+b11/e2fsprogs/g" \
      -e "s/tmux=3\\.5a-3/tmux/g" \
      "$f"
  done'
```

Then re-create the sandbox through the controller UI. No service
restart needed; nemoclaw re-reads the Dockerfiles per build.

### Other places that pin versions (audit notes)

- **`install_versioned_nemoclaw_openshell.sh`** — pins `OPENSHELL_VERSION`,
  `NEMOCLAW_INSTALL_REF`, `OPENCLAW_VERSION`. Bumping any of these can
  re-introduce the Dockerfile-pin failure if NemoClaw added new pins.
- **`package.json`** — Next.js `15.5.15`, React `18.3.1`, `xterm`,
  `node-pty`. These pin the *controller's* build, not the sandbox build.
  Standard `npm install` validation suffices.
- **`Dockerfile.base` ARG OPENCLAW_VERSION** — set by `--build-arg` from
  `install_versioned_nemoclaw_openshell.sh`. Bumps here need a re-test
  of `openclaw doctor --generate-gateway-token` because the CLI surface
  can change (we've already seen flag renames in this CLI's recent
  history).
- **`tests/sandbox-lifecycle-check.mjs`** — has version-aware
  assertions. Re-run after any bump.

The general rule: **bump one version at a time, re-run the smoke test
above, and grep the extracted Dockerfiles for new pinned apt installs
before declaring the bump done.**

---

## 9. Hermes Desktop remote-gateway exposure (multi-tenant)

Hermes sandboxes can be driven by the Hermes Desktop app over a public
URL: `https://<controller-host>/hermes/<sandbox>`. Implemented in
`scripts/hermes-remote/` + `app/lib/hermesRemote.ts`; wired into sandbox
create/delete and surfaced in the UI ("Remote Desktop Access" drawer).

Mode is `HERMES_REMOTE_MODE` in `.env.local`: `desktop` (default), `web`,
or `off`.

Architecture facts (validated 2026-06-10; full detail in
`memory/project_hermes_remote_desktop_poc.md`):

- **Ports**: in-sandbox dashboard port == host bind port == `21000 +
  hash(name) % 2000` (same hash as `server.mjs` `hashSandboxId`; OpenClaw
  owns 19000–20999). `openshell forward` cannot remap ports, hence the
  shared value.
- **Bind IP**: forwards bind on Traefik's compose-bridge gateway
  (discovered via `docker inspect`, typically `172.18.0.1`) — NOT docker0,
  and `host.docker.internal` does not resolve in this stack's Traefik.
- **Auth**: Hermes' session-token gate, pinned per sandbox via
  `HERMES_DASHBOARD_SESSION_TOKEN` (>=0.16). In `desktop` mode the Traefik
  rule forwards only `/hermes/<sb>/api/*` so the token-embedding SPA HTML
  is never public; the token is distributed via the controller UI/API
  (`GET/POST /api/sandbox/<sb>/hermes-remote`, OAuth users gated by
  sandbox access). The route intentionally bypasses Pangolin — the
  desktop's `/api/status` probe cannot follow SSO redirects.
- **Supervision**: `hermes-remote-forward@<sb>.service` (systemd,
  Restart=always) owns the forward; `hermes-remote-watchdog.timer` re-runs
  `launch.sh` every 2 min (sandbox restarts change the gateway PID/netns,
  killing the dashboard). All units are self-installed by `expose.sh`.
- **Version rule**: Hermes Desktop and the in-sandbox `hermes-agent` MUST
  be the same minor version (the desktop calls endpoints that older
  backends lack, and old gateways reject new TUIs). Hermes >=0.16 also
  requires `API_SERVER_KEY` in the sandbox `.env`; `launch.sh` provisions
  it and re-pins the NemoClaw config-integrity hash.

Don'ts: don't hand-edit `/etc/komodo/.../rules/hermes-remote-*.yml` (owned
by `expose.sh`); don't serve the SPA shell publicly in `desktop` mode (the
expose script hard-fails if `GET /` returns non-404).

### Troubleshooting "Unreachable" or "returned 000"

When the drawer shows Unreachable / `expose.sh` ends with `returned 000`:

**1. UFW not opened (most common on fresh installs)**
The controller's systemd PATH omits `/usr/sbin`, so `command -v ufw`
silently fails. Fixed in expose.sh to use `/usr/sbin/ufw` directly, but
worth checking on any deployment:
```bash
/usr/sbin/ufw status numbered | grep <port>
# If missing:
/usr/sbin/ufw allow from 172.0.0.0/8 to any port <port> proto tcp
```

**2. Traefik cannot reach the upstream (UFW present but still 000)**
Confirm from inside the Traefik container:
```bash
docker exec <traefik-container> wget -qO- http://172.18.0.1:<port>/api/status
```
If that times out, check UFW INPUT chain — Docker bridge traffic must
be allowed through INPUT (not just FORWARD).

**3. Forward dead / "sandbox is not ready"**
`openshell forward` returns `FailedPrecondition: sandbox is not ready`
when the sandbox is in Provisioning state. This happens after a
controller restart re-arms mTLS on the openshell-gateway (the
ensure-mtls hook runs on every service start). Only fix: recreate the
sandbox. Fresh deployments are immune (sandbox created after mTLS armed).
Since 2026-06-11 the ensure-mtls script (`/usr/local/sbin/
openshell-gateway-ensure-mtls.sh`, VPS-only) **skips the mTLS flip when
any `openshell-*` containers are running** and logs a WARNING instead —
flipping with live sandboxes orphans their plaintext supervisors
permanently. To complete the migration: delete all sandboxes, restart
the controller, recreate.

**4. Hermes gateway not running (#2478)**
`launch.sh` dies with "no 'hermes gateway run' process". Root cause:
`nemoclaw-proxy-env.sh` lacks `NODE_OPTIONS`, so gateway-recovery refuses
to relaunch. Workaround:
```bash
docker exec <container> mv /tmp/nemoclaw-proxy-env.sh /tmp/nemoclaw-proxy-env.sh.bak
# wait ~10s for the gateway to restart
docker exec <container> pgrep -fa "hermes gateway run"
docker exec <container> mv /tmp/nemoclaw-proxy-env.sh.bak /tmp/nemoclaw-proxy-env.sh
```
If the gateway then fails with "API_SERVER_KEY required", check that
`/sandbox/.hermes/.env` has `API_SERVER_KEY=...` and the config hash
at `/etc/nemoclaw/hermes.config-hash` covers it.

**5. expose.sh timeout (180 s) kills during Hermes upgrade**
`hermesRemote.ts` runs expose.sh with a 180 s timeout, but the in-sandbox
Hermes upgrade (pip install) takes 3–5 min. The upgrade continues as an
orphan after the timeout. The first expose call may leave the UI showing
"Unreachable" or a stale v0.14.0 version in the drawer; clicking "Retry
Exposure" after ~5 min will succeed once the upgrade has finished.
The UFW rule and access file are written before launch.sh (and the upgrade),
so they survive the timeout.

**6. hermesVersion shows v0.14.0 after upgrade**
The `hermesVersion` field in the access file is written when expose.sh
first runs (before upgrade). It only updates when expose.sh completes
successfully. After the upgrade finishes, click "Retry Exposure" to
refresh it.

### Version alignment and upgrade-hermes.sh

`scripts/hermes-remote/upgrade-hermes.sh` is a **temporary shim** that
upgrades the in-sandbox Hermes from 0.14 (NemoClaw base image) to >=0.16
at expose time. See the top of that file for exact removal steps. In brief:
once `docker exec openshell-<name>-* /opt/hermes/.venv/bin/hermes --version`
reports >=0.16 on a fresh sandbox, the shim and the version-check block
in `launch.sh` can both be deleted.

Until then: the Hermes Desktop app version MUST match the in-sandbox
backend minor version. Mismatches show up as broken UI tabs or WebSocket
failures, not a clear version error.

---

## 10. BYOVPS vs cloud VPS — architecture differences that affect scripts

When a script works on cloud VPS but breaks on BYOVPS, check these first:

### Traefik network mode

Cloud VPS: Traefik has its own Docker network entry → `docker inspect traefik`
returns `.NetworkSettings.Networks` with a populated `.Gateway` field.

BYOVPS (Komodo stack): Traefik runs with `--network container:gerbil` so it
shares Gerbil's network namespace. Its own `NetworkSettings.Networks` is
**empty**. `traefik_bridge_ip()` in `lib.sh` detects this by reading
`HostConfig.NetworkMode` — if it starts with `container:`, it inspects the
referenced container (Gerbil) instead. Never assume `docker inspect traefik`
has network data on a BYOVPS.

### hermes gateway process name

Older NemoClaw base images: `hermes` is the Python entry-point.
Cmdline: `/opt/hermes/.venv/bin/python /usr/local/bin/hermes gateway run`

Newer base images (≥ v0.16 era): `hermes` is a bash wrapper that `exec`s
`hermes.real`. Cmdline: `/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway run`

`pgrep -f 'hermes gateway run'` misses the newer form. Always use:
`pgrep -f 'hermes[^ ]* gateway run'`  (in `find_gateway_pid()` in `lib.sh`).

### Hermes first sandbox creation time

The first Hermes sandbox on a fresh BYOVPS takes **7–10 minutes** — Docker
builds the full Hermes base image from scratch. The browser HTTP request
times out and the UI shows "Sandbox creation started…" with no further
update. **This is normal.** The creation completes in the background.
Refresh the sandbox list after ~10 minutes and the sandbox will be Ready.
Subsequent creations are fast (layers cached).

### openshell forward "sandbox is not ready"

On BYOVPS, `openshell-gateway-ensure-mtls.sh` runs as ExecStartPre every
time the controller starts. If mTLS is re-armed after a sandbox was created
in plaintext era (e.g. after a controller update), the forward fails with
`FailedPrecondition: sandbox is not ready`. Only fix: recreate the sandbox.

After NemoClaw onboard, the gateway runs in plaintext with
`OPENSHELL_DISABLE_GATEWAY_AUTH=true`. The ensure-mtls script detects the
mismatch by checking the CLI **registration URL** (https:// vs http://),
not gateway.env flags — because NVIDIA's install.sh sets the same flags.

Since 2026-06-11 the script refuses to flip while `openshell-*`
containers are running (see §9 troubleshooting item 3) — the flip used
to silently brick every live sandbox. It also now registers the CLI to
**match the gateway's actual scheme** (http:// while plaintext is
deferred, https:// otherwise). The old version always registered
https://, which combined with a deferred flip left the CLI speaking TLS
to a plaintext gateway — every `openshell` command then fails with
`transport error: received corrupt message of type InvalidContentType`
("Inventory Unavailable" in the UI). If you ever see that error, check
`gateway.env` `OPENSHELL_DISABLE_TLS` vs `openshell gateway list`'s
scheme; re-register to match.

### needrestart vs the controller (incident 2026-06-11)

Ubuntu's `unattended-upgrades` + `needrestart` restarts every service
linked against an upgraded library — **once per upgraded package**. A
systemd/libssl upgrade restarted `openshell-controller` 5+ times in
60 s, tripping `StartLimitBurst=5` and leaving the service permanently
`failed` (and the restarts triggered the ensure-mtls flip that bricked
the sandboxes above). Every controller VPS needs:

```bash
cat > /etc/needrestart/conf.d/openshell-controller.conf <<'EOF'
$nrconf{override_rc}{qr(^openshell-controller\.service$)} = 0;
EOF
```

After an unattended upgrade, restart the controller manually
(`systemctl restart openshell-controller`). Recovery from the failed
state is `systemctl reset-failed openshell-controller && systemctl
start openshell-controller`.

### Ollama bootstrap lives in manidae-cloud, not here

When a fresh-deploy sandbox-create fails with "Failed to apply Ollama
systemd loopback override" — or a stray root-owned `ollama serve` holds
port 11434 — the bug is in the user-data, not the controller. We tried
adding a controller-side preflight shim (commit `b9f7fce`, reverted in
`0c7e7bf`) and explicitly rejected it: the controller doesn't own
ollama lifecycle. Fix it at source:

| Deploy path | Source-of-truth file |
|---|---|
| Cloud (Hetzner, Linode, Vultr, GCE) | `manidae-cloud/backend/app/core/deployment/terraform_templates/includes/startup_ollama.sh.j2` |
| BYOVPS phase-2 | `manidae-cloud/backend/app/core/deployment/byovps_bootstrap.py` (`ollama_install_block` lines ~188-271) |

Both must follow the same pattern: pkill any orphan `ollama serve`
(matches `^/usr/local/bin/ollama serve` and `^/usr/bin/ollama serve`),
write `override.conf` + `kill-stale-proxy.conf` drop-ins, then
`systemctl daemon-reload && systemctl enable ollama && systemctl restart
ollama || true`. **Never** `OLLAMA_HOST=… ollama serve &` directly —
that creates a root-owned orphan whose models live under `/root/.ollama/`
(invisible to the daemon's `ollama` user) and whose process holds the
port so `nemoclaw onboard`'s later restart can't bind.

Regression tests: `manidae-cloud/backend/tests/test_startup_ollama_template.py`
(cloud) and `test_byovps_bootstrap.py::test_ollama_install_kills_orphan_serve_before_systemctl_restart`
(BYOVPS) lock the orphan-kill-before-restart ordering on both paths.

---

## 11. OpenClaw dashboard token + tunnel architecture (the brittle one)

This section exists because we spent a full day rediscovering this in
June 2026. The OpenClaw "Open Dashboard" path is by far the most fragile
piece of the controller: a token has to be in sync across four carriers
on three machines, and there's a lazy SSH tunnel in the middle. When it
breaks the user sees `Auth did not match — gateway token mismatch` and
no obvious server-side error.

### The four token carriers

The gateway compares against `gateway.auth.token` in
`/sandbox/.openclaw/openclaw.json` (inside the sandbox container) for
every connection. The same value has to ride along on EVERY one of
these carriers, or the connection is rejected:

| Carrier | Who sets it | Who reads it |
|---|---|---|
| `openclaw_dashboard_token` HttpOnly cookie | `/api/openshell/dashboard/open` sets it from a live probe of `openclaw dashboard --no-open` | `server.mjs` for WS upgrades, `shared.ts` for HTTP proxy |
| URL `?token=…` query | The OpenClaw Control UI SPA, from `settings.gatewayUrl` in localStorage | `server.mjs` `withDashboardTokenQuery` |
| `Authorization: Bearer …` header | Browser, replayed from a cached value | `server.mjs` `copyDashboardWebSocketHeaders` |
| URL hash `#token=…` on the launchUrl | `/api/openshell/dashboard/open` from the probe | The injected bootstrap script (`shared.ts` `bootstrapScriptResponse`), which writes it to `localStorage[openclaw.control.settings.v1*]` |

**The invariant that holds everything together (post 2026-06-13 fixes):**
the HttpOnly cookie is the *only* trusted source. Both `server.mjs`
`withDashboardTokenQuery` and `copyDashboardWebSocketHeaders` now
**unconditionally overwrite** any client-supplied `?token=` /
`Authorization` with the cookie value. Do not re-introduce
`if (!headers.authorization)` or `if (!searchParams.has('token'))`
guards on those carriers — that's the regression that left "delete and
recreate the same sandbox name" broken for any browser with cached
state.

### The lazy SSH tunnel on 127.0.0.1:20049

The controller does NOT connect directly to the in-sandbox gateway at
`ws://127.0.0.1:18789`. It connects to `127.0.0.1:20049`, which is a
**lazy SSH forward** spawned by `ensureOpenClawDashboardListener()` in
`app/lib/openshellHost.ts`. The forward:

- Is created on demand by `/dashboard/open`'s `probeOpenClawDashboard()`
- Maps `127.0.0.1:20049` (host) → `127.0.0.1:18789` (sandbox)
- Dies when idle / sandbox restart / controller restart
- Has to be re-spun by another `/dashboard/open` call before any WS or
  HTTP traffic can flow

**Gotcha for server-side testing:** a raw `curl` WS handshake against
`/api/openshell/instances/<sb>/dashboard/proxy` will return
`HTTP/1.1 101 Switching Protocols` (the controller accepts the
upgrade) and then immediately `connect ECONNREFUSED 127.0.0.1:20049`
because no `/dashboard/open` was called to spin the forward. Always
call `/dashboard/open` first when reproducing failures from a shell;
the browser path does this automatically.

### Browser-side cache layers (also relevant)

The SPA writes the gateway URL+token combination to several localStorage
keys, all scoped by URL origin:

- `openclaw.control.settings.v1` (global, no scope)
- `openclaw.control.settings.v1:https://<controller-origin>/.../proxy`
- `openclaw.control.settings.v1:wss://<controller-origin>/.../proxy`
- `openclaw.control.token.v1:<scope>` in sessionStorage

When a user deletes a sandbox and recreates it with the same name, the
controller URL is identical, so the SPA reads the SAME localStorage
entries and tries to connect with the OLD sandbox's token. The fix
chain handles this server-side (cookie always wins), so users don't
need to clear localStorage. **But if you ever debug this in a browser,
remember that hitting "hard reload" does NOT clear localStorage** —
DevTools → Application → Local Storage → clear, or use an Incognito
window.

### Diagnostic recipe (when "Auth did not match" appears)

1. **Confirm the token chain matches server-side.** Run a script that:
   - Reads `gateway.auth.token` from `/sandbox/.openclaw/openclaw.json`
     via `docker exec -u sandbox <cnt> ...`
   - Hits `/api/openshell/dashboard/open?sandboxId=<name>` (with
     operator cookie) and parses the `Set-Cookie:
     openclaw_dashboard_token=…` and the `bootstrapUrl` body field
   - Compares all three; they must be byte-identical
   - If they don't match: the probe failed. Check
     `/tmp/gateway.log` inside the sandbox + the controller's
     `probeOpenClawDashboard()` result.
2. **Confirm the server-side WS path works** with curl after calling
   `/dashboard/open` (to spin the lazy tunnel):
   ```bash
   curl -sS -i -N \
     -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     -H 'Sec-WebSocket-Version: 13' \
     -b "openshell_control_session=$SESSION; openclaw_dashboard_token=$TOK" \
     http://127.0.0.1:3000/api/openshell/instances/<sb-instance>/dashboard/proxy
   ```
   Success = `HTTP/1.1 101 Switching Protocols` followed by a
   `connect.challenge` event from the gateway. If curl succeeds but
   browser fails, it's a client-cache problem (browser sending stale
   `Authorization` or stuck SPA state) — but the cookie-wins fix should
   already mask that.
3. **If server-side curl ALSO fails** with `code=1008 reason=token_mismatch`,
   re-introduce the diagnostic logging that was in commit `ed22c9e`
   (token-fingerprint fields in `dashboard-ws-client-connected`). It
   logs first-8-chars of the cookie token, URL token, and the token
   forwarded upstream so you can see which carrier is wrong.

### When to suspect this section

| Symptom | This section? | First check |
|---|---|---|
| "Auth did not match" in OpenClaw UI | YES | Token chain match (step 1 above) |
| `code=1008 reason=token_mismatch` in controller journal | YES | Same |
| `connect ECONNREFUSED 127.0.0.1:20049` in journal/curl | YES (tunnel layer) | Did `/dashboard/open` run recently? |
| Dashboard works once then fails after sandbox restart | YES | Tunnel died, sandbox restart re-randomizes the token |
| Dashboard works on cloud VPS but not BYOVPS | NO | Look at §10 + the Pangolin/Traefik path |
| 401 on `/__openclaw/control-ui-config.json` | YES | The HTTP 401 auto-refresh (`shared.ts`) should handle it; if not, regression in that code |

### The four commits that make this work (do not revert)

| SHA | What it does |
|---|---|
| `c35fea5` | `shared.ts` — on HTTP 401/403 from upstream for GET/HEAD, re-probe and retry with fresh token, refresh the cookie |
| `48bbfa5` | `server.mjs` `withDashboardTokenQuery` — cookie token always overwrites URL `?token=` |
| `a2e8ddb` | `server.mjs` `copyDashboardWebSocketHeaders` — cookie token always overwrites `Authorization: Bearer` |
| `b42b323` | reverts a temporary diagnostic — keep, leaves the three real fixes in place |

Rollback baseline (yesterday-working before any of these changes):
`8b9eb852097448bbfc6c4449ce9dddcda08ca37d`.

### Regression tests that protect this section

Two test files lock these invariants in. **Run them before pushing ANY
change to `server.mjs` or `app/api/openshell/dashboard/proxy/shared.ts`:**

```bash
node tests/dashboard-token-cookie-wins-check.mjs   # static source-text guards
node tests/dashboard-token-runtime-check.mjs        # behavioural execution
# or just:
npm test
```

| Test | What it catches |
|---|---|
| `dashboard-token-cookie-wins-check.mjs` | Direct reverts — someone re-adds `!url.searchParams.has('token')` or `!headers.authorization` guards |
| `dashboard-token-runtime-check.mjs` | Behavioural bugs — new code path bypasses the guard, subtle logic error, dependency drift in copyHeaders/filterCookieHeader/readCookieValue |

The runtime test EXTRACTS function source from `server.mjs` and executes
it in a `node:vm` sandbox. If you refactor the function signatures or
move them to a different module, the extract regex in
`dashboard-token-runtime-check.mjs` will fail to locate them — update
the regex, do NOT skip the test. (If you refactor enough that vm-eval
becomes painful, the right move is to extract the helpers into
`app/lib/dashboardProxy.mjs` and switch the test to import them
directly — see "Option B" referenced in the test header comment.)

If the runtime test fails with the assertion
`actual: 'STALE_FROM_LOCALSTORAGE' / expected: 'FRESH_FROM_COOKIE'`, the
exact 2026-06-13 production failure mode is back in the code. Do not
ship.

---

## 12. Useful one-liners

```bash
# How divergent are we from upstream?
git fetch upstream && \
  git rev-list --left-right --count upstream/main...HEAD

# Files only WE changed (since the last merge base with upstream/main):
git diff --stat upstream/main...HEAD

# What did upstream change since we last merged?
git log --oneline HEAD..upstream/main

# Quick local check after any source edit:
npx tsc --noEmit && npm run build 2>&1 | tail -5 \
  && node tests/control-auth-oauth-check.mjs

# Tail the controller logs on the VPS:
ssh -i ~/.ssh/tf_hetzner root@91.99.224.38 \
  'journalctl -u openshell-controller -n 100 --no-pager'
```
