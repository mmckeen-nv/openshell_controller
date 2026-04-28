"use client"
import { useEffect, useMemo, useState } from 'react'
import Sidebar from './components/Sidebar'
import SandboxList from './components/SandboxList'
import ConfigurationPanel from './components/ConfigurationPanel'
import InferenceEndpointPanel from './components/InferenceEndpointPanel'
import HelpPanel from './components/HelpPanel'
import WizardPanel from './components/WizardPanel'
import McpConfigurationPanel from './components/McpConfigurationPanel'
import { useSandboxInventory } from './hooks/useSandboxInventory'
import {
  createHydrationSafeDashboardSessionState,
  buildOperatorTerminalRoute,
  loadDashboardSessionState,
  persistDashboardSessionState,
  updateDashboardSessionSelection,
} from './lib/dashboardSession'

export default function Dashboard() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [dashboardSession, setDashboardSession] = useState(() => createHydrationSafeDashboardSessionState())
  const [isCreateMode, setIsCreateMode] = useState(false)
  const [isDestroyMode, setIsDestroyMode] = useState(false)
  const [activeView, setActiveView] = useState<'settings' | 'sandboxes' | 'help' | 'wizards' | 'mcp'>('sandboxes')
  const [deletingSandboxId, setDeletingSandboxId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [gatewayRepairing, setGatewayRepairing] = useState(false)
  const inventoryEnabled = activeView === 'sandboxes' || activeView === 'wizards' || activeView === 'help' || activeView === 'mcp' || isCreateMode || isDestroyMode
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
  const deletingSandbox = useMemo(
    () => sandboxes.find((sandbox) => sandbox.id === deletingSandboxId) ?? null,
    [sandboxes, deletingSandboxId]
  )

  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  useEffect(() => {
    if (!inventoryEnabled || loading || isCreateMode || isDestroyMode) return
    if (sandboxes.length === 0) {
      if (dashboardSession.selectedSandboxId) {
        setDashboardSession((current) => updateDashboardSessionSelection(current, null))
      }
      return
    }

    const selectedStillExists = sandboxes.some((sandbox) => sandbox.id === dashboardSession.selectedSandboxId)
    if (selectedStillExists) return

    const nextSelection = sandboxes.find((sandbox) => sandbox.isDefault)?.id || sandboxes[0]?.id || null
    setDashboardSession((current) => updateDashboardSessionSelection(current, nextSelection))
  }, [
    dashboardSession.selectedSandboxId,
    inventoryEnabled,
    isCreateMode,
    isDestroyMode,
    loading,
    sandboxes,
  ])

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

  const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

  const gatewayTrustError = Boolean(error && /BadSignature|invalid peer certificate|transport error|certificate signature|Unknown gateway|Deploy it first|Connection refused|tcp connect error/i.test(error))

  const repairGatewayTrust = async () => {
    if (gatewayRepairing) return
    try {
      setGatewayRepairing(true)
      setLifecycleMessage(
        "Repairing OpenShell gateway trust. This backs up local OpenShell config, restarts the selected gateway, reselects it, and verifies sandbox inventory. It does not destroy sandboxes."
      )
      const response = await fetch('/api/openshell/gateway/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'inventory BadSignature recovery' }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to repair OpenShell gateway trust')
      setLifecycleMessage(`${data.warning || 'OpenShell gateway trust repaired.'}\nGateway: ${data.gateway}\nBackup: ${data.backupPath}`)
      await refresh({ force: true })
    } catch (err) {
      setLifecycleMessage(err instanceof Error ? err.message : 'Failed to repair OpenShell gateway trust')
    } finally {
      setGatewayRepairing(false)
    }
  }

  const refreshUntilSandboxVisible = async (sandboxRef: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const latest = await refresh({ force: true })
      const sandbox = latest.find((item) => item.id === sandboxRef || item.name === sandboxRef)
      if (sandbox) return sandbox
      await sleep(1500)
    }
    return null
  }

  const refreshUntilSandboxGone = async (sandboxId: string, sandboxName: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const latest = await refresh({ force: true })
      const stillPresent = latest.find((item) => item.id === sandboxId || item.name === sandboxName)
      if (!stillPresent) return { latest, gone: true }
      await sleep(1500)
    }

    return { latest: await refresh({ force: true }), gone: false }
  }

  const handleCreateSuccess = async (createdSandboxId: string) => {
    setIsCreateMode(false)
    setIsDestroyMode(false)
    setActiveView('sandboxes')
    setLifecycleMessage(`Refreshing inventory for ${createdSandboxId}...`)
    const created = await refreshUntilSandboxVisible(createdSandboxId)
    setLifecycleMessage(created ? `Sandbox ${created.name} is ready.` : `Sandbox ${createdSandboxId} was created, but inventory has not reported it yet.`)
    setDashboardSession((current) => updateDashboardSessionSelection(current, created?.id ?? null))
  }

  const confirmDelete = async () => {
    if (!deletingSandboxId || deleteInProgress) return
    const sandbox = sandboxes.find((item) => item.id === deletingSandboxId)
    const sandboxName = sandbox?.name ?? deletingSandboxId

    try {
      setDeleteInProgress(true)
      setLifecycleMessage(`Destroying sandbox ${sandboxName}...`)
      const response = await fetch('/api/sandbox/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxName }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error([data.error, data.stdout, data.stderr].filter(Boolean).join('\n\n') || 'Failed to destroy sandbox')

      const { gone } = await refreshUntilSandboxGone(deletingSandboxId, sandboxName)
      setDashboardSession((current) => updateDashboardSessionSelection(current, current.selectedSandboxId === deletingSandboxId ? null : current.selectedSandboxId))
      setLifecycleMessage(gone ? `Sandbox ${sandboxName} destroyed.` : `Delete started for ${sandboxName}. Inventory still reports it while cleanup finishes.`)
      setShowDeleteConfirm(false)
      setDeletingSandboxId(null)
      setIsDestroyMode(false)
    } catch (err) {
      setLifecycleMessage(err instanceof Error ? err.message : 'Failed to destroy sandbox')
    } finally {
      setDeleteInProgress(false)
    }
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
        sandboxesRunning={sandboxes.filter((sandbox) => sandbox.status === 'running').length}
        sandboxesTotal={sandboxes.length}
        isCreateMode={isCreateMode}
        isDestroyMode={isDestroyMode}
        activeView={activeView}
        onSandboxesClick={() => {
          setActiveView('sandboxes')
          setIsCreateMode(false)
          setIsDestroyMode(false)
        }}
        onCreateClick={() => {
          setActiveView('sandboxes')
          setIsCreateMode(true)
          setIsDestroyMode(false)
          clearSelection()
          setLifecycleMessage(null)
        }}
        onDestroyClick={() => {
          setActiveView('sandboxes')
          setIsDestroyMode(true)
          setIsCreateMode(false)
          setLifecycleMessage(null)
        }}
        onTerminalClick={() => {
          const nextUrl = buildOperatorTerminalRoute({
            sandboxId: selectedSandbox?.id,
            dashboardSessionId: dashboardSession.dashboardSessionId,
          })
          window.open(nextUrl, '_blank', 'noopener,noreferrer')
        }}
        terminalDisabled={!selectedSandbox}
        onSettingsClick={() => {
          setActiveView('settings')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
        onMcpClick={() => {
          setActiveView('mcp')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
        onWizardsClick={() => {
          setActiveView('wizards')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
        onHelpClick={() => {
          setActiveView('help')
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
        onExitMode={() => {
          setIsCreateMode(false)
          setIsDestroyMode(false)
          clearSelection()
        }}
        onLogout={async () => {
          await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
          window.location.href = '/login'
        }}
      />

      <main className={`${activeView === 'sandboxes' && !isCreateMode ? 'lg:ml-[36rem]' : 'lg:ml-64'} min-h-screen transition-all duration-300 max-lg:ml-0 max-lg:pb-28`}>
        <div>
          <div className="mx-auto max-w-7xl p-8 max-sm:p-4">
            {activeView === 'settings' ? (
              <div className="space-y-6">
                <div className="panel p-8">
                  <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                    INFERENCE ENDPOINTS
                  </h1>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">Sandboxes</p>
                      <p className="text-xl font-mono text-[var(--nvidia-green)] mt-1">{sandboxes.length}</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">Running</p>
                      <p className="text-xl font-mono text-[var(--nvidia-green)] mt-1">{sandboxes.filter((sandbox) => sandbox.status === 'running').length}</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">OpenClaw</p>
                      <p className="text-sm font-mono text-[var(--foreground)] mt-2">{nemoclaw?.available ? 'available' : 'not detected'}</p>
                    </div>
                  </div>
                </div>
                <InferenceEndpointPanel />
              </div>
            ) : activeView === 'help' ? (
              <HelpPanel sandboxes={sandboxes} />
            ) : activeView === 'mcp' ? (
              <McpConfigurationPanel sandboxes={sandboxes} />
            ) : activeView === 'wizards' ? (
              <WizardPanel sandboxes={sandboxes} onInventoryRefresh={refresh} />
            ) : isCreateMode ? (
              <div className="space-y-6">
                <div className="panel p-8">
                  <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                    CREATE SANDBOX
                  </h1>
                  <p className="text-sm text-[var(--foreground-dim)]">
                    Choose a blueprint, name the sandbox, and create it.
                  </p>
                </div>
                <ConfigurationPanel sandboxId="new-sandbox" mode="create" onCreateSuccess={handleCreateSuccess} />
              </div>
            ) : isDestroyMode ? (
              <div className="space-y-6">
                <div className="panel p-8 border-2 border-[var(--status-stopped)]">
                  <h1 className="text-lg font-semibold text-[var(--status-stopped)] uppercase tracking-wider mb-4">
                    DESTROY SANDBOX
                  </h1>
                  <p className="text-sm text-[var(--foreground-dim)] mb-4">
                    Click a sandbox below to destroy it.
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

                {lifecycleMessage && (
                  <div className="panel p-4 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap" data-testid="sandbox-lifecycle-message">
                    {lifecycleMessage}
                  </div>
                )}

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
                    {gatewayTrustError && (
                      <div className="mx-auto mt-5 max-w-2xl rounded-sm border border-amber-500/40 bg-amber-500/10 p-4 text-left">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Gateway Trust Mismatch</h4>
                        <p className="mt-2 text-xs leading-5 text-amber-100/80">
                          OpenShell could not use the selected gateway. This usually means the gateway stopped, was undeployed, or regenerated mTLS material while this controller still has stale trust files.
                        </p>
                        <button
                          type="button"
                          disabled={gatewayRepairing}
                          onClick={repairGatewayTrust}
                          className="mt-4 rounded-sm bg-amber-300 px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
                        >
                          {gatewayRepairing ? 'Repairing Gateway...' : 'Repair Gateway Trust'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <SandboxList
                    sandboxes={sandboxes}
                    nemoclaw={nemoclaw}
                    selectedSandboxId={dashboardSession.selectedSandboxId}
                    selectedSandbox={selectedSandbox}
                    onSandboxSelect={handleSandboxSelect}
                    isDestroyMode={isDestroyMode}
                    onInventoryRefresh={refresh}
                  />
                )}
              </div>
            ) : (
              <>
                <div className="panel mb-6 overflow-hidden">
                  <div className="panel-header flex items-center justify-between gap-4 p-5 max-md:flex-col max-md:items-start">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--nvidia-green)]">
                        {sandboxes.filter((sandbox) => sandbox.status === 'running').length} online / {sandboxes.length} total
                      </p>
                      <h1 className="mt-1 text-xl font-semibold uppercase tracking-wider text-[var(--foreground)]">
                        OPENSHELL CONTROL
                      </h1>
                      <p className="mt-1 text-xs text-[var(--foreground-dim)]">
                        Manage local OpenShell sandboxes and operator access.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 max-sm:w-full">
                      <button
                        onClick={async () => {
                          await refresh({ force: true })
                        }}
                        className="action-button px-4 py-2 max-sm:flex-1"
                      >
                        REFRESH
                      </button>
                      <button
                        onClick={toggleTheme}
                        className="action-button px-4 py-2 max-sm:flex-1"
                        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                      >
                        {theme === 'dark' ? 'LIGHT' : 'DARK'}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-px bg-[var(--border-subtle)] sm:grid-cols-3">
                    <div className="bg-[var(--surface-raised)] p-4">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Selected</p>
                      <p className="mt-1 truncate font-mono text-sm text-[var(--foreground)]">{selectedSandbox?.name ?? 'none'}</p>
                    </div>
                    <div className="bg-[var(--surface-raised)] p-4">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Ready</p>
                      <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{sandboxes.filter((sandbox) => sandbox.ready).length} sandboxes</p>
                    </div>
                    <div className="bg-[var(--surface-raised)] p-4">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Gateway</p>
                      <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{nemoclaw?.available ? 'available' : 'not detected'}</p>
                    </div>
                  </div>
                </div>

                {lifecycleMessage && (
                  <div className="panel mb-6 p-4 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap" data-testid="sandbox-lifecycle-message">
                    {lifecycleMessage}
                  </div>
                )}

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
                    {gatewayTrustError && (
                      <div className="mx-auto mt-5 max-w-2xl rounded-sm border border-amber-500/40 bg-amber-500/10 p-4 text-left">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Gateway Trust Mismatch</h4>
                        <p className="mt-2 text-xs leading-5 text-amber-100/80">
                          OpenShell could not use the selected gateway. This usually means the gateway stopped, was undeployed, or regenerated mTLS material while this controller still has stale trust files.
                        </p>
                        <button
                          type="button"
                          disabled={gatewayRepairing}
                          onClick={repairGatewayTrust}
                          className="mt-4 rounded-sm bg-amber-300 px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
                        >
                          {gatewayRepairing ? 'Repairing Gateway...' : 'Repair Gateway Trust'}
                        </button>
                      </div>
                    )}
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
          <div className="panel w-[min(92vw,28rem)] p-8 border-2 border-[var(--status-stopped)]">
            <div className="flex items-center gap-4 mb-4">
              <svg className="w-12 h-12 text-[var(--status-stopped)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-lg font-semibold text-[var(--status-stopped)] uppercase tracking-wider">
                WARNING: DESTRUCTIVE ACTION
              </h2>
            </div>
            <p className="text-sm text-[var(--foreground)] mb-6">
              Destroying {deletingSandbox?.name ?? 'this sandbox'} will permanently delete it and it will not be recoverable. Are you sure?
            </p>
            {lifecycleMessage && (
              <div className="mb-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">
                {lifecycleMessage}
              </div>
            )}
            <div className="flex gap-4">
              <button
                onClick={confirmDelete}
                disabled={deleteInProgress}
                className="flex-1 px-4 py-2 rounded-sm bg-[var(--status-stopped)] text-white text-xs font-mono uppercase tracking-wider hover:bg-[#b91c1c] transition-colors disabled:opacity-50"
              >
                {deleteInProgress ? 'DESTROYING...' : 'YES — DESTROY'}
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
