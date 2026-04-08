import { NextResponse } from 'next/server'
import { dockerExecInOpenShell, OPENSHELL_NAMESPACE, probeSandboxShell, validateSandboxId } from '../../../../lib/openshellHost'

interface PodSummary {
  containers: string[]
  images: string[]
  runningStatuses: string[]
  phase?: string
  readyCondition?: string
}

const EMPTY_POD_SUMMARY: PodSummary = {
  containers: [],
  images: [],
  runningStatuses: [],
}

async function inspectPod(sandboxId: string): Promise<PodSummary> {
  const result = await dockerExecInOpenShell(
    `kubectl -n ${OPENSHELL_NAMESPACE} get pod ${sandboxId} -o json`
  )

  if (result.exitCode !== 0) {
    const failureText = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (failureText.includes('(notfound)') || failureText.includes('not found')) {
      return EMPTY_POD_SUMMARY
    }
    throw new Error(result.stderr.trim() || result.stdout.trim() || `kubectl get pod failed with exit code ${result.exitCode}`)
  }

  if (!result.stdout.trim()) {
    throw new Error('kubectl get pod returned empty stdout')
  }

  const pod = JSON.parse(result.stdout)
  return {
    containers: Array.isArray(pod?.spec?.containers) ? pod.spec.containers.map((c: any) => c.name) : [],
    images: Array.isArray(pod?.spec?.containers) ? pod.spec.containers.map((c: any) => c.image) : [],
    runningStatuses: Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses.map((c: any) => c.name) : [],
    phase: pod?.status?.phase,
    readyCondition: Array.isArray(pod?.status?.conditions)
      ? pod.status.conditions.find((c: any) => c.type === 'Ready')?.status
      : undefined,
  }
}

function buildAttachContract(sandboxId: string) {
  const alias = `openshell-${sandboxId}`
  return {
    alias,
    aliasCommand: `ssh ${alias}`,
    fallbackCommand: `ssh -i ~/.ssh/id_ed25519_openclaw_labmac ${alias}`,
    loginShellCommand: `env PATH=/opt/homebrew/bin:$PATH zsh -l -c 'ssh ${alias}'`,
    shellHint: 'If a non-interactive shell misses Homebrew tooling, retry from a login shell or prepend PATH=/opt/homebrew/bin:$PATH before ssh.',
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sandboxId = validateSandboxId(searchParams.get('sandboxId') || '')

    const attach = buildAttachContract(sandboxId)
    const pod = await inspectPod(sandboxId)

    let shellProbe: {
      ok: boolean
      output?: string
      stderr?: string
      error?: string
    } = { ok: false }

    const podExists = Boolean(pod.containers.length || pod.images.length || pod.phase)

    if (podExists) {
      try {
        const probe = await probeSandboxShell(sandboxId)
        shellProbe = {
          ok: true,
          output: probe.stdout.trim(),
          stderr: probe.stderr.trim(),
        }
      } catch (error) {
        shellProbe = {
          ok: false,
          error: error instanceof Error ? error.message : 'Shell probe failed',
        }
      }
    } else {
      shellProbe = {
        ok: false,
        error: `Sandbox pod ${sandboxId} was not found in ${OPENSHELL_NAMESPACE}.`,
      }
    }

    const podReady = pod.readyCondition === 'True' || pod.phase === 'Running'
    const sshReachable = shellProbe.ok

    return NextResponse.json({
      ok: true,
      sandboxId,
      podExists,
      podReady,
      sshReachable,
      degraded: podExists && !sshReachable,
      attach,
      pod,
      shellProbe,
      note: !podExists
        ? `Sandbox pod ${sandboxId} is not present in ${OPENSHELL_NAMESPACE}.`
        : sshReachable
          ? 'Pod introspection and bounded shell probe both succeeded.'
          : 'Pod introspection succeeded, but bounded shell probe did not. Treat this as degraded dashboard reachability until direct SSH is confirmed.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build readiness contract'
    const status = message === 'sandboxId is required'
      || message.includes('sandboxId must be a valid lowercase DNS-style identifier')
      ? 400
      : 500

    return NextResponse.json({
      ok: false,
      podExists: false,
      podReady: false,
      sshReachable: false,
      degraded: false,
      error: message,
    }, { status })
  }
}
