"use client"

import { FormEvent, useCallback, useEffect, useState } from "react"
import AuthShell from "../components/AuthShell"

type AccessEntry = { sandboxName: string; email: string }
type AuthMe = { operator: boolean; configured: boolean }

export default function SecurityPage() {
  const [me, setMe] = useState<AuthMe | null>(null)

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setMe(data ?? { operator: false, configured: true }))
      .catch(() => setMe({ operator: false, configured: true }))
  }, [])

  const showPassword = me ? me.operator || !me.configured : false
  const showSandboxAccess = me?.operator === true
  const showLockedNotice = me ? !me.operator && me.configured : false

  return (
    <AuthShell title="Security" description="Manage the operator password and per-sandbox access for company users.">
      {me === null ? (
        <p className="text-xs text-[var(--foreground-dim)]">Loading…</p>
      ) : (
        <>
          {showPassword && <PasswordSection firstRun={!me.configured} />}
          {showPassword && showSandboxAccess && <div className="border-t border-[var(--border-subtle)]" />}
          {showSandboxAccess && <SandboxAccessSection />}
          {showLockedNotice && (
            <p className="text-xs text-[var(--foreground-dim)]">
              Operator session required to manage security settings. Sign in with the operator password to change the password or edit sandbox access.
            </p>
          )}
        </>
      )}
      <a href="/login" className="block text-center text-xs text-[var(--foreground-dim)] hover:text-[var(--nvidia-green)]">Back to Sign In</a>
    </AuthShell>
  )
}

function PasswordSection({ firstRun }: { firstRun: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("")
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
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not update account.")
      setMessage("Password updated. Redirecting…")
      window.setTimeout(() => { window.location.href = "/" }, 600)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update account.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-[var(--foreground)]">{firstRun ? "Set Password" : "Change Password"}</h2>
      {!firstRun && (
        <label className="block space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Current Password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
          />
        </label>
      )}

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
        {busy ? "Saving…" : "Save Password"}
      </button>
    </form>
  )
}

function SandboxAccessSection() {
  const [entries, setEntries] = useState<AccessEntry[]>([])
  const [sandboxOptions, setSandboxOptions] = useState<string[]>([])
  const [pickedSandbox, setPickedSandbox] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [loading, setLoading] = useState(true)
  const [authorized, setAuthorized] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/security/sandbox-access", { cache: "no-store" })
      if (response.status === 401) {
        setAuthorized(false)
        return
      }
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to load sandbox access list.")
      setAuthorized(true)
      setEntries(Array.isArray(data.entries) ? data.entries : [])
      setDirty(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load sandbox access list.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    fetch("/api/telemetry/real", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        const names: string[] = []
        if (Array.isArray(data.sandboxes)) {
          for (const s of data.sandboxes) if (typeof s?.name === "string") names.push(s.name)
        } else if (Array.isArray(data?.pods?.items)) {
          for (const p of data.pods.items) {
            const n = p?.metadata?.labels?.["nemoclaw.ai/sandbox-name"] || p?.metadata?.name
            if (typeof n === "string") names.push(n)
          }
        }
        const unique = Array.from(new Set(names)).sort()
        setSandboxOptions(unique)
        if (unique.length > 0) setPickedSandbox((prev) => prev || unique[0])
      })
      .catch(() => null)
  }, [load])

  const addEntry = () => {
    setMessage("")
    const sandboxName = pickedSandbox.trim()
    const email = newEmail.trim().toLowerCase()
    if (!sandboxName || !email) {
      setMessage("Pick a sandbox and enter an email.")
      return
    }
    if (entries.some((e) => e.sandboxName === sandboxName && e.email === email)) {
      setMessage("That sandbox/email pair is already in the list.")
      return
    }
    setEntries([...entries, { sandboxName, email }])
    setNewEmail("")
    setDirty(true)
  }

  const removeEntry = (index: number) => {
    setEntries(entries.filter((_, i) => i !== index))
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch("/api/security/sandbox-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save.")
      setEntries(Array.isArray(data.entries) ? data.entries : entries)
      setDirty(false)
      setMessage("Saved.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save.")
    } finally {
      setBusy(false)
    }
  }

  if (!authorized) {
    return (
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Sandbox Access</h2>
        <p className="text-xs text-[var(--foreground-dim)]">
          Sign in as an operator to manage per-sandbox access for company users.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <h2 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Sandbox Access</h2>
      <p className="text-xs text-[var(--foreground-dim)]">
        Authorize MCPAuth (company) users for specific sandboxes. Changes apply after the controller restarts.
      </p>

      {loading ? (
        <p className="text-xs text-[var(--foreground-dim)]">Loading…</p>
      ) : (
        <>
          <ul className="space-y-1">
            {entries.length === 0 && (
              <li className="text-xs text-[var(--foreground-dim)] italic">No assignments yet.</li>
            )}
            {entries.map((entry, index) => (
              <li
                key={`${entry.sandboxName}:${entry.email}:${index}`}
                className="flex items-center justify-between gap-2 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2 py-1.5 text-xs font-mono"
              >
                <span className="truncate text-[var(--foreground)]">{entry.sandboxName}</span>
                <span className="flex-1 truncate text-[var(--foreground-dim)]">{entry.email}</span>
                <button
                  type="button"
                  onClick={() => removeEntry(index)}
                  className="text-[var(--foreground-dim)] hover:text-[var(--status-stopped)]"
                  aria-label={`Remove ${entry.email} from ${entry.sandboxName}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className="space-y-2 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
            <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Add Assignment</span>
            {sandboxOptions.length > 0 ? (
              <select
                value={pickedSandbox}
                onChange={(event) => setPickedSandbox(event.target.value)}
                className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
              >
                {sandboxOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={pickedSandbox}
                onChange={(event) => setPickedSandbox(event.target.value)}
                placeholder="sandbox name"
                className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
              />
            )}
            <input
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              placeholder="user@example.com"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-[var(--nvidia-green)]"
            />
            <button
              type="button"
              onClick={addEntry}
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--foreground)] hover:border-[var(--nvidia-green)] hover:text-[var(--nvidia-green)]"
            >
              + Add
            </button>
          </div>

          {message && (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
              {message}
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="w-full rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
          >
            {busy ? "Saving…" : dirty ? "Save Sandbox Access" : "No Changes"}
          </button>
        </>
      )}
    </section>
  )
}
