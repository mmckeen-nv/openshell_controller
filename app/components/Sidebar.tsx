"use client"

interface SidebarProps {
  sandboxesRunning: number
  sandboxesTotal: number
  activeView: 'settings' | 'sandboxes' | 'help' | 'wizards'
  isCreateMode: boolean
  isDestroyMode: boolean
  onSandboxesClick: () => void
  onCreateClick: () => void
  onDestroyClick: () => void
  onTerminalClick: () => void
  onSettingsClick: () => void
  onWizardsClick: () => void
  onHelpClick: () => void
  onExitMode: () => void
  onLogout: () => void
  terminalDisabled?: boolean
}

export default function Sidebar({
  sandboxesRunning,
  sandboxesTotal,
  activeView,
  isCreateMode,
  isDestroyMode,
  onSandboxesClick,
  onCreateClick,
  onDestroyClick,
  onTerminalClick,
  onSettingsClick,
  onWizardsClick,
  onHelpClick,
  onExitMode,
  onLogout,
  terminalDisabled = false,
}: SidebarProps) {
  const navItemClass = (active = false, danger = false) => `w-full flex items-center gap-3 px-3 py-2.5 rounded transition-colors ${
    active
      ? danger
        ? 'bg-[var(--status-stopped)] text-white shadow-[0_10px_28px_rgba(220,38,38,0.18)]'
        : 'bg-[var(--nvidia-green)] text-black shadow-[0_10px_28px_rgba(118,185,0,0.18)]'
      : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)]'
  }`

  return (
    <aside className="fixed left-0 top-0 z-20 flex h-screen w-64 flex-col border-r border-[var(--border-subtle)] bg-[var(--background-secondary)]/95 shadow-[12px_0_40px_rgba(0,0,0,0.22)] backdrop-blur lg:w-64 max-lg:bottom-0 max-lg:top-auto max-lg:h-auto max-lg:w-full max-lg:border-r-0 max-lg:border-t max-lg:shadow-[0_-12px_40px_rgba(0,0,0,0.22)]">
      <div className="p-4 border-b border-[var(--border-subtle)] max-lg:hidden">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[var(--nvidia-green)] rounded flex items-center justify-center shadow-[0_0_22px_rgba(118,185,0,0.28)]">
            <svg className="w-5 h-5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8-4 8 4v10l-8 4-8-4V7z" />
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8 4 8-4M12 11v10" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)] tracking-tight">OpenShell Control</p>
            <p className="text-[10px] text-[var(--foreground-dim)] font-mono mt-1">
              {sandboxesRunning} running / {sandboxesTotal} total
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-2 max-lg:grid max-lg:grid-cols-4 max-lg:gap-1 max-lg:overflow-x-auto">
        <button
          onClick={onSandboxesClick}
          className={navItemClass(activeView === 'sandboxes' && !isCreateMode && !isDestroyMode)}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <span className="text-sm">Sandboxes</span>
        </button>

        <button
          onClick={onCreateClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(isCreateMode)}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm">Create Sandbox</span>
        </button>

        <button
          onClick={onDestroyClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(isDestroyMode, true)}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
          </svg>
          <span className="text-sm">Destroy Sandbox</span>
        </button>

        <button
          onClick={onTerminalClick}
          disabled={terminalDisabled}
          className="mt-1 max-lg:mt-0 w-full flex items-center gap-3 px-3 py-2.5 rounded transition-colors hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 17l6-6-6-6m8 14h8" />
          </svg>
          <span className="text-sm">Operator Terminal</span>
        </button>

        {(isCreateMode || isDestroyMode) && (
          <button
            onClick={onExitMode}
            className="mt-1 w-full flex items-center gap-3 px-3 py-2.5 rounded bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:bg-[var(--background-panel)] transition-colors max-lg:col-span-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-sm">Cancel</span>
          </button>
        )}

        <button
          onClick={onSettingsClick}
          className={`mt-4 max-lg:mt-0 ${navItemClass(activeView === 'settings')}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm">Inference Endpoints</span>
        </button>

        <button
          onClick={onWizardsClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(activeView === 'wizards')}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2L12 3zm6 12l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
          </svg>
          <span className="text-sm">Wizards</span>
        </button>

        <button
          onClick={onHelpClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(activeView === 'help')}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9.09 9a3 3 0 115.82 1c-.64.85-1.91 1.26-2.41 2.32V13m-.5 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
          </svg>
          <span className="text-sm">Help</span>
        </button>

        <a
          href="/setup-account"
          className="mt-1 max-lg:mt-0 w-full flex items-center gap-3 px-3 py-2.5 rounded transition-colors hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)]"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" />
          </svg>
          <span className="text-sm">Setup Account</span>
        </a>
      </nav>

      <div className="p-2 border-t border-[var(--border-subtle)] max-lg:hidden">
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded transition-colors hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)]"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M15 12H3m0 0l4-4m-4 4l4 4m5-10h6v12h-6" />
          </svg>
          <span className="text-sm">Sign Out</span>
        </button>
      </div>
    </aside>
  )
}
