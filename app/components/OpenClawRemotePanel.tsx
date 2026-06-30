"use client"
import { useCallback, useEffect, useState } from 'react'

type OpenClawRemoteAccess = {
  sandbox: string
  gatewayPort: number
  hostPort: number
  token: string
  host: string
  port: number
  url: string
  updatedAt: string
}

type FetchState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'ready'; access: OpenClawRemoteAccess; healthy: boolean | null }
  | { status: 'error'; message: string }

export default function OpenClawRemotePanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`)
      if (res.status === 404) {
        setState({ status: 'unconfigured' })
        return
      }
      const data = await res.json()
      if (!res.ok || !data?.access) {
        setState({ status: 'error', message: data?.error || `Request failed (${res.status})` })
        return
      }
      setState({ status: 'ready', access: data.access, healthy: null })
      // Reachability: the gateway also serves HTTP on the same port, so a plain
      // GET to the https:// form of the URL should answer if the route is live.
      try {
        const httpsUrl = String(data.access.url).replace(/^wss:/, 'https:')
        const probe = await fetch(httpsUrl, { signal: AbortSignal.timeout(8000) })
        setState({ status: 'ready', access: data.access, healthy: probe.ok || probe.status > 0 })
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
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`, { method: 'POST' })
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
    return <p className="text-xs text-[var(--foreground-dim)]">Loading mobile-app gateway access…</p>
  }

  if (state.status === 'unconfigured') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--foreground-dim)]">
          This OpenClaw sandbox is not yet exposed for the OpenClaw mobile apps.
        </p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Enabling…' : 'Enable mobile-app gateway access'}
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--status-pending)]">{state.message}</p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Retrying…' : 'Retry exposure'}
        </button>
      </div>
    )
  }

  const { access, healthy } = state
  const maskedToken = `${access.token.slice(0, 4)}…${access.token.slice(-4)}`

  const Row = ({ label, value, copyKey }: { label: string; value: string; copyKey: string }) => (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">{label}</span>
      <span className="truncate text-[var(--foreground)]">{value}</span>
      <button onClick={() => copy(copyKey, value)} className="action-button px-2 py-1 shrink-0">
        {copied === copyKey ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2 font-mono text-xs">
        <Row label="Host" value={access.host} copyKey="host" />
        <Row label="Port" value={String(access.port)} copyKey="port" />
        <Row label="URL" value={access.url} copyKey="url" />
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
        </div>
      </div>

      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
        <p className="font-semibold uppercase tracking-wider text-[var(--foreground)]">OpenClaw mobile app setup</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>Open the app → <span className="font-mono">Connect</span> tab → <span className="font-mono">Manual / Advanced</span></li>
          <li>Host <span className="font-mono">{access.host}</span>, Port <span className="font-mono">{access.port}</span>, TLS / <span className="font-mono">wss://</span> on</li>
          <li>Paste the Token as the gateway auth token, then connect</li>
          <li>Approve the pairing request on the gateway host: <span className="font-mono">openclaw devices approve --latest</span></li>
        </ol>
        <p className="mt-2">
          The token is the gateway shared secret — the app sends it in the connection (<span className="font-mono">connect</span>) frame; it is not part of the URL.
        </p>
      </div>

      {healthy === false && (
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Repairing…' : 'Retry exposure'}
        </button>
      )}
    </div>
  )
}
