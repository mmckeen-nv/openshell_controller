import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_COMMAND_LENGTH, runSandboxCommand, validateSandboxId, validateTerminalCommand } from '../../../lib/openshellHost'

type TranscriptEntry = {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  executionMode?: string
  ranAt: string
}

type TerminalSession = {
  sessionId: string
  sandboxId: string
  createdAt: string
  updatedAt: string
  cwd?: string
  transcript: TranscriptEntry[]
}

const sessions = new Map<string, TerminalSession>()
const MAX_TRANSCRIPT = 100

function ensureSession(sessionId: string, sandboxId: string) {
  const existing = sessions.get(sessionId)
  if (existing) {
    if (existing.sandboxId !== sandboxId) {
      throw new Error('sessionId does not match sandboxId')
    }
    return existing
  }

  const now = new Date().toISOString()
  const created: TerminalSession = {
    sessionId,
    sandboxId,
    createdAt: now,
    updatedAt: now,
    cwd: undefined,
    transcript: [],
  }
  sessions.set(sessionId, created)
  return created
}

function sanitizePromptPath(cwd?: string) {
  if (!cwd) return '~'
  return cwd
}

function buildWrappedCommand(command: string, cwd?: string) {
  const trimmed = validateTerminalCommand(command)
  const cdPrefix = cwd ? `cd ${quoteForSingleQuotedShell(cwd)} >/dev/null 2>&1 || exit 98; ` : ''
  const shellBody = `${cdPrefix}${trimmed}; __cmd_exit=$?; printf '\n__OPENCLAW_PWD__=%s\n' "$PWD"; exit $__cmd_exit`
  return shellBody
}

function quoteForSingleQuotedShell(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function extractPwd(stdout: string) {
  const match = stdout.match(/\n__OPENCLAW_PWD__=(.*)\n?$/)
  if (!match) {
    return { cleanedStdout: stdout.trim(), cwd: undefined }
  }

  const cwd = match[1]?.trim() || undefined
  const cleanedStdout = stdout.slice(0, match.index).trimEnd()
  return { cleanedStdout, cwd }
}

function serializeSession(session: TerminalSession) {
  return {
    ok: true,
    interactive: false,
    terminalLike: true,
    mode: 'session-backed-command-terminal',
    session: {
      sessionId: session.sessionId,
      sandboxId: session.sandboxId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      prompt: `${session.sandboxId}:${sanitizePromptPath(session.cwd)}$`,
      transcript: session.transcript,
    },
    limits: {
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      maxCommandLength: MAX_COMMAND_LENGTH,
    },
    note: 'Dashboard terminal is session-backed and command-scoped. It preserves transcript and working directory across commands, but it is not a raw PTY stream yet.',
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const sandboxId = searchParams.get('sandboxId') || ''
  const sessionId = searchParams.get('sessionId') || ''

  if (!sandboxId) {
    return NextResponse.json({
      ok: false,
      interactive: false,
      mode: 'session-backed-command-terminal',
      error: 'sandboxId is required',
    }, { status: 400 })
  }

  try {
    const validatedSandboxId = validateSandboxId(sandboxId)

    if (!sessionId) {
      const createdSession = ensureSession(randomUUID(), validatedSandboxId)
      return NextResponse.json(serializeSession(createdSession))
    }

    const session = sessions.get(sessionId)
    if (!session || session.sandboxId !== validatedSandboxId) {
      return NextResponse.json({
        ok: false,
        interactive: false,
        mode: 'session-backed-command-terminal',
        error: 'session not found',
      }, { status: 404 })
    }

    return NextResponse.json(serializeSession(session))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to inspect terminal session'
    const status = message.includes('sandboxId') ? 400 : 500
    return NextResponse.json({
      ok: false,
      interactive: false,
      mode: 'session-backed-command-terminal',
      error: message,
    }, { status })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const sandboxInput = typeof body?.sandboxId === 'string' ? body.sandboxId : ''
    const sessionInput = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const commandInput = typeof body?.command === 'string' ? body.command : ''

    const sandboxId = validateSandboxId(sandboxInput)
    const command = validateTerminalCommand(commandInput)
    const sessionId = sessionInput || randomUUID()
    const session = ensureSession(sessionId, sandboxId)

    const wrappedCommand = buildWrappedCommand(command, session.cwd)
    const result = await runSandboxCommand(sandboxId, wrappedCommand)
    const { cleanedStdout, cwd } = extractPwd(result.stdout)

    session.cwd = cwd || session.cwd
    session.updatedAt = new Date().toISOString()
    session.transcript.push({
      id: randomUUID(),
      command,
      stdout: cleanedStdout,
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
      executionMode: result.mode,
      ranAt: session.updatedAt,
    })
    if (session.transcript.length > MAX_TRANSCRIPT) {
      session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT)
    }

    const ok = result.exitCode === 0

    return NextResponse.json({
      ...serializeSession(session),
      ok,
      command,
      exitCode: result.exitCode,
      executionMode: result.mode,
      stdout: cleanedStdout,
      stderr: result.stderr.trim(),
      note: ok
        ? 'Command completed and terminal session state was updated.'
        : `Command exited non-zero (${result.exitCode}); transcript preserved for inspection.`,
    }, { status: ok ? 200 : 502 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run sandbox command'
    const status = message === 'sandboxId is required'
      || message === 'command is required'
      || message.includes('sandboxId must be a valid lowercase DNS-style identifier')
      || message.includes('command exceeds')
      || message.includes('sessionId does not match sandboxId')
      ? 400
      : 500

    return NextResponse.json({
      ok: false,
      interactive: false,
      mode: 'session-backed-command-terminal',
      error: message,
    }, { status })
  }
}
