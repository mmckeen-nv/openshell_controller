"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

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
  replay?: string
  websocketUrl: string
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const defaultAlias = (sandboxId: string | null) => `ssh openshell-${sandboxId || 'my-assistant'}`
const defaultFallback = (sandboxId: string | null) => `ssh -i ~/.ssh/id_ed25519_openclaw_labmac openshell-${sandboxId || 'my-assistant'}`
const defaultLoginShell = (sandboxId: string | null) => `env PATH=/opt/homebrew/bin:$PATH zsh -l -c 'ssh openshell-${sandboxId || 'my-assistant'}'`
const DEFAULT_SHELL_HINT = 'If your non-interactive shell misses Homebrew tooling, retry from a login shell or prepend PATH=/opt/homebrew/bin:$PATH before ssh.'

export default function OperatorTerminalPage() {
  const searchParams = useSearchParams()
  const sandboxId = searchParams.get('sandboxId')
  const [state, setState] = useState<LoadState>(sandboxId ? 'loading' : 'idle')
  const [data, setData] = useState<ReadinessResponse | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState<string>('')
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [terminalStatus, setTerminalStatus] = useState<string>('Terminal not connected yet.')
  const [liveSession, setLiveSession] = useState<LiveTerminalSession | null>(null)

  const terminalContainerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  const refreshReadiness = useCallback(async () => {
    if (!sandboxId) {
      setState('idle')
      setData(null)
      return
    }

    setState('loading')
    setCopyMessage('')

    try {
      const response = await fetch(`/api/openshell/terminal/readiness?sandboxId=${encodeURIComponent(sandboxId)}`, {
        cache: 'no-store',
      })
      const result: ReadinessResponse = await response.json()
      setData(result)
      setState(response.ok && result.ok ? 'ready' : 'error')
      setLastCheckedAt(new Date().toLocaleTimeString())
    } catch (error) {
      setData({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to inspect sandbox readiness.',
      })
      setState('error')
      setLastCheckedAt(new Date().toLocaleTimeString())
    }
  }, [sandboxId])

  const ensureLiveSession = useCallback(async () => {
    if (!sandboxId) {
      setLiveSession(null)
      setTerminalState('idle')
      return
    }

    setTerminalState('connecting')
    setTerminalStatus('Initializing live PTY session…')

    try {
      const response = await fetch('/api/openshell/terminal/live', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sandboxId,
          sessionId: liveSession?.sessionId,
        }),
      })
      const result = await response.json()
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Failed to initialize live terminal session.')
      }
      setLiveSession({
        sessionId: result.sessionId,
        sandboxId: result.sandboxId,
        replay: result.replay,
        websocketUrl: result.websocketUrl,
      })
    } catch (error) {
      setTerminalState('error')
      setTerminalStatus(error instanceof Error ? error.message : 'Failed to initialize live terminal session.')
    }
  }, [sandboxId, liveSession?.sessionId])

  useEffect(() => {
    refreshReadiness()
  }, [refreshReadiness])

  useEffect(() => {
    ensureLiveSession()
  }, [ensureLiveSession])

  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#000000',
        foreground: '#f5f5f5',
        cursor: '#76b900',
      },
      scrollback: 5000,
      allowTransparency: false,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalContainerRef.current)
    fitAddon.fit()

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    const handleResize = () => {
      fitAddon.fit()
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }))
      }
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      socketRef.current?.close()
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!liveSession?.websocketUrl || !terminalRef.current) {
      return
    }

    const term = terminalRef.current
    term.reset()
    if (liveSession.replay) {
      term.write(liveSession.replay)
    }

    const socket = new WebSocket(liveSession.websocketUrl)
    socketRef.current = socket

    const inputDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })

    socket.addEventListener('open', () => {
      setTerminalState('connected')
      setTerminalStatus(`Live PTY connected for ${liveSession.sandboxId}.`)
      if (fitAddonRef.current) {
        fitAddonRef.current.fit()
      }
      socket.send(JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }))
    })

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'ready') {
          if (message.replay) {
            term.reset()
            term.write(message.replay)
          }
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
      setTerminalState((current) => current === 'error' ? current : 'idle')
      setTerminalStatus('Terminal disconnected. Refresh session to reconnect.')
    })

    socket.addEventListener('error', () => {
      setTerminalState('error')
      setTerminalStatus('Terminal websocket error.')
    })

    return () => {
      inputDisposable.dispose()
      socket.close()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [liveSession])

  const readiness = useMemo(() => {
    if (!sandboxId) {
      return {
        tone: 'border-[var(--status-pending)] text-[var(--status-pending)]',
        label: 'NO SANDBOX SELECTED',
        detail: 'Return to the dashboard and choose a sandbox before opening Operator Terminal.',
      }
    }

    if (state === 'loading') {
      return {
        tone: 'border-[var(--status-pending)] text-[var(--status-pending)]',
        label: 'CHECKING READINESS',
        detail: 'Verifying pod metadata and bounded shell reachability so the page can report terminal truth in one pass.',
      }
    }

    if (state === 'ready' && data?.ok && data?.podReady && data?.sshReachable) {
      return {
        tone: 'border-[var(--status-running)] text-[var(--status-running)]',
        label: 'LIVE TERMINAL PATH VERIFIED',
        detail: 'The backend confirmed pod readiness and shell reachability, and the dashboard is now wired for a live PTY transport.',
      }
    }

    if (state === 'ready' && data?.ok && data?.podExists && data?.degraded) {
      return {
        tone: 'border-[var(--status-pending)] text-[var(--status-pending)]',
        label: 'DEGRADED: POD UP, SHELL UNCONFIRMED',
        detail: 'The pod exists, but the readiness probe did not fully succeed. The live terminal may still connect, but direct SSH remains the stronger fallback.',
      }
    }

    if (state === 'ready' && data?.ok && data?.podExists) {
      return {
        tone: 'border-[var(--status-running)] text-[var(--status-running)]',
        label: 'READY FOR LIVE TERMINAL',
        detail: 'Pod metadata is present and the dashboard live terminal can attempt a real PTY session.',
      }
    }

    return {
      tone: 'border-[var(--status-stopped)] text-[var(--status-stopped)]',
      label: 'READINESS CHECK FAILED',
      detail: 'The dashboard could not confirm pod metadata or shell reachability. Use the recovery commands below, then retry.',
    }
  }, [sandboxId, state, data])

  const copyCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyMessage(`Copied: ${command}`)
    } catch {
      setCopyMessage(`Copy failed. Use: ${command}`)
    }
  }, [])

  const aliasCommand = data?.attach?.aliasCommand || defaultAlias(sandboxId)
  const fallbackCommand = data?.attach?.fallbackCommand || defaultFallback(sandboxId)
  const loginShellCommand = data?.attach?.loginShellCommand || defaultLoginShell(sandboxId)
  const shellHint = data?.attach?.shellHint || DEFAULT_SHELL_HINT

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--foreground-dim)] font-mono">Operator path</p>
            <h1 className="text-2xl font-semibold uppercase tracking-wider mt-2">Operator Terminal</h1>
            <p className="text-sm text-[var(--foreground-dim)] mt-3 max-w-3xl">
              Real live terminal surface for the selected sandbox. Browser keys flow into a PTY-backed shell process and output streams back live into the dashboard.
            </p>
          </div>
          <Link
            href="/"
            className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]"
          >
            Back to Dashboard
          </Link>
        </div>

        <section className={`panel p-6 border-2 ${readiness.tone}`}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] font-mono opacity-80">Sandbox</p>
              <h2 className="text-lg font-semibold mt-1">{sandboxId || 'UNSELECTED'}</h2>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-[0.2em] font-mono opacity-80">Status</p>
              <p className="text-sm font-mono mt-1">{readiness.label}</p>
              {lastCheckedAt && <p className="text-[10px] mt-1 opacity-80">Last checked {lastCheckedAt}</p>}
            </div>
          </div>
          <p className="text-sm mt-4 text-[var(--foreground)]">{readiness.detail}</p>
        </section>

        <section className="panel p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider">Live Dashboard Terminal</h3>
              <p className="text-xs text-[var(--foreground-dim)] mt-2">
                xterm-backed live terminal. Supports typed input, streamed output, resize, and session reconnect.
              </p>
            </div>
            <div className="text-[11px] text-[var(--foreground-dim)] font-mono">{terminalStatus}</div>
          </div>

          <div className="rounded-sm border border-[var(--border-subtle)] bg-black p-3">
            <div ref={terminalContainerRef} className="h-[520px] w-full" />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={ensureLiveSession}
              disabled={!sandboxId || terminalState === 'connecting'}
              className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {terminalState === 'connecting' ? 'Connecting…' : 'Reconnect Live Terminal'}
            </button>
            <button
              onClick={refreshReadiness}
              className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
            >
              Refresh Readiness
            </button>
            <span className="text-[11px] text-[var(--foreground-dim)] font-mono">
              {liveSession?.sessionId ? `session ${liveSession.sessionId.slice(0, 8)}` : 'no session'}
            </span>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <div className="panel p-6 space-y-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Direct Attach Fallbacks</h3>
                <p className="text-xs text-[var(--foreground-dim)] mt-2">
                  If the live dashboard terminal is degraded, these remain the authoritative escape hatches.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Preferred attach command</p>
                <code className="block mt-2 text-sm font-mono text-[var(--nvidia-green)] break-all">{aliasCommand}</code>
                <button
                  onClick={() => copyCommand(aliasCommand)}
                  className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
                >
                  Copy Alias Command
                </button>
              </div>

              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Fallback if alias or agent config is missing</p>
                  <code className="block mt-2 text-sm font-mono text-[var(--foreground)] break-all">{fallbackCommand}</code>
                  <p className="text-xs text-[var(--foreground-dim)] mt-2">{shellHint}</p>
                  <button
                    onClick={() => copyCommand(fallbackCommand)}
                    className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
                  >
                    Copy Fallback Command
                  </button>
                </div>

                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Login-shell retry for Homebrew/path issues</p>
                  <code className="block mt-2 text-sm font-mono text-[var(--foreground)] break-all">{loginShellCommand}</code>
                  <button
                    onClick={() => copyCommand(loginShellCommand)}
                    className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
                  >
                    Copy Login-Shell Retry
                  </button>
                </div>
              </div>
            </div>

            {copyMessage && (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
                {copyMessage}
              </div>
            )}
          </div>

          <div className="panel p-6 space-y-5">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider">Readiness Evidence</h3>
              <p className="text-xs text-[var(--foreground-dim)] mt-2">
                Live pod introspection and bounded shell evidence from the backend.
              </p>
            </div>

            <div className="space-y-3 text-sm">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Pod phase / ready</p>
                <p className="mt-2 font-mono break-words">{data?.pod?.phase || 'Unknown'} / {data?.pod?.readyCondition || 'Unknown'}</p>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Containers</p>
                <p className="mt-2 font-mono break-words">{data?.pod?.containers?.length ? data.pod.containers.join(', ') : 'Unavailable'}</p>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Images</p>
                <p className="mt-2 font-mono break-words">{data?.pod?.images?.length ? data.pod.images.join(', ') : 'Unavailable'}</p>
              </div>
            </div>

            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Shell probe</p>
                  <p className="text-xs text-[var(--foreground-dim)] mt-2">Readiness-side shell evidence.</p>
                </div>
                <div className="text-[11px] text-[var(--foreground-dim)] font-mono">
                  {data?.shellProbe?.ok ? 'Probe passed' : 'Probe not confirmed'}
                </div>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Probe stdout</p>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono text-[var(--foreground)] min-h-16">{data?.shellProbe?.output || 'No backend shell output captured yet.'}</pre>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Probe stderr / status</p>
                <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono text-[var(--foreground)] min-h-16">{data?.shellProbe?.error || data?.shellProbe?.stderr || data?.note || 'No stderr.'}</pre>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
