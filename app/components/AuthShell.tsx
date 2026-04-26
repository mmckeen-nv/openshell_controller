"use client"

import type { ReactNode } from "react"

export default function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex items-center justify-center p-6">
      <section className="panel w-full max-w-md p-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold uppercase tracking-wider text-[var(--foreground)]">{title}</h1>
          <p className="text-xs text-[var(--foreground-dim)]">{description}</p>
        </div>
        {children}
      </section>
    </main>
  )
}
