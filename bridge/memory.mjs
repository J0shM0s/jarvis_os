import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

/**
 * Persistent memory — JARVIS can remember things between turns.
 *
 * Two separate namespaces:
 *   general  — private assistant brain (your gmail, preferences, notes)
 *   business — business partner brain
 *
 * Stored at ~/.jarvis/memory.json so it survives restarts.
 * Each entry: { value, updatedAt }
 */

const DIR = join(homedir(), '.jarvis')
const FILE = join(DIR, 'memory.json')

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }) } catch {}
}

function load() {
  try {
    const raw = readFileSync(FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      return {
        general: data.general && typeof data.general === 'object' ? data.general : {},
        business: data.business && typeof data.business === 'object' ? data.business : {},
      }
    }
  } catch {}
  return { general: {}, business: {} }
}

function save(data) {
  ensureDir()
  try { writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8') } catch (e) { console.error('[memory] save failed', e) }
}

const normKey = (k) => String(k).trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80)
const normMode = (m) => m === 'business' ? 'business' : 'general'

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions: 'Long-term memory. Save, recall and forget facts across turns. Use general for personal, business for business context.',
    alwaysLoad: true,
    tools: [
      tool('remember', 'Save a fact to long-term memory. Use for anything the user asks you to remember: gmail, preferences, notes, business data. Category is usually a short key like gmail, preference, note, client, idea.',
        {
          key: z.string().describe('Short key, e.g. "gmail", "birthday", "client_acme"'),
          value: z.string().describe('The value to remember'),
          category: z.enum(['general', 'business']).default('general').describe('Which brain: general or business'),
        },
        async (args) => {
          const data = load()
          const mode = normMode(args.category)
          const key = normKey(args.key)
          if (!key || !String(args.value).trim()) return { isError: true, content: [{ type: 'text', text: 'Need both key and value.' }] }
          data[mode][key] = { value: String(args.value).trim(), updatedAt: new Date().toISOString() }
          save(data)
          console.log(`[memory] remember ${mode}:${key}`)
          return { content: [{ type: 'text', text: `Saved ${key} to ${mode} memory.` }] }
        }),

      tool('recall', 'Recall a fact from memory. If key is given, returns that entry. If omitted, lists all keys for the category.',
        {
          key: z.string().optional().describe('Key to recall, omit to list all'),
          category: z.enum(['general', 'business']).default('general'),
        },
        async (args) => {
          const data = load()
          const mode = normMode(args.category)
          const bucket = data[mode]
          if (args.key) {
            const k = normKey(args.key)
            const entry = bucket[k]
            if (!entry) return { content: [{ type: 'text', text: `No memory for "${k}" in ${mode}.` }] }
            return { content: [{ type: 'text', text: JSON.stringify({ key: k, ...entry }, null, 2) }] }
          }
          const keys = Object.keys(bucket)
          if (!keys.length) return { content: [{ type: 'text', text: `No memories in ${mode} yet.` }] }
          const summary = keys.map(k => `${k}: ${String(bucket[k].value).slice(0, 120)}`).join('\n')
          return { content: [{ type: 'text', text: `Memory ${mode} (${keys.length}):\n${summary}` }] }
        }),

      tool('forget', 'Delete a fact from memory.',
        {
          key: z.string().describe('Key to delete'),
          category: z.enum(['general', 'business']).default('general'),
        },
        async (args) => {
          const data = load()
          const mode = normMode(args.category)
          const k = normKey(args.key)
          if (!data[mode][k]) return { content: [{ type: 'text', text: `No entry "${k}" in ${mode}.` }] }
          delete data[mode][k]
          save(data)
          console.log(`[memory] forget ${mode}:${k}`)
          return { content: [{ type: 'text', text: `Forgot ${k} from ${mode}.` }] }
        }),

      tool('list_memory', 'List all memories in both brains or one category (compact overview).',
        {
          category: z.enum(['general', 'business', 'all']).default('all'),
        },
        async (args) => {
          const data = load()
          const cat = args.category
          if (cat === 'all') {
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
          }
          const mode = normMode(cat)
          return { content: [{ type: 'text', text: JSON.stringify({ [mode]: data[mode] }, null, 2) }] }
        }),
    ],
  })
}

// Also expose helpers for HTTP endpoints / debugging
export function getMemorySnapshot() { return load() }
