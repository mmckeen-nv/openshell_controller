type RateLimitBucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, RateLimitBucket>()

export type RateLimitResult = {
  limited: boolean
  retryAfterSeconds: number
}

function clientAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded
    || request.headers.get("x-real-ip")
    || request.headers.get("cf-connecting-ip")
    || "local"
}

export function rateLimitKey(request: Request, scope: string) {
  return `${scope}:${clientAddress(request)}`
}

export function checkRateLimit(key: string, maxAttempts: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const current = buckets.get(key)
  if (!current || current.resetAt <= now) {
    return { limited: false, retryAfterSeconds: 0 }
  }

  return {
    limited: current.count >= maxAttempts,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  }
}

export function recordRateLimitFailure(key: string, windowMs: number) {
  const now = Date.now()
  const current = buckets.get(key)
  const next = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + windowMs }
    : { count: current.count + 1, resetAt: current.resetAt }

  buckets.set(key, next)
  return next
}

export function clearRateLimit(key: string) {
  buckets.delete(key)
}
