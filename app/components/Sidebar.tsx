"use client"
import { useState, useEffect } from 'react'

interface Sandbox {
  id: string
  name: string
  ip: string
  status: 'running' | 'stopped' | 'unknown'
}

interface SidebarProps {
  hostIP: string
  selectedSandbox: string | null
  onSandboxSelect: (id: string | null) => void
  isSubmenuOpen: boolean
  onToggleSubmenu: () => void
  isCreateMode: boolean
  isDestroyMode: boolean
  onCreateClick: () => void
  onDestroyClick: () => void
  onExitMode: () => void
}

export default function Sidebar({
  hostIP,
  selectedSandbox,
  onSandboxSelect,
  isSubmenuOpen,
  onToggleSubmenu,
  isCreateMode,
  isDestroyMode,
  onCreateClick,
  onDestroyClick,
  onExitMode
}: SidebarProps) {
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])

  useEffect(() => {
    const fetchSandboxes = async () => {
      try {
        const response = await fetch('/api/telemetry/real')
        const data = await response.json()
        
        const items = data?.pods?.items || []
        if (!Array.isArray(items)) {
          setSandboxes([])
          return
        }
        
        const sandboxList = items
          .filter((pod: any) => pod?.metadata?.namespace === 'agent-sandbox-system')
          .map((pod: any) => ({
            id: pod.metadata?.name || 'unknown',
            name: pod.metadata?.name || 'Unknown Sandbox',
            ip: pod.status?.podIP || 'N/A',
            status: pod.status?.phase === 'Running' ? 'running' : 
                    pod.status?.phase === 'Pending' ? 'pending' : 
                    pod.status?.phase === 'Stopped' ? 'stopped' : 'unknown' as const
          }))
        
        setSandboxes(sandboxList)
      } catch (error) {
        console.error('Error fetching sandboxes in Sidebar:', error)
        setSandboxes([])
      }
    }

    if (isSubmenuOpen || isDestroyMode || isCreateMode) {
      fetchSandboxes()
      const interval = setInterval(fetchSandboxes, 10000)
      return () => clearInterval(interval)
    }
  }, [isSubmenuOpen, isDestroyMode, isCreateMode])
  return (
    <>
      {/* Main Sidebar */}
      <aside className="fixed left-0 top-0 h-screen w-64 bg-[var(--background-secondary)] border-r border-[var(--border-subtle)] flex flex-col z-20">
        {/* Host IP Header - Industrial Style */}
        <div className="p-4 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[var(--nvidia-green)] rounded-sm flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            </div>
            <div>
              <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider font-semibold">Host</p>
              <p className="text-sm font-mono text-[var(--nvidia-green)] tracking-tight">{hostIP}</p>
            </div>
          </div>
        </div>

        {/* Navigation Menu - Technical */}
        <nav className="flex-1 p-2">
          <button
            onClick={onToggleSubmenu}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-sm transition-colors ${
              isSubmenuOpen
                ? 'bg-[var(--nvidia-green)] text-white'
                : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)]'
            }`}
          >
            <span className="flex items-center gap-3">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <span className="text-sm font-medium tracking-tight">Sandboxes</span>
            </span>
            <svg 
              className={`w-4 h-4 transition-transform ${isSubmenuOpen ? 'rotate-90' : ''}`} 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Quick Actions - Technical Icons */}
          <div className="mt-4 space-y-1">
            <button 
              onClick={onCreateClick}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm transition-colors ${
                isCreateMode
                  ? 'bg-[var(--nvidia-green)] text-white'
                  : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)]'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-sm">Create Sandbox</span>
            </button>
            
            <button 
              onClick={onDestroyClick}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm transition-colors ${
                isDestroyMode
                  ? 'bg-[var(--status-stopped)] text-white'
                  : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)]'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="text-sm">Destroy Sandbox</span>
            </button>

            {(isCreateMode || isDestroyMode) && (
              <button 
                onClick={onExitMode}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:bg-[var(--background-panel)] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm">Cancel</span>
              </button>
            )}
            
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="text-sm">Settings</span>
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-[var(--background-tertiary)] text-[var(--foreground-dim)] transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span className="text-sm">Overview</span>
            </button>
          </div>
        </nav>

        {/* Footer - Technical */}
        <div className="p-4 border-t border-[var(--border-subtle)]">
          <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">OpenShell Control</p>
          <p className="text-[10px] text-[var(--foreground-dim)] font-mono">v1.0.0</p>
        </div>
      </aside>

      {/* Slide-out Sandbox Submenu - Technical Data Panel */}
      <div
        className={`fixed left-64 top-0 h-screen w-72 bg-[var(--background)] border-r border-[var(--border-subtle)] transform transition-transform duration-200 ease-in-out z-10 ${
          isSubmenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-4 border-b border-[var(--border-subtle)]">
          <h3 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
            {isCreateMode ? 'CREATE SANDBOX' : isDestroyMode ? 'DESTROY SANDBOX' : 'SANDBOXES'}
          </h3>
          <p className="text-[10px] text-[var(--foreground-dim)] font-mono mt-1">
            {isDestroyMode && 'SELECT A SANDBOX BELOW'}
            {!isCreateMode && !isDestroyMode && `${sandboxes.filter(s => s.status === 'running').length} RUNNING / ${sandboxes.length} TOTAL`}
          </p>
        </div>

        <div className="p-2 overflow-y-auto h-[calc(100vh-80px)]">
          {isCreateMode ? (
            <div className="text-center py-8">
              <svg className="w-12 h-12 mx-auto mb-4 text-[var(--nvidia-green)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              <p className="text-xs text-[var(--foreground-dim)]">CONFIGURATION PANEL WILL OPEN BELOW</p>
            </div>
          ) : isDestroyMode ? (
            <div className="space-y-1">
              {sandboxes.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-xs text-[var(--foreground-dim)]">NO SANDBOXES TO DESTROY</p>
                </div>
              ) : (
                sandboxes.map((sandbox) => (
                  <button
                    key={sandbox.id}
                    onClick={() => onSandboxSelect(sandbox.id)}
                    className="w-full px-3 py-2 rounded-sm text-left transition-colors border-2 border-[var(--status-stopped)] hover:bg-[var(--status-stopped-bg)]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-sm bg-[var(--status-stopped)] animate-pulse" />
                        <span className="text-sm font-mono truncate text-[var(--status-stopped)]">{sandbox.name}</span>
                      </div>
                      <svg className="w-3 h-3 text-[var(--status-stopped)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                    <p className="text-[10px] text-[var(--foreground-dim)] font-mono mt-1 ml-4">
                      {sandbox.ip}
                    </p>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <button
                onClick={() => onSandboxSelect(null)}
                className={`w-full px-3 py-2 rounded-sm text-left transition-colors ${
                  selectedSandbox === null
                    ? 'bg-[var(--nvidia-green)] text-white'
                    : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">ALL SANDBOXES</span>
                  <svg className="w-3 h-3 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </button>

              {sandboxes.map((sandbox) => (
                <button
                  key={sandbox.id}
                  onClick={() => onSandboxSelect(sandbox.id)}
                  className={`w-full px-3 py-2 rounded-sm text-left transition-colors ${
                    selectedSandbox === sandbox.id
                      ? 'bg-[var(--nvidia-green)] text-white'
                      : 'hover:bg-[var(--background-tertiary)] text-[var(--foreground)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-sm ${
                          sandbox.status === 'running'
                            ? 'bg-[var(--status-running)]'
                            : 'bg-[var(--status-pending)]'
                        }`}
                      />
                      <span className="text-sm font-mono truncate">{sandbox.name}</span>
                    </div>
                    <svg className="w-3 h-3 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                  <p className="text-[10px] text-[var(--foreground-dim)] font-mono mt-1 ml-4">
                    {sandbox.ip}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
