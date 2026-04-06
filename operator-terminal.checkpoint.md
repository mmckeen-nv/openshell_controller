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

## Next milestone
- Add a backend operator-readiness contract that can distinguish pod existence, SSH reachability, and dashboard degradation, then optionally layer in streamed attach transport afterward.
