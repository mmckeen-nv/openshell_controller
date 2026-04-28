"use client"

import { useEffect, useMemo, useState } from "react"

type ControllerNodeRecord = {
  id: string
  name: string
  host: string
  url: string
  role: "local" | "controller-node"
  status: "configured" | "local"
}

interface SidebarProps {
  sandboxesRunning: number
  sandboxesTotal: number
  activeView: 'settings' | 'sandboxes' | 'help' | 'wizards' | 'mcp'
  isCreateMode: boolean
  isDestroyMode: boolean
  onSandboxesClick: () => void
  onCreateClick: () => void
  onDestroyClick: () => void
  onTerminalClick: () => void
  onSettingsClick: () => void
  onMcpClick: () => void
  onWizardsClick: () => void
  onHelpClick: () => void
  onExitMode: () => void
  onLogout: () => void
  terminalDisabled?: boolean
}

const SELECTED_CONTROLLER_NODE_KEY = "openshell-control-selected-node"

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
  onMcpClick,
  onWizardsClick,
  onHelpClick,
  onExitMode,
  onLogout,
  terminalDisabled = false,
}: SidebarProps) {
  const [controllerNodes, setControllerNodes] = useState<ControllerNodeRecord[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState("local")
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false)
  const [friendlyNameDraft, setFriendlyNameDraft] = useState("")
  const [friendlyNameSaving, setFriendlyNameSaving] = useState(false)
  const [friendlyNameMessage, setFriendlyNameMessage] = useState("")

  const selectedNode = useMemo(
    () => controllerNodes.find((node) => node.id === selectedNodeId) || controllerNodes[0] || null,
    [controllerNodes, selectedNodeId],
  )
  const hasRemoteNodes = controllerNodes.some((node) => node.role === "controller-node")

  useEffect(() => {
    const stored = window.localStorage.getItem(SELECTED_CONTROLLER_NODE_KEY)
    if (stored) setSelectedNodeId(stored)
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadControllerNodes = () => {
      fetch("/api/controller-node/registry", { cache: "no-store" })
        .then((response) => response.json())
        .then((data) => {
          if (cancelled) return
          const nodes = Array.isArray(data.nodes) ? data.nodes : []
          setControllerNodes(nodes)
          if (nodes.length > 1) setNodeMenuOpen(true)
          setSelectedNodeId((current) => nodes.some((node: ControllerNodeRecord) => node.id === current) ? current : nodes[0]?.id || "local")
        })
        .catch(() => {
          if (!cancelled) setControllerNodes([])
        })
    }

    loadControllerNodes()
    window.addEventListener("controller-nodes-changed", loadControllerNodes)
    return () => {
      cancelled = true
      window.removeEventListener("controller-nodes-changed", loadControllerNodes)
    }
  }, [])

  useEffect(() => {
    if (!selectedNode) return
    setFriendlyNameDraft(selectedNode.name)
    window.localStorage.setItem(SELECTED_CONTROLLER_NODE_KEY, selectedNode.id)
  }, [selectedNode])

  async function saveFriendlyName() {
    if (!selectedNode || friendlyNameSaving) return
    try {
      setFriendlyNameSaving(true)
      setFriendlyNameMessage("")
      const response = await fetch("/api/controller-node/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rename",
          nodeId: selectedNode.id,
          name: friendlyNameDraft,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save node name")
      setControllerNodes(Array.isArray(data.nodes) ? data.nodes : [])
      setFriendlyNameMessage("Saved")
    } catch (error) {
      setFriendlyNameMessage(error instanceof Error ? error.message : "Failed to save")
    } finally {
      setFriendlyNameSaving(false)
    }
  }

  const navItemClass = (active = false, danger = false) => `w-full flex items-center gap-3 rounded px-3 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)] max-lg:min-w-24 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2 ${
    active
      ? danger
        ? 'bg-[var(--status-stopped)] text-white shadow-[0_10px_28px_rgba(220,38,38,0.18)]'
        : 'bg-[var(--nvidia-green)] text-black shadow-[0_10px_28px_rgba(118,185,0,0.18)]'
      : 'text-[var(--foreground-dim)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)]'
  }`

  return (
    <aside className="fixed left-0 top-0 z-20 flex h-screen w-64 flex-col border-r border-[var(--border-subtle)] bg-[var(--background-secondary)]/95 shadow-[12px_0_40px_rgba(0,0,0,0.22)] backdrop-blur lg:w-64 max-lg:bottom-0 max-lg:top-auto max-lg:h-auto max-lg:w-full max-lg:border-r-0 max-lg:border-t max-lg:shadow-[0_-12px_40px_rgba(0,0,0,0.22)]">
      <div className="border-b border-[var(--border-subtle)] p-4 max-lg:hidden">
        <button
          type="button"
          onClick={() => setNodeMenuOpen((open) => !open)}
          aria-expanded={nodeMenuOpen}
          className="flex w-full items-center gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
        >
          <div className="w-8 h-8 bg-[var(--nvidia-green)] rounded flex items-center justify-center shadow-[0_0_22px_rgba(118,185,0,0.28)]">
            <svg className="w-5 h-5 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8-4 8 4v10l-8 4-8-4V7z" />
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8 4 8-4M12 11v10" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--foreground)] tracking-tight">OpenShell Control</p>
            <p className="text-[10px] text-[var(--foreground-dim)] font-mono mt-1">
              {selectedNode ? `${selectedNode.name} / ${selectedNode.host}` : `${sandboxesRunning} running / ${sandboxesTotal} total`}
            </p>
          </div>
          <svg
            className={`h-4 w-4 shrink-0 text-[var(--foreground-dim)] transition-transform ${nodeMenuOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        {nodeMenuOpen && (
          <div className="mt-4 space-y-3 border-t border-[var(--border-subtle)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <span className={`status-chip px-2 py-1 ${hasRemoteNodes ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending)]"}`}>
                {hasRemoteNodes ? "multi-node" : "local"}
              </span>
              <span className="text-[10px] font-mono text-[var(--foreground-dim)]">
                {sandboxesRunning} running / {sandboxesTotal} total
              </span>
            </div>
            <label className="block space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Managed Node</span>
              <select
                value={selectedNode?.id || ""}
                onChange={(event) => setSelectedNodeId(event.target.value)}
                className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2 py-2 text-xs font-mono text-[var(--foreground)] focus:border-[var(--nvidia-green)] focus:outline-none"
              >
                {controllerNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name} - {node.host}
                  </option>
                ))}
              </select>
            </label>
            {selectedNode && (
              <div className="space-y-2 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
                <p className="truncate text-[11px] font-mono text-[var(--foreground)]">{selectedNode.url}</p>
                <label className="block space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Friendly Name</span>
                  <input
                    value={friendlyNameDraft}
                    onChange={(event) => setFriendlyNameDraft(event.target.value)}
                    className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono text-[var(--foreground)] focus:border-[var(--nvidia-green)] focus:outline-none"
                  />
                </label>
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={saveFriendlyName}
                    disabled={friendlyNameSaving || !friendlyNameDraft.trim()}
                    className="action-button px-3 py-1.5 text-[10px] disabled:opacity-50"
                  >
                    {friendlyNameSaving ? "Saving" : "Save Name"}
                  </button>
                  {friendlyNameMessage && <span className="truncate text-[10px] text-[var(--foreground-dim)]">{friendlyNameMessage}</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <nav className="flex-1 p-2 max-lg:flex max-lg:gap-1 max-lg:overflow-x-auto max-lg:[scrollbar-width:none]">
        <button
          onClick={onSandboxesClick}
          className={navItemClass(activeView === 'sandboxes' && !isCreateMode && !isDestroyMode)}
          aria-current={activeView === 'sandboxes' && !isCreateMode && !isDestroyMode ? 'page' : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <span className="text-sm max-lg:text-[11px]">Sandboxes</span>
        </button>

        <button
          onClick={onCreateClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(isCreateMode)}`}
          aria-pressed={isCreateMode}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm max-lg:text-[11px] max-lg:leading-tight">Create</span>
        </button>

        <button
          onClick={onDestroyClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(isDestroyMode, true)}`}
          aria-pressed={isDestroyMode}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M4 7h16" />
          </svg>
          <span className="text-sm max-lg:text-[11px] max-lg:leading-tight">Destroy</span>
        </button>

        <button
          onClick={onTerminalClick}
          disabled={terminalDisabled}
          title={terminalDisabled ? 'Select a sandbox to open the operator terminal' : 'Open operator terminal'}
          className="mt-1 flex w-full items-center gap-3 rounded px-3 py-2.5 text-[var(--foreground-dim)] transition-all hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)] disabled:cursor-not-allowed disabled:opacity-40 max-lg:mt-0 max-lg:min-w-24 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 17l6-6-6-6m8 14h8" />
          </svg>
          <span className="text-sm max-lg:text-[11px] max-lg:leading-tight">Terminal</span>
        </button>

        {(isCreateMode || isDestroyMode) && (
          <button
            onClick={onExitMode}
            className="mt-1 flex w-full items-center gap-3 rounded bg-[var(--background-tertiary)] px-3 py-2.5 text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-panel)] max-lg:mt-0 max-lg:min-w-24 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-sm max-lg:text-[11px]">Cancel</span>
          </button>
        )}

        <button
          onClick={onSettingsClick}
          className={`mt-4 max-lg:mt-0 ${navItemClass(activeView === 'settings')}`}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm max-lg:text-[11px] max-lg:leading-tight">Inference</span>
        </button>

        <button
          onClick={onWizardsClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(activeView === 'wizards')}`}
          aria-current={activeView === 'wizards' ? 'page' : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2L12 3zm6 12l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z" />
          </svg>
          <span className="text-sm max-lg:text-[11px]">Wizards</span>
        </button>

        <button
          onClick={onMcpClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(activeView === 'mcp')}`}
          aria-current={activeView === 'mcp' ? 'page' : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M7 8h10M7 16h10M9 4h6a2 2 0 012 2v12a2 2 0 01-2 2H9a2 2 0 01-2-2V6a2 2 0 012-2z" />
          </svg>
          <span className="text-sm max-lg:text-[11px]">MCP</span>
        </button>

        <button
          onClick={onHelpClick}
          className={`mt-1 max-lg:mt-0 ${navItemClass(activeView === 'help')}`}
          aria-current={activeView === 'help' ? 'page' : undefined}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9.09 9a3 3 0 115.82 1c-.64.85-1.91 1.26-2.41 2.32V13m-.5 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" />
          </svg>
          <span className="text-sm max-lg:text-[11px]">Help</span>
        </button>

        <a
          href="/swagger"
          className="mt-1 flex w-full items-center gap-3 rounded px-3 py-2.5 text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)] max-lg:mt-0 max-lg:min-w-24 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M7 7h10M7 12h10M7 17h6M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
          </svg>
          <span className="text-sm max-lg:text-[11px]">Swagger</span>
        </a>

        <a
          href="/setup-account"
          className="mt-1 flex w-full items-center gap-3 rounded px-3 py-2.5 text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)] max-lg:mt-0 max-lg:min-w-24 max-lg:flex-col max-lg:justify-center max-lg:gap-1 max-lg:px-2 max-lg:py-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0" />
          </svg>
          <span className="text-sm max-lg:text-[11px] max-lg:leading-tight">Account</span>
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
