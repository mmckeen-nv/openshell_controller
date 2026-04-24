import { NextResponse } from 'next/server'
import { inspectSandbox, isOpenShellTransportError } from '@/app/lib/openshellHost'
import { resolveRuntimeAuthority } from '@/app/lib/runtimeAuthority'

function normalizeSandboxId(value: string | null) {
  return (value || '').trim()
}

function buildAttach(alias: string, sandboxId: string) {
  const loginShell = process.platform === 'darwin' ? 'zsh' : 'bash'
  const extraPath = process.platform === 'darwin' ? '/opt/homebrew/bin' : `${process.env.HOME || '~'}/.local/bin`

  return {
    alias,
    aliasCommand: `ssh ${alias}`,
    fallbackCommand: `ssh ${alias}`,
    loginShellCommand: `env PATH=${extraPath}:$PATH ${loginShell} -l -c 'ssh ${alias}'`,
    shellHint: process.platform === 'darwin'
      ? 'If your non-interactive shell misses Homebrew tooling, retry from a login shell or prepend PATH=/opt/homebrew/bin:$PATH before ssh.'
      : 'If your non-interactive shell misses local tooling, retry from a login shell or prepend PATH=$HOME/.local/bin:$PATH before ssh.',
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  let sandboxId = 'unknown'

  try {
    sandboxId = normalizeSandboxId(url.searchParams.get('sandboxId'))

    if (!sandboxId) {
      const authority = resolveRuntimeAuthority({ sandboxId: null })
      return NextResponse.json({
        ok: true,
        sandboxId: 'host',
        authority: {
          requestedSandboxId: authority.requestedSandboxId,
          resolvedSandboxId: authority.resolvedSandboxId,
          sandboxAuthority: authority.sandboxAuthority,
          requestedInstanceId: authority.requestedInstanceId,
          instanceId: authority.openclaw.id,
          sandboxInstanceId: authority.mappedSandboxInstanceId,
          explicitInstanceOverride: authority.explicitInstanceOverride,
          usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
          terminalFallback: true,
        },
        podExists: false,
        podReady: true,
        sshReachable: true,
        degraded: true,
        attach: null,
        pod: {
          phase: 'Host',
          readyCondition: 'Host',
          containers: [],
          images: [],
          runningStatuses: [],
        },
        shellProbe: {
          ok: true,
          output: 'Host terminal mode active. No sandbox selected.',
          stderr: '',
        },
        note: 'Host operator terminal is ready. Sandbox context is optional.',
      })
    }

    const sandbox = await inspectSandbox(sandboxId)
    const authority = resolveRuntimeAuthority({
      sandboxId,
      resolvedSandboxId: sandbox.name,
    })
    const podReady = sandbox.phase === 'Running'
    const sshReachable = sandbox.phase === 'Running'

    return NextResponse.json({
      ok: true,
      sandboxId: sandbox.name,
      authority: {
        requestedSandboxId: authority.requestedSandboxId,
        resolvedSandboxId: authority.resolvedSandboxId,
        sandboxAuthority: authority.sandboxAuthority,
        requestedInstanceId: authority.requestedInstanceId,
        instanceId: authority.openclaw.id,
        sandboxInstanceId: authority.mappedSandboxInstanceId,
        explicitInstanceOverride: authority.explicitInstanceOverride,
        usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
        terminalFallback: false,
      },
      podExists: true,
      podReady,
      sshReachable,
      degraded: !sshReachable,
      attach: buildAttach(sandbox.sshHostAlias, sandbox.name),
      pod: {
        phase: sandbox.phase,
        readyCondition: podReady ? 'True' : sandbox.rawPhase || 'Unknown',
        containers: [],
        images: [],
        runningStatuses: [],
      },
      shellProbe: {
        ok: sshReachable,
        output: sandbox.rawDetails,
        stderr: '',
      },
      note: sshReachable
        ? 'Sandbox inspection succeeded and the normalized phase is Running.'
        : `Sandbox inspection succeeded, but authoritative phase is ${sandbox.rawPhase || 'Unknown'} (normalized ${sandbox.phase || 'Unknown'}).`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to inspect terminal readiness.'
    const transportError = isOpenShellTransportError(error)
    const authority = resolveRuntimeAuthority({ sandboxId })
    return NextResponse.json({
      ok: true,
      sandboxId: sandboxId || 'host',
      authority: {
        requestedSandboxId: authority.requestedSandboxId,
        resolvedSandboxId: authority.resolvedSandboxId,
        sandboxAuthority: authority.sandboxAuthority,
        requestedInstanceId: authority.requestedInstanceId,
        instanceId: authority.openclaw.id,
        sandboxInstanceId: authority.mappedSandboxInstanceId,
        explicitInstanceOverride: authority.explicitInstanceOverride,
        usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
        terminalFallback: true,
      },
      podExists: false,
      podReady: true,
      sshReachable: true,
      degraded: true,
      error: message,
      attach: null,
      pod: {
        phase: 'Host',
        readyCondition: 'Host',
        containers: [],
        images: [],
        runningStatuses: [],
      },
      shellProbe: {
        ok: true,
        output: 'Host terminal mode active. Sandbox inspection failed, but host shell remains available.',
        stderr: message,
      },
      note: transportError ? 'OpenShell transport is unavailable for sandbox inspection; host operator terminal remains available.' : 'Sandbox inspection failed; host operator terminal remains available.',
    }, { status: 200 })
  }
}
