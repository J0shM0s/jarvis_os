import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const SKILLS_DIR = join(homedir(), '.agents', 'skills')
const TREE_DIR = join(homedir(), '.jarvis', 'ceo')
const TREE_FILE = join(TREE_DIR, 'task_tree.json')
const toolCache = new Map() // key -> { value, at }
const CACHE_TTL_MS = 10*60*1000
const MAX_PARALLEL = 3

let registryCache = null
let registryMtime = 0
let registryFileMtimes = new Map()

async function buildRegistry() {
  try {
    const st = await stat(SKILLS_DIR).catch(() => null)
    if (!st) return []
    // inkrementell: prüfe nur wenn Root mtime gleich aber einzelne Files geändert
    if (registryCache && st.mtimeMs === registryMtime) {
      // quick check einzelner SKILL.md mtimes (stichprobe)
      let changed = false
      for (const [p, old] of registryFileMtimes) {
        try { const s = await stat(p); if (s.mtimeMs !== old) { changed = true; break } } catch { changed = true; break }
      }
      if (!changed) return registryCache
    }
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
    const out = []
    const newMtimes = new Map()
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const md = join(SKILLS_DIR, e.name, 'SKILL.md')
      if (!existsSync(md)) continue
      try {
        const s = await stat(md)
        newMtimes.set(md, s.mtimeMs)
        // reuse cached entry if mtime unchanged
        const cached = registryCache?.find(c => c.path === md)
        const oldMtime = registryFileMtimes.get(md)
        if (cached && oldMtime === s.mtimeMs) { out.push(cached); continue }
        const txt = await readFile(md, 'utf8')
        const front = txt.slice(0, 2000)
        const descMatch = txt.match(/description:\s*\|?\s*([\s\S]*?)\n[a-z_]+:/i) || txt.match(/description:\s*(.+)/)
        let desc = ''
        if (descMatch) desc = descMatch[1].replace(/\s+/g, ' ').trim().slice(0, 220)
        if (!desc) {
          const h = txt.match(/#\s+(.+)/)
          if (h) desc = h[1].slice(0, 150)
        }
        // tokens für scoring vorbereiten
        const tokens = (e.name + ' ' + desc).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        out.push({ name: e.name, description: desc || e.name, path: md, tokens, descLower: desc.toLowerCase(), nameLower: e.name.toLowerCase() })
      } catch {}
    }
    registryCache = out
    registryMtime = st.mtimeMs
    registryFileMtimes = newMtimes
    return out
  } catch { return [] }
}

// Scoring: TF-ähnlich, Name 10x, Description 3x, Fuzzy Levenshtein 1 Distanz = +2
function scoreSkill(skill, queryTokens) {
  let score = 0
  for (const q of queryTokens) {
    if (!q) continue
    if (skill.nameLower.includes(q)) score += 10
    else if (skill.tokens.some(t => t.includes(q) || q.includes(t))) score += 6
    if (skill.descLower.includes(q)) score += 3
    // fuzzy: edit distance 1 für typos
    for (const t of skill.tokens) {
      if (Math.abs(t.length - q.length) > 1) continue
      let diff = 0
      for (let i = 0; i < Math.min(t.length, q.length); i++) if (t[i] !== q[i]) diff++
      diff += Math.abs(t.length - q.length)
      if (diff === 1) score += 2
    }
  }
  // Bonus wenn alle Tokens treffen
  const hit = queryTokens.filter(q => skill.nameLower.includes(q) || skill.descLower.includes(q)).length
  if (hit === queryTokens.length && queryTokens.length > 1) score += 5
  return score
}

async function loadTree() {
  try {
    const txt = await readFile(TREE_FILE, 'utf8')
    return JSON.parse(txt)
  } catch { return { root: null, nodes: [] } }
}
async function saveTree(tree) {
  await mkdir(TREE_DIR, { recursive: true })
  await writeFile(TREE_FILE, JSON.stringify(tree, null, 2), 'utf8')
}

export function ceoServer() {
  return createSdkMcpServer({
    name: 'jarvis_ceo',
    version: '2.0.0',
    instructions: 'CEO Orchestrierung: Delegiere Aufgaben hierarchisch an Sub-Agenten (Task tool), rufe Skills automatisch auf, verwalte Task-Baum. JARVIS ist CEO, nicht Worker.',
    alwaysLoad: true,
    tools: [
      tool('ceo_list_skills', 'Liste alle 140+ Skills mit Beschreibung. Filter optional via query (scored, fuzzy). Immer aufrufen bevor du delegierst, um passenden Skill zu finden.',
        {
          query: z.string().optional().describe('Suchbegriff, z.B. browser, seo, voice, training — leer = alle'),
          limit: z.number().optional().default(40).describe('Max Ergebnisse'),
        },
        async ({ query, limit }) => {
          const reg = await buildRegistry()
          if (!query || !query.trim()) {
            const slice = reg.slice(0, limit || 40)
            const lines = slice.map(r => `- ${r.name}: ${r.description}`)
            return { content: [{ type: 'text', text: `Skills (${reg.length} total, zeige ${slice.length}):\n` + lines.join('\n') + `\n\nNutze ceo_read_skill um SKILL.md zu laden.` }] }
          }
          const qTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
          const scored = reg.map(r => ({ r, s: scoreSkill(r, qTokens) })).filter(x => x.s > 0).sort((a,b)=>b.s-a.s)
          const slice = (scored.length? scored.map(x=>x.r) : reg).slice(0, limit || 40)
          const lines = scored.length ? scored.slice(0, limit||40).map(x=> `- ${x.r.name} [score ${x.s}]: ${x.r.description}`) : slice.map(r=> `- ${r.name}: ${r.description}`)
          const txt = `Skills für "${query}" — ${scored.length} Treffer von ${reg.length} (Top ${slice.length}, scored):\n` + lines.join('\n') + `\n\nNutze ceo_read_skill oder ceo_auto_route für direkten Load.`
          return { content: [{ type: 'text', text: txt }] }
        }),

      tool('ceo_auto_route', 'AUTO-Router: Gib Task/Goal rein, bekomme Top-3 Skills mit Score + Begründung. Ruft keinen Skill auf, nur Empfehlung. Ideal für CEO Auto-Entscheidung.',
        {
          task: z.string().describe('Aufgabe/Goal, z.B. "Browser Automatisierung mit echtem Login" oder "SEO Keyword Planner"'),
        },
        async ({ task }) => {
          const reg = await buildRegistry()
          const qTokens = task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 12)
          const scored = reg.map(r => ({ r, s: scoreSkill(r, qTokens) })).sort((a,b)=>b.s-a.s).slice(0, 3).filter(x=>x.s>0)
          if (!scored.length) return { content: [{ type: 'text', text: `Kein Skill-Treffer für "${task}". Nutze ceo_list_skills mit anderen Keywords oder arbeite ohne Skill.` }] }
          const lines = scored.map((x,i)=> `${i+1}. ${x.r.name} (score ${x.s})\n   ${x.r.description}\n   → ceo_read_skill skill="${x.r.name}"`)
          return { content: [{ type: 'text', text: `Auto-Route für "${task}":\n` + lines.join('\n') + `\n\nNächster Schritt: ceo_read_skill für Top-1, dann ceo_delegate mit skill.` }] }
        }),

      tool('ceo_read_skill', 'Lese SKILL.md eines Skills — Pflicht vor Ausführung. Gibt volle Anleitung + wann/wie zu nutzen.',
        {
          skill: z.string().describe('Skill-Name, z.B. browser-skill, voicestudio, humanizer, seo-growth-loop'),
        },
        async ({ skill }) => {
          const name = String(skill).trim()
          const safe = name.replace(/[^a-z0-9-_]/gi, '')
          const p = join(SKILLS_DIR, safe, 'SKILL.md')
          if (!existsSync(p)) return { isError: true, content: [{ type: 'text', text: `Skill nicht gefunden: ${safe}. Nutze ceo_list_skills zum Suchen.` }] }
          const txt = await readFile(p, 'utf8')
          // limit 20k
          return { content: [{ type: 'text', text: txt.slice(0, 20000) }] }
        }),

      tool('ceo_delegate', 'Delegiere Teilaufgabe an Sub-Agent (Ebene 1 oder tiefer). JARVIS bleibt CEO — führt nicht selbst aus, sondern vergibt Tasks via Task tool. Dieser Call loggt die Delegation im Task-Baum.',
        {
          task: z.string().describe('Konkrete Teilaufgabe für Sub-Agent'),
          agent: z.string().optional().default('worker').describe('Agent-Typ: worker, specialist, researcher, browser, etc.'),
          skill: z.string().optional().describe('Optional: Skill der Sub-Agent nutzen soll (z.B. browser-skill)'),
          parent: z.string().optional().describe('Parent-Task ID, leer = CEO direkt'),
        },
        async ({ task, agent, skill, parent }) => {
          const tree = await loadTree()
          const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
          const node = { id, task, agent: agent || 'worker', skill: skill || null, parent: parent || 'CEO', status: 'delegated', at: new Date().toISOString() }
          tree.nodes.push(node)
          if (!tree.root) tree.root = { created: new Date().toISOString(), ceo: 'JARVIS' }
          await saveTree(tree)
          const hint = skill ? `Hinweis: Sub-Agent soll zuerst ceo_read_skill skill="${skill}" lesen und dann handeln.` : 'Hinweis: Sub-Agent nutzt Task tool für weitere Unter-Delegation wenn nötig.'
          return { content: [{ type: 'text', text: `Delegiert ${id} an ${agent}: "${task}" (parent: ${parent || 'CEO'})\n${hint}\n\nNächster Schritt: Rufe jetzt Task tool auf mit prompt="${task}" und lass den Sub-Agenten arbeiten. Er kann selbst wieder ceo_delegate nutzen für Ebene 3+.` }] }
        }),

      tool('ceo_spawn_team', 'Starte paralleles Team aus mehreren Sub-Agenten für große Aufgabe. Zerteilt automatisch in Teilaufgaben (Semaphore max 3 parallel, Rest queued).',
        {
          goal: z.string().describe('Gesamtziel, z.B. "Recherchiere X und erstelle Report"'),
          subtasks: z.array(z.string()).describe('Liste Teilaufgaben (3-5), werden parallel delegiert'),
          skills: z.array(z.string()).optional().describe('Optionale Skill-Zuordnung pro Subtask (gleiche Länge wie subtasks oder leer)'),
        },
        async ({ goal, subtasks, skills }) => {
          const tree = await loadTree()
          const active = tree.nodes.filter(n=>n.status==='delegated' || n.status==='retrying').length
          const teamId = `team_${Date.now().toString(36)}`
          const ids = []
          for (let i = 0; i < subtasks.length; i++) {
            const id = `${teamId}_${i}`
            ids.push(id)
            const queued = (active + i) >= MAX_PARALLEL
            tree.nodes.push({ id, task: subtasks[i], agent: `worker_${i + 1}`, skill: skills?.[i] || null, parent: teamId, teamGoal: goal, status: queued ? 'queued' : 'delegated', at: new Date().toISOString(), queued: queued||undefined })
          }
          tree.nodes.push({ id: teamId, task: goal, agent: 'CEO', status: 'team_spawned', children: ids, at: new Date().toISOString(), maxParallel: MAX_PARALLEL })
          await saveTree(tree)
          const queuedCount = subtasks.length - Math.max(0, MAX_PARALLEL - active)
          return { content: [{ type: 'text', text: `Team ${teamId} für "${goal}" gespawnt: ${subtasks.length} Tasks (aktiv ${Math.min(subtasks.length, Math.max(0, MAX_PARALLEL-active))}, queued ${Math.max(0, queuedCount)})\nIDs: ${ids.join(', ')}\n\nJetzt für jede *delegated* sofort Task tool call, für *queued* warten bis Platz frei (via ceo_queue_status). Cache Tipp: vor teuren Reads ceo_cache get prüfen.` }] }
        }),

      tool('ceo_task_tree', 'Zeige aktuellen Delegations-Baum (CEO → Ebene 1 → Ebene 2 → ...). Für Status & Abschluss.',
        {
          limit: z.number().optional().default(30),
        },
        async ({ limit }) => {
          const tree = await loadTree()
          if (!tree.nodes.length) return { content: [{ type: 'text', text: '(noch keine Delegationen — JARVIS ist CEO, nutze ceo_delegate / ceo_spawn_team)' }] }
          const recent = tree.nodes.slice(-(limit || 30))
          const lines = recent.map(n => `${n.status === 'delegated' ? '↳' : '●'} [${n.id}] ${n.agent} ← ${n.parent}: ${n.task.slice(0, 120)}${n.skill ? ` [skill:${n.skill}]` : ''}`)
          return { content: [{ type: 'text', text: `Task-Baum (letzte ${recent.length}/${tree.nodes.length}):\n` + lines.join('\n') }] }
        }),

      tool('ceo_complete_task', 'Markiere Task als erledigt (Sub-Agent meldet zurück an CEO).',
        {
          task_id: z.string().describe('ID aus ceo_delegate / ceo_spawn_team'),
          result: z.string().optional().describe('Kurz-Zusammenfassung Ergebnis'),
        },
        async ({ task_id, result }) => {
          const tree = await loadTree()
          const node = tree.nodes.find(n => n.id === task_id)
          if (!node) return { isError: true, content: [{ type: 'text', text: `Task ${task_id} nicht gefunden` }] }
          node.status = 'done'
          node.result = (result || '').slice(0, 500)
          node.doneAt = new Date().toISOString()
          await saveTree(tree)
          return { content: [{ type: 'text', text: `Task ${task_id} → done${result ? `: ${result.slice(0, 200)}` : ''}` }] }
        }),

      tool('ceo_retry_task', 'Retry fehlgeschlagenen Task mit neuem Sub-Agent (mit Timeout/Backoff).',
        {
          task_id: z.string().describe('ID des fehlgeschlagenen Tasks'),
          reason: z.string().optional().describe('Fehlergrund'),
          new_agent: z.string().optional().default('worker_retry').describe('Neuer Agent-Typ'),
        },
        async ({ task_id, reason, new_agent }) => {
          const tree = await loadTree()
          const orig = tree.nodes.find(n => n.id === task_id)
          if (!orig) return { isError: true, content: [{ type: 'text', text: `Task ${task_id} nicht gefunden` }] }
          const retries = tree.nodes.filter(n => n.retryOf === task_id).length
          if (retries >= 2) return { isError: true, content: [{ type: 'text', text: `Max retries (2) für ${task_id} erreicht` }] }
          const nid = `t_${Date.now().toString(36)}_r${retries+1}`
          const node = { id: nid, task: orig.task, agent: new_agent || orig.agent, skill: orig.skill, parent: orig.parent, status: 'delegated', retryOf: task_id, reason: reason||'retry', attempt: retries+1, timeoutMs: 90000, at: new Date().toISOString() }
          orig.status = 'retrying'
          orig.retryTo = nid
          tree.nodes.push(node)
          await saveTree(tree)
          return { content: [{ type: 'text', text: `Retry ${nid} für ${task_id} (Versuch ${retries+1}) an ${new_agent}: "${orig.task.slice(0,80)}"${reason?` Grund: ${reason}`:''}\n→ Jetzt Task tool mit prompt="${orig.task}" erneut starten.` }] }
        }),

      tool('ceo_fail_task', 'Markiere Task als fehlgeschlagen (für Retry/Timeout Handling).',
        {
          task_id: z.string().describe('ID'),
          error: z.string().describe('Fehler'),
        },
        async ({ task_id, error }) => {
          const tree = await loadTree()
          const n = tree.nodes.find(x=>x.id===task_id)
          if (!n) return { isError: true, content: [{ type: 'text', text: `Task ${task_id} nicht gefunden` }] }
          n.status = 'failed'
          n.error = error.slice(0, 500)
          n.failedAt = new Date().toISOString()
          await saveTree(tree)
          return { content: [{ type: 'text', text: `Task ${task_id} → failed: ${error.slice(0,200)}\n→ Nutze ceo_retry_task für Retry oder neu delegieren.` }] }
        }),

      tool('ceo_invoke_planner', 'CEO → Planner Delegation: Gib Ziel, bekomme Planner-Task ID + Anleitung für Task tool. PLICHT: CEO ruft IMMER erst diesen Tool, dann Task für Planner.',
        {
          goal: z.string().describe('Gesamtziel das geplant werden soll'),
          context: z.string().optional().describe('Zusatzkontext für Planner'),
        },
        async ({ goal, context }) => {
          const tree = await loadTree()
          const pid = `planner_${Date.now().toString(36)}`
          tree.nodes.push({ id: pid, task: `PLAN: ${goal}`, agent: 'planner', parent: 'CEO', status: 'delegated', context: context||'', at: new Date().toISOString() })
          if (!tree.root) tree.root = { created: new Date().toISOString(), ceo: 'JARVIS' }
          await saveTree(tree)
          const prompt = `Du bist PLANNER (Ebene 1). CEO Ziel: "${goal}"${context?` Kontext: ${context}`:''}\n\nAuftrag:\n1) TodoWrite mit 3-5 Subtasks (klar, je 1 Skill + erwartetes Ergebnis)\n2) Für jede Subtask: ceo_auto_route + ceo_read_skill (Pflicht)\n3) Überdenke: Ist Plan vollständig? Fehlt Skill? Dann korrigiere TodoWrite\n4) Verteile via ceo_spawn_team oder ceo_delegate + parallele Task calls an WORKER (Ebene 2)\n5) Worker melden via ceo_complete_task, danach je Worker ceo_critic_review\nDu bist nur Planner — arbeite nicht selbst, verteile.`
          return { content: [{ type: 'text', text: `Planner ${pid} erstellt für "${goal}"\n\nNÄCHSTER SCHRITT (CEO): Rufe SOFORT Task tool auf:\nTask(prompt="${prompt}", description="Planner für ${goal.slice(0,40)}")\n\nPlanner wird dann selbst TodoWrite + Skill-Checks + Verteilung machen. CEO wartet danach nur auf Zusammenfassung.` }] }
        }),

      tool('ceo_critic_review', 'Critic-Loop: Lass Sub-Agent Output von Critic prüfen (humanizer/ara-rigor-reviewer). Worker → Critic → CEO. Pflicht nach jedem Team.',
        {
          task_id: z.string().describe('ID des Worker-Tasks der geprüft werden soll'),
          output: z.string().describe('Output des Workers der geprüft werden soll (Text/Ergebnis)'),
          critic_skill: z.string().optional().default('humanizer').describe('Critic Skill: humanizer, ara-rigor-reviewer, etc.'),
        },
        async ({ task_id, output, critic_skill }) => {
          const tree = await loadTree()
          const orig = tree.nodes.find(n=>n.id===task_id)
          const cid = `critic_${Date.now().toString(36)}`
          tree.nodes.push({ id: cid, task: `Critic Review für ${task_id}`, agent: 'critic', skill: critic_skill, parent: task_id, output: output.slice(0,800), status: 'delegated', at: new Date().toISOString() })
          await saveTree(tree)
          return { content: [{ type: 'text', text: `Critic ${cid} für ${task_id} via ${critic_skill} gestartet.\n→ Sub-Agent soll jetzt ceo_read_skill skill="${critic_skill}" lesen und Output prüfen: "${output.slice(0,120)}..."\n→ Ergebnis zurück an ceo_complete_task task_id=${cid} + ceo_complete_task task_id=${task_id} wenn bestanden.` }] }
        }),

      tool('ceo_queue_status', 'Zeige Queue/Semaphore Status für parallele Teams (max 3 gleichzeitig).',
        {},
        async () => {
          const tree = await loadTree()
          const active = tree.nodes.filter(n=>n.status==='delegated' || n.status==='retrying').length
          const done = tree.nodes.filter(n=>n.status==='done').length
          const failed = tree.nodes.filter(n=>n.status==='failed').length
          const queued = tree.nodes.filter(n=>n.status==='queued').length
          return { content: [{ type: 'text', text: `Queue: ${active} aktiv, ${queued} queued, ${done} done, ${failed} failed, max parallel ${MAX_PARALLEL}. Bei >3 werden neue Delegationen queued (CEO wartet).` }] }
        }),

      tool('ceo_voice_check', 'Prüfe Voice-Status (ElevenLabs vs Browser/Kokoro) + gib Anleitung für bessere Stimme.',
        {},
        async () => {
          try {
            const fs = await import('node:fs')
            const path = await import('node:path')
            const os = await import('node:os')
            const cfgPath = path.join(os.homedir(), '.claude.json')
            let hasKey = false
            try { const cfg = JSON.parse(fs.readFileSync(cfgPath,'utf8')); hasKey = !!cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY || !!process.env.ELEVENLABS_API_KEY } catch {}
            return { content: [{ type: 'text', text: hasKey ? 'Voice: ElevenLabs aktiv (beste Qualität, Scribe STT). Nutze voicestudio Skill für Klon/Design.' : 'Voice: Browser/Kokoro Fallback (funktioniert, aber ElevenLabs ist besser). Setup: 1) Key bei elevenlabs.io holen, 2) in ~/.claude.json unter mcpServers.elevenlabs.env.ELEVENLABS_API_KEY eintragen oder ELEVENLABS_API_KEY env setzen, 3) Bridge neu starten → /health tts:true.' }] }
          } catch (e) { return { content: [{ type: 'text', text: `Voice check fehlgeschlagen: ${e.message}` }] } }
        }),

      tool('ceo_cache', 'Tool-Cache (10min) für teure Reads: get/set. Spart Cost wenn 3 SUBs gleiche Recherche machen.',
        {
          op: z.enum(['get','set','clear']).describe('get/set/clear'),
          key: z.string().describe('Cache-Key, z.B. "serper:ki news" oder "exa:acme.com"'),
          value: z.string().optional().describe('Bei set: Ergebnis-Text'),
        },
        async ({ op, key, value }) => {
          const k = String(key).slice(0,120)
          if (op==='clear') { toolCache.clear(); return { content: [{ type: 'text', text: 'Cache cleared' }] } }
          if (op==='get') {
            const e = toolCache.get(k)
            if (!e) return { content: [{ type: 'text', text: `Cache miss: ${k}` }] }
            if (Date.now()-e.at > CACHE_TTL_MS) { toolCache.delete(k); return { content: [{ type: 'text', text: `Cache expired: ${k}` }] } }
            return { content: [{ type: 'text', text: `Cache hit: ${k}\n${e.value.slice(0,8000)}` }] }
          }
          if (op==='set') {
            toolCache.set(k, { value: String(value||'').slice(0,8000), at: Date.now() })
            return { content: [{ type: 'text', text: `Cached: ${k} (${String(value||'').length} chars, TTL 10min)` }] }
          }
          return { isError: true, content: [{ type: 'text', text: 'unknown op' }] }
        }),
    ],
  })
}
