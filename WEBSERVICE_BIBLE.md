# NemoClaw Web Service Coding BIBLE

## Purpose

This document is the operating doctrine for the NemoClaw web service.

Its job is to prevent three failure classes that already caused drift:

1. **authority drift** — multiple competing sources of truth
2. **ownership drift** — multiple processes/services thinking they own the same runtime surface
3. **runtime-truth confusion** — dashboards or probes looking green while describing the wrong process, wrong route owner, or wrong machine state

This is not philosophy. These are build and run rules.

---

## 0. Canonical names and lanes

### 0.1 Canonical code lane
The canonical editable codebase is:

- `/home/nvidia/.openclaw/workspace/projects/nemoclaw-dashboard`

All feature work, bug fixes, route changes, and tests must start here.

### 0.2 Canonical live runtime lane
The canonical live runtime tree is:

- `/home/nvidia/nemoclaw-dashboard`

This path is a deployment target, not the primary authoring lane.

### 0.3 Runtime owner
The intended runtime owner is:

- `nemoclaw-dashboard.service`

Anything else listening on the production ports is drift unless explicitly documented as a temporary diagnostic with start/stop bounds.

### 0.4 Intended listeners
The intended listeners are:

- `:3000` → dashboard HTTP/WebSocket entrypoint
- `:3011` → loopback terminal server

Per current runtime design:

- `:3000` must be owned by the dashboard service path under `/home/nvidia/nemoclaw-dashboard`
- `:3011` must be owned by the terminal server started under dashboard supervisor control

If these ports are owned by a workspace `next dev`, a random shell, or a second service, that is **not success**. It is drift.

---

## 1. Source-of-truth doctrine

## 1.1 One truth per concern
Every concern must have exactly one canonical authority.

Use this mapping:

- **Editable application code truth** → `projects/nemoclaw-dashboard`
- **Live executable runtime truth** → `/home/nvidia/nemoclaw-dashboard` + `nemoclaw-dashboard.service`
- **Port ownership truth** → PID/socket inspection, not browser success alone
- **Terminal session transport truth** → `terminal-server.mjs` on `127.0.0.1:3011`
- **Dashboard-to-terminal bridge truth** → `server.mjs` proxy path `/api/openshell/terminal/live/ws`
- **OpenClaw instance registry truth** → `app/lib/openclawInstances.ts` environment-driven registry
- **Dashboard browser session identity truth** → `app/lib/dashboardSession.ts`

No feature may silently invent a second authority for the same concern.

## 1.2 Browser-visible truth is not runtime truth
A page returning HTTP 200 from `:3000` is insufficient evidence.

A claim like “dashboard is up” is valid only if all are true:

- the expected port is listening
- the owning PID belongs to the intended runtime path/service
- the service state matches the port state
- the deployed code path matches the claimed release lane

If one of those is missing, report degraded or unknown, not healthy.

## 1.3 Environment defaults may bootstrap, not silently redefine truth
Defaults such as:

- `OPENCLAW_DASHBOARD_URL`
- `TERMINAL_SERVER_URL`
- `OPENCLAW_INSTANCE_REGISTRY_JSON`
- `OPENCLAW_SANDBOX_INSTANCE_MAP_JSON`

may provide bootstrap behavior, but they must not create silent semantic rewrites.

If an env var changes authority, routing, loopback policy, or instance selection, the UI and logs must expose that fact.

---

## 2. Route ownership doctrine

## 2.1 Each route has one owner module
Each API route or transport path must have one clearly named owner.

Current ownership model:

- Next.js app routes under `app/api/**` own user-facing HTTP API semantics
- `server.mjs` owns the outer HTTP/WebSocket server and terminal bridge upgrade path
- `terminal-server.mjs` owns terminal session creation, buffering, resize/input handling, and process lifecycle
- `app/lib/*` owns shared authority/identity resolution logic, not ad hoc route-local copies

Do not duplicate resolution logic inside multiple route handlers when a shared module already exists.

## 2.2 No split-brain route semantics
If the same conceptual operation is available in multiple places, one path must be canonical and the others must either:

- delegate directly to it, or
- be removed

Example:

- terminal live WebSocket entrypoint must be treated as owned by `server.mjs` proxy path `/api/openshell/terminal/live/ws`
- direct client assumptions that bypass this owner path are not allowed unless the architecture is intentionally changed and this BIBLE is updated

## 2.3 UI state is not authority
UI-selected sandbox, browser sessionStorage, or client memory can express **intent**, but not authoritative backend fact.

Specifically:

- `dashboardSessionId` is correlation state, not backend truth
- `selectedSandboxId` is operator intent, not proof that the backend session is attached to the correct target

Backends must validate and log the actual resolved identity.

## 2.4 Shared resolution logic must live in library code
The following classes of logic must live in shared modules, not repeated inline:

- instance resolution
- sandbox-to-instance mapping
- dashboard session identity construction
- host/runtime probing
- normalized phase/status naming

If a contributor copies logic from `app/lib/openclawInstances.ts`, `app/lib/dashboardSession.ts`, or `app/lib/openshellHost.ts` into route files, that is a doctrine violation.

---

## 3. Runtime ownership doctrine

## 3.1 Single supervised owner for live runtime
Live runtime on Spark must be single-owner and supervised.

That means:

- `nemoclaw-dashboard.service` is the owner
- its supervisor script controls process startup/cleanup
- `terminal-server.mjs` is not independently service-owned in normal operation

The disabled oneshot `tmp_nemoclaw_terminal.service` pattern reflects the correct doctrine: terminal runtime is subordinate to the dashboard supervisor, not a co-equal long-running owner.

## 3.2 Manual `next dev` on production ports is drift
A manually launched workspace process on `:3000` or `:3011` is drift when the service is supposed to own those ports.

This includes:

- `npm run dev`
- `next dev`
- `node server.mjs` from the wrong tree
- shell-started `terminal-server.mjs`

Manual processes are allowed only for bounded diagnostics when all are true:

- the service is stopped or intentionally isolated
- the operator explicitly says diagnostic mode is active
- the ports and owning path are checked before and after
- the process is removed after diagnosis

## 3.3 Supervisor owns child lifecycle
The dashboard supervisor must remain responsible for:

- preflight port guarding
- starting terminal server
- waiting for terminal `/healthz`
- starting dashboard HTTP owner
- cleanup of child terminal PID
- cleanup of both ports on exit

Do not move those responsibilities piecemeal into random shell scripts or route handlers.

## 3.4 Loopback-only terminal server is intentional
`terminal-server.mjs` defaulting to `127.0.0.1:3011` is a security and ownership feature.

Do not expose `:3011` directly on public interfaces as a convenience shortcut.

External clients must go through the dashboard-owned bridge unless the architecture is explicitly redesigned.

## 3.5 Preserve runtime helpers across deploys
The live tree’s `.runtime/*` contents are part of runtime ownership.

Per local notes, do not delete or clobber runtime helper scripts during sync/deploy.

At minimum preserve:

- supervisor scripts
- port guards
- PID/log/runtime state files needed by the service contract

A deploy that replaces app code but destroys ownership tooling is a broken deploy.

---

## 4. Deploy and release discipline

## 4.1 Build in projects, run in live
Required flow:

1. change code in `/home/nvidia/.openclaw/workspace/projects/nemoclaw-dashboard`
2. validate there
3. sync/promote intentionally into `/home/nvidia/nemoclaw-dashboard`
4. restart or reload via the owning service
5. verify runtime ownership after deploy

Do not “hotfix the live tree and maybe backport later.” That creates untraceable truth forks.

## 4.2 Every deployment must answer four questions
Before claiming deploy success, record:

- what commit/content was deployed
- from which source path it came
- which service/process now owns `:3000` and `:3011`
- which verification checks passed

If these are not known, the deploy is not complete.

## 4.3 Production mode must be explicit
The supervisor currently selects:

- production mode if `.next/BUILD_ID` exists
- development mode otherwise

This fallback is operationally useful, but dangerous because it can make drift look normal.

Doctrine:

- intended service mode must be explicit in deploy notes/logs
- production claims require proof that production artifacts existed and were used
- if the service falls back to `next dev`, that state must be treated as degraded, not equivalent to production

## 4.4 No invisible lane crossing
If code is copied/synced from workspace to live tree, that action must be deliberate and logged.

Allowed:

- controlled sync scripts
- documented rsync/copy steps
- release commits/tags

Not allowed:

- ad hoc manual edits in both trees
- partial file copying without manifest or explanation
- “I think live matches workspace” with no evidence

---

## 5. Fallback and degraded-mode honesty

## 5.1 Fallbacks must announce themselves
A fallback path must never present itself as canonical success.

Examples:

- default instance chosen because requested instance was missing
- default dashboard session created because client session was absent
- terminal transport falling back from PTY to stream
- service using dev mode because build artifacts were absent

All of these are legal only if they are observable.

## 5.2 Honesty rule
When the system is using fallback or degraded behavior, it must say one of:

- `fallback-active`
- `degraded`
- `defaulted`
- `unknown-owner`
- `unverified`

It must not say only `ok`, `healthy`, or `connected` if the canonical target was not proven.

## 5.3 Transport downgrade is not neutral
If terminal runtime drops from PTY to stream mode, treat it as a material runtime fact.

Expose it in:

- `/healthz` payloads where relevant
- session init response
- logs
- test expectations

Do not hide transport downgrades; they affect operator behavior and bug interpretation.

## 5.4 Missing target must fail closed where authority matters
If a requested instance, sandbox, or runtime owner cannot be proven, then:

- read paths may return explicit unknown/degraded state
- mutating/interactive paths must prefer explicit failure over silent retargeting

Silent retargeting is how authority drift becomes data loss or operator deception.

---

## 6. Logging and provenance doctrine

## 6.1 Logs must prove who did what, where
Every meaningful runtime action should be attributable across these axes:

- timestamp
- owning component
- route/path/event
- dashboard session id if present
- sandbox id or instance id if relevant
- resolved target actually used
- transport/runtime mode if relevant

## 6.2 Distinguish requested identity from resolved identity
Whenever user input can be remapped, logs must preserve both:

- requested sandbox/instance/session
- resolved sandbox/instance/session

Never overwrite requested identity and keep only the resolved one. That destroys forensic value.

## 6.3 Ownership logs beat cosmetic logs
Prefer logs that answer:

- which PID owned the port
- which path launched the process
- which service unit was active
- which upstream terminal URL was bridged

over decorative logs that only say “connected” or “success”.

## 6.4 Bridge/proxy logs are mandatory for multiplexed terminal behavior
Because `server.mjs` proxies terminal WebSockets, bridge logs are part of runtime truth.

Required for connection lifecycle events:

- bridge id
- client path
- upstream URL
- close source
- close code/reason
- frame counters or equivalent activity signal

That pattern already exists and must remain.

---

## 7. Testing and acceptance gates

## 7.1 A web-service change is not done until authority is tested
Tests must validate not only feature output, but authority correctness.

Minimum acceptance for runtime-affecting changes:

1. route/feature behaves as intended
2. resolved authority matches expected authority
3. fallback/degraded states are explicit
4. logs contain provenance fields
5. runtime owner on ports remains correct after deploy

## 7.2 Required verification classes
Any non-trivial change touching routing, instance selection, terminal bridging, or deploy logic must include checks from these classes:

### A. Static ownership checks
- confirm owner module was changed in one place, not duplicated in several
- confirm shared resolution logic still comes from `app/lib/*`

### B. Behavior checks
- valid request to intended sandbox/instance
- invalid/missing target request
- fallback activation path
- degraded transport path if applicable

### C. Runtime checks
- service status
- listener presence on `:3000` and `:3011`
- PID/path ownership for both ports
- dashboard bridge path still functional
- terminal server `/healthz` still functional

### D. Honesty checks
- UI/API response does not call fallback state healthy without qualification
- logs reveal requested vs resolved target

## 7.3 No green-by-HTTP-only acceptance
A test bundle that checks only:

- page loads
- API returns 200
- WebSocket connects

is insufficient for this service.

At least one acceptance step must verify owner identity beyond network reachability.

## 7.4 Promotion gate
Do not promote workspace changes into live runtime unless all apply:

- build or intentional dev-mode rationale is documented
- tests passed in workspace lane
- sync target is identified
- ownership verification plan exists
- post-deploy owner verification completed

---

## 8. No-go anti-patterns

These are banned unless this BIBLE is explicitly amended.

## 8.1 Split truth planes
- showing dashboard state from one source while actions hit another
- inventory from one registry and terminal attach from a hidden different registry
- route owner changed in one layer but old path still appears canonical elsewhere

## 8.2 Silent default authority
- missing requested instance silently replaced with default for a mutating action
- absent sandbox silently converted to host shell without explicit operator visibility
- production claim made while actually running fallback dev mode

## 8.3 Cosmetic health
- declaring service healthy from HTTP 200 alone
- using successful UI render as proof of correct owner
- treating any listener on `:3000` as acceptable

## 8.4 Live-tree hand editing
- editing `/home/nvidia/nemoclaw-dashboard` directly as the normal development path
- patching runtime helper scripts ad hoc without backporting and documenting

## 8.5 Ownership multiplication
- separate long-lived service for terminal server without deliberate architecture decision
- parallel dashboard launchers fighting over `:3000`
- supervisor plus manual shell process both trying to own the same port

## 8.6 Logic cloning
- duplicating instance resolution logic in route handlers
- duplicating dashboard session semantics in UI pages and API routes independently
- separate, inconsistent normalization of sandbox phase names

## 8.7 Lying fallbacks
- fallback used but not logged
- degraded state shown as normal
- unknown owner reported as healthy

---

## 9. Change protocol for contributors and agents

## 9.1 Before changing anything, classify the change
Every contributor must first state which doctrine area is affected:

- source of truth
- route ownership
- runtime ownership
- deploy/release
- fallback/degraded behavior
- logging/provenance
- tests/acceptance

If the change crosses more than one, say so up front.

## 9.2 For any authority-affecting change, write the invariant first
Before editing code, write the invariant in one sentence.

Examples:

- “dashboard WebSocket clients must only reach terminal sessions through `server.mjs` proxy ownership”
- “requested sandbox identity must be preserved in logs even when remapped”
- “service-owned runtime on `:3000` must not be replaceable by stray workspace dev server without detection”

If you cannot state the invariant, you are not ready to edit.

## 9.3 Touch the owner, not a symptom surface
Fix problems in the owning layer.

Examples:

- instance-selection bug → fix `app/lib/openclawInstances.ts`, not several callers
- terminal bridge bug → fix `server.mjs` or `terminal-server.mjs`, not UI hacks pretending the bridge is fine
- runtime drift → fix deploy/supervisor/service ownership, not status wording alone

## 9.4 Any new fallback requires four things
If you add a fallback path, you must also add:

1. explicit trigger condition
2. explicit log field/message
3. explicit degraded/defaulted outward state where relevant
4. test coverage proving fallback honesty

No silent convenience fallbacks.

## 9.5 Any new route must declare ownership and authority inputs
For every new route or socket path, document:

- owner file
- inputs that affect target resolution
- canonical backend authority it depends on
- fallback behavior
- logging fields
- acceptance checks

## 9.6 Any runtime/deploy change must verify ownership before and after
Before changing service/deploy/runtime scripts:

- capture current owner of `:3000` and `:3011`
- capture current service state

After change:

- recapture owner of `:3000` and `:3011`
- verify expected service and path ownership
- verify HTTP plus ownership, not HTTP alone

## 9.7 If architecture changes, update this document in the same work packet
This BIBLE is part of the codebase contract.

If you change:

- who owns ports
- how terminal transport is exposed
- what the canonical code/live lanes are
- what module owns instance resolution
- whether `server.mjs` remains the sole bridge owner

then update this file in the same change.

Code and doctrine must ship together.

---

## 10. Operational truth checklist

Use this checklist before saying “NemoClaw web service is healthy.”

- [ ] code change originated from `projects/nemoclaw-dashboard`
- [ ] live tree sync target is known
- [ ] `nemoclaw-dashboard.service` state is known
- [ ] `:3000` listener exists and owner PID/path is correct
- [ ] `:3011` listener exists and owner PID/path is correct
- [ ] terminal `/healthz` passes
- [ ] dashboard root responds
- [ ] terminal bridge path works through the dashboard owner
- [ ] any fallback/degraded mode is explicitly visible
- [ ] logs show requested and resolved target identity where applicable

If any box is unchecked, the correct status is not healthy. It is partial, degraded, unknown, or failed.

---

## 11. Non-negotiable service invariants

These are the core invariants future work must preserve unless deliberately replaced.

1. **One editable code authority**: `projects/nemoclaw-dashboard`
2. **One live runtime authority**: `/home/nvidia/nemoclaw-dashboard` under `nemoclaw-dashboard.service`
3. **One owner for terminal exposure**: dashboard bridge in `server.mjs`
4. **One owner for terminal session lifecycle**: `terminal-server.mjs`
5. **One owner for instance registry logic**: `app/lib/openclawInstances.ts`
6. **One owner for dashboard session identity logic**: `app/lib/dashboardSession.ts`
7. **HTTP success alone never proves runtime truth**
8. **Fallbacks must announce themselves**
9. **Port ownership outranks appearance**
10. **Doctrine must be updated when architecture changes**

If a proposed change violates one of these, stop and redesign instead of papering over it.
