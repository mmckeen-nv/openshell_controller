"use client"

import { FormEvent, useEffect, useState } from "react"
import AuthShell from "../components/AuthShell"

export default function LoginPage() {
  const [nextPath, setNextPath] = useState("/")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setNextPath(new URLSearchParams(window.location.search).get("next") || "/")
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
      window.location.href = data.next || "/"
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

        <div className="flex items-center justify-between text-xs">
          <a href="/setup-account" className="text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Setup Account</a>
          <a href="/forgot-password" className="text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Forgot Password?</a>
        </div>
      </form>
    </AuthShell>
  )
}
