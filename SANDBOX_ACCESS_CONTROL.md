# Per-Sandbox Access Control via OAuth/IDP

Allows enterprise users to authenticate via the internal IDP (OAuth/IDP) and access
only the sandboxes assigned to them, without needing the operator password.

## Architecture

```
User browser
    │
    ▼
openshell-controller.ag-*.nemoclaw.dpdns.org  (Traefik, no badger@http)
    │
    ▼
Next.js middleware.ts
    ├── Operator session cookie → full access (all sandboxes, can create/delete)
    └── `oauth_session` JWT cookie → read-only, own sandboxes only
```

The key insight: OAuth/IDP sets a `oauth_session` JWT cookie scoped to
`.ag-*.nemoclaw.dpdns.org`. Once a user logs into the IDP at
`idp.ag-*.nemoclaw.dpdns.org`, that cookie is automatically sent to the
openshell controller on the same domain. The controller validates the JWT
locally (no network call to OAuth/IDP) and gates per-sandbox access.

## What Was Changed

### 1. Traefik on VPS (`/etc/komodo/stacks/support-799109_setup-stack/config/traefik/rules/resource-overrides.yml`)

Removed `badger@http` from the openshell controller router so Pangolin no longer
gates the controller. The controller handles all auth itself.

**Before:**
```yaml
8-openshell-controller-router-auth:
    middlewares:
        - badger@http
    rule: "Host(`openshell-controller.ag-*.nemoclaw.dpdns.org`)"
    service: "8-openshell-controller-service@http"
```

**After:**
```yaml
8-openshell-controller-router-auth:
    rule: "Host(`openshell-controller.ag-*.nemoclaw.dpdns.org`)"
    service: "8-openshell-controller-service@http"
```

### 2. `.env.local` — New env vars

```env
# OAuth IDP Configuration for Enterprise Sandbox Access
OAUTH_JWT_SECRET=my-secret-key                              # must match the IDP's JWT signing secret
SANDBOX_ACCESS_USERS=sandbox-name:user@example.com,other-sandbox:other@example.com
OAUTH_LOGIN_URL=https://idp.ag-*.nemoclaw.dpdns.org/internal/login
OAUTH_CLIENT_ID=<oauth-client-id>
OAUTH_CLIENT_SECRET=<oauth-client-secret>
OAUTH_CALLBACK_URL=https://openshell-controller.ag-*.nemoclaw.dpdns.org/api/auth/callback
```

> The historical `MCPAUTH_*` and `CF_AUTH_JWT_SECRET` env var names are still
> read as fallbacks; existing deployments don't need to rename anything to
> upgrade. Note that `SANDBOX_ACCESS_USERS` is now optional — the access
> list is preferentially read from `data/sandbox-access.json`, edited via
> the Security page.

`SANDBOX_ACCESS_USERS` is a comma-separated list of `sandboxName:email` pairs.
Use the sandbox **name** (not the UUID) — e.g. `my-first-claw:alice@company.com`.
The name is what appears in the dashboard URL and the instance ID format `sandbox-{port}-{name}`.
A sandbox can have at most one assigned user. Operator (password login) bypasses
this check and sees all sandboxes.

### 3. `middleware.ts` — oauth_session validation

Added to the existing Next.js middleware:

- Reads `oauth_session` cookie on every request (falls back to the legacy
  `CF_Authorization` cookie name for sessions issued by an older controller)
- Validates the JWT signature (HS256, `OAUTH_JWT_SECRET`)
- Extracts `email` claim
- If valid email found:
  - GET `/api/sandbox/create` → allowed (template list is read-only)
  - POST `/api/sandbox/create`, POST `/api/sandbox/delete` → 403 (operator only)
  - Any `/api/sandbox/[sandboxId]/...` or `/api/telemetry/sandbox/[sandboxId]/...` → allowed only if `isUserAuthorizedForSandbox(email, sandboxId)` returns true
  - Sets `x-forwarded-user` header for downstream handlers

### 4. `app/lib/auth/` — Shared auth library

**`verifyOAuthJWT(token, secret)`** (in `edge.ts` / `node.mjs`) — validates HMAC
HS256 JWT, returns `{ email, sub, exp, … }` or null.

**`isUserAuthorizedForSandbox(email, sandboxId)`** (in `controlAuth.ts`) —
consults the file-backed `SandboxAccessStore` and returns true if the email is
assigned to that sandbox. Sandbox matching is by sandbox name (not ID — the
sandbox ID from the URL is used as the sandbox name in this context).

The store is `data/sandbox-access.json`; the legacy `SANDBOX_ACCESS_USERS` CSV
env var is read as a fallback if the file is absent.

## User Flows

### Enterprise user (Alice)
1. Alice navigates to `https://idp.ag-*.nemoclaw.dpdns.org`
2. Logs in with email/password via the internal IDP
3. OAuth/IDP sets `oauth_session` JWT cookie (24h TTL, domain `.ag-*.nemoclaw.dpdns.org`)
4. Alice navigates to `https://openshell-controller.ag-*.nemoclaw.dpdns.org`
5. Controller middleware validates cookie → extracts `alice@company.com`
6. Only sandboxes assigned to `alice@company.com` in `SANDBOX_ACCESS_USERS` are visible/accessible
7. Create/delete operations return 403

### Operator
1. Navigates to `https://openshell-controller.ag-*.nemoclaw.dpdns.org`
2. Logs in with `OPENSHELL_CONTROL_PASSWORD` at `/login`
3. Gets `openshell_control_session` cookie
4. Full access — all sandboxes, create/delete enabled
5. Unaffected by `SANDBOX_ACCESS_USERS`

## Assigning a Sandbox to a User

Use the Security page (operator login required) at
`https://openshell-controller.ag-*.nemoclaw.dpdns.org/setup-account` to add
or remove rows. Changes are persisted to `data/sandbox-access.json` and
take effect immediately — no controller restart needed.

The sandbox name is the short identifier (e.g. `my-first-claw`), not the UUID.
Find it with `openshell sandbox list` or from the sandbox URL in the dashboard.

For headless / first-run setup the legacy `SANDBOX_ACCESS_USERS` CSV env var
in `.env.local` is still read as a fallback when the JSON file is absent:

```env
SANDBOX_ACCESS_USERS=alice-sandbox:alice@company.com,bob-sandbox:bob@company.com
```

To create a user in the IDP, use the IDP's own admin surface (e.g. the
Pangolin admin panel at `https://pangolin.ag-*.nemoclaw.dpdns.org`).

## JWT Secret

The OAuth `oauth_session` cookie is signed with HMAC HS256 using a shared
secret that must match the IDP's signing secret. The controller reads it
from `OAUTH_JWT_SECRET`, falling back to `MCPAUTH_JWT_SECRET` /
`CF_AUTH_JWT_SECRET` for backwards compatibility.

If the IDP defaults to a hardcoded development secret (e.g. `"my-secret-key"`),
override it for production and keep `OAUTH_JWT_SECRET` in sync.

## Future Enhancements

- **Dynamic sandbox assignment**: Add an "Assign to user" field in the sandbox
  creation wizard (WizardPanel.tsx) that writes to a JSON config file instead of
  requiring manual `.env.local` edits.

- **User creation in controller**: Add an operator-only UI to create/invite OAuth/IDP
  users without needing to use the Pangolin admin panel.

- **Stronger JWT secret**: Move OAuth/IDP's `jwtSecret` to an env var and generate
  a cryptographically random value on first run.

- **Per-sandbox URL**: If direct per-sandbox links are needed (e.g., to email
  Alice a link directly to her sandbox), add a `/sandbox/[sandboxId]` route that
  skips the full dashboard and proxies directly to the OpenClaw dashboard for that
  sandbox. This requires the browser-redirect flow in OAuth/IDP (a new
  `/auth/browser` endpoint that redirects to login instead of returning 401).
