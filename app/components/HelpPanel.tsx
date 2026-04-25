"use client"

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

export default function HelpPanel() {
  return (
    <div className="space-y-6">
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
    </div>
  )
}
