#!/usr/bin/env node
/**
 * JARVIS Brain Sync — Git-Backup + Supabase Export (perfekt für Obsidian Vault)
 * - Liest alle brains/*.md
 * - Schreibt brains/.backup/brain-export.json (für Supabase Import)
 * - Versucht Git: add + commit + push (falls git repo und Änderungen)
 * - Versucht Supabase storage/table falls RLS es erlaubt, sonst nur Export
 *
 * Aufruf: node scripts/brain-sync.mjs [--push]  (--push = git push)
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(join(import.meta.dirname ?? '.', '..'))
const BRAINS = resolve(join(ROOT, 'brains'))
const EXPORT_DIR = join(BRAINS, '.backup')
const EXPORT_FILE = join(EXPORT_DIR, 'brain-export.json')

async function walk(dir, base = '') {
  const out = []
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.backup') || e.name === '.obsidian') continue
    const abs = join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(...await walk(abs, rel))
    } else if (e.name.endsWith('.md')) {
      try {
        const txt = await readFile(abs, 'utf8')
        const s = await stat(abs)
        out.push({ path: rel, content: txt, size: txt.length, mtime: s.mtime.toISOString() })
      } catch {}
    }
  }
  return out
}

async function gitBackup(push = false) {
  try {
    await exec('git', ['status', '--porcelain', 'brains'], { cwd: ROOT })
  } catch { console.log('[sync] kein git repo — überspringe Git-Backup'); return }
  try {
    const { stdout } = await exec('git', ['status', '--porcelain', 'brains'], { cwd: ROOT })
    if (!stdout.trim()) { console.log('[sync] Git: keine Änderungen in brains/'); return }
    await exec('git', ['add', 'brains/.backup/brain-export.json', 'brains/01_general', 'brains/02_business', 'brains/03_personal'], { cwd: ROOT }).catch(()=>{})
    // add all brains but .gitignore filtert private Inhalte — nur Export + Index bleiben
    const msg = `brains backup ${new Date().toISOString().slice(0,10)}`
    await exec('git', ['commit', '-m', msg], { cwd: ROOT })
    console.log('[sync] Git commit:', msg)
    if (push) {
      await exec('git', ['push'], { cwd: ROOT })
      console.log('[sync] Git push OK')
    } else {
      console.log('[sync] Git commit lokal — push mit --push')
    }
  } catch (e) {
    console.log('[sync] Git Backup Fehler:', e.message?.slice(0, 200))
  }
}

async function main() {
  const files = await walk(BRAINS)
  await mkdir(EXPORT_DIR, { recursive: true })
  const payload = {
    exportedAt: new Date().toISOString(),
    count: files.length,
    brains: files,
  }
  await writeFile(EXPORT_FILE, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`[sync] Export: ${files.length} Dateien → ${relative(ROOT, EXPORT_FILE)}`)

  // Supabase Versuch — bricht leise ab wenn RLS blockiert (anon key hat keine Rechte zum Erstellen)
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
    const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    if (url && key) {
      const sup = createClient(url, key)
      // Versuch: upsert in Tabelle 'brains' falls sie existiert (ansonsten 404 und wir lassen Export)
      const rows = files.map(f => ({ path: f.path, content: f.content, updated_at: f.mtime }))
      const { error } = await sup.from('brains').upsert(rows, { onConflict: 'path' })
      if (error) {
        console.log('[sync] Supabase: Tabelle brains fehlt — nutze Export. SQL zum Anlegen:')
        console.log(`  create table public.brains (path text primary key, content text, updated_at timestamptz); alter table public.brains enable row level security; create policy "anon all" on public.brains for all using (true) with check (true);`)
      } else {
        console.log('[sync] Supabase: ${rows.length} Dateien hochgeladen')
      }
    } else {
      console.log('[sync] Supabase: keine URL/KEY — nur lokaler Export')
    }
  } catch (e) {
    console.log('[sync] Supabase Fehler (nur Export):', e.message?.slice(0, 200))
  }

  await gitBackup(process.argv.includes('--push'))
  console.log('[sync] Fertig. Obsidian: brains/ ist Vault, Export liegt in brains/.backup/')
}

main().catch(e => { console.error(e); process.exit(1) })
