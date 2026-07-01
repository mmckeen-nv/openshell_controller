const DASHBOARD_SESSION_STORAGE_KEY = 'nemoclaw-dashboard-session-id'
export const HYDRATION_SAFE_DASHBOARD_SESSION_ID = 'dashboard-session'

export interface DashboardSessionState {
  dashboardSessionId: string
  selectedSandboxId: string | null
  updatedAt: number
}

function generateDashboardSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createDashboardSessionState(selectedSandboxId: string | null = null): DashboardSessionState {
  return {
    dashboardSessionId: generateDashboardSessionId(),
    selectedSandboxId,
    updatedAt: Date.now(),
  }
}

export function createHydrationSafeDashboardSessionState(
  selectedSandboxId: string | null = null
): DashboardSessionState {
  return {
    dashboardSessionId: HYDRATION_SAFE_DASHBOARD_SESSION_ID,
    selectedSandboxId,
    updatedAt: 0,
  }
}

export function updateDashboardSessionSelection(
  session: DashboardSessionState,
  selectedSandboxId: string | null
): DashboardSessionState {
  return {
    ...session,
    selectedSandboxId,
    updatedAt: Date.now(),
  }
}

export function ensureDashboardSessionId(existingId: string | null | undefined) {
  return existingId && existingId.trim() ? existingId.trim() : generateDashboardSessionId()
}

export function loadDashboardSessionState(): DashboardSessionState {
  if (typeof window === 'undefined') {
    return createHydrationSafeDashboardSessionState()
  }

  const stored = window.sessionStorage.getItem(DASHBOARD_SESSION_STORAGE_KEY)
  if (!stored) {
    return createDashboardSessionState()
  }

  try {
    const parsed = JSON.parse(stored) as Partial<DashboardSessionState>
    return {
      dashboardSessionId: ensureDashboardSessionId(parsed.dashboardSessionId),
      selectedSandboxId: typeof parsed.selectedSandboxId === 'string' ? parsed.selectedSandboxId : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    }
  } catch {
    return createDashboardSessionState()
  }
}

export function persistDashboardSessionState(session: DashboardSessionState) {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(DASHBOARD_SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function buildOperatorTerminalRoute(params: {
  sandboxId?: string | null
  dashboardSessionId: string
}) {
  const searchParams = new URLSearchParams()
  if (params.sandboxId) {
    searchParams.set('sandboxId', params.sandboxId)
  }
  searchParams.set('dashboardSessionId', params.dashboardSessionId)
  const query = searchParams.toString()
  return query ? `/operator-terminal?${query}` : '/operator-terminal'
}
