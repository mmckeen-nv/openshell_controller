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
          <div className="w-9 h-9 bg-[var(--nvidia-green)] rounded-sm flex items-center justify-center">
            <svg className="w-5 h-5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 11V7a4 4 0 00-8 0v4m12 0V7a4 4 0 00-8 0m-2 4h12v10H6V11z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold uppercase tracking-wider text-[var(--foreground)]">{title}</h1>
          <p className="text-xs text-[var(--foreground-dim)]">{description}</p>
        </div>
        {children}
      </section>
    </main>
  )
}
