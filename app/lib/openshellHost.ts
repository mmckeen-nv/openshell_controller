import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DOCKER_BIN = '/Applications/Docker.app/Contents/Resources/bin/docker'
const OPENSHELL_CONTAINER = 'openshell-cluster-openshell'
const OPENSHELL_NAMESPACE = 'agent-sandbox-system'
const OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/'
const DEFAULT_EXEC_TIMEOUT_MS = 10000
const MAX_COMMAND_LENGTH = 400
const SANDBOX_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

function normalizeExecError(error: unknown): ExecResult {
  const execError = error as ExecFileException & { stdout?: string, stderr?: string, code?: number | string | null }
  return {
    stdout: typeof execError?.stdout === 'string' ? execError.stdout : '',
    stderr: typeof execError?.stderr === 'string' ? execError.stderr : '',
    exitCode: typeof execError?.code === 'number' ? execError.code : -1,
  }
}

export async function dockerExecInOpenShell(command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      DOCKER_BIN,
      [
        'exec',
        OPENSHELL_CONTAINER,
        'sh',
        '-lc',
        command,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      }
    )
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    const normalized = normalizeExecError(error)
    if (normalized.exitCode !== -1 || normalized.stdout || normalized.stderr) {
      return normalized
    }
    throw error
  }
}

type SandboxExecPlan = {
  command: string
  mode: 'shell' | 'env'
}

function buildSandboxExecPlans(podName: string, shellCommand: string, options?: { allowEnvFallback?: boolean }): SandboxExecPlan[] {
  const escaped = quoteForSingleQuotedShell(shellCommand)
  const attempts: SandboxExecPlan[] = [
    {
      command: `kubectl -n ${OPENSHELL_NAMESPACE} exec ${podName} -- /bin/sh -lc '${escaped}'`,
      mode: 'shell',
    },
    {
      command: `kubectl -n ${OPENSHELL_NAMESPACE} exec ${podName} -- /busybox/sh -lc '${escaped}'`,
      mode: 'shell',
    },
  ]

  if (options?.allowEnvFallback) {
    attempts.push({
      command: `kubectl -n ${OPENSHELL_NAMESPACE} exec ${podName} -- env`,
      mode: 'env',
    })
  }

  return attempts
}

async function execInSandboxWithFallback(podName: string, shellCommand: string, options?: { allowEnvFallback?: boolean }) {
  const attempts = buildSandboxExecPlans(podName, shellCommand, options)

  let lastFailure: ({ mode: SandboxExecPlan['mode'] } & ExecResult) | undefined
  for (const plan of attempts) {
    const result = await dockerExecInOpenShell(plan.command)
    if (result.exitCode === 0) {
      return {
        ...result,
        mode: plan.mode,
      }
    }

    lastFailure = {
      ...result,
      mode: plan.mode,
    }
  }

  if (lastFailure) {
    return lastFailure
  }

  throw new Error('Failed to probe sandbox shell')
}

export async function probeSandboxShell(podName: string) {
  const result = await execInSandboxWithFallback(podName, 'echo OPENSHELL_OK && pwd && whoami', { allowEnvFallback: true })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Shell probe failed with exit code ${result.exitCode}`)
  }
  return result
}

function quoteForSingleQuotedShell(command: string) {
  return command.replace(/'/g, `'"'"'`)
}

export function validateSandboxId(sandboxId: string) {
  const trimmed = sandboxId.trim()

  if (!trimmed) {
    throw new Error('sandboxId is required')
  }

  if (!SANDBOX_ID_PATTERN.test(trimmed)) {
    throw new Error('sandboxId must be a valid lowercase DNS-style identifier')
  }

  return trimmed
}

export function validateTerminalCommand(command: string) {
  const trimmed = command.trim()

  if (!trimmed) {
    throw new Error('command is required')
  }

  if (trimmed.length > MAX_COMMAND_LENGTH) {
    throw new Error(`command exceeds ${MAX_COMMAND_LENGTH} characters`)
  }

  return trimmed
}

export async function runSandboxCommand(podName: string, command: string) {
  const trimmed = validateTerminalCommand(command)

  return await execInSandboxWithFallback(podName, trimmed)
}

export function getOpenClawDashboardUrl() {
  return OPENCLAW_DASHBOARD_URL
}

export { DEFAULT_EXEC_TIMEOUT_MS, DOCKER_BIN, MAX_COMMAND_LENGTH, OPENSHELL_CONTAINER, OPENSHELL_NAMESPACE }
