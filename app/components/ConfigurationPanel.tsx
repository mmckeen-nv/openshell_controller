"use client"
import { useEffect, useMemo, useState } from "react"
import { SECURITY_PRESETS, getSecurityPreset, type OpenShellPolicyShape, type SecurityPresetId } from "../lib/securityPresets"

type LandlockCompatibility = "best_effort" | "hard_requirement"
type EndpointProtocol = "" | "rest"
type EndpointTls = "" | "terminate" | "passthrough"
type EndpointEnforcement = "" | "enforce" | "audit"
type EndpointAccess = "" | "read-only" | "read-write" | "full"

interface NetworkRule { method: string; path: string }
interface NetworkEndpoint { host: string; port: string; protocol: EndpointProtocol; tls: EndpointTls; enforcement: EndpointEnforcement; access: EndpointAccess; rules: NetworkRule[] }
interface NetworkBinary { path: string }
interface NetworkPolicyBlock { key: string; name: string; endpoints: NetworkEndpoint[]; binaries: NetworkBinary[] }
type OpenShellPolicy = OpenShellPolicyShape

type BlueprintOption = {
  id: string
  label: string
  description: string
  type: "blueprint" | "custom"
  source: string
  supportsTailscale?: boolean
}

interface ConfigurationPanelProps {
  sandboxId: string
  mode?: 'existing' | 'create'
  onCreateSuccess?: (sandboxId: string) => void | Promise<void>
  onInventoryRefresh?: () => Promise<unknown>
}

function FieldHelp({ text }: { text: string }) {
  return <span className="ml-2 inline-flex align-middle group relative"><span className="w-4 h-4 rounded-full border border-[var(--foreground-dim)] text-[10px] text-[var(--foreground-dim)] flex items-center justify-center cursor-help">?</span><span className="pointer-events-none absolute left-0 top-6 z-50 hidden w-80 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-panel)] p-2 text-[11px] text-[var(--foreground)] shadow-lg group-hover:block">{text}</span></span>
}
function Badge({ children, tone }: { children: React.ReactNode; tone: "dynamic" | "static" | "danger" }) {
  const cls = tone === "dynamic" ? "bg-[rgba(118,185,0,0.12)] text-[var(--nvidia-green)] border-[rgba(118,185,0,0.35)]" : tone === "danger" ? "bg-[rgba(220,38,38,0.12)] text-red-400 border-[rgba(220,38,38,0.35)]" : "bg-[rgba(245,158,11,0.10)] text-amber-400 border-[rgba(245,158,11,0.35)]"
  return <span className={`text-[10px] uppercase tracking-wider border px-2 py-1 rounded-sm ${cls}`}>{children}</span>
}
function TextListEditor({ label, tooltipText, value, onChange, placeholder }: { label: string; tooltipText: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return <div className="space-y-2"><label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">{label}<FieldHelp text={tooltipText} /></label><textarea value={value.join("\n")} onChange={(e) => onChange(e.target.value.split("\n").map(s => s.trim()).filter(Boolean))} placeholder={placeholder} rows={4} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" /></div>
}

const defaultPolicy: OpenShellPolicy = {
  version: 1,
  filesystem_policy: { include_workdir: true, read_only: ["/usr", "/lib", "/etc", "/proc", "/dev/urandom"], read_write: ["/sandbox", "/tmp", "/dev/null"] },
  landlock: { compatibility: "best_effort" },
  process: { run_as_user: "sandbox", run_as_group: "sandbox" },
  network_policies: {},
}

function normalizeFromApi(data: any): OpenShellPolicy {
  const current = data?.currentConfig || data?.policy || data || {}
  return {
    version: Number(current.version ?? 1),
    filesystem_policy: {
      include_workdir: Boolean(current.filesystem_policy?.include_workdir ?? true),
      read_only: Array.isArray(current.filesystem_policy?.read_only) ? current.filesystem_policy.read_only : defaultPolicy.filesystem_policy.read_only,
      read_write: Array.isArray(current.filesystem_policy?.read_write) ? current.filesystem_policy.read_write : defaultPolicy.filesystem_policy.read_write,
    },
    landlock: { compatibility: current.landlock?.compatibility === "hard_requirement" ? "hard_requirement" : "best_effort" },
    process: { run_as_user: String(current.process?.run_as_user ?? "sandbox"), run_as_group: String(current.process?.run_as_group ?? "sandbox") },
    network_policies: current.network_policies && typeof current.network_policies === "object" ? current.network_policies : {},
  }
}
function policyBlocksFromPolicy(policy: OpenShellPolicy): NetworkPolicyBlock[] {
  return Object.entries(policy.network_policies).map(([key, value]) => ({ key, name: value.name || key, endpoints: (value.endpoints || []).map((ep) => ({ host: ep.host || "", port: String(ep.port ?? "443"), protocol: ep.protocol === "rest" ? "rest" : "", tls: ep.tls === "terminate" || ep.tls === "passthrough" ? ep.tls : "", enforcement: ep.enforcement === "enforce" || ep.enforcement === "audit" ? ep.enforcement : "", access: ep.access === "read-only" || ep.access === "read-write" || ep.access === "full" ? ep.access : "", rules: Array.isArray(ep.rules) ? ep.rules.map((r) => ({ method: r.allow?.method || "GET", path: r.allow?.path || "/**" })) : [] })), binaries: (value.binaries || []).map((b) => ({ path: b.path || "" })) }))
}
function blocksToPolicy(blocks: NetworkPolicyBlock[]): OpenShellPolicy["network_policies"] {
  const out: OpenShellPolicy["network_policies"] = {}
  for (const block of blocks) {
    const key = block.key.trim(); if (!key) continue
    out[key] = { name: block.name.trim() || key, endpoints: block.endpoints.filter((ep) => ep.host.trim() && ep.port.trim()).map((ep) => ({ host: ep.host.trim(), port: Number(ep.port), ...(ep.protocol ? { protocol: ep.protocol } : {}), ...(ep.tls ? { tls: ep.tls } : {}), ...(ep.enforcement ? { enforcement: ep.enforcement } : {}), ...(ep.access ? { access: ep.access } : {}), ...(!ep.access && ep.rules.length ? { rules: ep.rules.filter((r) => r.method.trim() && r.path.trim()).map((r) => ({ allow: { method: r.method.trim(), path: r.path.trim() } })) } : {}) })), binaries: block.binaries.filter((b) => b.path.trim()).map((b) => ({ path: b.path.trim() })) }
  }
  return out
}

export default function ConfigurationPanel({ sandboxId, mode = 'existing', onCreateSuccess, onInventoryRefresh }: ConfigurationPanelProps) {
  const [policy, setPolicy] = useState<OpenShellPolicy>(defaultPolicy)
  const [blocks, setBlocks] = useState<NetworkPolicyBlock[]>([])
  const [loading, setLoading] = useState(mode === 'existing')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [selectedPreset, setSelectedPreset] = useState<SecurityPresetId | ''>('')
  const [blueprints, setBlueprints] = useState<BlueprintOption[]>([])
  const [selectedBlueprint, setSelectedBlueprint] = useState<string>('nemoclaw-blueprint')
  const [sandboxName, setSandboxName] = useState<string>('')
  const [enableTailscale, setEnableTailscale] = useState<boolean>(false)

  useEffect(() => {
    if (mode === 'create') {
      setLoading(false)
      fetch('/api/sandbox/create', { cache: 'no-store' }).then((res) => res.json()).then((data) => { if (Array.isArray(data?.blueprints)) setBlueprints(data.blueprints) }).catch(() => {})
      return
    }
    let active = true
    ;(async () => {
      try {
        setLoading(true)
        const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxId)}/config`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Failed to fetch configuration")
        const normalized = normalizeFromApi(data)
        if (!active) return
        setPolicy(normalized)
        setBlocks(policyBlocksFromPolicy(normalized))
      } catch (err) {
        if (!active) return
        setMessage(err instanceof Error ? err.message : "Failed to fetch configuration")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [sandboxId, mode])

  const assembledPolicy = useMemo(() => ({ ...policy, network_policies: blocksToPolicy(blocks) }), [policy, blocks])
  const activePreset = selectedPreset ? getSecurityPreset(selectedPreset) : null
  const activeBlueprint = blueprints.find((bp) => bp.id === selectedBlueprint)

  function applyPreset(presetId: SecurityPresetId) {
    const preset = getSecurityPreset(presetId); if (!preset) return
    setSelectedPreset(presetId); setPolicy(preset.policy); setBlocks(policyBlocksFromPolicy(preset.policy)); setMessage(`${preset.label} applied. Review before saving.`)
  }

  async function savePolicy() {
    try {
      setSaving(true); setMessage("")
      if (mode === 'create') {
        if (!sandboxName.trim()) throw new Error('sandbox name is required')
        const res = await fetch('/api/sandbox/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blueprint: selectedBlueprint, sandboxName: sandboxName.trim(), enableTailscale, policy: assembledPolicy, preset: selectedPreset || null }) })
        const data = await res.json()
        if (!res.ok) throw new Error([data.error, data.verification?.summary, data.verification?.error, data.stdout, data.stderr].filter(Boolean).join('\n\n'))
        const createdSandboxId = data.verification?.details?.id || data.verification?.details?.name || data.sandboxName
        if (onInventoryRefresh) {
          await onInventoryRefresh()
        }
        setMessage([
          `Sandbox '${data.sandboxName}' created.`,
          data.verification?.summary,
        ].filter(Boolean).join('\n\n'))
        if (createdSandboxId && onCreateSuccess) {
          await onCreateSuccess(createdSandboxId)
        }
        return
      }
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxId)}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: assembledPolicy, preset: selectedPreset || null, mode }) })
      const data = await res.json(); if (!res.ok) throw new Error(data.error || "Failed to save policy")
      setMessage('Policy saved. Dynamic network policy can apply live; static sections require sandbox recreation.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save policy")
    } finally { setSaving(false) }
  }

  function updateBlock(idx: number, next: NetworkPolicyBlock) { setBlocks((prev) => prev.map((b, i) => (i === idx ? next : b))) }
  function addBlock() { setBlocks((prev) => [...prev, { key: `policy_${prev.length + 1}`, name: `policy-${prev.length + 1}`, endpoints: [{ host: "", port: "443", protocol: "", tls: "", enforcement: "", access: "read-only", rules: [] }], binaries: [{ path: "" }] }]) }

  return (
    <div className="panel p-6 mt-6 border-t-2 border-[var(--nvidia-green)]">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-subtle)]">
        <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
          {mode === 'create' ? 'New Sandbox' : `${sandboxId} — OpenShell Policy`}
        </h4>
        <button onClick={savePolicy} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50">
          {saving ? "Working..." : mode === 'create' ? 'Create Sandbox' : 'Save Policy'}
        </button>
      </div>
      {loading ? <div className="text-sm text-[var(--foreground-dim)]">Loading policy…</div> : <div className="space-y-8">
        {mode === 'create' && <section className="space-y-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4"><div><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Create Sandbox</h5><p className="text-xs text-[var(--foreground-dim)] mt-1">Choose a template and enter a sandbox name.</p></div><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{blueprints.map((bp) => <button key={bp.id} type="button" onClick={() => setSelectedBlueprint(bp.id)} className={`rounded-sm border p-4 text-left ${selectedBlueprint === bp.id ? 'border-[var(--nvidia-green)] bg-[rgba(118,185,0,0.08)]' : 'border-[var(--border-subtle)] bg-[var(--background)]'}`}><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">{bp.label}</span><Badge tone={bp.type === 'custom' ? 'static' : 'dynamic'}>{bp.type}</Badge></div><p className="text-xs text-[var(--foreground-dim)] mt-2">{bp.description}</p></button>)}</div><div><label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Sandbox Name<FieldHelp text="Lowercase letters, numbers, and hyphens only." /></label><input value={sandboxName} onChange={(e) => setSandboxName(e.target.value)} placeholder={selectedBlueprint === 'nemoclaw-blueprint' ? 'my-assistant' : 'custom-sandbox'} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" /></div>{activeBlueprint?.supportsTailscale && <label className="flex items-center gap-3 text-sm text-[var(--foreground)] font-mono"><input type="checkbox" checked={enableTailscale} onChange={(e) => setEnableTailscale(e.target.checked)} /> Enable Tailscale</label>}{enableTailscale && <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300">Tailscale-enabled creation requires NVIDIA_API_KEY in the dashboard process environment.</div>}</section>}
        <section className="space-y-4"><div className="flex items-center justify-between gap-4 flex-wrap"><div><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Security Presets</h5><p className="text-xs text-[var(--foreground-dim)] mt-1">Use a canned profile for new sandboxes or switch an existing sandbox policy baseline on the fly.</p></div><div className="min-w-[260px]"><select value={selectedPreset} onChange={(e) => { const value = e.target.value as SecurityPresetId | ''; setSelectedPreset(value); if (value) applyPreset(value) }} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]"><option value="">Select preset…</option>{SECURITY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></div></div>{activePreset && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 space-y-3"><div className="flex items-center gap-3 flex-wrap"><span className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">{activePreset.label}</span></div><p className="text-sm text-[var(--foreground-dim)]">{activePreset.summary}</p></div>}</section>
        <section className="space-y-4"><div className="flex items-center gap-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Filesystem Policy</h5><Badge tone="static">Static</Badge></div><label className="flex items-center gap-3 text-sm text-[var(--foreground)] font-mono"><input type="checkbox" checked={policy.filesystem_policy.include_workdir} onChange={(e) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, include_workdir: e.target.checked } })} />Include workdir<FieldHelp text="Automatically adds the agent working directory to read_write. Static: changing this requires recreating the sandbox." /></label><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><TextListEditor label="Read-only paths" tooltipText="Absolute paths the sandbox can read but not modify. Paths not listed are inaccessible." value={policy.filesystem_policy.read_only} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_only: v } })} placeholder="/usr\n/lib\n/etc" /><TextListEditor label="Read-write paths" tooltipText="Absolute paths the sandbox can read and write. Keep this scoped; broad paths are rejected." value={policy.filesystem_policy.read_write} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_write: v } })} placeholder="/sandbox\n/tmp" /></div></section>
        <section className="space-y-4"><div className="flex items-center gap-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Network Policies</h5><Badge tone="dynamic">Dynamic</Badge></div><button onClick={addBlock} className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]">Add policy block</button></section>
        {mode === 'existing' && <section className="space-y-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Policy JSON</h5><pre className="overflow-auto rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-[11px] leading-5 text-[var(--foreground)]">{JSON.stringify(assembledPolicy, null, 2)}</pre></section>}
        {message && <div className="text-sm text-[var(--foreground-dim)] whitespace-pre-wrap">{message}</div>}
      </div>}
    </div>
  )
}
