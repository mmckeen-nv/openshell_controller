import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

// Regression guard for scripts/setup/openshell-controller.service +
// scripts/setup/install-production.sh.
//
// These files codify the host-side setup that install.sh deliberately skips
// (install.sh is a dev installer). Several of the assertions below correspond
// to specific incidents observed on the test VPS on 2026-06-21:
//
//   - Missing HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS in the systemd
//     unit caused `ssh-via-openshell-gateway` to fail silently, leaving
//     every dashboard probe at reachable: false.
//   - Missing /root/.local/state/nemoclaw/openshell-docker-gateway/ caused
//     the gateway to crash-loop with "unable to open database file".
//   - Missing UFW rule on port 8080 caused sandbox containers to fail
//     policy fetch and enter Error state at boot.
//   - Missing needrestart drop-in caused the controller to be hammered into
//     a failed state by libssl unattended upgrades (see CLAUDE.md §10).

const root = process.cwd()
const setupDir = path.join(root, 'scripts/setup')
const unitPath = path.join(setupDir, 'openshell-controller.service')
const scriptPath = path.join(setupDir, 'install-production.sh')

await stat(unitPath)
await stat(scriptPath)

const unit = await readFile(unitPath, 'utf8')
const script = await readFile(scriptPath, 'utf8')

// ── 1. Unit declares the three load-bearing env vars ──

for (const envVar of ['HOME=/root', 'XDG_RUNTIME_DIR=/run/user/0', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus']) {
  assert.ok(
    unit.includes(`Environment=${envVar}`),
    `openshell-controller.service must declare Environment=${envVar}. ` +
    `Without this env var, the openshell ssh-proxy ProxyCommand can't talk to the user-level ` +
    `openshell-gateway and every dashboard probe returns reachable: false.`,
  )
}

// ── 2. Unit declares LimitNOFILE so long-running FD count doesn't pile up ──

assert.ok(
  /^LimitNOFILE=\d{4,}$/m.test(unit),
  'openshell-controller.service must set LimitNOFILE to a 4+ digit value. The default of 1024 is ' +
  'exhausted after a few weeks of WS upstream connections + child ssh forwards + lsof probes.',
)

// ── 3. install-production.sh installs the unit, daemon-reloads, starts service ──

for (const fragment of ['/etc/systemd/system/openshell-controller.service', 'systemctl daemon-reload', 'systemctl enable openshell-controller', 'systemctl start openshell-controller', 'systemctl restart openshell-controller']) {
  assert.ok(
    script.includes(fragment),
    `install-production.sh must contain '${fragment}'. Without this the unit either isn't installed, ` +
    `not picked up by systemd, or never started.`,
  )
}

// ── 4. install-production.sh creates the gateway DB parent dir ──

assert.ok(
  /mkdir -p.*openshell-docker-gateway|dirname.*DB_PATH/.test(script),
  'install-production.sh must create the openshell-gateway DB parent directory. After a purge, ' +
  '/root/.local/state/nemoclaw/openshell-docker-gateway/ is missing and the gateway crash-loops ' +
  'with "unable to open database file".',
)

// ── 5. install-production.sh adds the UFW allow for openshell-docker bridge ──

assert.ok(
  /\bUFW\b.*allow from 172\.0\.0\.0\/8|ufw allow from 172\.0\.0\.0\/8/.test(script),
  'install-production.sh must add a UFW allow from 172.0.0.0/8 to the gateway port. Without it, ' +
  'sandbox containers on the openshell-docker bridge (172.19.0.0/16) can\'t reach the gateway, ' +
  'and the sandbox supervisor enters Error state at boot.',
)

// ── 6. install-production.sh installs the needrestart guard ──

assert.ok(
  /needrestart\/conf\.d\/openshell-controller\.conf/.test(script) &&
  /override_rc.*openshell-controller/.test(script),
  'install-production.sh must install /etc/needrestart/conf.d/openshell-controller.conf with the ' +
  'override_rc directive. Without it, unattended-upgrades cycles the controller multiple times ' +
  'on a single libssl upgrade and trips StartLimitBurst (see CLAUDE.md §10 incident 2026-06-11).',
)

// ── 7. install-production.sh enables systemd linger for root ──

assert.ok(
  /loginctl enable-linger root/.test(script),
  'install-production.sh must call loginctl enable-linger root. The user-level openshell-gateway ' +
  'lives under root\'s user manager (/run/user/0/) and is torn down when the SSH session ends ' +
  'unless linger is enabled.',
)

// ── 8. install-production.sh idempotency ──

assert.ok(
  /already up-to-date|already present|already exists|already enabled|already running/.test(script),
  'install-production.sh must short-circuit idempotently. The file is meant to be safe to re-run ' +
  'after every deploy; if it isn\'t, it gets skipped and the host drifts.',
)

console.log('PASS: openshell-controller.service declares HOME/XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS')
console.log('PASS: openshell-controller.service sets LimitNOFILE')
console.log('PASS: install-production.sh installs the unit, daemon-reloads, enables + starts the service')
console.log('PASS: install-production.sh creates the gateway DB parent directory')
console.log('PASS: install-production.sh adds the UFW allow for the openshell-docker bridge')
console.log('PASS: install-production.sh installs the needrestart drop-in guard')
console.log('PASS: install-production.sh enables systemd linger for root')
console.log('PASS: install-production.sh is idempotent on re-run')
