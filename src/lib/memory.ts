/**
 * Client-side memory helper (for direct mode + UI).
 * Mirrors bridge/memory.mjs but in localStorage so it works without bridge.
 * Bridge mode is primary — this is just the fallback and UI preview.
 */

const KEY_GENERAL = 'jarvis.memory.general.v1'
const KEY_BUSINESS = 'jarvis.memory.business.v1'

export type MemoryBucket = Record<string, { value: string; updatedAt: string }>

function loadBucket(key: string): MemoryBucket {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as MemoryBucket
  } catch { return {} }
}

function saveBucket(key: string, data: MemoryBucket) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch {}
}

const normKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80)

export function saveMemory(key: string, value: string, mode: 'general' | 'business' = 'general') {
  const k = normKey(key)
  if (!k || !value.trim()) return
  const storeKey = mode === 'business' ? KEY_BUSINESS : KEY_GENERAL
  const bucket = loadBucket(storeKey)
  bucket[k] = { value: value.trim(), updatedAt: new Date().toISOString() }
  saveBucket(storeKey, bucket)
}

export function getMemory(key: string, mode: 'general' | 'business' = 'general'): string | null {
  const storeKey = mode === 'business' ? KEY_BUSINESS : KEY_GENERAL
  const bucket = loadBucket(storeKey)
  return bucket[normKey(key)]?.value ?? null
}

export function listMemories(mode: 'general' | 'business' = 'general'): MemoryBucket {
  return loadBucket(mode === 'business' ? KEY_BUSINESS : KEY_GENERAL)
}

export function deleteMemory(key: string, mode: 'general' | 'business' = 'general') {
  const storeKey = mode === 'business' ? KEY_BUSINESS : KEY_GENERAL
  const bucket = loadBucket(storeKey)
  const k = normKey(key)
  if (bucket[k]) { delete bucket[k]; saveBucket(storeKey, bucket) }
}

export function getMemoryContext(mode: 'general' | 'business' = 'general'): string {
  const bucket = listMemories(mode)
  const keys = Object.keys(bucket)
  if (!keys.length) return ''
  return keys.map(k => `${k}: ${bucket[k].value}`).join('\n')
}
