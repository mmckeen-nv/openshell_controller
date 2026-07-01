import { NextRequest, NextResponse } from "next/server"
import { isOperator } from "@/app/lib/auth/context"
import {
  listSandboxAccessEntries,
  replaceSandboxAccessEntries,
  type SandboxAccessEntry,
} from "@/app/lib/auth/sandboxAccessStore"

const EMAIL_RE = /^[^\s,:@]+@[^\s,:@]+\.[^\s,:@]+$/
const SANDBOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export async function GET(request: NextRequest) {
  if (!(await isOperator(request))) {
    return NextResponse.json({ ok: false, error: "Operator session required." }, { status: 401 })
  }
  return NextResponse.json({ ok: true, entries: listSandboxAccessEntries() })
}

export async function POST(request: NextRequest) {
  if (!(await isOperator(request))) {
    return NextResponse.json({ ok: false, error: "Operator session required." }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const rawEntries = Array.isArray(body?.entries) ? body.entries : null
  if (!rawEntries) {
    return NextResponse.json({ ok: false, error: "Body must include an `entries` array." }, { status: 400 })
  }

  const seen = new Set<string>()
  const normalized: SandboxAccessEntry[] = []
  for (const raw of rawEntries) {
    const sandboxName = typeof raw?.sandboxName === "string" ? raw.sandboxName.trim() : ""
    const email = typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : ""
    if (!sandboxName || !email) {
      return NextResponse.json({ ok: false, error: "Each entry needs both sandboxName and email." }, { status: 400 })
    }
    if (!SANDBOX_NAME_RE.test(sandboxName)) {
      return NextResponse.json({ ok: false, error: `Invalid sandbox name: ${sandboxName}` }, { status: 400 })
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ ok: false, error: `Invalid email: ${email}` }, { status: 400 })
    }
    const key = `${sandboxName}:${email}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ sandboxName, email })
  }

  // File-backed, atomic write. The middleware (Node runtime) reads this file
  // fresh on every request, so the change takes effect immediately — no
  // process restart required.
  const result = replaceSandboxAccessEntries(normalized)
  return NextResponse.json({ ok: true, entries: normalized, storePath: result.path, willRestart: false })
}
