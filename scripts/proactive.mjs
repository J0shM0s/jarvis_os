#!/usr/bin/env node
/**
 * JARVIS Proaktiv — Offerte Follow-up + Tagesbriefing
 * Liest brains/02_business + Kalender/Gmail (falls google-workspace) und schreibt:
 *  - brains/02_business/_briefing.md (für nächsten JARVIS Start)
 *  - Windows Toast (via PowerShell) wenn überfällig
 *
 * Aufruf: node scripts/proactive.mjs [--toast]
 * Cron: Windows Task Scheduler täglich 08:00 + alle 3 Tage 18:00 für Offerten
 */
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(join(import.meta.dirname ?? '.', '..'))
const BRAINS = join(ROOT, 'brains')
const BUSINESS = join(BRAINS, '02_business')

async function daysSince(file) {
  try { const s = await stat(file); return (Date.now() - s.mtimeMs) / 86400000 } catch { return 99 }
}

async function toast(title, msg) {
  if (!process.argv.includes('--toast')) return
  try {
    const ps = `New-BurntToastNotification -Text '${title.replace(/'/g,"''")}', '${msg.replace(/'/g,"''")}'`
    await exec('powershell', ['-Command', ps])
  } catch {
    // Fallback: PowerShell ohne Modul
    try {
      const script = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000,'${title}','${msg}',[System.Windows.Forms.ToolTipIcon]::Info)`
      await exec('powershell', ['-Command', script])
    } catch {}
  }
}

async function main() {
  const now = new Date()
  const today = now.toISOString().slice(0,10)
  const inbox = join(BUSINESS, 'inbox.md')
  const kunden = join(BUSINESS, 'kunden.md')
  const briefing = join(BUSINESS, '_briefing.md')

  let inboxTxt = ''
  try { inboxTxt = await readFile(inbox, 'utf8') } catch {}
  let kundenTxt = ''
  try { kundenTxt = await readFile(kunden, 'utf8') } catch {}

  const dInbox = await daysSince(inbox)
  const dKunden = await daysSince(kunden)

  // Offerten-Check: Wenn inbox/kunden älter als 2 Tage und enthält "Offerte geschickt"
  const pending = (inboxTxt + kundenTxt).includes('Offerte')
  const overdue = pending && Math.max(dInbox, dKunden) >= 2

  let briefingTxt = `# Tagesbriefing ${today}\n\n`
  briefingTxt += `> Auto-generiert proaktiv — JARVIS liest das beim nächsten Start\n\n`
  briefingTxt += `## Business — Winterthur\n`
  if (overdue) {
    briefingTxt += `- ⚠️ **Offerte Follow-up fällig!** 2 Offerten seit ${Math.round(Math.max(dInbox, dKunden))} Tagen ohne Update. Heute nachfassen!\n`
  } else {
    briefingTxt += `- Offerten: 2 geschickt — kein Follow-up überfällig (letztes Update vor ${Math.round(Math.min(dInbox, dKunden))} Tag(en))\n`
  }
  briefingTxt += `- Inbox: ${inboxTxt.split('\n').filter(l=>l.startsWith('- ')).slice(0,3).join(' | ') || 'leer'}\n\n`
  briefingTxt += `## To-do heute\n`
  briefingTxt += `- [ ] Offerte 1 + 2 Follow-up (Anruf/Mail)\n`
  briefingTxt += `- [ ] 1 neuen Betrieb ohne Website in Winterthur finden\n`
  briefingTxt += `- [ ] Gym von zuhause: 15 Min Session\n\n`
  briefingTxt += `## Personal\n`
  try {
    const profil = await readFile(join(BRAINS, '03_personal/profil.md'), 'utf8')
    const interests = profil.includes('Unihockey') ? 'Unihockey' : 'Sport'
    briefingTxt += `- Fokus: ${interests} + KI/IT — ${today} als guter Tag nutzen\n`
  } catch { briefingTxt += `- Sir Josh — fit, bereit für Home-Gym\n` }

  await writeFile(briefing, briefingTxt, 'utf8')
  console.log(`[proactive] Briefing → ${briefing}`)

  if (overdue) {
    console.log('[proactive] Offerte Follow-up ÜBERFÄLLIG — Toast + JARVIS wird beim Start daran erinnern')
    await toast('JARVIS — Offerte fällig', '2 Offerten in Winterthur warten seit 2+ Tagen auf Follow-up!')
  } else {
    console.log('[proactive] Kein Follow-up überfällig')
  }

  // Auch für JARVIS Memory: schreibe compact für Voice
  const voiceLine = overdue
    ? `Sir, zwei Offerten in Winterthur warten seit ${Math.round(Math.max(dInbox, dKunden))} Tagen auf Follow-up — heute nachfassen.`
    : `Business ruhig, Sir — zwei Offerten draußen, heute einen neuen Betrieb ohne Website finden.`
  await writeFile(join(BUSINESS, '_voice.md'), voiceLine, 'utf8')
}

main().catch(e => { console.error(e); process.exit(1) })
