# Per-Sandbox Access Control via MCPAuth

Allows enterprise users to authenticate via the internal IDP (MCPAuth) and access
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
    └── CF_Authorization JWT cookie (from MCPAuth) → read-only, own sandboxes only
```

The key insight: MCPAuth sets a `CF_Authorization` JWT cookie scoped to
`.ag-*.nemoclaw.dpdns.org`. Once a user logs into the IDP at
`idp.ag-*.nemoclaw.dpdns.org`, that cookie is automatically sent to the
openshell controller on the same domain. The controller validates the JWT
locally (no network call to MCPAuth) and gates per-sandbox access.

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
# MCPAuth IDP Configuration for Enterprise Sandbox Access
MCPAUTH_JWT_SECRET=my-secret-key          # must match MCPAuth server/session.go jwtSecret
SANDBOX_ACCESS_USERS=sandbox-name:user@example.com,other-sandbox:other@example.com
MCPAUTH_LOGIN_URL=https://idp.ag-*.nemoclaw.dpdns.org/internal/login
MCPAUTH_CLIENT_ID=<oauth-client-id>
MCPAUTH_CLIENT_SECRET=<oauth-client-secret>
MCPAUTH_CALLBACK_URL=https://openshell-controller.ag-*.nemoclaw.dpdns.org/api/auth/callback
```

`SANDBOX_ACCESS_USERS` is a comma-separated list of `sandboxName:email` pairs.
Use the sandbox **name** (not the UUID) — e.g. `my-first-claw:alice@company.com`.
The name is what appears in the dashboard URL and the instance ID format `sandbox-{port}-{name}`.
A sandbox can have at most one assigned user. Operator (password login) bypasses
this check and sees all sandboxes.

### 3. `middleware.ts` — CF_Authorization validation

Added to the existing Next.js middleware:

- Reads `CF_Authorization` cookie on every request
- Validates the JWT signature (HS256, `MCPAUTH_JWT_SECRET`)
- Extracts `email` claim
- If valid email found:
  - GET `/api/sandbox/create` → allowed (template list is read-only)
  - POST `/api/sandbox/create`, POST `/api/sandbox/delete` → 403 (operator only)
  - Any `/api/sandbox/[sandboxId]/...` or `/api/telemetry/sandbox/[sandboxId]/...` → allowed only if `isUserAuthorizedForSandbox(email, sandboxId)` returns true
  - Sets `x-forwarded-user` header for downstream handlers

### 4. `app/lib/controlAuth.ts` — New helper functions

**`verifyCFAuthorizationJWT(token)`** — validates HMAC HS256 JWT, returns `{ email, sub, exp }` or null.

**`isUserAuthorizedForSandbox(email, sandboxId)`** — parses `SANDBOX_ACCESS_USERS` env var and returns true if the email is assigned to that sandbox. Sandbox matching is by sandbox name (not ID — the sandbox ID from the URL is used as the sandbox name in this context).

## User Flows

### Enterprise user (Alice)
1. Alice navigates to `https://idp.ag-*.nemoclaw.dpdns.org`
2. Logs in with email/password via the internal IDP
3. MCPAuth sets `CF_Authorization` JWT cookie (24h TTL, domain `.ag-*.nemoclaw.dpdns.org`)
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

Edit `.env.local` on the server and add the sandbox **name** and email to `SANDBOX_ACCESS_USERS`.
The sandbox name is the short identifier (e.g. `my-first-claw`), not the UUID.
Find it with `openshell sandbox list` or from the sandbox URL in the dashboard.

```env
SANDBOX_ACCESS_USERS=alice-sandbox:alice@company.com,bob-sandbox:bob@company.com
```

Restart the controller for the change to take effect:
```bash
# On the VPS
cd /opt/openshell-controller && pm2 restart all  # or however it's run
```

To create a user in MCPAuth's internal IDP, use the Pangolin admin panel at
`https://pangolin.ag-*.nemoclaw.dpdns.org` or the MCPAuth internal API.

## MCPAuth JWT Secret

The JWT is signed with HMAC HS256 using the `jwtSecret` variable in
`mcpauth/server/session.go` (currently hardcoded as `"my-secret-key"`).

`MCPAUTH_JWT_SECRET` in `.env.local` must match this value. If MCPAuth is ever
updated to read the key from an env var, update `.env.local` accordingly.

**Security note:** The hardcoded `my-secret-key` in MCPAuth is a known value.
For production, update `mcpauth/server/session.go` to read the JWT secret from
an env var (`JWT_SECRET`) and set a strong random value in both MCPAuth and
`MCPAUTH_JWT_SECRET`.

## Future Enhancements

- **Dynamic sandbox assignment**: Add an "Assign to user" field in the sandbox
  creation wizard (WizardPanel.tsx) that writes to a JSON config file instead of
  requiring manual `.env.local` edits.

- **User creation in controller**: Add an operator-only UI to create/invite MCPAuth
  users without needing to use the Pangolin admin panel.

- **Stronger JWT secret**: Move MCPAuth's `jwtSecret` to an env var and generate
  a cryptographically random value on first run.

- **Per-sandbox URL**: If direct per-sandbox links are needed (e.g., to email
  Alice a link directly to her sandbox), add a `/sandbox/[sandboxId]` route that
  skips the full dashboard and proxies directly to the OpenClaw dashboard for that
  sandbox. This requires the browser-redirect flow in MCPAuth (a new
  `/auth/browser` endpoint that redirects to login instead of returning 401).
