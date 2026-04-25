"use client"

import { useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

interface SandboxArchivePanelProps {
  sandbox: SandboxInventoryItem
  onRestoreComplete?: () => Promise<void> | void
}

export default function SandboxArchivePanel({ sandbox, onRestoreComplete }: SandboxArchivePanelProps) {
  const [backupPath, setBackupPath] = useState("/sandbox")
  const [restorePath, setRestorePath] = useState("/sandbox")
  const [restoreReplace, setRestoreReplace] = useState(false)
  const [selectedArchive, setSelectedArchive] = useState<File | null>(null)
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null)
  const [message, setMessage] = useState("")

  async function backupSandbox() {
    if (!backupPath.trim() || busy) return
    try {
      setBusy("backup")
      setMessage("")
      const pathToBackup = backupPath.trim()
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/backup?${new URLSearchParams({ path: pathToBackup })}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to create sandbox backup")
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("content-disposition") || ""
      const fileName = decodeURIComponent(contentDisposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
        || contentDisposition.match(/filename="([^"]+)"/)?.[1]
        || `${sandbox.name}-backup.tar.gz`
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setMessage(`Created backup for ${pathToBackup}: ${fileName}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to create sandbox backup")
    } finally {
      setBusy(null)
    }
  }

  async function restoreSandbox() {
    if (!selectedArchive || !restorePath.trim() || busy) return
    try {
      setBusy("restore")
      setMessage("")
      const form = new FormData()
      form.set("archive", selectedArchive)
      form.set("targetPath", restorePath.trim())
      form.set("replace", restoreReplace ? "true" : "false")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/restore`, {
        method: "POST",
        body: form,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to restore sandbox backup")
      setMessage(data.note || `Restored ${selectedArchive.name} into ${restorePath.trim()}.`)
      await onRestoreComplete?.()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to restore sandbox backup")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 max-lg:flex-col">
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Backup / Restore</h5>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">
            Export sandbox contents as a compressed archive, or restore an archive into this sandbox.
          </p>
        </div>
        <span className="status-chip border border-[var(--border-subtle)] bg-[var(--background)] px-2.5 py-1 text-[var(--foreground-dim)]">
          tar.gz
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4 space-y-3">
          <div>
            <h6 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--foreground)]">Backup</h6>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Archive a directory for cold storage or cloning.</p>
          </div>
          <label className="block space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Source Directory</span>
            <input
              value={backupPath}
              onChange={(event) => setBackupPath(event.target.value)}
              placeholder="/sandbox"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
            />
          </label>
          <button
            type="button"
            onClick={backupSandbox}
            disabled={!backupPath.trim() || busy !== null}
            className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
          >
            {busy === "backup" ? "Creating Backup..." : "Download Backup"}
          </button>
        </div>

        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4 space-y-3">
          <div>
            <h6 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--foreground)]">Restore</h6>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Merge into the target directory, or replace it first.</p>
          </div>
          <input
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            onChange={(event) => setSelectedArchive(event.target.files?.[0] || null)}
            className="block w-full text-xs text-[var(--foreground-dim)] file:mr-3 file:rounded-sm file:border file:border-[var(--border-subtle)] file:bg-[var(--background-tertiary)] file:px-3 file:py-2 file:text-xs file:font-mono file:uppercase file:text-[var(--foreground)]"
          />
          <label className="block space-y-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Target Directory</span>
            <input
              value={restorePath}
              onChange={(event) => setRestorePath(event.target.value)}
              placeholder="/sandbox"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
            />
          </label>
          <label className="flex items-start gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
            <input
              type="checkbox"
              checked={restoreReplace}
              onChange={(event) => setRestoreReplace(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--nvidia-green)]"
            />
            <span>
              <span className="block text-xs font-mono uppercase tracking-wider text-[var(--foreground)]">Replace target contents</span>
              <span className="mt-1 block text-[11px] text-[var(--foreground-dim)]">Deletes existing files in the target directory before extracting.</span>
            </span>
          </label>
          <button
            type="button"
            onClick={restoreSandbox}
            disabled={!selectedArchive || !restorePath.trim() || busy !== null}
            className="action-button px-4 py-2"
          >
            {busy === "restore" ? "Restoring..." : "Restore Archive"}
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">
          {message}
        </div>
      )}
    </div>
  )
}
