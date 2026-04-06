"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface IntrospectResponse {
  ok: boolean
  sandboxId?: string
  containers?: string[]
  images?: string[]
  runningStatuses?: string[]
  stderr?: string
  note?: string
  error?: string
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const SSH_ALIAS = 'ssh openshell-my-assistant'
const SSH_FALLBACK = 'ssh -i ~/.ssh/id_ed25519_openclaw_labmac openshell-my-assistant'

export default function OperatorTerminalPage() {
  const searchParams = useSearchParams()
  const sandboxId = searchParams.get('sandboxId')
  const [state, setState] = useState<LoadState>(sandboxId ? 'loading' : 'idle')
  const [data, setData] = useState<IntrospectResponse | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState<string>('')

  const refreshReadiness = useCallback(async () => {
    if (!sandboxId) {
      setState('idle')
      setData(null)
      return
    }

    setState('loading')
    setCopyMessage('')

    try {
      const response = await fetch(`/api/openshell/terminal/introspect?sandboxId=${encodeURIComponent(sandboxId)}`, {
        cache: 'no-store',
      })
      const result: IntrospectResponse = await response.json()
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
        detail: 'Verifying pod metadata so the page can show a truthful operator handoff.',
      }
    }

    if (state === 'ready' && data?.ok) {
      return {
        tone: 'border-[var(--status-running)] text-[var(--status-running)]',
        label: 'READY FOR LOCAL SSH ATTACH',
        detail: 'This page confirms the sandbox exists. Interactive PTY embedding is not wired up yet, so attach from your local terminal.',
      }
    }

    return {
      tone: 'border-[var(--status-stopped)] text-[var(--status-stopped)]',
      label: 'READINESS CHECK FAILED',
      detail: 'The dashboard could not confirm pod metadata. Use the recovery commands below, then retry.',
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

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--foreground-dim)] font-mono">Operator path</p>
            <h1 className="text-2xl font-semibold uppercase tracking-wider mt-2">Operator Terminal</h1>
            <p className="text-sm text-[var(--foreground-dim)] mt-3 max-w-2xl">
              Truthful first render for the current terminal path. This page does not pretend to host an embedded shell; it verifies readiness and tells the operator exactly how to attach.
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
                  Preferred path is the SSH alias. If your shell environment is missing the alias or key wiring, use the explicit fallback.
                </p>
              </div>
              <button
                onClick={refreshReadiness}
                className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
              >
                Retry Readiness Check
              </button>
            </div>

            <div className="space-y-3">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Preferred attach command</p>
                <code className="block mt-2 text-sm font-mono text-[var(--nvidia-green)] break-all">{SSH_ALIAS}</code>
                <button
                  onClick={() => copyCommand(SSH_ALIAS)}
                  className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
                >
                  Copy Alias Command
                </button>
              </div>

              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Fallback if alias or agent config is missing</p>
                <code className="block mt-2 text-sm font-mono text-[var(--foreground)] break-all">{SSH_FALLBACK}</code>
                <p className="text-xs text-[var(--foreground-dim)] mt-2">
                  If your non-interactive shell misses Homebrew tooling, retry from a login shell or prepend <span className="font-mono text-[var(--foreground)]">PATH=/opt/homebrew/bin:$PATH</span> before related helper commands.
                </p>
                <button
                  onClick={() => copyCommand(SSH_FALLBACK)}
                  className="mt-3 px-3 py-2 rounded-sm border border-[var(--border-subtle)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)]"
                >
                  Copy Fallback Command
                </button>
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
                Live pod introspection from the dashboard backend. This is the page’s truth source until persistent PTY transport exists.
              </p>
            </div>

            <div className="space-y-3 text-sm">
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Containers</p>
                <p className="mt-2 font-mono break-words">{data?.containers?.length ? data.containers.join(', ') : 'Unavailable'}</p>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Images</p>
                <p className="mt-2 font-mono break-words">{data?.images?.length ? data.images.join(', ') : 'Unavailable'}</p>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Running statuses</p>
                <p className="mt-2 font-mono break-words">{data?.runningStatuses?.length ? data.runningStatuses.join(', ') : 'Unavailable'}</p>
              </div>
            </div>

            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--foreground-dim)] font-mono">Recovery notes</p>
              <ul className="mt-2 space-y-2 text-xs text-[var(--foreground-dim)] list-disc pl-4">
                <li>If readiness fails but SSH still works, use the local attach command and treat the dashboard as degraded, not authoritative.</li>
                <li>If SSH fails, verify the host alias and key path on the Mac first.</li>
                <li>If both fail, restart the dashboard/backend side and rerun the readiness check.</li>
              </ul>
            </div>

            {(data?.note || data?.error || data?.stderr) && (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)] space-y-2">
                {data?.note && <p><span className="text-[var(--foreground)]">Note:</span> {data.note}</p>}
                {data?.error && <p><span className="text-[var(--status-stopped)]">Error:</span> {data.error}</p>}
                {data?.stderr && <p><span className="text-[var(--foreground)]">stderr:</span> {data.stderr}</p>}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
