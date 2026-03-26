"use client"
import { useState } from 'react'
import Sidebar from './components/Sidebar'
import SandboxList from './components/SandboxList'

export default function Dashboard() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [isSubmenuOpen, setIsSubmenuOpen] = useState(false)
  const [hostIP] = useState('192.168.50.173')
  const [selectedSandbox, setSelectedSandbox] = useState<string | null>(null)
  const [isCreateMode, setIsCreateMode] = useState(false)
  const [isDestroyMode, setIsDestroyMode] = useState(false)
  const [deletingSandboxId, setDeletingSandboxId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  const handleSandboxSelect = (id: string | null) => {
    if (isDestroyMode && id) {
      setDeletingSandboxId(id)
      setShowDeleteConfirm(true)
    } else {
      setSelectedSandbox(id)
    }
  }

  const confirmDelete = () => {
    // TODO: Call destroy sandbox API
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
      {/* Sidebar */}
      <Sidebar
        hostIP={hostIP}
        selectedSandbox={selectedSandbox}
        onSandboxSelect={handleSandboxSelect}
        isSubmenuOpen={isSubmenuOpen}
        onToggleSubmenu={() => {
          setIsSubmenuOpen(!isSubmenuOpen)
          if (isCreateMode) setIsCreateMode(false)
          if (isDestroyMode) setIsDestroyMode(false)
        }}
        isCreateMode={isCreateMode}
        isDestroyMode={isDestroyMode}
        onCreateClick={() => {
          setIsCreateMode(true)
          setIsDestroyMode(false)
          setSelectedSandbox(null)
          setIsSubmenuOpen(true)
        }}
        onDestroyClick={() => {
          setIsDestroyMode(true)
          setIsCreateMode(false)
          setIsSubmenuOpen(true)
        }}
        onExitMode={() => {
          setIsCreateMode(false)
          setIsDestroyMode(false)
          setSelectedSandbox(null)
        }}
      />

      {/* Main Content */}
      <main className="ml-64 transition-all duration-300">
        <div className={isSubmenuOpen ? 'ml-72' : ''}>
          <div className="p-8">
            {isCreateMode ? (
              <div className="panel p-8">
                <h1 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider mb-4">
                  CREATE SANDBOX
                </h1>
                <p className="text-sm text-[var(--foreground-dim)]">
                  Sandbox creation workflow will appear here. Configure parameters and deploy a new sandbox instance.
                </p>
                {/* TODO: Add creation form */}
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
                      setSelectedSandbox(null)
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
                  </div>
                  <button
                    onClick={toggleTheme}
                    className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]"
                  >
                    {theme === 'dark' ? 'LIGHT' : 'DARK'}
                  </button>
                </div>

                <SandboxList 
                  selectedSandbox={selectedSandbox}
                  onSandboxSelect={handleSandboxSelect}
                  isDestroyMode={isDestroyMode}
                />
              </>
            )}
          </div>
        </div>
      </main>

      {/* Delete Confirmation Overlay */}
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