"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

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

interface CommandRunResponse {
  ok: boolean
  command?: string
  executionMode?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  error?: string
  note?: string
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
  const [commandInput, setCommandInput] = useState<string>('pwd && whoami')
  const [commandState, setCommandState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [commandResult, setCommandResult] = useState<CommandRunResponse | null>(null)

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

  useEffect(() => {
    refreshReadiness()
  }, [refreshReadiness])

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
        label: 'TERMINAL PATH VERIFIED',
        detail: 'The dashboard confirmed the pod is ready and a bounded backend shell exec succeeded. Interactive PTY embedding is still not wired up, but this path now proves command execution reachability without requiring a second manual probe.',
      }
    }

    if (state === 'ready' && data?.ok && data?.podExists && data?.degraded) {
      return {
        tone: 'border-[var(--status-pending)] text-[var(--status-pending)]',
        label: 'DEGRADED: POD UP, SHELL UNCONFIRMED',
        detail: 'The pod exists, but the bounded shell probe did not succeed from the dashboard backend. Treat the page as degraded and try the local SSH attach path.',
      }
    }

    if (state === 'ready' && data?.ok && data?.podExists) {
      return {
        tone: 'border-[var(--status-running)] text-[var(--status-running)]',
        label: 'READY FOR LOCAL SSH ATTACH',
        detail: 'The dashboard confirmed pod metadata. Use the attach commands below while persistent PTY transport is still pending.',
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

  const runCommand = useCallback(async () => {
    if (!sandboxId) {
      setCommandState('error')
      setCommandResult({ ok: false, error: 'Select a sandbox before running a command.' })
      return
    }

    setCommandState('running')
    setCommandResult(null)

    try {
      const response = await fetch('/api/openshell/terminal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sandboxId,
          command: commandInput,
        }),
      })
      const result: CommandRunResponse = await response.json()
      setCommandResult(result)
      setCommandState(response.ok && result.ok ? 'done' : 'error')
    } catch (error) {
      setCommandResult({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to run dashboard command.',
      })
      setCommandState('error')
    }
  }, [commandInput, sandboxId])

  const aliasCommand = data?.attach?.aliasCommand || defaultAlias(sandboxId)
  const fallbackCommand = data?.attach?.fallbackCommand || defaultFallback(sandboxId)
  const loginShellCommand = data?.attach?.loginShellCommand || defaultLoginShell(sandboxId)
  const shellHint = data?.attach?.shellHint || DEFAULT_SHELL_HINT

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--foreground-dim)] font-mono">Operator path</p>
            <h1 className="text-2xl font-semibold uppercase tracking-wider mt-2">Operator Terminal</h1>
            <p className="text-sm text-[var(--foreground-dim)] mt-3 max-w-2xl">
              Truthful operator render for the current terminal path. This page still does not pretend to host an embedded PTY, but it now checks pod readiness and bounded shell reachability together before telling you how to attach.
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

        <section className="grid grid-cols-1 xl:grid-cols-[1.25fr_0.9fr] gap-6">
          <div className="panel p-6 space-y-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Attach Instructions</h3>
                <p className="text-xs text-[var(--foreground-dim)] mt-2">
                  Preferred path is the SSH alias. If your shell environment is missing the alias or key wiring, use the explicit fallback. The readiness check below is now the page&apos;s single preflight source.
                </p>
              </div>
              <button
                onClick={refreshReadiness}
                className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
              >
                Refresh Terminal Readiness
              </button>
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

            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Bounded shell reachability</p>
                  <p className="text-xs text-[var(--foreground-dim)] mt-2">
                    This is now captured as part of the readiness contract, so the page can show command execution reachability immediately on load.
                  </p>
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

            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Bounded dashboard command runner</p>
                  <p className="text-xs text-[var(--foreground-dim)] mt-2">
                    Minimal in-dashboard execution while PTY transport is still pending. Runs a single bounded command through the dashboard backend against the selected sandbox.
                  </p>
                </div>
                <div className="text-[11px] text-[var(--foreground-dim)] font-mono">
                  {commandState === 'running' ? 'Running…' : commandState === 'done' ? 'Last run succeeded' : commandState === 'error' ? 'Last run failed' : 'Idle'}
                </div>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Command</span>
                <textarea
                  value={commandInput}
                  onChange={(event) => setCommandInput(event.target.value)}
                  spellCheck={false}
                  rows={3}
                  className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:border-[var(--nvidia-green)] focus:outline-none"
                  placeholder="pwd && whoami"
                />
              </label>

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={runCommand}
                  disabled={commandState === 'running' || !sandboxId}
                  className="px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {commandState === 'running' ? 'Running Command…' : 'Run Bounded Command'}
                </button>
                <p className="text-[11px] text-[var(--foreground-dim)] font-mono">One-shot only. No persistent PTY state yet.</p>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Command stdout</p>
                  <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono text-[var(--foreground)] min-h-16">{commandResult?.stdout || 'No command output yet.'}</pre>
                </div>

                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Command stderr / status</p>
                    {typeof commandResult?.exitCode === 'number' && (
                      <span className="text-[10px] font-mono text-[var(--foreground-dim)]">
                        exit {commandResult.exitCode}{commandResult.executionMode ? ` · ${commandResult.executionMode}` : ''}
                      </span>
                    )}
                  </div>
                  <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono text-[var(--foreground)] min-h-16">{commandResult?.error || commandResult?.stderr || commandResult?.note || 'No stderr.'}</pre>
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
                Live pod introspection and bounded shell evidence from the dashboard backend. This is the page&apos;s truth source until persistent PTY transport exists.
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
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Running statuses</p>
                <p className="mt-2 font-mono break-words">{data?.pod?.runningStatuses?.length ? data.pod.runningStatuses.join(', ') : 'Unavailable'}</p>
              </div>
            </div>

            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Recovery notes</p>
              <ul className="mt-2 space-y-2 text-xs text-[var(--foreground-dim)] list-disc pl-4">
                <li>If the dashboard reports degraded but SSH still works, use the local attach command and treat the dashboard as degraded, not authoritative.</li>
                <li>If SSH fails, verify the Mac host alias and key path first: <span className="font-mono text-[var(--foreground)]">~/.ssh/id_ed25519_openclaw_labmac</span>.</li>
                <li>If helper commands miss Homebrew binaries in non-interactive mode, use a login shell or prepend <span className="font-mono text-[var(--foreground)]">PATH=/opt/homebrew/bin:$PATH</span>.</li>
              </ul>
            </div>

            {(data?.note || data?.error) && (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)] space-y-2">
                {data?.note && <p><span className="text-[var(--foreground)]">Note:</span> {data.note}</p>}
                {data?.error && <p><span className="text-[var(--status-stopped)]">Error:</span> {data.error}</p>}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
