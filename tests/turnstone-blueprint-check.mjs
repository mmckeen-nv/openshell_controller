#!/usr/bin/env node
// Sanity checks for the Turnstone agent integration: identity normalization,
// create-route blueprint coverage, dashboard-port routing, and the new SVG asset.
// Mirrors the structure of the existing identity/lifecycle checks so a failure
// is easy to read next to the others.
//
// Run via:
//   node tests/turnstone-blueprint-check.mjs
//
// Exits 0 on success, non-zero on first failure.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const identityLibPath = path.join(repoRoot, 'app/lib/nemoclawIdentity.mjs');
const createRoutePath = path.join(repoRoot, 'app/api/sandbox/create/route.ts');
const sandboxListPath = path.join(repoRoot, 'app/components/SandboxList.tsx');
const configPanelPath = path.join(repoRoot, 'app/components/ConfigurationPanel.tsx');
const dashboardOpenRoutePath = path.join(repoRoot, 'app/api/openshell/dashboard/open/route.ts');
const hostPath = path.join(repoRoot, 'app/lib/openshellHost.ts');
const dashboardSessionPath = path.join(repoRoot, 'app/lib/dashboardSession.ts');
const operatorTerminalPath = path.join(repoRoot, 'app/operator-terminal/page.tsx');
const logoPath = path.join(repoRoot, 'public/sandbox-logos/turnstone.svg');

function readOrFail(p) {
  assert.ok(existsSync(p), `expected file to exist: ${p}`);
  return readFileSync(p, 'utf8');
}

const identityLib = readOrFail(identityLibPath);
const createRoute = readOrFail(createRoutePath);
const sandboxList = readOrFail(sandboxListPath);
const configPanel = readOrFail(configPanelPath);
const dashboardOpenRoute = readOrFail(dashboardOpenRoutePath);
const hostSource = readOrFail(hostPath);
const dashboardSession = readOrFail(dashboardSessionPath);
const operatorTerminal = readOrFail(operatorTerminalPath);

assert.match(
  identityLib,
  /compact === 'turnstone' \|\| compact === 'turnstonesandbox'[\s\S]*return 'turnstone'/,
  'nemoclawIdentity must recognize turnstone / turnstonesandbox as the turnstone agent'
);
assert.match(
  identityLib,
  /compact\.includes\('turnstone'\)[\s\S]*return 'turnstone'/,
  'nemoclawIdentity must include() the substring "turnstone" before falling through to the canonicalizer'
);

assert.match(
  createRoute,
  /type NemoClawAgent = "openclaw" \| "hermes" \| "turnstone" \| "langchain-deepagents-code"/,
  'create route NemoClawAgent type must include "turnstone"'
);
assert.match(
  createRoute,
  /blueprint === "nemoclaw-turnstone"\) return "turnstone"/,
  'create route must map the nemoclaw-turnstone blueprint to the turnstone agent'
);
assert.match(
  createRoute,
  /nemoclaw-blueprint" \|\| blueprint === "nemoclaw-hermes" \|\| blueprint === "nemoclaw-turnstone"/,
  'create route must list nemoclaw-turnstone as an onboard blueprint'
);
assert.match(
  createRoute,
  /id: "nemoclaw-turnstone"[\s\S]*?"Fresh Turnstone Sandbox"/,
  'GET /api/sandbox/create must advertise a nemoclaw-turnstone blueprint descriptor'
);

assert.match(
  sandboxList,
  /TURNSTONE_SANDBOX_LOGO = '\/sandbox-logos\/turnstone\.svg'/,
  'sandbox list must register the turnstone logo path'
);
assert.match(
  sandboxList,
  /if \(normalized === 'turnstone'\) return 'Turnstone'/,
  'sandbox list displaySandboxAgent must label turnstone as "Turnstone"'
);
assert.match(
  sandboxList,
  /const isTurnstone = normalized === 'turnstone'/,
  'sandbox list must compute an isTurnstone branch for tile rendering'
);
assert.match(
  sandboxList,
  /border-emerald-300\/60 bg-emerald-500\/15/,
  'sandbox list must apply the dedicated turnstone tile color treatment'
);
assert.match(
  sandboxList,
  /Open Turnstone Terminal/,
  'sandbox list must surface the per-sandbox Open Turnstone Terminal action button'
);
assert.match(
  sandboxList,
  /connectToTurnstone/,
  'sandbox list must define a connectToTurnstone helper that routes through the operator terminal'
);
assert.match(
  sandboxList,
  /searchParams\.set\('agent', 'turnstone'\)[\s\S]*?searchParams\.set\('dashboardPort', '8080'\)/,
  'sandbox list dashboard launch must pass agent=turnstone and dashboardPort=8080'
);

assert.match(
  configPanel,
  /selectedBlueprint === 'nemoclaw-blueprint' \|\| selectedBlueprint === 'nemoclaw-hermes' \|\| selectedBlueprint === 'nemoclaw-turnstone' \|\| selectedBlueprint === 'nemoclaw-deepagents-code'/,
  'configuration panel must include nemoclaw-turnstone in the onboard branch'
);
assert.match(
  configPanel,
  /selectedBlueprint === 'nemoclaw-turnstone' \? 'my-turnstone'/,
  'configuration panel must surface a my-turnstone placeholder for the turnstone blueprint'
);

assert.match(
  dashboardOpenRoute,
  /const requestedDashboardPort = requestUrl\.searchParams\.get\('dashboardPort'\)/,
  'dashboard open route must read dashboardPort from the query string'
);
assert.match(
  dashboardOpenRoute,
  /probeOpenClawDashboard\(authority\.openclaw\.id, \{ dashboardPort: requestedDashboardPort \}\)/,
  'dashboard open route must forward the dashboardPort override into the probe call'
);
assert.match(
  dashboardOpenRoute,
  /dashboardUrl: effectiveDashboardUrl/,
  'dashboard open route JSON response must use the effective dashboard URL that honors the override'
);

assert.match(
  hostSource,
  /probeOpenClawDashboard\(instanceId[\s\S]*?options: \{ dashboardPort\?: number \| string \| null \} = \{\}\)/,
  'openshellHost probeOpenClawDashboard must accept an optional dashboardPort option'
);
assert.match(
  hostSource,
  /overridden\.port[\s\n]*=[\s\n]*String\(dashboardPortOverride\)/,
  'openshellHost probeOpenClawDashboard must use the dashboardPort override when constructing the target URL'
);

assert.match(
  dashboardSession,
  /launch\?: 'hermes' \| 'turnstone' \| null/,
  'dashboardSession launch parameter must accept "turnstone" alongside "hermes"'
);

assert.match(
  operatorTerminal,
  /shouldLaunchTurnstone = launchMode === 'turnstone' && Boolean\(sandboxId\)/,
  'operator-terminal page must compute shouldLaunchTurnstone from launchMode === "turnstone"'
);
assert.match(
  operatorTerminal,
  /buildTurnstoneTerminalConnectCommand\(sandboxId\)/,
  'operator-terminal page must call the Turnstone-specific terminal connect command'
);
assert.match(
  operatorTerminal,
  /TURNSTONE_AGENT_COMMAND/,
  'operator-terminal page must export a TURNSTONE_AGENT_COMMAND constant for after-attach CLI launch'
);

assert.ok(existsSync(logoPath), 'public/sandbox-logos/turnstone.svg must exist');
const logo = readFileSync(logoPath, 'utf8');
assert.match(logo, /<svg[^>]*viewBox="0 0 64 64"/, 'turnstone logo must be a 64x64 viewBox SVG');
assert.match(logo, /aria-label="Turnstone"/, 'turnstone logo must declare an aria-label');

console.log('turnstone-blueprint-check: all turnstone integration assertions passed');
