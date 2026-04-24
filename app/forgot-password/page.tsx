"use client"

import { FormEvent, useState } from "react"
import AuthShell from "../components/AuthShell"

export default function ForgotPasswordPage() {
  const [recoveryToken, setRecoveryToken] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage("")
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.")
      return
    }

    setBusy(true)
    try {
      const response = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recoveryToken, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not reset password.")
      setMessage("Password reset. Redirecting...")
      window.setTimeout(() => {
        window.location.href = "/"
      }, 600)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not reset password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Forgot Password?" description="Use the local recovery token from .env.local to reset the operator password.">
      <form onSubmit={submit} className="space-y-5">
        <label className="block space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Recovery Token</span>
          <input
            type="password"
            value={recoveryToken}
            onChange={(event) => setRecoveryToken(event.target.value)}
            autoFocus
            className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">New Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Confirm Password</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
          />
        </label>

        {message && (
          <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
            {message}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
        >
          {busy ? "Resetting..." : "Reset Password"}
        </button>

        <a href="/login" className="block text-center text-xs text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Back to Sign In</a>
      </form>
    </AuthShell>
  )
}
