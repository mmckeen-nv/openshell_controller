"use client"

import { useEffect, useMemo, useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

type SandboxFileEntry = {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size: number | null
  modifiedAt: string | null
}

type SandboxFileListing = {
  path: string
  entries: SandboxFileEntry[]
  truncated: boolean
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "-"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function parentPath(currentPath: string) {
  const trimmed = currentPath.replace(/\/+$/, "")
  if (trimmed === "/sandbox" || trimmed === "/tmp") return trimmed
  const parent = trimmed.split("/").slice(0, -1).join("/") || "/sandbox"
  return parent === "" ? "/sandbox" : parent
}

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
  const [listPath, setListPath] = useState("/sandbox")
  const [listing, setListing] = useState<SandboxFileListing | null>(null)
  const [listingBusy, setListingBusy] = useState(false)
  const [message, setMessage] = useState("")

  const suggestedUploadPath = useMemo(() => {
    if (!selectedFile) return uploadPath
    return uploadPath.endsWith("/") ? `${uploadPath}${selectedFile.name}` : uploadPath
  }, [selectedFile, uploadPath])

  const sortedEntries = useMemo(() => {
    return [...(listing?.entries || [])].sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1
      if (left.type !== "directory" && right.type === "directory") return 1
      return left.name.localeCompare(right.name)
    })
  }, [listing])

  async function loadFileList(nextPath = listPath) {
    if (listingBusy) return
    try {
      setListingBusy(true)
      setMessage("")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/list?${new URLSearchParams({ path: nextPath.trim() || "/sandbox" })}`, {
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to list sandbox files")
      setListing(data.listing)
      setListPath(data.listing.path)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to list sandbox files")
    } finally {
      setListingBusy(false)
    }
  }

  useEffect(() => {
    setListPath("/sandbox")
    setDownloadPath("/sandbox/")
    setListing(null)
  }, [sandbox.id])

  useEffect(() => {
    loadFileList("/sandbox")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox.id])

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
      await loadFileList(listPath)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to upload file")
    } finally {
      setBusy(null)
    }
  }

  async function downloadFile(pathOverride?: string) {
    const pathToDownload = (pathOverride || downloadPath).trim()
    if (!pathToDownload || busy) return
    try {
      setBusy("download")
      setMessage("")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/download?${new URLSearchParams({ path: pathToDownload })}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to download file")
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("content-disposition") || ""
      const fileName = decodeURIComponent(contentDisposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
        || contentDisposition.match(/filename="([^"]+)"/)?.[1]
        || pathToDownload.split("/").filter(Boolean).pop()
        || "download.bin"
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setMessage(`Downloaded ${pathToDownload}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to download file")
    } finally {
      setBusy(null)
    }
  }

  const openEntry = (entry: SandboxFileEntry) => {
    if (entry.type === "directory") {
      setListPath(entry.path)
      loadFileList(entry.path)
      return
    }
    setDownloadPath(entry.path)
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

      <div className={`${showHeader ? "mt-5" : ""} grid grid-cols-1 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)] gap-5`}>
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
            className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
          >
            {busy === "upload" ? "Uploading..." : "Upload File"}
          </button>
        </section>

        <section className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Download</h5>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Browse sandbox files or enter a regular file path under /sandbox or /tmp.</p>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]">
            <input
              value={listPath}
              onChange={(event) => setListPath(event.target.value)}
              placeholder="/sandbox"
              className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
            />
            <button
              type="button"
              onClick={() => loadFileList(listPath)}
              disabled={listingBusy}
              className="action-button px-3 py-2"
            >
              {listingBusy ? "Loading..." : "List"}
            </button>
            <button
              type="button"
              onClick={() => loadFileList(parentPath(listPath))}
              disabled={listingBusy || listPath === "/sandbox" || listPath === "/tmp"}
              className="action-button px-3 py-2"
            >
              Up
            </button>
          </div>
          <div className="overflow-hidden rounded-sm border border-[var(--border-subtle)] bg-[var(--background)]">
            <div className="grid grid-cols-[1fr_84px_116px_76px] gap-3 border-b border-[var(--border-subtle)] px-3 py-2 text-[10px] uppercase tracking-wider text-[var(--foreground-dim)] max-md:grid-cols-[1fr_72px]">
              <span>Name</span>
              <span className="max-md:hidden">Size</span>
              <span className="max-md:hidden">Modified</span>
              <span className="text-right">Action</span>
            </div>
            <div className="max-h-72 overflow-auto">
              {listingBusy ? (
                <div className="px-3 py-8 text-center text-xs font-mono uppercase tracking-wider text-[var(--foreground-dim)]">
                  Reading sandbox directory...
                </div>
              ) : sortedEntries.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-[var(--foreground-dim)]">
                  {listing ? "No files found in this directory." : "File list has not loaded yet."}
                </div>
              ) : (
                sortedEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className="grid grid-cols-[1fr_84px_116px_76px] items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0 hover:bg-[var(--surface-hover)] max-md:grid-cols-[1fr_72px]"
                  >
                    <button
                      type="button"
                      onClick={() => openEntry(entry)}
                      className="min-w-0 text-left"
                      title={entry.path}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${entry.type === "directory" ? "bg-[var(--nvidia-green)]" : "bg-[var(--foreground-dim)]"}`} />
                        <span className="truncate text-xs font-mono text-[var(--foreground)]">{entry.name}</span>
                      </span>
                    </button>
                    <span className="text-xs font-mono text-[var(--foreground-dim)] max-md:hidden">{entry.type === "directory" ? "dir" : formatBytes(entry.size)}</span>
                    <span className="text-xs font-mono text-[var(--foreground-dim)] max-md:hidden">
                      {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString() : "-"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setDownloadPath(entry.path)
                        if (entry.type !== "directory") {
                          downloadFile(entry.path)
                        }
                      }}
                      disabled={entry.type === "directory" || busy !== null}
                      className="action-button px-2 py-1 text-right disabled:opacity-30"
                    >
                      Get
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          {listing?.truncated && (
            <p className="text-[11px] text-[var(--foreground-dim)]">
              Showing the first 200 entries. Narrow the path to see more.
            </p>
          )}
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
            onClick={() => downloadFile()}
            disabled={!downloadPath.trim() || busy !== null}
            className="action-button px-4 py-2"
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
