import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.TERMINAL_SERVER_PORT || 3011)
const HOST = process.env.TERMINAL_SERVER_HOST || '127.0.0.1'
const MAX_SESSIONS = 24
const BUFFER_LIMIT = 200000
const INITIAL_CLEANUP_LIMIT = 16384
const sessions = new Map()

const runtime = await resolveRuntime()

function trimSessions() {
  if (sessions.size <= MAX_SESSIONS) return
  const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
  if (!oldest) return
  oldest.transport.kill()
  sessions.delete(oldest.id)
}

async function resolveRuntime() {
  const preferred = (process.env.TERMINAL_TRANSPORT || 'auto').trim().toLowerCase()
  if (preferred === 'stream') return { mode: 'stream' }

  if (preferred === 'pty' || preferred === 'auto') {
    try {
      const mod = await import('node-pty')
      return { mode: 'pty', nodePty: mod.default || mod }
    } catch (error) {
      if (preferred === 'pty' || process.platform === 'darwin') {
        throw new Error(`TERMINAL_TRANSPORT=${preferred} but node-pty is unavailable on ${process.platform}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { mode: 'stream' }
}

function shellCandidatesForPlatform() {
  const candidates = [
    process.env.TERMINAL_SHELL,
    process.env.SHELL,
    process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/sh',
  ].filter(Boolean)

  return [...new Set(candidates)]
}

function shellForPlatform() {
  for (const candidate of shellCandidatesForPlatform()) {
    if (typeof candidate === 'string' && candidate.startsWith('/') && existsSync(candidate)) {
      return candidate
    }
  }

  for (const candidate of shellCandidatesForPlatform()) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }

  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function homebrewBinPrefix() {
  return process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin']
}

function effectivePath() {
  return [
    process.env.TERMINAL_EXTRA_PATH,
    ...homebrewBinPrefix(),
    process.env.HOME ? `${process.env.HOME}/.local/bin` : '',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.PATH || '',
  ].filter(Boolean).join(':')
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function openshellBin() {
  return process.env.OPENSHELL_BIN || 'openshell'
}

function buildAttachCommand(sandboxId) {
  if (process.env.OPENSHELL_TERMINAL_ATTACH_TEMPLATE) {
    const alias = `openshell-${sandboxId}`
    return process.env.OPENSHELL_TERMINAL_ATTACH_TEMPLATE.replaceAll('{sandboxId}', sandboxId).replaceAll('{alias}', alias)
  }
  return shellForPlatform()
}

function buildBootstrapShell(sandboxId) {
  return [
    `export PATH=${shellEscape(effectivePath())}`,
    `export OPENSHELL_SANDBOX_ID=${shellEscape(sandboxId)}`,
    `export PS1='[operator:${sandboxId || 'host'}] \\u@\\h:\\w\\$ '`,
    `exec ${shellForPlatform()} -i`,
  ].join('; ')
}

function stripNullBytes(value) {
  return value.replace(/\u0000/g, '')
}

function stripOscSequences(value) {
  return value.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
}

function stripCsiSequences(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function stripOtherEscapeSequences(value) {
  return value.replace(/\u001b[@-_]/g, '')
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, '\n')
}

function cleanInitialBurst(value) {
  return normalizeLineEndings(
    stripOtherEscapeSequences(
      stripCsiSequences(
        stripOscSequences(
          stripNullBytes(value)
        )
      )
    )
  )
}

function sanitizeChunkForClient(session, data) {
  const text = typeof data === 'string' ? data : String(data ?? '')
  if (!text) return ''

  if (!session.initialStreamSettled) {
    session.initialBytesSeen += text.length
    const cleaned = cleanInitialBurst(text)
    const hasReadableText = /[A-Za-z0-9_$>#:%~\-]/.test(cleaned)
    const hasLineBreak = cleaned.includes('\n')

    if (hasReadableText && hasLineBreak) {
      session.initialStreamSettled = true
      session.clientReady = true
      return cleaned
    }

    if (session.initialBytesSeen >= INITIAL_CLEANUP_LIMIT) {
      session.initialStreamSettled = true
      session.clientReady = true
      return cleaned
    }

    return cleaned.trim() ? cleaned : ''
  }

  return stripNullBytes(text)
}

function appendBuffer(session, data) {
  const sanitized = sanitizeChunkForClient(session, data)
  if (!sanitized) return

  session.updatedAt = Date.now()
  session.buffer += sanitized
  if (session.buffer.length > BUFFER_LIMIT) {
    session.buffer = session.buffer.slice(-BUFFER_LIMIT)
  }
  for (const socket of session.sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'data', data: sanitized }))
    }
  }
}

function createPtyTransport(sandboxId) {
  const shell = shellForPlatform()
  const bootstrap = buildBootstrapShell(sandboxId)
  const ptyEnv = {
    ...process.env,
    PATH: effectivePath(),
    OPENSHELL_SANDBOX_ID: sandboxId,
    SHELL: shell,
  }
  const requestedCwd = process.env.TERMINAL_CWD || process.env.HOME || process.cwd()
  const spawnCwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : process.cwd()

  let proc
  try {
    proc = runtime.nodePty.spawn(shell, ['-lc', bootstrap], {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd: spawnCwd,
      env: ptyEnv,
    })
  } catch (error) {
    const context = {
      shell,
      requestedShell: process.env.TERMINAL_SHELL || process.env.SHELL || null,
      spawnCwd,
      requestedCwd,
      path: ptyEnv.PATH,
      platform: process.platform,
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`PTY spawn failed: ${detail} :: ${JSON.stringify(context)}`)
  }

  return {
    kind: 'pty',
    write(data) { proc.write(data) },
    resize(cols, rows) { proc.resize(cols, rows) },
    kill() { proc.kill() },
    onData(handler) { proc.onData(handler) },
    onExit(handler) { proc.onExit(handler) },
  }
}

function createStreamTransport(sandboxId) {
  const shell = shellForPlatform()
  const bootstrap = buildBootstrapShell(sandboxId)
  const child = spawn(shell, ['-lc', bootstrap], {
    cwd: process.env.HOME,
    env: {
      ...process.env,
      PATH: effectivePath(),
      TERM: process.env.TERM || 'xterm-256color',
      OPENSHELL_SANDBOX_ID: sandboxId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return {
    kind: 'stream',
    write(data) { if (!child.stdin.destroyed) child.stdin.write(data) },
    resize() {},
    kill() {
      if (!child.killed) child.kill('SIGTERM')
      if (!child.stdin.destroyed) child.stdin.end()
    },
    onData(handler) {
      child.stdout.on('data', (chunk) => handler(chunk.toString()))
      child.stderr.on('data', (chunk) => handler(chunk.toString()))
    },
    onExit(handler) {
      child.on('exit', (exitCode, signal) => handler({ exitCode, signal }))
    },
  }
}

function createTransport(sandboxId) {
  return runtime.mode === 'pty' ? createPtyTransport(sandboxId) : createStreamTransport(sandboxId)
}

function createSessionIdentity(sandboxId, dashboardSessionId) {
  return {
    sandboxId,
    dashboardSessionId: dashboardSessionId && dashboardSessionId.trim() ? dashboardSessionId.trim() : 'dashboard-host',
  }
}

function createSession(identity) {
  trimSessions()
  const id = randomUUID()
  const transport = createTransport(identity.sandboxId)

  const session = {
    id,
    sandboxId: identity.sandboxId,
    dashboardSessionId: identity.dashboardSessionId,
    attachCommand: buildAttachCommand(identity.sandboxId),
    transport,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    buffer: '',
    sockets: new Set(),
    initialBytesSeen: 0,
    initialStreamSettled: false,
    clientReady: false,
  }

  transport.onData((data) => appendBuffer(session, data))

  transport.onExit(({ exitCode, signal }) => {
    for (const socket of session.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode, signal }))
        socket.close()
      }
    }
    sessions.delete(id)
  })

  sessions.set(id, session)
  return session
}

function getOrCreateSession(sessionId, identity) {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (
      existing &&
      existing.sandboxId === identity.sandboxId &&
      existing.dashboardSessionId === identity.dashboardSessionId
    ) {
      existing.updatedAt = Date.now()
      return existing
    }
  }
  return createSession(identity)
}

function serializeSession(session) {
  return {
    ok: true,
    sessionId: session.id,
    sandboxId: session.sandboxId,
    dashboardSessionId: session.dashboardSessionId,
    attachCommand: session.attachCommand,
    replay: session.buffer,
    transport: runtime.mode,
    clientReady: session.clientReady,
    initialStreamSettled: session.initialStreamSettled,
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, transport: runtime.mode }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 10000) {
        req.destroy(new Error('request too large'))
      }
    })
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {}
        const sandboxId = typeof parsed.sandboxId === 'string' && parsed.sandboxId.trim() ? parsed.sandboxId.trim() : 'host'
        const requestedSessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
        const dashboardSessionId = typeof parsed.dashboardSessionId === 'string' ? parsed.dashboardSessionId.trim() : 'dashboard-host'
        const identity = createSessionIdentity(sandboxId, dashboardSessionId)
        const session = getOrCreateSession(requestedSessionId, identity)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(serializeSession(session)))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'session init failed' }))
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
  const sessionId = url.searchParams.get('sessionId') || ''
  const sandboxId = url.searchParams.get('sandboxId') || 'host'
  const dashboardSessionId = url.searchParams.get('dashboardSessionId') || 'dashboard-host'
  const identity = createSessionIdentity(sandboxId, dashboardSessionId)
  const session = getOrCreateSession(sessionId, identity)
  session.sockets.add(socket)
  session.updatedAt = Date.now()

  socket.send(JSON.stringify({
    type: 'ready',
    sessionId: session.id,
    sandboxId: session.sandboxId,
    dashboardSessionId: session.dashboardSessionId,
    attachCommand: session.attachCommand,
    replay: session.buffer,
    transport: runtime.mode,
    clientReady: session.clientReady,
    initialStreamSettled: session.initialStreamSettled,
  }))

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.updatedAt = Date.now()
        session.transport.write(msg.data)
      } else if (msg.type === 'resize') {
        const cols = Number(msg.cols) || 120
        const rows = Number(msg.rows) || 34
        session.updatedAt = Date.now()
        session.transport.resize(cols, rows)
      } else if (msg.type === 'kill') {
        session.transport.kill()
      }
    } catch {
      // ignore malformed frames
    }
  })

  socket.on('close', () => {
    session.sockets.delete(socket)
    session.updatedAt = Date.now()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`terminal server listening on http://${HOST}:${PORT} transport=${runtime.mode}`)
})
