/**
 * Named prompt presets — "create a workflow named standup making read my
 * calendar and summarise my inbox", then "run workflow standup".
 *
 * A workflow is one saved sentence. It is deliberately small: the value is
 * that a long, fiddly instruction you say every morning becomes two words,
 * not that it gains steps or conditionals — the moment it needs those it is
 * a program, and the model is better at being the program than any preset
 * grammar built here. The storage is localStorage on purpose: these are
 * personal conveniences, per-browser, not data to sync.
 */

const KEY = 'jarvis.workflows.v1'

export type Workflows = Record<string, string>

export function loadWorkflows(): Workflows {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Workflows = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

function save(map: Workflows): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* private mode / quota — the session still works, saves just don't persist */
  }
}

/** Upsert one workflow. Pass an empty prompt to remove it. */
export function saveWorkflow(name: string, prompt: string): void {
  const map = loadWorkflows()
  if (prompt.trim()) map[name] = prompt.trim()
  else delete map[name]
  save(map)
}

/**
 * Names are spoken things: lower-case, whitespace collapsed, punctuation at
 * the edges stripped. Matching is exact against that normal form, so "run
 * workflow stand up" and "run workflow standup" are different workflows —
 * but a name with nothing configured is reported as "unknown workflow",
 * which is the honest answer.
 */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Command grammar
// ---------------------------------------------------------------------------

export type WorkflowCommand =
  | { kind: 'create'; name: string; prompt: string }
  | { kind: 'run'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'list' }

/**
 * "create a workflow named standup making <prompt>" — everything after the
 * first "making" is the preset prompt, so the prompt itself may not contain
 * the word "making". That is a real limitation and the escape hatch is
 * editing the file by hand, which no one should ever need for a morning
 * routine. "make" and "that" are accepted as spoken variants.
 *
 * The prompt is captured non-greedy and NOT name-normalised: it is a
 * sentence for the model, not a key.
 */
const CREATE = /\bcreate\s+(?:a\s+)?workflow\s+(?:named\s+|called\s+)?(.+?)\s+(?:making|make|that)\s+(.+)/i

const RUN = /\brun\s+(?:the\s+)?workflow\s+(.+)/i

const DELETE = /\b(?:delete|remove)\s+(?:the\s+)?workflow\s+(.+)/i

const LIST = /\b(?:list|show)\s+(?:all\s+)?(?:my\s+)?workflows\b/i

/** Try to read a workflow command out of an utterance. Null if it isn't one. */
export function parseWorkflowCommand(text: string): WorkflowCommand | null {
  const t = text.trim()
  if (!t) return null

  const list = LIST.exec(t)
  if (list) return { kind: 'list' }

  const create = CREATE.exec(t)
  if (create) {
    const name = normalizeName(create[1])
    const prompt = create[2].trim()
    if (!name || !prompt) return null
    return { kind: 'create', name, prompt }
  }

  const run = RUN.exec(t)
  if (run) {
    const name = normalizeName(run[1])
    if (!name) return null
    return { kind: 'run', name }
  }

  const del = DELETE.exec(t)
  if (del) {
    const name = normalizeName(del[1])
    if (!name) return null
    return { kind: 'delete', name }
  }

  return null
}
