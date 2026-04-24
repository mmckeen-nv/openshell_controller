"use client"
import { useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar'
import SandboxList from './components/SandboxList'
import ConfigurationPanel from './components/ConfigurationPanel'
import { useSandboxInventory } from './hooks/useSandboxInventory'
import {
  createHydrationSafeDashboardSessionState,
  loadDashboardSessionState,
  persistDashboardSessionState,
  updateDashboardSessionSelection,
} from './lib/dashboardSession'

export default function Dashboard() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false)
  const [hostIP] = useState('192.168.50.173')
  const [dashboardSession, setDashboardSession] = useState(() => createHydrationSafeDashboardSessionState())
  const [isCreateMode, setIsCreateMode] = useState(false)
  const [isDestroyMode, setIsDestroyMode] = useState(false)
  const [activeView, setActiveView] = useState<'overview' | 'settings' | 'sandboxes'>('sandboxes')
  const [deletingSandboxId, setDeletingSandboxId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const inventoryEnabled = isSubmenuOpen || activeView === 'sandboxes' || isCreateMode || isDestroyMode
  const { sandboxes, nemoclaw, loading, error, refresh } = useSandboxInventory({
    enabled: inventoryEnabled,
  })

  useEffect(() => {
    setDashboardSession(loadDashboardSessionState())
  }, [])

  useEffect(() => {
    persistDashboardSessionState(dashboardSession)
  }, [dashboardSession])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const selectedSandbox = useMemo(
    () => sandboxes.find((sandbox) => sandbox.id === dashboardSession.selectedSandboxId) ?? null,
    [sandboxes, dashboardSession.selectedSandboxId]
  )

  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  const handleSandboxSelect = (id: string | null) => {
    if (isDestroyMode && id) {
      setDeletingSandboxId(id)
      setShowDeleteConfirm(true)
    } else {
      setDashboardSession((current) => updateDashboardSessionSelection(current, id))
    }
  }

  const clearSelection = () => {
    setDashboardSession((current) => updateDashboardSessionSelection(current, null))
  }

  const handleCreateSuccess = async (createdSandboxId: string) => {
    setIsCreateMode(false)
    setIsDestroyMode(false)
    setActiveView('sandboxes')
    setIsSubmenuOpen(true)
    const latest = await refresh()
    const created = latest.find((sandbox) => sandbox.id === createdSandboxId || sandbox.name === createdSandboxId)
    setDashboardSession((current) => updateDashboardSessionSelection(current, created?.id ?? createdSandboxId))
  }

  const confirmDelete = () => {
    console.log('Destroying sandbox:', deletingSandboxId)
    setShowDeleteConfirm(false)
    setDeletingSandboxId(null)
    setIsDestroyMode(false)
  }

  const cancelDelete = () => {
    setShowDeleteConfirm(false)
    setDeletingSandboxId(null)
  }

  return (
    <div
      className={`min-h-screen transition-colors duration-300 ${
        theme === 'dark'
          ? 'bg-[var(--background)] text-[var(--foreground)]'
          : 'bg-[var(--background)] text-[var(--foreground)]'
      }`}
    >
      <Sidebar
        hostIP={hostIP}
        sandboxes={sandboxes}
        nemoclaw={nemoclaw}
        dashboardSessionId={dashboardSession.dashboardSessionId}
        selectedSandboxId={dashboardSession.selectedSandboxId}
        onSandboxSelect={handleSandboxSelect}
        isSubmenuOpen={isSubmenuOpen}
        onToggleSubmenu={() => {
          setIsSubmenuOpen(!isSubmenuOpen)
          if (isCreateMode) setIsCreateMode(false)
          if (isDestroyMode) setIsDestroyMode(false)
        }}
        isCreateMode={isCreateMode}
        isDestroyMode={isDestroyMode}
        activeView={activeView}
        onCreateClick={() => {
          setActiveView('sandboxes')
          setIsCreateMode(true)
          setIsDestroyMode(false)
          clearSelection()
          setIsSubmenuOpen(true)
        }}
        onDestroyClick={() => {
          setActiveView('sandboxes')
          setIsDestroyMode(true)
          setIsCreateMode(false)
          setIsSubmenuOpen(true)
        }}
        onOverviewClick={() => {
          setActiveView('overview')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
          setIsSubmenuOpen(false)
        }}
        onSettingsClick={() => {
          setActiveView('settings')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
          setIsSubmenuOpen(false)
        }}
        onExitMode={() => {
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
      />

      <main className="ml-64 transition-all duration-300">
        <div className={isSubmenuOpen ? 'ml-72' : ''}>
          <div className="p-8">
            {activeView === 'overview' ? (
              <div className="space-y-6">
                <div className="panel p-8">
                  <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                    OVERVIEW
                  </h1>
                  <p className="text-sm text-[var(--foreground-dim)] mb-6">
                    Operational summary of the current OpenShell environment and preset posture.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">HOST</p>
                      <p className="text-lg font-mono text-[var(--nvidia-green)] mt-2">{hostIP}</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">VIEW</p>
                      <p className="text-lg font-mono text-[var(--foreground)] mt-2">OVERVIEW</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">STATUS</p>
                      <p className="text-lg font-mono text-[var(--nvidia-green)] mt-2">ONLINE</p>
                    </div>
                  </div>
                </div>
                <div className="panel p-8">
                  <h2 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider mb-4">Preset Ladder</h2>
                  <div className="space-y-3 text-sm text-[var(--foreground-dim)]">
                    <p><span className="text-[var(--foreground)] font-mono">Lockdown Mode</span> → minimum writable scope</p>
                    <p><span className="text-[var(--foreground)] font-mono">Enterprise Mode</span> → controlled enterprise defaults</p>
                    <p><span className="text-[var(--foreground)] font-mono">Medium-Spicy</span> → balanced dev workflow</p>
                    <p><span className="text-[var(--foreground)] font-mono">Spicy</span> → broad engineering access, dangerous if misused</p>
                    <p><span className="text-[var(--foreground)] font-mono">Ultra-Lobster</span> → maximum lab convenience, highly permissive</p>
                  </div>
                </div>
              </div>
            ) : activeView === 'settings' ? (
              <div className="space-y-6">
                <div className="panel p-8">
                  <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                    SETTINGS
                  </h1>
                  <p className="text-sm text-[var(--foreground-dim)] mb-6">
                    Global defaults and preset-driven policy controls for this dashboard instance.
                  </p>
                  <p className="text-[11px] text-[var(--foreground-dim)] font-mono">
                    Dashboard session {dashboardSession.dashboardSessionId.slice(0, 8)}
                  </p>
                </div>
                <ConfigurationPanel sandboxId="global-settings" mode="create" onCreateSuccess={handleCreateSuccess} onInventoryRefresh={refresh} />
              </div>
            ) : isCreateMode ? (
              <div className="space-y-6">
                <div className="panel p-8">
                  <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                    CREATE SANDBOX
                  </h1>
                  <p className="text-sm text-[var(--foreground-dim)]">
                    Start from a named security preset, then refine the OpenShell policy before creating the sandbox.
                  </p>
                </div>
                <ConfigurationPanel sandboxId="new-sandbox" mode="create" onCreateSuccess={handleCreateSuccess} onInventoryRefresh={refresh} />
              </div>
            ) : isDestroyMode ? (
              <div className="panel p-8 border-2 border-[var(--status-stopped)]">
                <h1 className="text-lg font-semibold text-[var(--status-stopped)] uppercase tracking-wider mb-4">
                  DESTROY SANDBOX
                </h1>
                <p className="text-sm text-[var(--foreground-dim)] mb-4">
                  Click on any sandbox below to initiate destruction. All sandboxes are highlighted in red.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setIsDestroyMode(false)
                      clearSelection()
                    }}
                    className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h1 className="text-lg font-semibold text-[var(--foreground)] uppercase tracking-wider">
                      NEMOSHELL DASHBOARD
                    </h1>
                    <p className="text-xs text-[var(--foreground-dim)] mt-1">
                      Real-time OpenShell sandbox monitoring
                    </p>
                    <p className="text-[11px] text-[var(--foreground-dim)] font-mono mt-2">
                      Dashboard session {dashboardSession.dashboardSessionId.slice(0, 8)}
                    </p>
                  </div>
                  <button
                    onClick={toggleTheme}
                    className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]"
                  >
                    {theme === 'dark' ? 'LIGHT' : 'DARK'}
                  </button>
                </div>

                {inventoryEnabled && loading ? (
                  <div className="flex items-center justify-center h-64" data-testid="inventory-loading-state">
                    <div className="text-xs text-[var(--foreground-dim)] font-mono uppercase tracking-wider">
                      INITIALIZING...
                    </div>
                  </div>
                ) : inventoryEnabled && error ? (
                  <div className="panel p-8 text-center" data-testid="inventory-error-state">
                    <h3 className="text-sm font-semibold text-[var(--status-stopped)] uppercase tracking-wider">Inventory Unavailable</h3>
                    <p className="text-xs text-[var(--foreground-dim)] mt-2 font-mono">{error}</p>
                  </div>
                ) : sandboxes.length === 0 ? (
                  <div className="panel p-8 text-center" data-testid="inventory-empty-state">
                    <svg className="w-12 h-12 mx-auto mb-4 text-[var(--foreground-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                    <h3 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">No Sandboxes Detected</h3>
                    <p className="text-xs text-[var(--foreground-dim)] mt-2">
                      No live OpenShell sandboxes reported yet
                    </p>
                  </div>
                ) : (
                  <SandboxList
                    sandboxes={sandboxes}
                    nemoclaw={nemoclaw}
                    dashboardSessionId={dashboardSession.dashboardSessionId}
                    selectedSandboxId={dashboardSession.selectedSandboxId}
                    selectedSandbox={selectedSandbox}
                    onSandboxSelect={handleSandboxSelect}
                    isDestroyMode={isDestroyMode}
                    onInventoryRefresh={refresh}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="panel p-8 max-w-md border-2 border-[var(--status-stopped)]">
            <div className="flex items-center gap-4 mb-4">
              <svg className="w-12 h-12 text-[var(--status-stopped)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-lg font-semibold text-[var(--status-stopped)] uppercase tracking-wider">
                WARNING: DESTRUCTIVE ACTION
              </h2>
            </div>
            <p className="text-sm text-[var(--foreground)] mb-6">
              Destroying this sandbox will permanently delete it and it will not be recoverable. Are you sure?
            </p>
            <div className="flex gap-4">
              <button
                onClick={confirmDelete}
                className="flex-1 px-4 py-2 rounded-sm bg-[var(--status-stopped)] text-white text-xs font-mono uppercase tracking-wider hover:bg-[#b91c1c] transition-colors"
              >
                YES — DESTROY
              </button>
              <button
                onClick={cancelDelete}
                className="flex-1 px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)] transition-colors"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
