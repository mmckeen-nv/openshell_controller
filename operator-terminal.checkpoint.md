# DML Checkpoint — 2026-04-06 — operator-terminal

- milestone: truthful first-render / readiness / recovery UX
- status: shipped bounded UI slice without PTY embedding
- sandbox target: `my-assistant`

## Delta
- Added `/operator-terminal` page.
- Dashboard CTA now routes to `/operator-terminal?sandboxId=...`.
- Page fetches `/api/openshell/terminal/introspect` and shows:
  - explicit non-embedded status
  - readiness state
  - exact SSH attach commands
  - retry + copy actions
  - live introspection evidence + recovery notes

## Validation
- `npm install` succeeded.
- `eslint app/operator-terminal/page.tsx app/components/SandboxList.tsx` passed.
- Full `tsc --noEmit` still fails on pre-existing unrelated type errors outside this slice.
- Linux-side direct `ssh openshell-my-assistant` validation blocked because alias is Mac-local here.

## Additional progress
- Hardened `/api/openshell/terminal/readiness` so a missing sandbox pod returns a truthful non-degraded readiness contract instead of collapsing into a generic 500.
- Shell probing now skips absent pods and reports an explicit not-found note for `my-assistant`-style operator checks.
- Added a bounded dashboard command runner: `/api/openshell/terminal` now accepts POST for one-shot sandbox commands with input validation, timeout/length limits, and real stdout/stderr/exit-code reporting.
- Updated `/operator-terminal` to consume the readiness contract, surface probe evidence, show resolved attach commands, and expose the bounded one-shot command runner while explicitly keeping PTY embedding marked as not-yet-live.

## Validation
- `npm run lint -- app/operator-terminal/page.tsx app/api/openshell/terminal/route.ts app/api/openshell/terminal/readiness/route.ts app/lib/openshellHost.ts` passed.
- Full live shell/SSH validation against the Mac/OpenShell runtime is still pending from a host that can actually reach the alias/path.

## Next milestone
- Validate the readiness + bounded-command contract against the live Mac/OpenShell path for `my-assistant`, then layer in streamed attach transport only after the route truth matches real runtime states.
