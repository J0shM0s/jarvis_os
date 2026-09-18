import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

// Erlaubte Roots — nur hier darf gelesen/geschrieben werden
const ALLOWED_ROOTS = [
  homedir(),
  'C:\\Users\\moser\\Projekte',
  'C:\\Temp',
].map(p => resolve(p))

function isAllowed(p) {
  const abs = resolve(p)
  return ALLOWED_ROOTS.some(root => abs === root || abs.startsWith(root + '\\') || abs.startsWith(root + '/'))
}

export function filesystemServer() {
  return createSdkMcpServer({
    name: 'jarvis_fs',
    version: '1.0.0',
    instructions: 'Filesystem für JARVIS — lesen, schreiben, suchen im erlaubten Bereich. Nutze für Projekt-Dateien, Notizen, Business-Docs.',
    alwaysLoad: true,
    tools: [
      tool('fs_list', 'Liste Dateien/Ordner in einem Verzeichnis',
        { path: z.string().describe('Absoluter Pfad, z.B. C:/Users/moser/Projekte/jarvis_v7') },
        async ({ path }) => {
          if (!isAllowed(path)) return { isError: true, content: [{ type: 'text', text: 'Pfad nicht erlaubt — nur Projekte/Home/Temp' }] }
          try {
            const entries = await readdir(path, { withFileTypes: true })
            const out = entries.slice(0, 80).map(e => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`).join('\n')
            return { content: [{ type: 'text', text: out || '(leer)' }] }
          } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message) }] } }
        }),

      tool('fs_read', 'Lese Datei-Inhalt (max 50kB)',
        { path: z.string().describe('Absoluter Pfad zur Datei') },
        async ({ path }) => {
          if (!isAllowed(path)) return { isError: true, content: [{ type: 'text', text: 'Pfad nicht erlaubt' }] }
          try {
            const txt = await readFile(path, 'utf8')
            return { content: [{ type: 'text', text: txt.slice(0, 50000) }] }
          } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message) }] } }
        }),

      tool('fs_write', 'Schreibe/überschreibe Datei (erstellt Ordner falls nötig)',
        { path: z.string().describe('Absoluter Pfad'), content: z.string().describe('Inhalt') },
        async ({ path, content }) => {
          if (!isAllowed(path)) return { isError: true, content: [{ type: 'text', text: 'Pfad nicht erlaubt' }] }
          try {
            const { dirname } = await import('node:path')
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, content, 'utf8')
            return { content: [{ type: 'text', text: `Gespeichert: ${path} (${content.length} Zeichen)` }] }
          } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message) }] } }
        }),

      tool('fs_search', 'Suche Text in Dateien (grep) im erlaubten Bereich',
        { pattern: z.string().describe('Suchbegriff/Regex'), path: z.string().optional().describe('Startpfad, default Projekte') },
        async ({ pattern, path }) => {
          const root = path && isAllowed(path) ? resolve(path) : ALLOWED_ROOTS[1]
          try {
            const { execFile } = await import('node:child_process')
            const { promisify } = await import('node:util')
            const exec = promisify(execFile)
            // nutze ripgrep wenn vorhanden, sonst Node fallback
            try {
              const { stdout } = await exec('rg', ['-n', pattern, root, '--max-count', '30'], { timeout: 4000 })
              return { content: [{ type: 'text', text: stdout.slice(0, 8000) || '(keine Treffer)' }] }
            } catch {
              return { content: [{ type: 'text', text: 'Suche nur via rg verfügbar — nutze fs_list + fs_read' }] }
            }
          } catch (e) { return { content: [{ type: 'text', text: String(e.message) }] } }
        }),
    ]
  })
}
