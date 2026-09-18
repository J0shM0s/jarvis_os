import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Speichert Business-Daten in ~/.jarvis/business.json (getrennt von memory)
const DIR = join(homedir(), '.jarvis')
const FILE = join(DIR, 'business.json')

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch { return { ideas: [], leads: [], invoices: [], goals: [] } }
}
function save(data) {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(data, null, 2)) } catch {}
}

export function businessServer() {
  return createSdkMcpServer({
    name: 'jarvis_business',
    version: '1.0.0',
    instructions: 'Business-Helper: Ideen, Leads, Rechnungen, Ziele. Alles lokal in ~/.jarvis/business.json. Nutze für Business-Mode.',
    alwaysLoad: true,
    tools: [
      tool('business_idea', 'Speichere eine Business-Idee mit Titel + Notiz',
        { title: z.string(), note: z.string().optional(), tag: z.string().optional() },
        async ({ title, note, tag }) => {
          const d = load(); d.ideas.push({ id: Date.now().toString(36), title, note: note||'', tag: tag||'general', at: new Date().toISOString() }); save(d)
          return { content: [{ type: 'text', text: `Idee gespeichert: ${title}` }] }
        }),
      tool('business_lead', 'Erfasse Lead/Kontakt',
        { name: z.string(), contact: z.string().optional(), value: z.string().optional(), status: z.enum(['neu','kontaktiert','verhandlung','gewonnen','verloren']).default('neu') },
        async (a) => {
          const d = load(); d.leads.push({ id: Date.now().toString(36), ...a, at: new Date().toISOString() }); save(d)
          return { content: [{ type: 'text', text: `Lead ${a.name} → ${a.status}` }] }
        }),
      tool('business_invoice', 'Entwurf Rechnung (noch nicht versendet) — speichert lokal, du kannst später Stripe nutzen',
        { to: z.string(), amount: z.string(), desc: z.string().optional() },
        async ({ to, amount, desc }) => {
          const d = load(); const inv = { id: `INV-${Date.now().toString(36).toUpperCase()}`, to, amount, desc: desc||'', at: new Date().toISOString(), status: 'draft' }; d.invoices.push(inv); save(d)
          return { content: [{ type: 'text', text: `Rechnung ${inv.id} an ${to}: ${amount} — Entwurf gespeichert` }] }
        }),
      tool('business_goal', 'Setze Business-Ziel mit Deadline',
        { goal: z.string(), deadline: z.string().optional() },
        async ({ goal, deadline }) => {
          const d = load(); d.goals.push({ id: Date.now().toString(36), goal, deadline: deadline||'', at: new Date().toISOString() }); save(d)
          return { content: [{ type: 'text', text: `Ziel: ${goal} ${deadline?'bis '+deadline:''}` }] }
        }),
      tool('business_overview', 'Zeige Business-Übersicht (Ideen, Leads, Rechnungen, Ziele)',
        {},
        async () => {
          const d = load()
          const txt = `Business Overview:\nIdeen: ${d.ideas.length}\nLeads: ${d.leads.length}\nRechnungen: ${d.invoices.length}\nZiele: ${d.goals.length}\n\n` +
            `Letzte Ideen:\n${d.ideas.slice(-3).map(i=>`- ${i.title} [${i.tag}]`).join('\n') || '-'}\n` +
            `Letzte Leads:\n${d.leads.slice(-3).map(l=>`- ${l.name} ${l.status} ${l.value||''}`).join('\n') || '-' }`
          return { content: [{ type: 'text', text: txt }] }
        }),
    ]
  })
}
