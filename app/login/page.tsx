"use client"

import { FormEvent, useEffect, useState } from "react"
import AuthShell from "../components/AuthShell"

export default function LoginPage() {
  const [nextPath, setNextPath] = useState("/")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [oauthLoginUrl, setOauthLoginUrl] = useState<string | null>(null)

  useEffect(() => {
    setNextPath(new URLSearchParams(window.location.search).get("next") || "/")

    fetch("/api/auth/login")
      .then((res) => res.json())
      .then((data) => {
        if (data.oauthLoginUrl) {
          setOauthLoginUrl(data.oauthLoginUrl)
        }
      })
      .catch(() => null)
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, next: nextPath }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Login failed")
      // Browsers carry the original URL fragment through a server redirect when
      // the redirect target has no fragment of its own. Reattach it on the way
      // back so deep-links like `#token=…` survive a login round-trip.
      const carryHash = typeof window !== "undefined" ? window.location.hash : ""
      const nextUrl = data.next || "/"
      window.location.href = carryHash && !nextUrl.includes("#") ? `${nextUrl}${carryHash}` : nextUrl
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="OpenShell Control" description="Operator access is required for sandbox control.">
      <form onSubmit={submit} className="space-y-6">
        <label className="block space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
          />
        </label>

        {message && (
          <div className="rounded-sm border border-[var(--status-stopped)] bg-red-950/20 p-3 text-xs text-[var(--status-stopped)]">
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
        >
          {busy ? "Signing In..." : "Sign In"}
        </button>

        {oauthLoginUrl && (
          <>
            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-[var(--border-subtle)]"></div>
              <span className="flex-shrink mx-4 text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider font-mono">Or</span>
              <div className="flex-grow border-t border-[var(--border-subtle)]"></div>
            </div>

            <a
              href={`${oauthLoginUrl}${oauthLoginUrl.includes("?") ? "&" : "?"}state=${encodeURIComponent(nextPath)}`}
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-[var(--foreground)] hover:border-[var(--nvidia-green)] hover:text-[var(--nvidia-green)] transition-all text-center block"
            >
              Sign In via Company Portal
            </a>
          </>
        )}

        <div className="flex items-center justify-between text-xs">
          <a href="/setup-account" className="text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Security</a>
          <a href="/forgot-password" className="text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Forgot Password?</a>
        </div>
      </form>
    </AuthShell>
  )
}

