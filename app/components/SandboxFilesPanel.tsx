"use client"

import { useMemo, useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

export default function SandboxFilesPanel({
  sandbox,
  embedded = false,
  showHeader = true,
}: {
  sandbox: SandboxInventoryItem
  embedded?: boolean
  showHeader?: boolean
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadPath, setUploadPath] = useState("/sandbox/")
  const [downloadPath, setDownloadPath] = useState("/sandbox/")
  const [busy, setBusy] = useState<"upload" | "download" | null>(null)
  const [message, setMessage] = useState("")

  const suggestedUploadPath = useMemo(() => {
    if (!selectedFile) return uploadPath
    return uploadPath.endsWith("/") ? `${uploadPath}${selectedFile.name}` : uploadPath
  }, [selectedFile, uploadPath])

  async function uploadFile() {
    if (!selectedFile || busy) return
    try {
      setBusy("upload")
      setMessage("")
      const form = new FormData()
      form.set("file", selectedFile)
      form.set("path", uploadPath)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/upload`, {
        method: "POST",
        body: form,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to upload file")
      setMessage(data.note || `Uploaded to ${data.uploaded?.path || suggestedUploadPath}.`)
      setDownloadPath(data.uploaded?.path || suggestedUploadPath)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to upload file")
    } finally {
      setBusy(null)
    }
  }

  async function downloadFile() {
    if (!downloadPath.trim() || busy) return
    try {
      setBusy("download")
      setMessage("")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/download?${new URLSearchParams({ path: downloadPath.trim() })}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to download file")
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("content-disposition") || ""
      const fileName = decodeURIComponent(contentDisposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
        || contentDisposition.match(/filename="([^"]+)"/)?.[1]
        || downloadPath.split("/").filter(Boolean).pop()
        || "download.bin"
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setMessage(`Downloaded ${downloadPath.trim()}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to download file")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={embedded ? "" : "panel p-6"}>
      {showHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
          <div>
            <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
              {sandbox.name} - FILE TRANSFER
            </h4>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">
              Move files through scoped sandbox paths.
            </p>
          </div>
        </div>
      )}

      <div className={`${showHeader ? "mt-5" : ""} grid grid-cols-1 lg:grid-cols-2 gap-5`}>
        <section className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Upload</h5>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Destination must be under /sandbox or /tmp.</p>
          </div>
          <input
            type="file"
            onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
            className="block w-full text-xs text-[var(--foreground-dim)] file:mr-3 file:rounded-sm file:border file:border-[var(--border-subtle)] file:bg-[var(--background)] file:px-3 file:py-2 file:text-xs file:font-mono file:uppercase file:text-[var(--foreground)]"
          />
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Destination Path</label>
            <input
              value={uploadPath}
              onChange={(event) => setUploadPath(event.target.value)}
              placeholder="/sandbox/file.txt"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
            />
            {selectedFile && (
              <p className="text-[11px] font-mono text-[var(--foreground-dim)]">Target: {suggestedUploadPath}</p>
            )}
          </div>
          <button
            onClick={uploadFile}
            disabled={!selectedFile || busy !== null}
            className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50"
          >
            {busy === "upload" ? "Uploading..." : "Upload File"}
          </button>
        </section>

        <section className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Download</h5>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Enter a regular file path under /sandbox or /tmp.</p>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Source Path</label>
            <input
              value={downloadPath}
              onChange={(event) => setDownloadPath(event.target.value)}
              placeholder="/sandbox/file.txt"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
            />
          </div>
          <button
            onClick={downloadFile}
            disabled={!downloadPath.trim() || busy !== null}
            className="px-4 py-2 rounded-sm bg-[var(--background)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)] disabled:opacity-50"
          >
            {busy === "download" ? "Downloading..." : "Download File"}
          </button>
        </section>
      </div>

      {message && (
        <div className="mt-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">
          {message}
        </div>
      )}
    </div>
  )
}
