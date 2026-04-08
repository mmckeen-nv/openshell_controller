import { NextResponse } from 'next/server'
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_COMMAND_LENGTH, runSandboxCommand, validateSandboxId, validateTerminalCommand } from '../../../lib/openshellHost'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const sandboxId = searchParams.get('sandboxId') || 'unknown'

  return NextResponse.json({
    ok: true,
    sandboxId,
    attached: false,
    interactive: false,
    mode: 'bounded-command-runner',
    note: 'Embedded PTY transport is still not live. This route now supports bounded one-shot command execution via POST while interactive terminal attach remains pending.',
    suggestedCommand: `openshell sandbox exec ${sandboxId} -- /bin/sh`,
    limits: {
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      maxCommandLength: MAX_COMMAND_LENGTH,
    },
  })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const sandboxInput = typeof body?.sandboxId === 'string' ? body.sandboxId : ''
    const commandInput = typeof body?.command === 'string' ? body.command : ''

    const sandboxId = validateSandboxId(sandboxInput)
    const command = validateTerminalCommand(commandInput)
    const result = await runSandboxCommand(sandboxId, command)

    const ok = result.exitCode === 0

    return NextResponse.json({
      ok,
      sandboxId,
      interactive: false,
      mode: 'bounded-command-runner',
      executionMode: result.mode,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      note: ok
        ? result.mode === 'shell'
          ? 'Bounded sandbox command execution succeeded. Interactive PTY transport is still pending.'
          : 'Sandbox reachability fallback succeeded, but command execution still requires a shell-capable image.'
        : `Bounded sandbox command exited non-zero (${result.exitCode}). Interactive PTY transport is still pending, but stderr/stdout below reflect the real sandbox response.`,
      limits: {
        timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
        maxCommandLength: MAX_COMMAND_LENGTH,
      },
    }, { status: ok ? 200 : 502 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run sandbox command'
    const status = message === 'sandboxId is required'
      || message === 'command is required'
      || message.includes('sandboxId must be a valid lowercase DNS-style identifier')
      || message.includes('command exceeds')
      ? 400
      : 500

    return NextResponse.json({
      ok: false,
      interactive: false,
      mode: 'bounded-command-runner',
      error: message,
    }, { status })
  }
}
