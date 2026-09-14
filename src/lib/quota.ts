import { BACKEND, BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * How much brain is left today — and which brain is answering.
 *
 * The OpenRouter free tier caps requests per day, and hitting the cap used to
 * look identical to the assistant ignoring you: the turn failed, the HUD went
 * quiet, no hint why. The brain proxy now keeps a provider chain (e.g.
 * openrouter P1, local ollama P2): when the online brain runs dry it cools
 * down and the local one takes over. The proxy reports both facts — the
 * `x-ratelimit-*` headers and the currently active provider — the bridge
 * exposes them at /quota, this module polls it into the store, and the HUD
 * shows `BRAIN 12/50` or, once the fallback is serving, `BRAIN OLLAMA`.
 *
 * Null whenever the brain is not the local proxy — a Claude Code login has
 * neither quota nor a chain — or the bridge is down. The HUD simply omits the
 * readout then.
 */

type Quota = {
  limit: number | null
  remaining: number | null
  reset: string | null
  active: string | null
}

let timer: number | undefined

async function poll(): Promise<void> {
  if (BACKEND !== 'bridge') return
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/quota`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(String(res.status))
    const q = (await res.json()) as Partial<Quota>
    const hasQuota =
      typeof q.limit === 'number' &&
      typeof q.remaining === 'number' &&
      Number.isFinite(q.limit) &&
      Number.isFinite(q.remaining)
    const active = typeof q.active === 'string' && q.active ? q.active : null
    if (!hasQuota && !active) {
      // Not the proxy brain at all — hide the readout entirely.
      useStore.getState().setQuota(null)
      return
    }
    useStore.getState().setQuota({
      limit: hasQuota ? (q.limit as number) : null,
      remaining: hasQuota ? (q.remaining as number) : null,
      reset: typeof q.reset === 'string' ? q.reset : null,
      active,
    })
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

/**
 * One line for the HUD rail — or null when unknown.
 *
 *   BRAIN 12/50      the online brain, with today's budget
 *   BRAIN OLLAMA     the fallback is serving (online brain cooled down)
 */
export function quotaLabel(q: {
  limit: number | null
  remaining: number | null
  active: string | null
} | null): string | null {
  if (!q) return null
  if (q.active && q.active !== 'openrouter') return `BRAIN ${q.active.toUpperCase()}`
  if (
    typeof q.limit === 'number' &&
    Number.isFinite(q.limit) &&
    q.limit > 0 &&
    typeof q.remaining === 'number'
  ) {
    const used = Math.max(0, q.limit - q.remaining)
    return `BRAIN ${used}/${q.limit}`
  }
  if (q.active) return `BRAIN ${q.active.toUpperCase()}`
  return null
}
