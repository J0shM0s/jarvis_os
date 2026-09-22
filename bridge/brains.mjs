import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { join, resolve, relative, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'

const VAULT_ROOT = resolve(join(import.meta.dirname ?? '.', '..', 'brains'))
// Fallback wenn import.meta.dirname nicht existiert (ältere Node)
const ROOT = VAULT_ROOT.includes('brains') ? VAULT_ROOT : resolve('brains')

const BRAINS = {
  general:  { dir: join(ROOT, '01_general'),  label: 'General (Brain 1 — Normal)' },
  business: { dir: join(ROOT, '02_business'), label: 'Business (Brain 2)' },
  personal: { dir: join(ROOT, '03_personal'), label: 'Personal (Brain 3 — Privat)' },
}
// Alias 1,2,3 und deutsche Namen
const ALIASES = {
  '1': 'general', 'general': 'general', 'allgemein': 'general', 'normal': 'general',
  '2': 'business', 'business': 'business', 'firma': 'business', 'biz': 'business',
  '3': 'personal', 'personal': 'personal', 'privat': 'personal', 'private': 'personal',
}

function resolveBrain(b) {
  const k = String(b ?? 'general').trim().toLowerCase()
  return ALIASES[k] ?? 'general'
}

function safeFile(name) {
  let n = String(name ?? 'inbox.md').trim()
  if (!n) n = 'inbox.md'
  // prevent traversal
  n = n.replace(/\\/g, '/').replace(/\.\./g, '').replace(/^\/+/, '')
  if (!n.endsWith('.md') && !n.includes('.')) n += '.md'
  return n
}

async function ensureBrainDir(brain) {
  const dir = BRAINS[brain].dir
  await mkdir(dir, { recursive: true })
  return dir
}

export function brainsServer() {
  return createSdkMcpServer({
    name: 'jarvis_brains',
    version: '1.0.0',
    instructions: '3-Brain Vault (Obsidian). general=01_general (normal), business=02_business (Firma), personal=03_personal (privat). Nutze brain_write/brain_read/brain_list/brain_search für schnellen Zugriff. Jede Brain ist ein Ordner voller Markdown.',
    alwaysLoad: true,
    tools: [
      tool('brain_write', 'Schreibe/append in ein Brain — erstellt Datei/Ordner falls nötig. Für schnelles Merken. Brain: general/business/personal (alias 1/2/3).',
        {
          brain: z.enum(['general','business','personal','1','2','3','allgemein','privat']).default('general').describe('Welches Brain: general(1), business(2), personal(3)'),
          file: z.string().default('inbox.md').describe('Datei in Brain, z.B. inbox.md, kunden/acme.md, profil.md'),
          content: z.string().describe('Markdown Inhalt zum Schreiben'),
          mode: z.enum(['append','overwrite']).default('append').describe('append = anfügen (default), overwrite = überschreiben'),
        },
        async ({ brain, file, content, mode }) => {
          const b = resolveBrain(brain)
          const dir = await ensureBrainDir(b)
          const rel = safeFile(file)
          const abs = join(dir, rel)
          // containment check
          const relCheck = relative(dir, abs)
          if (relCheck.startsWith('..')) return { isError: true, content: [{ type: 'text', text: 'Pfad außerhalb des Brains' }] }
          await mkdir(dirname(abs), { recursive: true })
          if (mode === 'append' && existsSync(abs)) {
            const prev = await readFile(abs, 'utf8').catch(() => '')
            const stamp = new Date().toISOString().slice(0,10)
            const toWrite = prev + (prev.endsWith('\n') ? '' : '\n') + `\n## ${stamp}\n${content}\n`
            await writeFile(abs, toWrite, 'utf8')
            return { content: [{ type: 'text', text: `Angehängt an ${b}/${rel} (${content.length} Zeichen)` }] }
          } else {
            await writeFile(abs, content, 'utf8')
            return { content: [{ type: 'text', text: `Gespeichert: ${b}/${rel} (${content.length} Zeichen)` }] }
          }
        }),

      tool('brain_read', 'Lese Datei aus einem Brain (max 40kB).',
        {
          brain: z.enum(['general','business','personal','1','2','3','allgemein','privat']).default('general'),
          file: z.string().describe('Datei, z.B. inbox.md, profil.md, _index.md'),
        },
        async ({ brain, file }) => {
          const b = resolveBrain(brain)
          const abs = join(BRAINS[b].dir, safeFile(file))
          try {
            const txt = await readFile(abs, 'utf8')
            return { content: [{ type: 'text', text: txt.slice(0, 40000) || '(leer)' }] }
          } catch (e) { return { isError: true, content: [{ type: 'text', text: `Nicht gefunden: ${b}/${file} — ${e.message}` }] } }
        }),

      tool('brain_list', 'Liste alle Dateien in einem Brain (oder allen Brains).',
        {
          brain: z.enum(['general','business','personal','all']).default('all').describe('general/business/personal oder all'),
        },
        async ({ brain }) => {
          const targets = brain === 'all' ? Object.entries(BRAINS) : [[resolveBrain(brain), BRAINS[resolveBrain(brain)]]]
          let out = ''
          for (const [key, { dir, label }] of targets) {
            try {
              const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(async () => await readdir(dir, { withFileTypes: true }))
              // Node <20 no recursive — fallback flat
              const flat = []
              async function walk(d, prefix='') {
                const es = await readdir(d, { withFileTypes: true }).catch(()=>[])
                for (const e of es) {
                  const p = prefix ? `${prefix}/${e.name}` : e.name
                  if (e.isDirectory()) { flat.push(`DIR  ${p}/`); await walk(join(d, e.name), p) }
                  else flat.push(`FILE ${p}`)
                }
              }
              if (entries.length && entries[0] && typeof entries[0].isDirectory === 'function' && !entries.some(e=>e.name.includes('/'))) {
                // try walk
                flat.length = 0
                await walk(dir)
                out += `\n== ${label} [${key}] ==\n${dir}\n${flat.slice(0,80).join('\n') || '(leer)'}\n`
              } else {
                out += `\n== ${label} [${key}] ==\n${dir}\n${entries.slice(0,80).map(e=>`${e.isDirectory()?'DIR ':'FILE'} ${e.name}`).join('\n') || '(leer)'}\n`
              }
            } catch (e) { out += `\n== ${label} ==\nFehler: ${e.message}\n` }
          }
          return { content: [{ type: 'text', text: out.trim() || '(keine Brains gefunden)' }] }
        }),

      tool('brain_search', 'Volltextsuche über alle Brains (grep über Markdown).',
        {
          query: z.string().describe('Suchbegriff'),
          brain: z.enum(['general','business','personal','all']).default('all'),
        },
        async ({ query, brain }) => {
          const q = String(query).toLowerCase()
          const targets = brain === 'all' ? Object.values(BRAINS) : [BRAINS[resolveBrain(brain)]]
          let hits = []
          for (const { dir } of targets) {
            async function walk(d, prefix='') {
              const es = await readdir(d, { withFileTypes: true }).catch(()=>[])
              for (const e of es) {
                const rel = prefix ? `${prefix}/${e.name}` : e.name
                const abs = join(d, e.name)
                if (e.isDirectory()) await walk(abs, rel)
                else if (e.name.endsWith('.md')) {
                  try {
                    const txt = await readFile(abs, 'utf8')
                    const lines = txt.split('\n')
                    lines.forEach((line, i) => {
                      if (line.toLowerCase().includes(q)) hits.push(`${rel}:${i+1}: ${line.slice(0,140)}`)
                    })
                  } catch {}
                }
              }
            }
            await walk(dir)
          }
          const out = hits.slice(0, 40).join('\n') || '(keine Treffer)'
          return { content: [{ type: 'text', text: `Suche "${query}" in ${brain}:\n${out}` }] }
        }),
    ]
  })
}
