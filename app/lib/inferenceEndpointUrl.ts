export type InferenceEndpointFlavor = "anthropic" | "openai"

const HOST_REACHABLE_FROM_OPENSHELL = "host.docker.internal"
const LOCAL_GATEWAY_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"])

function stripEndpointSuffix(pathname = "", suffixes: string[] = []) {
  for (const suffix of suffixes) {
    if (pathname === suffix) return ""
    if (pathname.endsWith(suffix)) return pathname.slice(0, -suffix.length)
  }
  return pathname
}

function endpointSuffixes(flavor: InferenceEndpointFlavor) {
  return flavor === "anthropic"
    ? ["/v1/messages", "/v1/models", "/v1", "/messages", "/models"]
    : ["/responses", "/chat/completions", "/completions", "/models"]
}

function ensureScheme(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

export function normalizeInferenceBaseUrlForGateway(value: string, flavor: InferenceEndpointFlavor = "openai") {
  const raw = String(value || "").trim()
  if (!raw) return ""

  try {
    const url = new URL(ensureScheme(raw))
    url.search = ""
    url.hash = ""
    if (LOCAL_GATEWAY_HOSTS.has(url.hostname.toLowerCase())) {
      url.hostname = HOST_REACHABLE_FROM_OPENSHELL
    }
    let pathname = stripEndpointSuffix(url.pathname.replace(/\/+$/, ""), endpointSuffixes(flavor))
    pathname = pathname.replace(/\/+$/, "")
    url.pathname = pathname || "/"
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "")
  }
}
