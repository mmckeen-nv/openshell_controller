import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'

const PORT = Number(process.env.TERMINAL_SERVER_PORT || 3011)
const HOST = process.env.TERMINAL_SERVER_HOST || '127.0.0.1'
const MAX_SESSIONS = 24
const sessions = new Map()

function trimSessions() {
  if (sessions.size <= MAX_SESSIONS) return
  const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
  if (!oldest) return
  oldest.pty.kill()
  sessions.delete(oldest.id)
}

function shellForPlatform() {
  return process.env.SHELL || '/bin/bash'
}

function createSession(sandboxId) {
  trimSessions()
  const id = randomUUID()
  const shell = shellForPlatform()
  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 34,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      PS1: `[${sandboxId}] \\u@\\h:\\w\\$ `,
      OPENSHELL_SANDBOX_ID: sandboxId,
    },
  })

  const session = {
    id,
    sandboxId,
    pty: proc,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    buffer: '',
    sockets: new Set(),
  }

  proc.onData((data) => {
    session.updatedAt = Date.now()
    session.buffer += data
    if (session.buffer.length > 200000) {
      session.buffer = session.buffer.slice(-200000)
    }
    for (const socket of session.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data }))
      }
    }
  })

  proc.onExit(({ exitCode, signal }) => {
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

function getOrCreateSession(sessionId, sandboxId) {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (existing && existing.sandboxId === sandboxId) {
      existing.updatedAt = Date.now()
      return existing
    }
  }
  return createSession(sandboxId)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }))
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
        const sandboxId = typeof parsed.sandboxId === 'string' && parsed.sandboxId.trim() ? parsed.sandboxId.trim() : 'default'
        const requestedSessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : ''
        const session = getOrCreateSession(requestedSessionId, sandboxId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          sessionId: session.id,
          sandboxId: session.sandboxId,
          replay: session.buffer,
        }))
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
  const sandboxId = url.searchParams.get('sandboxId') || 'default'
  const session = getOrCreateSession(sessionId, sandboxId)
  session.sockets.add(socket)
  session.updatedAt = Date.now()

  socket.send(JSON.stringify({
    type: 'ready',
    sessionId: session.id,
    sandboxId: session.sandboxId,
    replay: session.buffer,
  }))

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.updatedAt = Date.now()
        session.pty.write(msg.data)
      } else if (msg.type === 'resize') {
        const cols = Number(msg.cols) || 120
        const rows = Number(msg.rows) || 34
        session.updatedAt = Date.now()
        session.pty.resize(cols, rows)
      } else if (msg.type === 'kill') {
        session.pty.kill()
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
  console.log(`terminal server listening on http://${HOST}:${PORT}`)
})
