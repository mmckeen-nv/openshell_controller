"use client"
import { useEffect, useMemo, useState } from "react"

type LandlockCompatibility = "best_effort" | "hard_requirement"
type EndpointProtocol = "" | "rest"
type EndpointTls = "" | "terminate" | "passthrough"
type EndpointEnforcement = "" | "enforce" | "audit"
type EndpointAccess = "" | "read-only" | "read-write" | "full"

interface NetworkRule {
  method: string
  path: string
}

interface NetworkEndpoint {
  host: string
  port: string
  protocol: EndpointProtocol
  tls: EndpointTls
  enforcement: EndpointEnforcement
  access: EndpointAccess
  rules: NetworkRule[]
}

interface NetworkBinary {
  path: string
}

interface NetworkPolicyBlock {
  key: string
  name: string
  endpoints: NetworkEndpoint[]
  binaries: NetworkBinary[]
}

interface OpenShellPolicy {
  version: number
  filesystem_policy: {
    include_workdir: boolean
    read_only: string[]
    read_write: string[]
  }
  landlock: {
    compatibility: LandlockCompatibility
  }
  process: {
    run_as_user: string
    run_as_group: string
  }
  network_policies: Record<string, {
    name?: string
    endpoints: Array<{
      host: string
      port: number
      protocol?: string
      tls?: string
      enforcement?: string
      access?: string
      rules?: Array<{ allow: { method: string; path: string } }>
    }>
    binaries: Array<{ path: string }>
  }>
}

interface ConfigurationPanelProps {
  sandboxId: string
}

function FieldHelp({ text }: { text: string }) {
  return (
    <span className="ml-2 inline-flex align-middle group relative">
      <span className="w-4 h-4 rounded-full border border-[var(--foreground-dim)] text-[10px] text-[var(--foreground-dim)] flex items-center justify-center cursor-help">?</span>
      <span className="pointer-events-none absolute left-0 top-6 z-50 hidden w-80 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-panel)] p-2 text-[11px] text-[var(--foreground)] shadow-lg group-hover:block">
        {text}
      </span>
    </span>
  )
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "dynamic" | "static" }) {
  const cls = tone === "dynamic"
    ? "bg-[rgba(118,185,0,0.12)] text-[var(--nvidia-green)] border-[rgba(118,185,0,0.35)]"
    : "bg-[rgba(245,158,11,0.10)] text-amber-400 border-[rgba(245,158,11,0.35)]"
  return <span className={`text-[10px] uppercase tracking-wider border px-2 py-1 rounded-sm ${cls}`}>{children}</span>
}

function TextListEditor({ label, tooltipText, value, onChange, placeholder }: {
  label: string
  tooltipText: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder: string
}) {
  return (
    <div className="space-y-2">
      <label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">
        {label}
        <FieldHelp text={tooltipText} />
      </label>
      <textarea
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n").map(s => s.trim()).filter(Boolean))}
        placeholder={placeholder}
        rows={4}
        className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
      />
    </div>
  )
}

const defaultPolicy: OpenShellPolicy = {
  version: 1,
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/usr", "/lib", "/etc", "/proc", "/dev/urandom"],
    read_write: ["/sandbox", "/tmp", "/dev/null"],
  },
  landlock: {
    compatibility: "best_effort",
  },
  process: {
    run_as_user: "sandbox",
    run_as_group: "sandbox",
  },
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
    landlock: {
      compatibility: current.landlock?.compatibility === "hard_requirement" ? "hard_requirement" : "best_effort",
    },
    process: {
      run_as_user: String(current.process?.run_as_user ?? "sandbox"),
      run_as_group: String(current.process?.run_as_group ?? "sandbox"),
    },
    network_policies: current.network_policies && typeof current.network_policies === "object" ? current.network_policies : {},
  }
}

function policyBlocksFromPolicy(policy: OpenShellPolicy): NetworkPolicyBlock[] {
  return Object.entries(policy.network_policies).map(([key, value]) => ({
    key,
    name: value.name || key,
    endpoints: (value.endpoints || []).map((ep) => ({
      host: ep.host || "",
      port: String(ep.port ?? "443"),
      protocol: ep.protocol === "rest" ? "rest" : "",
      tls: ep.tls === "terminate" || ep.tls === "passthrough" ? ep.tls : "",
      enforcement: ep.enforcement === "enforce" || ep.enforcement === "audit" ? ep.enforcement : "",
      access: ep.access === "read-only" || ep.access === "read-write" || ep.access === "full" ? ep.access : "",
      rules: Array.isArray(ep.rules) ? ep.rules.map((r) => ({ method: r.allow?.method || "GET", path: r.allow?.path || "/**" })) : [],
    })),
    binaries: (value.binaries || []).map((b) => ({ path: b.path || "" })),
  }))
}

function blocksToPolicy(blocks: NetworkPolicyBlock[]): OpenShellPolicy["network_policies"] {
  const out: OpenShellPolicy["network_policies"] = {}
  for (const block of blocks) {
    const key = block.key.trim()
    if (!key) continue
    out[key] = {
      name: block.name.trim() || key,
      endpoints: block.endpoints.filter((ep) => ep.host.trim() && ep.port.trim()).map((ep) => ({
        host: ep.host.trim(),
        port: Number(ep.port),
        ...(ep.protocol ? { protocol: ep.protocol } : {}),
        ...(ep.tls ? { tls: ep.tls } : {}),
        ...(ep.enforcement ? { enforcement: ep.enforcement } : {}),
        ...(ep.access ? { access: ep.access } : {}),
        ...(!ep.access && ep.rules.length ? { rules: ep.rules.filter((r) => r.method.trim() && r.path.trim()).map((r) => ({ allow: { method: r.method.trim(), path: r.path.trim() } })) } : {}),
      })),
      binaries: block.binaries.filter((b) => b.path.trim()).map((b) => ({ path: b.path.trim() })),
    }
  }
  return out
}

export default function ConfigurationPanel({ sandboxId }: ConfigurationPanelProps) {
  const [policy, setPolicy] = useState<OpenShellPolicy>(defaultPolicy)
  const [blocks, setBlocks] = useState<NetworkPolicyBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
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
  }, [sandboxId])

  const assembledPolicy = useMemo(() => ({ ...policy, network_policies: blocksToPolicy(blocks) }), [policy, blocks])

  async function savePolicy() {
    try {
      setSaving(true)
      setMessage("")
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxId)}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: assembledPolicy }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to save policy")
      setMessage("Policy saved. Dynamic network policy can apply live; static sections require sandbox recreation.")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save policy")
    } finally {
      setSaving(false)
    }
  }

  function updateBlock(idx: number, next: NetworkPolicyBlock) {
    setBlocks((prev) => prev.map((b, i) => (i === idx ? next : b)))
  }

  function addBlock() {
    setBlocks((prev) => [...prev, {
      key: `policy_${prev.length + 1}`,
      name: `policy-${prev.length + 1}`,
      endpoints: [{ host: "", port: "443", protocol: "", tls: "", enforcement: "", access: "read-only", rules: [] }],
      binaries: [{ path: "" }],
    }])
  }

  return (
    <div className="panel p-6 mt-6 border-t-2 border-[var(--nvidia-green)]">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-subtle)]">
        <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">{sandboxId} — OPENSHELL POLICY</h4>
        <div className="flex gap-2">
          <Badge tone="static">Static / Recreate Required</Badge>
          <Badge tone="dynamic">Dynamic / Apply Live</Badge>
        </div>
      </div>

      {loading ? <div className="text-sm text-[var(--foreground-dim)]">Loading policy…</div> : (
        <div className="space-y-8">
          <section className="space-y-4">
            <div className="flex items-center gap-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Filesystem Policy</h5><Badge tone="static">Static</Badge></div>
            <label className="flex items-center gap-3 text-sm text-[var(--foreground)] font-mono">
              <input type="checkbox" checked={policy.filesystem_policy.include_workdir} onChange={(e) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, include_workdir: e.target.checked } })} />
              Include workdir
              <FieldHelp text="Automatically adds the agent working directory to read_write. Static: changing this requires recreating the sandbox." />
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextListEditor label="Read-only paths" tooltipText="Absolute paths the sandbox can read but not modify. Paths not listed are inaccessible." value={policy.filesystem_policy.read_only} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_only: v } })} placeholder="/usr
/lib
/etc" />
              <TextListEditor label="Read-write paths" tooltipText="Absolute paths the sandbox can read and write. Keep this scoped; broad paths are rejected." value={policy.filesystem_policy.read_write} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_write: v } })} placeholder="/sandbox
/tmp" />
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Landlock + Process</h5><Badge tone="static">Static</Badge></div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Landlock compatibility<FieldHelp text="best_effort uses the highest kernel ABI available. hard_requirement fails if the required ABI is unavailable." /></label>
                <select value={policy.landlock.compatibility} onChange={(e) => setPolicy({ ...policy, landlock: { compatibility: e.target.value as LandlockCompatibility } })} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono"><option value="best_effort">best_effort</option><option value="hard_requirement">hard_requirement</option></select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Run as user<FieldHelp text="OS-level user for the sandbox process. Upstream policy validation expects sandbox; root is rejected." /></label>
                <input value={policy.process.run_as_user} onChange={(e) => setPolicy({ ...policy, process: { ...policy.process, run_as_user: e.target.value } })} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Run as group<FieldHelp text="OS-level group for the sandbox process. Upstream policy validation expects sandbox; root is rejected." /></label>
                <input value={policy.process.run_as_group} onChange={(e) => setPolicy({ ...policy, process: { ...policy.process, run_as_group: e.target.value } })} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono" />
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Network Policies</h5><Badge tone="dynamic">Dynamic</Badge></div>
              <button onClick={addBlock} className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)]">Add policy block</button>
            </div>
            <p className="text-xs text-[var(--foreground-dim)]">Named endpoint + binary allowlists. These are hot-reloadable on running sandboxes via policy updates.</p>
            <div className="space-y-6">
              {blocks.length === 0 && <div className="text-sm text-[var(--foreground-dim)]">No network policies defined.</div>}
              {blocks.map((block, idx) => (
                <div key={idx} className="border border-[var(--border-subtle)] rounded-sm p-4 space-y-4 bg-[var(--background-tertiary)]">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div><label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Policy key<FieldHelp text="Logical identifier in network_policies map." /></label><input value={block.key} onChange={(e) => updateBlock(idx, { ...block, key: e.target.value })} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono" /></div>
                    <div><label className="text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Display name<FieldHelp text="Optional display name used in logs; defaults to the key." /></label><input value={block.name} onChange={(e) => updateBlock(idx, { ...block, name: e.target.value })} className="mt-2 w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono" /></div>
                  </div>
                  <div className="space-y-4">
                    <div className="text-xs uppercase tracking-wider text-[var(--foreground)]">Endpoints</div>
                    {block.endpoints.map((ep, epIdx) => (
                      <div key={epIdx} className="grid grid-cols-1 md:grid-cols-6 gap-3 border border-[var(--border-subtle)] p-3 rounded-sm">
                        <input placeholder="host" value={ep.host} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, host: e.target.value }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono" />
                        <input placeholder="port" value={ep.port} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, port: e.target.value }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono" />
                        <select value={ep.protocol} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, protocol: e.target.value as EndpointProtocol }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono"><option value="">protocol</option><option value="rest">rest</option></select>
                        <select value={ep.tls} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, tls: e.target.value as EndpointTls }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono"><option value="">tls</option><option value="terminate">terminate</option><option value="passthrough">passthrough</option></select>
                        <select value={ep.enforcement} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, enforcement: e.target.value as EndpointEnforcement }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono"><option value="">enforcement</option><option value="enforce">enforce</option><option value="audit">audit</option></select>
                        <select value={ep.access} onChange={(e) => { const next = [...block.endpoints]; next[epIdx] = { ...ep, access: e.target.value as EndpointAccess }; updateBlock(idx, { ...block, endpoints: next }) }} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-2 py-2 text-xs font-mono"><option value="">rules mode</option><option value="read-only">read-only</option><option value="read-write">read-write</option><option value="full">full</option></select>
                      </div>
                    ))}
                    <button onClick={() => updateBlock(idx, { ...block, endpoints: [...block.endpoints, { host: "", port: "443", protocol: "", tls: "", enforcement: "", access: "", rules: [{ method: "GET", path: "/**" }] }] })} className="px-3 py-2 rounded-sm bg-[var(--background)] text-xs font-mono uppercase tracking-wider">Add endpoint</button>
                  </div>
                  <div className="space-y-3">
                    <div className="text-xs uppercase tracking-wider text-[var(--foreground)]">Binaries</div>
                    {block.binaries.map((bin, binIdx) => (<input key={binIdx} placeholder="/usr/bin/curl" value={bin.path} onChange={(e) => { const next = [...block.binaries]; next[binIdx] = { path: e.target.value }; updateBlock(idx, { ...block, binaries: next }) }} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono" />))}
                    <button onClick={() => updateBlock(idx, { ...block, binaries: [...block.binaries, { path: "" }] })} className="px-3 py-2 rounded-sm bg-[var(--background)] text-xs font-mono uppercase tracking-wider">Add binary</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between"><h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Policy JSON Preview</h5><button onClick={savePolicy} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50">{saving ? "Saving…" : "Save Policy"}</button></div>
            <pre className="overflow-auto rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-[11px] leading-5 text-[var(--foreground)]">{JSON.stringify(assembledPolicy, null, 2)}</pre>
            {message && <div className="text-sm text-[var(--foreground-dim)]">{message}</div>}
          </section>
        </div>
      )}
    </div>
  )
}
