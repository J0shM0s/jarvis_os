import { BACKEND, BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * How much brain is left today.
 *
 * The OpenRouter free tier caps requests per day, and hitting the cap used to
 * look identical to the assistant ignoring you: the turn failed, the HUD went
 * quiet, no hint why. The proxy sees the `x-ratelimit-*` headers on every
 * response and keeps the latest; the bridge exposes them at /quota; this module
 * polls it and keeps the store's `quota` fresh so the HUD can show it.
 *
 * Unknown (null in the store) whenever the brain is not the local proxy — a
 * Claude Code login has no such header — or the bridge is down. The HUD simply
 * omits the readout then.
 */

type Quota = { limit: number; remaining: number; reset: string | null }

let timer: number | undefined

async function poll(): Promise<void> {
  if (BACKEND !== 'bridge') return
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/quota`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(String(res.status))
    const q = (await res.json()) as Partial<Quota>
    if (
      typeof q.limit === 'number' &&
      typeof q.remaining === 'number' &&
      Number.isFinite(q.limit) &&
      Number.isFinite(q.remaining)
    ) {
      useStore.getState().setQuota({
        limit: q.limit,
        remaining: q.remaining,
        reset: typeof q.reset === 'string' ? q.reset : null,
      })
    } else {
      useStore.getState().setQuota(null)
    }
  } catch {
    // Bridge down or a non-proxy brain — show nothing rather than stale data.
    useStore.getState().setQuota(null)
  }
}

/** Start polling alongside the boot sequence; cheap enough to leave running. */
export function startQuotaPolling(intervalMs = 60_000): void {
  if (timer !== undefined) return
  void poll()
  timer = window.setInterval(() => void poll(), intervalMs)
}

export function stopQuotaPolling(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/** One line for the HUD rail: "BRAIN 12/50" — or null when unknown. */
export function quotaLabel(q: { limit: number; remaining: number } | null): string | null {
  if (!q || !Number.isFinite(q.limit) || q.limit <= 0) return null
  const used = Math.max(0, q.limit - q.remaining)
  return `BRAIN ${used}/${q.limit}`
}
