import { getDefaultOpenClawInstance, getOpenClawInstanceIdForSandbox, resolveOpenClawInstance, type OpenClawInstanceRecord } from './openclawInstances'

export type RuntimeAuthorityResolution = {
  requestedSandboxId: string | null
  resolvedSandboxId: string | null
  sandboxAuthority: 'host' | 'sandbox'
  authorityMode: 'direct-host' | 'bridged-sandbox-map' | 'bridged-instance-override'
  provenance: 'default-instance' | 'sandbox-instance-map' | 'explicit-instance'
  bridgeActive: boolean
  bridgeReason: string | null
  openclaw: OpenClawInstanceRecord
  mappedSandboxInstanceId: string | null
  usedMappedSandboxInstance: boolean
  requestedInstanceId: string | null
  explicitInstanceOverride: boolean
  terminalServerUrl: string | null
}

function normalizeId(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveRuntimeAuthority(params?: {
  sandboxId?: string | null
  resolvedSandboxId?: string | null
  instanceId?: string | null
}): RuntimeAuthorityResolution {
  const requestedSandboxId = normalizeId(params?.sandboxId)
  const resolvedSandboxId = normalizeId(params?.resolvedSandboxId) ?? requestedSandboxId
  const requestedInstanceId = normalizeId(params?.instanceId)
  const sandboxAuthority: RuntimeAuthorityResolution['sandboxAuthority'] = resolvedSandboxId ? 'sandbox' : 'host'
  const mappedSandboxInstanceId = getOpenClawInstanceIdForSandbox(resolvedSandboxId)
  const explicitInstanceOverride = Boolean(requestedInstanceId)
  const openclaw = requestedInstanceId
    ? resolveOpenClawInstance(requestedInstanceId)
    : mappedSandboxInstanceId
      ? resolveOpenClawInstance(mappedSandboxInstanceId)
      : getDefaultOpenClawInstance()
  const usedMappedSandboxInstance = Boolean(!requestedInstanceId && mappedSandboxInstanceId)
  const bridgeActive = Boolean(requestedInstanceId || usedMappedSandboxInstance)
  const authorityMode: RuntimeAuthorityResolution['authorityMode'] = requestedInstanceId
    ? 'bridged-instance-override'
    : usedMappedSandboxInstance
      ? 'bridged-sandbox-map'
      : 'direct-host'
  const provenance: RuntimeAuthorityResolution['provenance'] = requestedInstanceId
    ? 'explicit-instance'
    : usedMappedSandboxInstance
      ? 'sandbox-instance-map'
      : 'default-instance'
  const bridgeReason = requestedInstanceId
    ? 'Explicit instance override selected a bridged OpenClaw upstream for this dashboard action.'
    : usedMappedSandboxInstance
      ? 'Sandbox-to-instance mapping selected a bridged OpenClaw upstream for this sandbox context.'
      : null

  return {
    requestedSandboxId,
    resolvedSandboxId,
    sandboxAuthority,
    authorityMode,
    provenance,
    bridgeActive,
    bridgeReason,
    openclaw,
    mappedSandboxInstanceId,
    usedMappedSandboxInstance,
    requestedInstanceId,
    explicitInstanceOverride,
    terminalServerUrl: openclaw.terminalServerUrl || null,
  }
}
