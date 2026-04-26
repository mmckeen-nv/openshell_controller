"use client"

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import 'xterm/css/xterm.css'
import { ensureDashboardSessionId, HYDRATION_SAFE_DASHBOARD_SESSION_ID } from '../lib/dashboardSession'

interface ReadinessPodSummary {
  containers?: string[]
  images?: string[]
  runningStatuses?: string[]
  phase?: string
  readyCondition?: string
}

interface ReadinessResponse {
  ok: boolean
  sandboxId?: string
  podExists?: boolean
  podReady?: boolean
  sshReachable?: boolean
  degraded?: boolean
  attach?: {
    alias?: string
    aliasCommand?: string
    fallbackCommand?: string
    loginShellCommand?: string
    shellHint?: string
  }
  pod?: ReadinessPodSummary
  shellProbe?: {
    ok?: boolean
    output?: string
    stderr?: string
    error?: string
  }
  note?: string
  error?: string
}

interface LiveTerminalSession {
  sessionId: string
  sandboxId: string
  dashboardSessionId: string
  replay?: string
  websocketUrl: string
  sshHostAlias?: string
  reconnectKey?: string
}

type XTermModule = typeof import('xterm')
type FitAddonModule = typeof import('xterm-addon-fit')
type XTermInstance = InstanceType<XTermModule['Terminal']>
type FitAddonInstance = InstanceType<FitAddonModule['FitAddon']>
type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const defaultAlias = (sandboxId: string | null) => `ssh openshell-${sandboxId || 'my-assistant'}`
const defaultFallback = (sandboxId: string | null) => `ssh openshell-${sandboxId || 'my-assistant'}`
const defaultLoginShell = (sandboxId: string | null) => `env PATH=$HOME/.local/bin:$PATH bash -l -c 'ssh openshell-${sandboxId || 'my-assistant'}'`
const DEFAULT_SHELL_HINT = 'If your non-interactive shell misses local tooling, retry from a login shell or prepend PATH=$HOME/.local/bin:$PATH before ssh.'
function OperatorTerminalInner() {
  const searchParams = useSearchParams()
  const sandboxId = searchParams.get('sandboxId')
  const requestedDashboardSessionId = searchParams.get('dashboardSessionId')
  const [dashboardSessionId, setDashboardSessionId] = useState(
    () => requestedDashboardSessionId?.trim() || HYDRATION_SAFE_DASHBOARD_SESSION_ID
  )
  const [state, setState] = useState<LoadState>(sandboxId ? 'loading' : 'idle')
  const [data, setData] = useState<ReadinessResponse | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState<string>('')
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [terminalStatus, setTerminalStatus] = useState<string>('Terminal not connected yet.')
  const [liveSession, setLiveSession] = useState<LiveTerminalSession | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [showRecovery, setShowRecovery] = useState(false)

  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermInstance | null>(null)
  const fitAddonRef = useRef<FitAddonInstance | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const liveSessionIdRef = useRef<string>('')
  const liveSessionRequestRef = useRef<Promise<void> | null>(null)
  const reconnectCounterRef = useRef(0)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    setDashboardSessionId(ensureDashboardSessionId(requestedDashboardSessionId))
  }, [requestedDashboardSessionId])

  const terminalDescription = sandboxId ? 'Live operator terminal for the selected sandbox, brokered through the dashboard-owned terminal bridge.' : 'Live operator terminal for host mode, brokered through the dashboard-owned terminal bridge.'

  const refreshReadiness = useCallback(async () => {
    if (!sandboxId) {
      setState('idle')
      setData(null)
      return
    }

    setState('loading')
    setCopyMessage('')

    try {
      const response = await fetch(`/api/openshell/terminal/readiness?sandboxId=${encodeURIComponent(sandboxId)}`, { cache: 'no-store' })
      const result: ReadinessResponse = await response.json()
      setData(result)
      setState(response.ok && result.ok ? 'ready' : 'error')
      setLastCheckedAt(new Date().toLocaleTimeString())
    } catch (error) {
      setData({ ok: false, error: error instanceof Error ? error.message : 'Failed to inspect sandbox readiness.' })
      setState('error')
      setLastCheckedAt(new Date().toLocaleTimeString())
    }
  }, [sandboxId])

  const ensureLiveSession = useCallback(async ({ reset = false }: { reset?: boolean } = {}) => {
    if (liveSessionRequestRef.current) return liveSessionRequestRef.current
    if (reset) {
      reconnectCounterRef.current += 1
      liveSessionIdRef.current = ''
      socketRef.current?.close()
      socketRef.current = null
    }
    setTerminalState('connecting')
    setTerminalStatus(sandboxId
      ? `Initializing live terminal session for ${sandboxId}…`
      : 'Initializing host-mode live terminal session…')

    const request = (async () => {
      const response = await fetch('/api/openshell/terminal/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, sessionId: liveSessionIdRef.current, dashboardSessionId }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Failed to initialize live terminal session.')
      }
      liveSessionIdRef.current = result.sessionId
      setLiveSession({
        sessionId: result.sessionId,
        sandboxId: result.sandboxId,
        dashboardSessionId: result.dashboardSessionId || dashboardSessionId,
        replay: result.replay,
        websocketUrl: result.websocketUrl,
        sshHostAlias: result.sshHostAlias,
        reconnectKey: String(reconnectCounterRef.current),
      })
    })()

    liveSessionRequestRef.current = request
    try {
      await request
    } catch (error) {
      setTerminalState('error')
      setTerminalStatus(error instanceof Error ? error.message : 'Failed to initialize live terminal session.')
    } finally {
      liveSessionRequestRef.current = null
    }
  }, [dashboardSessionId, sandboxId])

  useEffect(() => { refreshReadiness() }, [refreshReadiness])
  useEffect(() => { ensureLiveSession() }, [ensureLiveSession])

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) return
    let disposed = false
    let cleanupResize: (() => void) | null = null

    ;(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('xterm'), import('xterm-addon-fit')])
      if (disposed || !terminalContainerRef.current) return

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#000000', foreground: '#f5f5f5', cursor: '#76b900' },
        scrollback: 5000,
        allowTransparency: false,
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(terminalContainerRef.current)
      requestAnimationFrame(() => fitAddon.fit())
      term.focus()
      terminalRef.current = term
      fitAddonRef.current = fitAddon
      setTerminalReady(true)

      const focusTerminal = () => term.focus()
      terminalContainerRef.current.addEventListener('click', focusTerminal)

      const handleResize = () => {
        try {
          fitAddon.fit()
        } catch {
          return
        }
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }
      window.addEventListener('resize', handleResize)
      resizeObserverRef.current = new ResizeObserver(handleResize)
      resizeObserverRef.current.observe(terminalContainerRef.current)
      cleanupResize = () => {
        window.removeEventListener('resize', handleResize)
        resizeObserverRef.current?.disconnect()
        resizeObserverRef.current = null
        terminalContainerRef.current?.removeEventListener('click', focusTerminal)
      }
    })().catch((error) => {
      setTerminalState('error')
      setTerminalStatus(error instanceof Error ? error.message : 'Failed to load terminal renderer.')
    })

    return () => {
      disposed = true
      cleanupResize?.()
      socketRef.current?.close()
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      setTerminalReady(false)
    }
  }, [])

  useEffect(() => {
    if (!terminalReady || !liveSession?.websocketUrl || !terminalRef.current) return
    const term = terminalRef.current
    const previousSocket = socketRef.current
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      previousSocket.close()
    }
    term.reset()
    if (liveSession.replay) term.write(liveSession.replay)

    const socket = new WebSocket(liveSession.websocketUrl)
    socketRef.current = socket
    const inputDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })

    socket.addEventListener('open', () => {
      setTerminalState('connected')
      setTerminalStatus(`Live terminal connected for ${liveSession.sandboxId}.`)
      try {
        fitAddonRef.current?.fit()
      } catch {
        // xterm fit can throw if the tab is backgrounded during initial layout.
      }
      term.focus()
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    })

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'ready' && message.replay) {
          term.reset()
          term.write(message.replay)
        } else if (message.type === 'data' && typeof message.data === 'string') {
          term.write(message.data)
        } else if (message.type === 'exit') {
          setTerminalState('error')
          setTerminalStatus(`Terminal exited with code ${message.exitCode ?? 'unknown'}.`)
        }
      } catch {
        // ignore malformed frames
      }
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return
      setTerminalState((current) => current === 'error' ? current : 'idle')
      setTerminalStatus('Terminal disconnected. Refresh session to reconnect.')
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket) return
      setTerminalState('error')
      setTerminalStatus('Terminal websocket error. Check that the dashboard websocket path is routed in production, then reconnect.')
    })

    return () => {
      inputDisposable.dispose()
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [liveSession, terminalReady])

  const readiness = useMemo(() => {
    if (!sandboxId) return { tone: 'border-[var(--status-pending)] text-[var(--status-pending)]', label: 'HOST MODE', detail: 'No sandbox query was provided. The dashboard terminal stays in host mode and keeps dashboard-session diagnostics for reconnect behavior.' }
    if (state === 'loading') return { tone: 'border-[var(--status-pending)] text-[var(--status-pending)]', label: 'CHECKING READINESS', detail: 'Verifying pod metadata and shell reachability.' }
    if (state === 'ready' && data?.ok && data?.podReady && data?.sshReachable) return { tone: 'border-[var(--status-running)] text-[var(--status-running)]', label: 'LIVE TERMINAL PATH VERIFIED', detail: 'The backend confirmed pod readiness and shell reachability, and the dashboard is wired for a live terminal transport.' }
    if (state === 'ready' && data?.ok && data?.podExists && data?.degraded) return { tone: 'border-[var(--status-pending)] text-[var(--status-pending)]', label: 'DEGRADED: POD UP, SHELL UNCONFIRMED', detail: 'The pod exists, but the readiness probe did not fully succeed. The live terminal may still connect, but direct SSH remains the stronger fallback.' }
    if (state === 'ready' && data?.ok && data?.podExists) return { tone: 'border-[var(--status-running)] text-[var(--status-running)]', label: 'READY FOR LIVE TERMINAL', detail: 'Pod metadata is present and the dashboard live terminal can attempt a real shell session.' }
    return { tone: 'border-[var(--status-stopped)] text-[var(--status-stopped)]', label: 'READINESS CHECK FAILED', detail: 'The dashboard could not confirm pod metadata or shell reachability. Use the recovery commands below, then retry.' }
  }, [sandboxId, state, data])

  const copyCommand = useCallback(async (command: string) => {
    try { await navigator.clipboard.writeText(command); setCopyMessage(`Copied: ${command}`) }
    catch { setCopyMessage(`Copy failed. Use: ${command}`) }
  }, [])

  const aliasCommand = data?.attach?.aliasCommand || defaultAlias(sandboxId)
  const fallbackCommand = data?.attach?.fallbackCommand || defaultFallback(sandboxId)
  const loginShellCommand = data?.attach?.loginShellCommand || defaultLoginShell(sandboxId)
  const shellHint = data?.attach?.shellHint || DEFAULT_SHELL_HINT

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--foreground-dim)] font-mono">OpenShell Control</p>
            <h1 className="text-xl font-semibold uppercase tracking-wider mt-2">Operator Terminal</h1>
            <p className="mt-2 max-w-2xl text-xs text-[var(--foreground-dim)]">{terminalDescription}</p>
          </div>
          <Link href="/" className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]">Back to Dashboard</Link>
        </div>

        <section className={`panel px-4 py-3 border ${readiness.tone}`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Sandbox</span>
              <span className="text-sm font-mono text-[var(--foreground)] truncate">{sandboxId || 'host'}</span>
            </div>
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Status</span>
              <span className="text-xs font-mono truncate">{readiness.label}</span>
              {lastCheckedAt && <span className="text-[10px] text-[var(--foreground-dim)]">checked {lastCheckedAt}</span>}
            </div>
          </div>
        </section>

        <section className="panel p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div><h3 className="text-sm font-semibold uppercase tracking-wider">Live Terminal</h3></div>
            <div className="text-[11px] text-[var(--foreground-dim)] font-mono">{terminalStatus}</div>
          </div>
          <div className="rounded-sm border border-[var(--border-subtle)] bg-black p-3"><div ref={terminalContainerRef} className="h-[68vh] min-h-[460px] w-full" /></div>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => ensureLiveSession({ reset: true })} disabled={terminalState === 'connecting'} className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] disabled:opacity-50 disabled:cursor-not-allowed">{terminalState === 'connecting' ? 'Connecting…' : 'Reconnect Live Terminal'}</button>
            <button onClick={refreshReadiness} disabled={!sandboxId} className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] disabled:opacity-50 disabled:cursor-not-allowed">Refresh Readiness</button>
            <button onClick={() => setShowRecovery((current) => !current)} className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]">{showRecovery ? 'Hide Recovery' : 'Recovery Commands'}</button>
            <span className="text-[11px] text-[var(--foreground-dim)] font-mono">{liveSession?.sessionId ? `session ${liveSession.sessionId.slice(0, 8)}` : 'no session'}</span>
          </div>
        </section>

        {showRecovery && (
          <section className="panel p-6 space-y-5">
            <div><h3 className="text-sm font-semibold uppercase tracking-wider">Recovery Commands</h3><p className="text-xs text-[var(--foreground-dim)] mt-2">{readiness.detail}</p></div>
            <div className="space-y-3">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4"><p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Preferred attach command</p><code className="block mt-2 text-sm font-mono text-[var(--nvidia-green)] break-all">{aliasCommand}</code><button onClick={() => copyCommand(aliasCommand)} className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]">Copy Alias Command</button></div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-3">
                <div><p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Fallback if alias or agent config is missing</p><code className="block mt-2 text-sm font-mono text-[var(--foreground)] break-all">{fallbackCommand}</code><p className="text-xs text-[var(--foreground-dim)] mt-2">{shellHint}</p><button onClick={() => copyCommand(fallbackCommand)} className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]">Copy Fallback Command</button></div>
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3"><p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Login-shell retry for Homebrew/path issues</p><code className="block mt-2 text-sm font-mono text-[var(--foreground)] break-all">{loginShellCommand}</code><button onClick={() => copyCommand(loginShellCommand)} className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]">Copy Login-Shell Retry</button></div>
              </div>
            </div>
            {copyMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{copyMessage}</div>}
          </section>
        )}
      </div>
    </main>
  )
}

export default function OperatorTerminalPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8"><div className="mx-auto max-w-6xl"><div className="panel p-6">Loading operator terminal…</div></div></main>}>
      <OperatorTerminalInner />
    </Suspense>
  )
}
