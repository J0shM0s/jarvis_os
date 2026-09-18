import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)

// Python Pfad — nvm Node Pfad ist separat, Python liegt unter Local/Programs
const PYTHONS = [
  'C:\\Users\\moser\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  'C:\\Python312\\python.exe',
  'python',
  'python3',
]

let PYTHON = PYTHONS[0]
for (const p of PYTHONS) {
  try { if (existsSync(p)) { PYTHON = p; break; } } catch {}
}
// Fallback: erstes das existiert, sonst python

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const HERE = dirname(fileURLToPath(import.meta.url))
const PY_SCRIPT = join(HERE, 'os_control.py')

// Sandbox: voll isoliert, damit User weiterarbeiten kann — Hidden-Desktop via CreateDesktop
let sandboxEnabled = true // default AN für "ohne zu blockieren" — User kann via Tool toggeln
function sbFlag() { return sandboxEnabled ? ['--sandbox'] : [] }

async function runPy(args) {
  try {
    const { stdout } = await execFileAsync(PYTHON, [PY_SCRIPT, ...args], { timeout: 15000, windowsHide: true, maxBuffer: 25*1024*1024 })
    const txt = stdout.trim()
    // Letzte Zeile ist JSON
    const lines = txt.split('\n').filter(Boolean)
    const last = lines[lines.length-1]
    try { return JSON.parse(last) } catch { return { raw: txt } }
  } catch (e) {
    return { error: e.message + (e.stdout ? ' | ' + e.stdout.slice(0,500) : '') }
  }
}

/**
 * @param {(msg:string)=>void} emitLog — schickt JARVIS Log an GUI (non-blocking)
 * @param {(dataUrl:string)=>void} emitImage — schickt Sandbox-Live-Bild an GUI
 */
export function osServer(emitLog, emitImage) {
  const log = (msg) => {
    try { emitLog(msg) } catch {}
    console.log(`[os] ${msg}`)
  }
  const emitSandbox = (b64) => {
    try {
      const url = `data:image/png;base64,${b64}`
      if (emitImage) emitImage(url)
      // auch Log für Sichtbarkeit
      try { emitLog(`JARVIS Log: Sandbox aktualisiert`) } catch {}
    } catch {}
  }

  return createSdkMcpServer({
    name: 'jarvis_os',
    version: '1.0.0',
    instructions: 'OS control: capture_screen, move_and_click, type_text, press_key, upload_file, sandbox_mode. Vor jeder Aktion Log senden. Sandbox ist voll isoliert via Hidden-Desktop (CreateDesktop) — User kann live weiterarbeiten.',
    alwaysLoad: true,
    tools: [
      tool('capture_screen', 'Erfasse den aktuellen Bildschirm als Screenshot für visuelle Analyse. Gibt Bild + Koordinaten-System zurück. Immer zuerst aufrufen bevor du klickst.',
        { hint: z.string().optional().describe('Wofür du schaust, z.B. "suche NotebookLM Create Button"') },
        async (args) => {
          log(`JARVIS Log: Erfasse Bildschirm${args.hint ? ` — ${args.hint}` : ''}${sandboxEnabled?' [Sandbox isoliert]':''}...`)
          try { if (emitImage) emitImage(''); } catch {}
          const res = await runPy(['capture', '--output', join(tmpdir(), `jarvis_${Date.now()}.png`), ...sbFlag()])
          if (res.error) return { isError: true, content: [{ type: 'text', text: `capture failed: ${res.error}` }] }
          const content = []
          if (res.base64) {
            content.push({ type: 'image', data: res.base64, mimeType: res.mime || 'image/png' })
            emitSandbox(res.base64)
          }
          content.push({ type: 'text', text: JSON.stringify({ path: res.path, width: res.width, height: res.height, hint: args.hint||'', sandbox: sandboxEnabled }, null, 2) })
          log(`JARVIS Log: Bildschirm erfasst ${res.width}x${res.height}${sandboxEnabled?' — Sandbox live':''} — bereit für Analyse`)
          return { content }
        }),

      tool('move_and_click', 'Bewege Maus und klicke. Nutze Koordinaten aus letztem Screenshot (0..width). Im Sandbox-Modus isoliert.',
        { x: z.number().describe('X Koordinate'), y: z.number().describe('Y Koordinate'), label: z.string().optional().describe('Menschenlesbar: "Klick auf Neues Notizbuch"') },
        async (args) => {
          log(`JARVIS Log: Klicke auf '${args.label || 'Ziel'}' bei Position (${args.x}, ${args.y})${sandboxEnabled?' [Sandbox]':''}...`)
          const res = await runPy(['click', '--x', String(Math.round(args.x)), '--y', String(Math.round(args.y)), ...sbFlag()])
          if (res.error) { log(`JARVIS Log: Klick fehlgeschlagen — ${res.error}`); return { isError:true, content:[{type:'text', text: res.error}] } }
          log(`JARVIS Log: Klick ausgeführt bei (${args.x}, ${args.y})${sandboxEnabled?' — Sandbox, dein Desktop frei':''}`)
          return { content: [{ type:'text', text: `Clicked (${args.x},${args.y}) — ${args.label||''}${sandboxEnabled?' [Sandbox]':''}` }] }
        }),

      tool('type_text', 'Tippe Text via Tastatur (für Eingabefelder, Suche, etc.)',
        { text: z.string().describe('Zu tippender Text'), label: z.string().optional().describe('Wofür') },
        async (args) => {
          log(`JARVIS Log: Tippe "${args.text.slice(0,40)}${args.text.length>40?'…':''}"${args.label?' — '+args.label:''}${sandboxEnabled?' [Sandbox]':''}...`)
          const res = await runPy(['type', '--text', args.text, ...sbFlag()])
          if (res.error) { log(`JARVIS Log: Tippen fehlgeschlagen`); return {isError:true, content:[{type:'text', text: res.error}]} }
          log(`JARVIS Log: Text eingegeben${sandboxEnabled?' — Sandbox':''}`)
          return { content: [{type:'text', text: `Typed: ${args.text}`}] }
        }),

      tool('press_key', 'Drücke Tastenkombination (Enter, Tab, Ctrl+V, Alt+F4, Win+R, etc.)',
        { combo: z.string().describe('z.B. "enter", "ctrl+v", "alt+tab", "win+r"') },
        async (args) => {
          log(`JARVIS Log: Drücke ${args.combo}${sandboxEnabled?' [Sandbox]':''}...`)
          const res = await runPy(['key', '--combo', args.combo, ...sbFlag()])
          if (res.error) return {isError:true, content:[{type:'text', text: res.error}]}
          log(`JARVIS Log: Taste ${args.combo} gedrückt`)
          return { content: [{type:'text', text: `Pressed ${args.combo}`}] }
        }),

      tool('upload_file', 'Wähle Datei im geöffneten File-Dialog aus (Pfad tippen + Enter). Datei muss existieren.',
        { file_path: z.string().describe('Absoluter Pfad, z.B. C:/Users/moser/Dokumente/file.pdf') },
        async (args) => {
          log(`JARVIS Log: Lade Datei hoch — ${args.file_path.split(/[\\/]/).pop()}${sandboxEnabled?' [Sandbox]':''}...`)
          const { existsSync } = await import('node:fs')
          if (!existsSync(args.file_path)) {
            log(`JARVIS Log: Datei nicht gefunden: ${args.file_path}`)
            return {isError:true, content:[{type:'text', text:`File not found: ${args.file_path}`}]}
          }
          const res = await runPy(['upload', '--file', args.file_path, ...sbFlag()])
          if (res.error) { log(`JARVIS Log: Upload fehlgeschlagen`); return {isError:true, content:[{type:'text', text: res.error}]} }
          log(`JARVIS Log: Datei ausgewählt — ${args.file_path}`)
          return { content: [{type:'text', text: `File dialog filled: ${res.file}`}] }
        }),
      tool('launch_app', 'Öffne JEDE Desktop-App via Startmenü oder direktem Pfad. Funktioniert für WhatsApp, Spotify, Rechner, Chrome, etc. — auch im Sandbox isoliert.',
        { app: z.string().describe('App-Name ("WhatsApp", "Rechner", "Spotify") oder absoluter Pfad ("C:/Program Files/.../app.exe")') },
        async ({ app }) => {
          log(`JARVIS Log: Öffne App "${app}"${sandboxEnabled?' [Sandbox]':''}...`)
          const res = await runPy(['launch', '--app', app, ...sbFlag()])
          if (res.error) { log(`JARVIS Log: App öffnen fehlgeschlagen`); return {isError:true, content:[{type:'text', text: res.error}]} }
          log(`JARVIS Log: App geöffnet: ${res.launched} via ${res.method}`)
          // Kurz warten + Screenshot zur Kontrolle
          await new Promise(r=>setTimeout(r,900))
          return { content: [{type:'text', text: `Opened ${app} → ${res.launched} (${res.method})`}] }
        }),
      tool('list_apps', 'Liste alle installierten Desktop-Apps (Startmenü) — damit du weißt was du öffnen kannst.',
        {},
        async () => {
          log(`JARVIS Log: Liste installierte Apps...`)
          const res = await runPy(['list', ...sbFlag()])
          if (res.error) return {isError:true, content:[{type:'text', text: res.error}]}
          const list = Object.keys(res.apps||{}).slice(0,50).join(', ')
          log(`JARVIS Log: ${res.count} Apps gefunden`)
          return { content: [{type:'text', text: `Installierte Apps (${res.count}):\n${list}\n\nNutze launch_app mit exaktem Namen oder Pfad.`}] }
        }),
      tool('sandbox_mode', 'Schalte voll isolierte Sandbox an/aus. Wenn an, läuft alles im Hidden-Desktop (CreateDesktop) — dein echter Desktop bleibt frei.',
        { enabled: z.boolean().describe('true=an (isoliert), false=aus (direkt auf Desktop)') },
        async (args) => {
          sandboxEnabled = Boolean(args.enabled)
          const msg = sandboxEnabled ? 'Sandbox AN — voll isoliert, du kannst weiterarbeiten' : 'Sandbox AUS — direkt auf Desktop'
          log(`JARVIS Log: ${msg}`)
          return { content: [{type:'text', text: msg}] }
        }),
    ]
  })
}
