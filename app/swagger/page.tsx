import Link from "next/link"
import { buildOpenApiSpec } from "@/app/lib/openapiSpec"

type OpenApiSpec = ReturnType<typeof buildOpenApiSpec>

function methodClass(method: string) {
  const normalized = method.toLowerCase()
  if (normalized === "get") return "border-blue-500/40 bg-blue-500/10 text-blue-300"
  if (normalized === "post") return "border-[var(--nvidia-green)]/50 bg-[var(--nvidia-green)]/10 text-[var(--nvidia-green)]"
  return "border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-[var(--foreground-dim)]"
}

function operationRows(spec: OpenApiSpec) {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      path,
      method,
      operation,
    })),
  )
}

export default function SwaggerPage() {
  const spec = buildOpenApiSpec()
  const rows = operationRows(spec)

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-7xl space-y-6 p-8 max-sm:p-4">
        <section className="panel p-8">
          <div className="flex items-start justify-between gap-4 max-md:flex-col">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">OpenAPI 3.1</p>
              <h1 className="mt-2 text-xl font-semibold uppercase tracking-wider text-[var(--foreground)]">Swagger</h1>
              <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-dim)]">
                Controller-node API reference for generating launch kits, autodeploying remote nodes, and managing friendly names.
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/" className="action-button px-3 py-2">
                Dashboard
              </Link>
              <a href="/api/openapi" className="rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black">
                OpenAPI JSON
              </a>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="metric p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Title</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{spec.info.title}</p>
          </div>
          <div className="metric p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Version</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{spec.info.version}</p>
          </div>
          <div className="metric p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Auth</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">session cookie</p>
          </div>
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-[var(--border-subtle)] p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Endpoints</h2>
            <p className="mt-1 text-xs text-[var(--foreground-dim)]">Expandable operations generated from the local OpenAPI spec.</p>
          </div>
          <div className="divide-y divide-[var(--border-subtle)]">
            {rows.map(({ path, method, operation }) => (
              <details key={`${method}-${path}`} className="group">
                <summary className="flex cursor-pointer items-center justify-between gap-4 p-5 marker:content-[''] hover:bg-[var(--background-tertiary)]">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className={`rounded-sm border px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider ${methodClass(method)}`}>
                      {method}
                    </span>
                    <span className="truncate font-mono text-sm text-[var(--foreground)]">{path}</span>
                  </span>
                  <span className="truncate text-xs text-[var(--foreground-dim)]">{operation.summary}</span>
                </summary>
                <div className="space-y-4 border-t border-[var(--border-subtle)] bg-[var(--background-secondary)] p-5">
                  <p className="text-sm leading-6 text-[var(--foreground-dim)]">{operation.description || operation.summary}</p>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Operation</h3>
                      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[var(--foreground-dim)]">{JSON.stringify(operation, null, 2)}</pre>
                    </div>
                    <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Curl</h3>
                      <pre className="mt-3 whitespace-pre-wrap text-[11px] leading-5 text-[var(--foreground-dim)]">{`${method.toUpperCase()} ${path}\nContent-Type: application/json\nCookie: ${spec.components.securitySchemes.sessionCookie.name}=...`}</pre>
                    </div>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Schemas</h2>
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Object.entries(spec.components.schemas).map(([name, schema]) => (
              <details key={name} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)]">
                <summary className="cursor-pointer p-4 font-mono text-xs text-[var(--foreground)]">{name}</summary>
                <pre className="max-h-96 overflow-auto border-t border-[var(--border-subtle)] p-4 text-[11px] leading-5 text-[var(--foreground-dim)]">{JSON.stringify(schema, null, 2)}</pre>
              </details>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
