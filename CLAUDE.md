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

Plus the auth unit test on the laptop:

```bash
node tests/control-auth-oauth-check.mjs
```

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

---

## 10. Useful one-liners

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
