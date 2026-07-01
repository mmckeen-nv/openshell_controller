"use client"
import { useCallback, useEffect, useState } from 'react'

type HermesRemoteAccess = {
  sandbox: string
  mode: string
  port: number
  token: string
  url: string
  hermesVersion: string
  updatedAt: string
}

type FetchState =
  | { status: 'loading' }
  | { status: 'unconfigured'; mode: string }
  | { status: 'ready'; access: HermesRemoteAccess; healthy: boolean | null }
  | { status: 'error'; message: string }

export default function HermesRemotePanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/hermes-remote`)
      if (res.status === 404) {
        const data = await res.json().catch(() => ({}))
        setState({ status: 'unconfigured', mode: data?.mode || 'desktop' })
        return
      }
      const data = await res.json()
      if (!res.ok || !data?.access) {
        setState({ status: 'error', message: data?.error || `Request failed (${res.status})` })
        return
      }
      setState({ status: 'ready', access: data.access, healthy: null })
      // Health: the public /api/status must answer for the desktop app to work.
      try {
        const probe = await fetch(`${data.access.url}/api/status`, { signal: AbortSignal.timeout(8000) })
        setState({ status: 'ready', access: data.access, healthy: probe.ok })
      } catch {
        setState({ status: 'ready', access: data.access, healthy: false })
      }
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load remote access' })
    }
  }, [sandboxName])

  useEffect(() => {
    setTokenRevealed(false)
    void load()
  }, [load])

  const enable = async () => {
    setEnabling(true)
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/hermes-remote`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setState({ status: 'error', message: data?.error || `Enable failed (${res.status})` })
        return
      }
      await load()
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Enable failed' })
    } finally {
      setEnabling(false)
    }
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1800)
    } catch {
      // Clipboard unavailable; the value is visible for manual copy.
    }
  }

  if (state.status === 'loading') {
    return <p className="text-xs text-[var(--foreground-dim)]">Loading remote desktop access…</p>
  }

  if (state.status === 'unconfigured') {
    if (state.mode === 'off') {
      return (
        <p className="text-xs text-[var(--foreground-dim)]">
          Remote desktop exposure is disabled on this deployment (HERMES_REMOTE_MODE=off).
        </p>
      )
    }
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--foreground-dim)]">
          This Hermes sandbox is not yet exposed for the Hermes Desktop app.
        </p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Enabling… (up to 2 min)' : 'Enable remote desktop access'}
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--status-pending)]">{state.message}</p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Retrying… (up to 2 min)' : 'Retry exposure'}
        </button>
      </div>
    )
  }

  const { access, healthy } = state
  const maskedToken = `${access.token.slice(0, 4)}…${access.token.slice(-4)}`

  return (
    <div className="space-y-4">
      <div className="space-y-2 font-mono text-xs">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">Remote URL</span>
          <span className="truncate text-[var(--foreground)]">{access.url}</span>
          <button onClick={() => copy('url', access.url)} className="action-button px-2 py-1 shrink-0">
            {copied === 'url' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">Token</span>
          <span className="truncate text-[var(--foreground)]">{tokenRevealed ? access.token : maskedToken}</span>
          <button onClick={() => setTokenRevealed((v) => !v)} className="action-button px-2 py-1 shrink-0">
            {tokenRevealed ? 'Hide' : 'Reveal'}
          </button>
          <button onClick={() => copy('token', access.token)} className="action-button px-2 py-1 shrink-0">
            {copied === 'token' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">Status</span>
          {healthy === null ? (
            <span className="text-[var(--foreground-dim)]">checking…</span>
          ) : healthy ? (
            <span className="text-[var(--status-running)]">● Reachable</span>
          ) : (
            <span className="text-[var(--status-pending)]">● Unreachable — try “Retry exposure” below</span>
          )}
          <span className="text-[var(--foreground-dim)]">Backend {access.hermesVersion} · {access.mode} mode</span>
        </div>
      </div>

      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
        <p className="font-semibold uppercase tracking-wider text-[var(--foreground)]">Hermes Desktop setup</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>Settings → Gateway → choose <span className="font-mono">Remote gateway</span></li>
          <li>Paste the Remote URL, wait for the probe, then paste the Session token</li>
          <li>Save and reconnect</li>
        </ol>
        <p className="mt-2">
          The desktop app must run the same Hermes version as the backend ({access.hermesVersion}).
        </p>
      </div>

      {healthy === false && (
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Repairing… (up to 2 min)' : 'Retry exposure'}
        </button>
      )}
    </div>
  )
}
