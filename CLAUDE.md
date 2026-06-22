# CLAUDE.md — repo guide for agents

This is a working fork of `mmckeen-nv/openshell_controller`. It carries
**~94 commits ahead of upstream** (dual-auth with operator + OAuth/IDP,
file-backed sandbox-access store, Hermes Remote Desktop, MCP broker,
Quick Deploy fixes, terminal fullscreen, copy-link, etc.). Treat
upstream as a moving target we periodically pull from. For a
risk-prioritised view of what's fork-local, see
`docs/upstream-divergence-audit.md` (§4 below).

---

## 1. Branches

| Branch | Purpose |
|---|---|
| `gatewaydashboard` | **Production branch.** Origin's default; deployed to the VPS. Always green; only fast-forward or `--no-ff` merges land here. |
| `main` | Mirror of upstream/main on origin. Don't commit here; only used to compare diffs. |
| `sync/upstream-YYYY-MM-DD` | Short-lived branches for testing each upstream pull before merging. Delete after the merge lands on `gatewaydashboard`. |
| `scratch/*` | Throwaway. |

Remotes:
- `origin` → `github.com/ivobrett/openshell_controller` (our fork)
- `upstream` → `github.com/mmckeen-nv/openshell_controller`

`git fetch upstream` regularly. The fork can diverge fast.

---

## 2. Deploy / rollback

**VPS IP changes** when the box is reprovisioned (test-agency
deployments are ephemeral). **Always confirm the current IP with the
user before SSHing** — don't reuse a stale one from earlier turns. When
the IP (or host key) rotates: run `ssh-keygen -R <ip>` then reconnect
with `-o StrictHostKeyChecking=accept-new`. If `Permission denied
(publickey)` follows, the new VM doesn't have the operator's public
key — coordinate with the user.

Service runs under systemd as `openshell-controller` (unit owned by
`scripts/setup/openshell-controller.service`).

### Deploy procedure (apply local commits to an already-installed VPS)

Always work on a branch on your laptop first. Once green:

```bash
git push origin <branch>
ssh <vps> 'set -e
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

For a fresh VPS (no existing install), see
`docs/runbooks/fresh-vps-setup.md`.

### Rollback

```bash
ssh <vps> 'set -e
  cd /opt/openshell-controller
  git checkout <previous SHA>
  PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH \
    node_modules/.bin/next build
  systemctl restart openshell-controller'
```

The big refactor merge into `gatewaydashboard` was done `--no-ff`
(commit `328370a`), so `git revert -m 1 328370a` rolls the entire
refactor back as one revertable commit. Keep using `--no-ff` for
future upstream merges so the same property holds.

**Do not** use rsync. The user explicitly wants every deployed state
to correspond to a pushed commit. See `memory/feedback_deployment.md`.

---

## 3. Gateway recovery

**Symptom:** `openshell sandbox list` (or any `openshell sandbox`
command) returns:

```
Error: × transport error
  ╰─▶ Connection refused (os error 111)
```

**Cause:** The OpenShell Docker-driver gateway process died. The
gateway shuts down all sandbox containers when it exits, so every
sandbox shows Exited in `docker ps`.

**Fix — run on the VPS:**

```bash
PATH=/root/.nvm/versions/node/v22.22.3/bin:/root/.local/bin:$PATH \
HOME=/root \
OPENSHELL_GATEWAY=nemoclaw \
nemoclaw <any-sandbox-name> recover
```

`<any-sandbox-name>` = any name from `nemoclaw list` (reads the local
registry, works even when the gateway is down). Once you see
`✓ Docker-driver gateway is healthy`, `openshell sandbox list` works
again and sandboxes return to Ready. `HOME` must be set explicitly —
NemoClaw needs it for `~/.local/state/nemoclaw/`. It is always set in
the systemd unit; add it for bare SSH sessions.

After the host gateway is back, individual sandbox inner gateways
(Hermes / OpenClaw) may also need recovery. Repeat the `nemoclaw
<sandbox-name> recover` command per affected sandbox.

---

## 4. Runbooks index — when to consult each doc

This repo ships several long-form docs alongside CLAUDE.md. Reach for
the right one based on what you're doing:

| Doc | When to read it |
|---|---|
| **`docs/upstream-divergence-audit.md`** | (a) After any `sync/upstream-*` merge (see §5 step 9) — drop shims the upstream now provides. (b) Before bumping any NEMOCLAW/OPENSHELL/HERMES version. (c) Before touching a file marked 🔴 HIGH in the audit (auth/, sandboxPrivilegedFiles, sandboxOpenClawMcpConfig, mcpBroker*, hermesRemote, scripts/hermes-remote/, dashboard token chain in server.mjs, restore handling). (d) For any security review. (e) When deciding whether a "cleanup" is safe — it may be load-bearing. |
| **`docs/runbooks/nemoclaw-version-bumps.md`** | Bumping `NEMOCLAW_INSTALL_REF`, `NEMOCLAW_INSTALL_TAG`, `OPENSHELL_VERSION`, or `OPENCLAW_VERSION` in `install_versioned_nemoclaw_openshell.sh`. Covers the Debian-pin failure mode + pre-flight smoke test. |
| **`docs/runbooks/byovps-architecture.md`** | A script works on cloud VPS but breaks on BYOVPS (or vice versa). Covers Traefik network mode, hermes process naming, openshell-gateway ensure-mtls flips, needrestart, ollama bootstrap source-of-truth. |
| **`docs/runbooks/fresh-vps-setup.md`** | Brand-new VPS (BYOVPS or cloud) bring-up. Not needed for incremental deploys — those use §2. |
| **`HERMES_REMOTE_DESKTOP.md`** | Anything about the Hermes Desktop public-URL flow: architecture, expose.sh / launch.sh, session-token gate, Traefik rule, troubleshooting cheatsheet (§5). |
| **`SANDBOX_ACCESS_CONTROL.md`** | Per-sandbox OAuth-user access controls + the file-backed `data/sandbox-access.json` store. |

After every `sync/upstream-*` merge, also refresh
`docs/upstream-divergence-audit.md` (file lists go stale immediately).
Target cadence: every 2 weeks during active development, or
immediately after an upstream merge.

---

## 5. Pulling from upstream — the safe procedure

This is the procedure I'd recommend whenever `git fetch upstream`
shows new commits on `upstream/main`. **Always use a sync branch —
never merge into `gatewaydashboard` directly.**

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

1. List conflicting files: `git status --short | grep ^UU` (or
   `grep -lnE '^<<<<<<<' -r .` from the repo root).
2. For each conflicting file, decide:
   - **Take upstream verbatim** when it's a doc / installer / test the
     upstream author owns (version pinning, README, install scripts).
     Use `git checkout --theirs <file>` then `git add <file>`.
   - **Take ours verbatim** when the file is one of our additions and
     upstream's parallel change is irrelevant. Rare.
   - **Manually merge hunk-by-hunk** when both sides have real code
     changes. Combine both sides while preserving any new upstream
     imports, activity-log / telemetry calls, and all of our
     `app/lib/auth/*`, `app/lib/sandboxCreate/*`, and middleware logic.
3. After resolution, `npm run build && npm test`.
4. Commit the merge with a thorough message listing the resolutions.
5. Push the sync branch: `git push -u origin sync/upstream-$DATE`.
6. Deploy the sync branch to the VPS using the Deploy procedure above
   (note the rollback SHA before switching).
7. Run the smoke tests (§7). All must pass.
8. Fast-forward `gatewaydashboard` to the sync branch and push:
   ```bash
   git checkout gatewaydashboard
   git merge --ff-only "sync/upstream-$DATE"
   git push origin gatewaydashboard
   git branch -d "sync/upstream-$DATE"
   git push origin --delete "sync/upstream-$DATE"
   ```
9. **Walk `docs/upstream-divergence-audit.md`** (see §4). For every
   item tagged "HIGHLY upstream-fixable", check whether this merge
   brings in the upstream capability that obsoletes our workaround —
   and if so, delete it in a follow-up commit. Then refresh the
   audit's file lists and per-area sections.

### Common conflict patterns and the right resolution

| Pattern | Resolution |
|---|---|
| Upstream changed `README.md` / version pins / installer scripts | `git checkout --theirs` |
| Upstream added new test files | Take theirs (additive) |
| Upstream added a new import to `app/api/sandbox/create/route.ts` | Keep both — re-order alphabetically |
| Upstream added activity/telemetry calls inside our refactored sections | Keep upstream's call but place it inside our refactored control flow (e.g. inside our readiness re-poll check, not before it) |
| Upstream changed `middleware.ts` to add a new public path | Add it to our `PUBLIC_PATHS` array; keep our dual-auth dispatch |
| Upstream changed cookie names | Don't follow them — our cookie is `oauth_session`. Keep the legacy `CF_Authorization` fallback. |
| Upstream changed `app/api/sandbox/create/route.ts` or `delete/route.ts` near our hermes-remote hooks | Take upstream's changes, then re-apply our hooks: in create, the `hermesRemote` block + import + response field; in delete, the `unexposeHermesRemote` teardown block + import + response field. All hermes-remote logic lives in `app/lib/hermesRemote.ts` + `scripts/hermes-remote/` (ours only, never conflict). |
| Upstream changed `ensureOpenClawGatewayToken` in `app/api/sandbox/create/route.ts` | Fork-only function. Keep ours verbatim — the shell script polls the gateway WS handshake to verify the JSON token is live, satisfying the §10 dashboard-token invariant. Test: `tests/openclaw-create-gateway-token-verify-check.mjs`. |
| Upstream changed `bootstrapScriptResponse` in `app/api/openshell/dashboard/proxy/shared.ts` near the `sessionStorage` block | Keep upstream's structure; re-apply our two fork additions BOTH inside the same `try { ... } catch {}`: (1) the `sessionKeysToWipe` scan that removes existing `tokenPrefix + <scope>` keys whose scope contains the current `proxyPrefix`, placed BETWEEN `window.sessionStorage.removeItem(tokenKey)` and `if (token) { ... }`; (2) the `pageScope` setItem inside the `if (token)` block that also writes the token under the https:// page-origin scope. See §10 — without these, the SPA replays stale tokens. Test: `tests/openclaw-dashboard-session-token-cleanup-check.mjs`. |
| Upstream changed `app/components/SandboxList.tsx` | Keep upstream; re-apply our 4 additions: `HermesRemotePanel` import, `'hermesRemote'` in `DrawerKey` + state init, and the "Remote Desktop Access" `<DrawerSection>` before File Transfer. |

---

## 6. Architecture pointers (where the load-bearing code lives)

Read these in this order if you're a new agent picking up the
codebase. **For a security-prioritised view of what's fork-local vs
upstream, also skim `docs/upstream-divergence-audit.md` — its summary
table tells you which areas are 🔴 HIGH risk and warrant extra care
before editing.**

1. **`middleware.ts`** — entry point. Uses `resolveAuthContext()` to
   build an `AuthContext` discriminated union, then dispatches per
   kind. Runs on `runtime: "nodejs"` so it can read `process.env` and
   the file-backed access store fresh per request. **Don't switch to
   Edge runtime** — it'll re-introduce the config-reload bug we
   already removed.
2. **`app/lib/auth/`** — the consolidated auth library.
   - `policy.mjs` (+ `policy.d.ts`) — runtime-agnostic pure logic
     (cookie/JWT splitting, base64url, sandbox-access map parsing).
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
   conflicts with our dashboard WS proxy.
5. **`app/api/sandbox/create/route.ts`** — sandbox creation. Branches:
   `nemoclaw-blueprint`, `nemoclaw-hermes`, `custom-sandbox`,
   `redeploy-image` (covers Quick Deploy for OpenClaw/Hermes/Custom).
   Helpers in `app/lib/sandboxCreate/{policy,agentFilter}.ts`. Agent
   detection uses `app/lib/sandboxContainerImage.ts`.

### Things to remember about the auth design

- `AuthContext.kind` is one of `"operator" | "oauth" | "anonymous" | "disabled"`.
- The OAuth cookie is `oauth_session`; the legacy alias
  `CF_Authorization` is **read** but no longer **written**. Both are
  cleared on logout.
- Env vars are read in priority order:
  `OAUTH_JWT_SECRET > MCPAUTH_JWT_SECRET > CF_AUTH_JWT_SECRET`. Same
  pattern for `_LOGIN_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`,
  `_CALLBACK_URL`.
- `x-forwarded-user` is set by middleware **only** for verified OAuth
  users. Routes can trust it. `server.mjs`'s WS upstream proxy
  **strips** any client-supplied `x-forwarded-user` (see
  `copyHeaders()`). Never weaken that.
- `MCPAUTH_WRITE_ALLOWED_PATHS` (in middleware.ts) is the allowlist
  for OAuth users to POST. New entries require the route handler
  itself to gate by sandbox access (see how `terminal/live` does it).
- **Don't** add a fallback secret to `getOAuthSecret`. The
  fail-closed-on-missing-secret behaviour is intentional.

---

## 7. Smoke tests + local regression suite

### After a deploy (run on the VPS)

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

```bash
npm test
```

Runs every `tests/*.mjs` and reports `PASS:` / `FAIL:` per file,
exiting non-zero on any failure. The expected baseline is **all tests
PASS except `control-auth-cookie-check.mjs`** (pre-existing TypeScript
module resolution issue, unrelated tech debt). Any *other* failure is
a real regression — fix the root cause rather than weakening the
assertion. Each assertion has a documented historical failure mode
behind it.

Particularly important after touching `server.mjs` or
`app/api/openshell/dashboard/proxy/shared.ts`:

```bash
node tests/dashboard-token-cookie-wins-check.mjs   # source-text guards
node tests/dashboard-token-runtime-check.mjs        # behavioural guards
node tests/control-auth-oauth-check.mjs             # auth invariants
```

If `dashboard-token-runtime-check.mjs` fails with assertion
`actual: 'STALE_FROM_LOCALSTORAGE' / expected: 'FRESH_FROM_COOKIE'`,
the cookie-wins invariant from §10 has been broken — do NOT push.

---

## 8. Memory & past decisions

Persistent memory lives at:
```
~/.claude/projects/-Users-mattercoder-Projects-nvidia-openshell-controller/memory/
```

Key files to read before changing security-adjacent code:
- `feedback_deployment.md` — *Don't rsync; use git commit → push → pull.*
- `project_password_reset_bug.md` — Edge-runtime middleware
  snapshotted `process.env`, causing freshly-issued login cookies to
  be rejected. Fixed by moving middleware to Node runtime.
- `project_sandbox_access_control.md` — Per-sandbox access via the
  `oauth_session` cookie + `SANDBOX_ACCESS_USERS` env var (now
  superseded by `data/sandbox-access.json`).
- `project_sandbox_ssh.md` — Historical: previously sandbox shells
  went via `docker exec` through `openshell-cluster-nemoclaw`. As of
  2026-06-22 we migrated all privileged in-sandbox writes to
  `openshell sandbox exec` (see audit §6).

Update those files when your work would change their accuracy.

---

## 9. Don'ts

These have all been tried and rejected — don't reintroduce them. The
parallel list at the end of `docs/upstream-divergence-audit.md` is
kept in sync — if you change either, update both.

- **Don't** call `process.exit(0)` after writing config. The
  Node-runtime middleware refresh covers this.
- **Don't** `rsync` source files to the VPS. Use git.
- **Don't** rename `MCPAUTH_*` env vars in the operator's `.env.local`.
  The fallback reads them; just add `OAUTH_*` for new deployments.
- **Don't** remove the legacy `CF_Authorization` cookie reader from
  `context.ts` / `server.mjs` until the user explicitly OKs it.
  Existing browsers may still hold sessions under that name.
- **Don't** switch middleware back to Edge runtime. The whole
  no-restart-on-config-change machinery depends on the Node runtime
  having a live `process.env` view.
- **Don't** generate or guess URLs for the user.
- **Don't** push to `gatewaydashboard` without running `npm run build`
  AND deploying + smoke-testing on the VPS first. Force-push to
  `gatewaydashboard` is forbidden.
- **Don't** push without running `npm test` first. The suite is fast
  (~2s) and locks in dashboard token (§10), auth, middleware, sandbox
  lifecycle, and MCP config invariants. Baseline is "all PASS except
  the one known tech-debt failure".
- **Don't** delete or weaken `tests/dashboard-token-cookie-wins-check.mjs`
  or `tests/dashboard-token-runtime-check.mjs` without understanding
  §10. They are the only mechanical guards against the brittle
  2026-06-13 dashboard regression coming back.

---

## 10. OpenClaw dashboard token + tunnel architecture (the brittle one)

This section exists because we spent a full day rediscovering this in
June 2026. The OpenClaw "Open Dashboard" path is by far the most
fragile piece of the controller: a token has to be in sync across
four carriers, and there's a lazy SSH tunnel in the middle. When it
breaks the user sees `Auth did not match — gateway token mismatch`
and no obvious server-side error.

### The four token carriers

The gateway compares against `gateway.auth.token` in
`/sandbox/.openclaw/openclaw.json` (inside the sandbox container) for
every connection. The same value has to ride along on **every** one
of these carriers, or the connection is rejected:

| Carrier | Who sets it | Who reads it |
|---|---|---|
| `openclaw_dashboard_token` HttpOnly cookie | `/api/openshell/dashboard/open` sets it from a live probe of `openclaw dashboard --no-open` | `server.mjs` for WS upgrades, `shared.ts` for HTTP proxy |
| URL `?token=…` query | The OpenClaw Control UI SPA, from `settings.gatewayUrl` in localStorage | `server.mjs` `withDashboardTokenQuery` |
| `Authorization: Bearer …` header | Browser, replayed from a cached value | `server.mjs` `copyDashboardWebSocketHeaders` |
| URL hash `#token=…` on the launchUrl | `/api/openshell/dashboard/open` from the probe | The injected bootstrap script (`shared.ts` `bootstrapScriptResponse`), which writes it to `localStorage[openclaw.control.settings.v1*]` |

**The invariant (post 2026-06-13 fixes):** the HttpOnly cookie is the
*only* trusted source. Both `server.mjs` `withDashboardTokenQuery`
and `copyDashboardWebSocketHeaders` **unconditionally overwrite** any
client-supplied `?token=` / `Authorization` with the cookie value. Do
not re-introduce `if (!headers.authorization)` or
`if (!searchParams.has('token'))` guards on those carriers — that's
the regression that left "delete and recreate the same sandbox name"
broken for any browser with cached state.

### The lazy SSH tunnel on 127.0.0.1:20049

The controller does NOT connect directly to the in-sandbox gateway at
`ws://127.0.0.1:18789`. It connects to `127.0.0.1:20049`, a **lazy
SSH forward** spawned by `ensureOpenClawDashboardListener()` in
`app/lib/openshellHost.ts`:

- Created on demand by `/dashboard/open`'s `probeOpenClawDashboard()`.
- Maps `127.0.0.1:20049` (host) → `127.0.0.1:18789` (sandbox).
- Dies when idle / sandbox restart / controller restart.
- Has to be re-spun by another `/dashboard/open` call before any WS
  or HTTP traffic can flow.

**Gotcha for server-side testing:** a raw `curl` WS handshake against
`/api/openshell/instances/<sb>/dashboard/proxy` will return
`HTTP/1.1 101 Switching Protocols` (the controller accepts the
upgrade) and then immediately `connect ECONNREFUSED 127.0.0.1:20049`
because no `/dashboard/open` was called to spin the forward. Always
call `/dashboard/open` first when reproducing failures from a shell;
the browser path does this automatically.

### Browser-side cache layers

The SPA writes the gateway URL+token combination to several
localStorage keys scoped by URL origin
(`openclaw.control.settings.v1[:scope]`, `openclaw.control.token.v1:<scope>`
in sessionStorage). When a user deletes a sandbox and recreates it
with the same name, the controller URL is identical, so the SPA
reads the SAME entries and tries to connect with the OLD token. The
server-side cookie-wins fix masks this end-to-end, so users don't
need to clear localStorage. **But if you ever debug this in a
browser, hitting "hard reload" does NOT clear localStorage** — use
DevTools → Application → Local Storage → clear, or an Incognito
window.

### When to suspect this section

| Symptom | This section? | First check |
|---|---|---|
| "Auth did not match" in OpenClaw UI | YES | Token chain (see diagnostic below) |
| `code=1008 reason=token_mismatch` in controller journal | YES | Same |
| `connect ECONNREFUSED 127.0.0.1:20049` in journal/curl | YES (tunnel layer) | Did `/dashboard/open` run recently? |
| Dashboard works once then fails after sandbox restart | YES | Tunnel died, restart re-randomises the token |
| Dashboard works on cloud VPS but not BYOVPS | NO | See `docs/runbooks/byovps-architecture.md` |
| 401 on `/__openclaw/control-ui-config.json` | YES | The HTTP 401 auto-refresh (`shared.ts`) should handle it; if not, regression there |

### Diagnostic recipe (when "Auth did not match" appears)

1. **Confirm the token chain matches server-side.** Read
   `gateway.auth.token` from `/sandbox/.openclaw/openclaw.json` via
   `docker exec -u sandbox <cnt> ...`, hit
   `/api/openshell/dashboard/open?sandboxId=<name>` (with operator
   cookie), parse the `Set-Cookie: openclaw_dashboard_token=…` and
   the `bootstrapUrl` body field. All three must be byte-identical.
   If not, the probe failed — check `/tmp/gateway.log` inside the
   sandbox + the controller's `probeOpenClawDashboard()` result.
2. **Confirm the server-side WS path works** with `curl` after
   calling `/dashboard/open` (to spin the lazy tunnel):
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
   browser fails, it's a client-cache problem.
3. **If server-side curl ALSO fails** with `code=1008 reason=token_mismatch`,
   re-introduce the diagnostic logging from commit `ed22c9e`
   (token-fingerprint fields in `dashboard-ws-client-connected`).

### Commits and tests that protect this section

The four load-bearing commits — **do not revert**:

| SHA | What it does |
|---|---|
| `c35fea5` | `shared.ts` — on HTTP 401/403 from upstream for GET/HEAD, re-probe and retry with fresh token, refresh the cookie |
| `48bbfa5` | `server.mjs` `withDashboardTokenQuery` — cookie token always overwrites URL `?token=` |
| `a2e8ddb` | `server.mjs` `copyDashboardWebSocketHeaders` — cookie token always overwrites `Authorization: Bearer` |
| `b42b323` | reverts a temporary diagnostic — keep, leaves the three real fixes in place |

Rollback baseline (yesterday-working before any of these):
`8b9eb852097448bbfc6c4449ce9dddcda08ca37d`.

Two regression tests lock these invariants in. **Run them before
pushing ANY change to `server.mjs` or
`app/api/openshell/dashboard/proxy/shared.ts`** (`npm test` runs
both):

| Test | What it catches |
|---|---|
| `tests/dashboard-token-cookie-wins-check.mjs` | Direct reverts — someone re-adds `!url.searchParams.has('token')` or `!headers.authorization` guards |
| `tests/dashboard-token-runtime-check.mjs` | Behavioural bugs — new code path bypasses the guard, subtle logic error, dependency drift in `copyHeaders` / `filterCookieHeader` / `readCookieValue` |

The runtime test extracts function source from `server.mjs` and
executes it in a `node:vm` sandbox. If you refactor function
signatures or move them, the extract regex will fail to locate them —
update the regex, do NOT skip the test. If refactoring makes vm-eval
painful, extract the helpers into `app/lib/dashboardProxy.mjs` and
switch the test to import them directly.
