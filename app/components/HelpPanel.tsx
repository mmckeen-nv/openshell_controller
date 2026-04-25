"use client"

import { useEffect, useMemo, useState } from "react"
import ActivityPanel from "./ActivityPanel"
import SandboxHealthPanel from "./SandboxHealthPanel"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

const helpSections = [
  {
    title: "Daily Flow",
    items: [
      "Select a sandbox to reveal operations, file transfer, inference routes, policy, and archive tools.",
      "Use Operator Terminal after selecting a sandbox; the terminal opens in a separate tab for that sandbox session.",
      "Use Refresh Inventory when a create, restore, restart, or destroy operation is still settling.",
    ],
  },
  {
    title: "Create And Clone",
    items: [
      "Create Sandbox builds a new sandbox from a blueprint or custom OpenShell sandbox template.",
      "Restore from Backup can hydrate a fresh sandbox immediately after it reaches Ready.",
      "Wizards includes a guided Clone Sandbox workflow that creates a target sandbox and restores a source backup into it.",
      "For cloning, keep Replace target contents enabled and restore into /sandbox.",
    ],
  },
  {
    title: "Files",
    items: [
      "File Transfer uploads local files into /sandbox or /tmp and downloads regular files back out.",
      "The file browser lists one directory at a time; select a directory to enter it or use Up to move back.",
      "Large file transfers are limited by SANDBOX_FILE_TRANSFER_MAX_BYTES, currently defaulting to 128 MiB.",
    ],
  },
  {
    title: "Backup / Restore",
    items: [
      "Backup downloads a compressed .tar.gz archive from a sandbox directory, usually /sandbox.",
      "Save to Catalog stores a backup on the controller host for later cloning or redeploying.",
      "Restore extracts a .tar.gz archive into the selected sandbox path.",
      "Replace target contents deletes existing files in the target directory before extraction; merge leaves existing files in place.",
    ],
  },
  {
    title: "Policy And Network",
    items: [
      "Sandbox Policy is where pending network permission requests appear for approval or rejection.",
      "Dynamic network policy changes can apply live; static filesystem policy changes may require recreating the sandbox.",
      "Inference Routes configure model/provider routing for the selected sandbox.",
    ],
  },
  {
    title: "Safety",
    items: [
      "Destroy Sandbox is permanent. Back up anything important first.",
      "Restore rejects unsafe archive paths, but only restore archives you trust.",
      "If the UI looks stale after code changes, hard refresh the browser; the dev server is on 192.168.50.81:3000.",
    ],
  },
]

function HealthAccordion({ sandboxes }: { sandboxes: SandboxInventoryItem[] }) {
  const [open, setOpen] = useState(true)
  const [selectedSandboxId, setSelectedSandboxId] = useState("")
  const selectedSandbox = useMemo(
    () => sandboxes.find((sandbox) => sandbox.id === selectedSandboxId) || sandboxes[0] || null,
    [sandboxes, selectedSandboxId],
  )

  useEffect(() => {
    if (!selectedSandboxId && sandboxes[0]) {
      setSelectedSandboxId(sandboxes[0].id)
    }
  }, [sandboxes, selectedSandboxId])

  return (
    <section className="panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 p-5 text-left"
      >
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">Operator Checks</p>
          <h2 className="mt-1 text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Sandbox Health</h2>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">OpenShell reachability, runtime state, SSH config, and backup coverage.</p>
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--foreground-dim)] transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && (
        <div className="space-y-4 border-t border-[var(--border-subtle)] p-5">
          {sandboxes.length > 1 && (
            <label className="block max-w-lg space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Sandbox</span>
              <select
                value={selectedSandbox?.id || ""}
                onChange={(event) => setSelectedSandboxId(event.target.value)}
                className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:border-[var(--nvidia-green)] focus:outline-none"
              >
                {sandboxes.map((sandbox) => (
                  <option key={sandbox.id} value={sandbox.id}>
                    {sandbox.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selectedSandbox ? (
            <SandboxHealthPanel sandbox={selectedSandbox} />
          ) : (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4 text-sm text-[var(--foreground-dim)]">
              No sandboxes are available for health checks yet.
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default function HelpPanel({ sandboxes }: { sandboxes: SandboxInventoryItem[] }) {
  return (
    <div className="space-y-6">
      <HealthAccordion sandboxes={sandboxes} />

      <section className="panel p-8">
        <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">Operator Guide</p>
        <h1 className="mt-2 text-xl font-semibold uppercase tracking-wider text-[var(--foreground)]">Help</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-dim)]">
          Quick reference for running sandboxes, moving files, preserving work, and cloning a prepared environment.
        </p>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {helpSections.map((section) => (
          <article key={section.title} className="panel p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{section.title}</h2>
            <ul className="mt-4 space-y-3">
              {section.items.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-[var(--foreground-dim)]">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--nvidia-green)]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="panel p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Common Paths</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            ["/sandbox", "Primary writable workspace for persisted sandbox contents."],
            ["/tmp", "Scratch space for short-lived files and transfer staging."],
            ["Backup .tar.gz", "Portable archive for cold storage, cloning, and redeploying."],
          ].map(([label, body]) => (
            <div key={label} className="metric p-4">
              <p className="font-mono text-xs text-[var(--nvidia-green)]">{label}</p>
              <p className="mt-2 text-xs leading-5 text-[var(--foreground-dim)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <ActivityPanel />
    </div>
  )
}
