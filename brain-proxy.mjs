/**
 * Brain proxy — the switchboard between the `claude` CLI and whatever brain
 * is available today.
 *
 * The CLI refuses model ids it doesn't know ("isn't described by this
 * version's model catalog") and speaks only the Anthropic Messages API. So
 * every provider hangs behind THIS proxy under a name the CLI accepts, and
 * the proxy translates and forwards.
 *
 * Two providers, tried in priority order (BRAIN_PRIORITY, default "openrouter,ollama"):
 *
 *   openrouter — https://openrouter.ai, Anthropic-shaped endpoint, forwarded
 *                nearly verbatim (model rewritten, Bearer auth added). The
 *                free tier has a daily request cap; a 429 with a reset time
 *                cools the provider down until then, so the next turn goes
 *                straight to Ollama instead of stalling for retries.
 *
 *   ollama     — a local Ollama (OLLAMA_URL, default 127.0.0.1:11434). Fully
 *                offline and free, so it makes the perfect standing fallback:
 *                when the online brain is out of tokens, JARVIS keeps
 *                talking. Anthropic requests are translated both ways,
 *                including streaming and tool calls, so agents keep working.
 *
 * Config comes from openrouter.env in this folder:
 *   OPENROUTER_API_KEY   required unless BRAIN_PRIORITY=ollama
 *   OPENROUTER_MODEL     OpenRouter target model (default: nemotron super, free)
 *   OLLAMA_MODEL         local fallback model (default: first tool-capable model)
 *   BRAIN_PRIORITY       comma list: openrouter,ollama (default) — order = priority
 *   BRAIN_PROXY_PORT     default 8790
 *   BRAIN_PROXY_SECRET   shared secret callers must send (see /messages gate)
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let CFG = {}
try {
  for (const line of readFileSync(join(here, 'openrouter.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !line.trim().startsWith('#')) CFG[m[1]] = m[2]
  }
} catch {}

const envv = (k) => (process.env[k] ?? CFG[k] ?? '').trim() || undefined

// .trim() matters: openrouter.env parsing is a regex over each line, so a
// trailing space survives into the key — and OpenRouter reports ANY malformed
// key as the wildly misleading "Missing Authentication header".
const KEY = envv('OPENROUTER_API_KEY')
// Vision-fähig für capture_screen, sonst 404 bei Bildern → Fallback auf Ollama (jetzt 404-retry)
// ling-3.0-flash-vl:free ist das einzige stabile freie VL-Modell laut /v1/models (2026-09)
const TARGET = envv('OPENROUTER_MODEL') || 'inclusionai/ling-3.0-flash-vl:free'
const OLLAMA_URL = (envv('OLLAMA_URL') || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const OLLAMA_MODEL = envv('OLLAMA_MODEL')
// Thinking level for models that take low/medium/high instead of a boolean
// (GPT-OSS family). Unset = send a plain boolean to thinking-capable models.
const OLLAMA_THINK_LEVEL = envv('OLLAMA_THINK_LEVEL')
// Priority order of the chain. "openrouter,ollama" (default): online first,
// local standing by. Reversing it ("ollama,openrouter") makes the local model
// primary and OpenRouter the overflow brain.
const PRIORITY = (envv('BRAIN_PRIORITY') || 'openrouter,ollama')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

// A port set in openrouter.env counts too — process.env wins, file is the fallback.
// Validated before startup: `8790x` would otherwise become NaN and kill the
// server on listen with an error pointing nowhere useful.
const PORT = Number(envv('BRAIN_PROXY_PORT') || 8790)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('[brain-proxy] BRAIN_PROXY_PORT must be an integer from 1 to 65535')
  process.exit(1)
}
// Override only to test the proxy against a mock upstream.
const UPSTREAM = envv('OPENROUTER_UPSTREAM') || 'https://openrouter.ai/api/v1'

// Shared secret for callers (see the /messages gate below). Generate one with
// `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
// and put the same value in openrouter.env — the bridge reads the file too.
const SECRET = envv('BRAIN_PROXY_SECRET')

// The OpenRouter key is required only when openrouter is actually in the chain.
if (PRIORITY.includes('openrouter')) {
  if (!KEY || /^paste\b/i.test(KEY) || KEY.startsWith('PASTE')) {
    console.error('[brain-proxy] OPENROUTER_API_KEY missing — copy openrouter.env.example to openrouter.env and paste your key from https://openrouter.ai/keys (or set BRAIN_PRIORITY=ollama for the local brain only)')
    process.exit(1)
  }
  // Real keys look like sk-or-v1-… (or sk-or-…). A different shape still gets a
  // start, because OpenRouter may mint other prefixes one day — but the warning
  // names the exact trap: the upstream error reads "Missing Authentication
  // header" even though the header was sent.
  if (!KEY.startsWith('sk-or-')) {
    console.warn('[brain-proxy] warning: OPENROUTER_API_KEY does not look like an OpenRouter key (expected "sk-or-…"). Upstream will fail with a misleading "Missing Authentication header".')
  }
}

/**
 * Latest rate-limit view of the OpenRouter brain, for the HUD.
 *
 * OpenRouter reports the free tier's daily budget on every response —
 * `x-ratelimit-limit`, `-remaining`, `-reset` — and hitting it used to look
 * identical to the assistant ignoring you. The latest headers are kept here
 * and served at /quota so the interface can show what is actually left.
 */
const ratelimit = { limit: null, remaining: null, reset: null }
function noteRatelimit(headers) {
  // Number(0) is falsy — a spent quota reports remaining: 0 and a naive
  // `|| null` erases exactly the number that matters most.
  const num = (v) => {
    if (v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  ratelimit.limit = num(headers.get('x-ratelimit-limit')) ?? ratelimit.limit
  ratelimit.remaining = num(headers.get('x-ratelimit-remaining')) ?? ratelimit.remaining
  const resetRaw = headers.get('x-ratelimit-reset')
  if (resetRaw) {
    // OpenRouter sends epoch milliseconds here, not a date string — Date.parse
    // on "1789430400000" is NaN and would silently disable the until-reset
    // cooldown. Normalize both shapes to ISO.
    const asNum = /^\d+$/.test(resetRaw.trim()) ? Number(resetRaw.trim()) : NaN
    const ms = Number.isFinite(asNum) ? asNum : Date.parse(resetRaw)
    ratelimit.reset = Number.isNaN(ms) ? resetRaw : new Date(ms).toISOString()
  }
}

/**
 * The provider chain. Each provider is a function that takes the (Anthropic-
 * shaped) payload and returns { status, headers?, body } where body is either
 * a string (JSON error) or a web ReadableStream (the SSE response to pipe).
 * Cooldowns keep a provider out of the rotation for a while — the daily-quota
 * 429 cools OpenRouter down until reset, so Ollama takes over immediately on
 * every following turn instead of re-probing the dead brain each time.
 */
const cooldownUntil = { openrouter: 0, ollama: 0 }

const PROBE_TIMEOUT_MS = 4000
let ollamaUp = null
let ollamaResolvedModel = null
/** Capabilities of the resolved model, from /api/show — read by the request
 *  translation to decide whether a thinking config may be forwarded. */
let ollamaModelCaps = []
/** One /api/show lookup. Returns capabilities on success, [] on any failure
 *  (old Ollama servers lack the endpoint; the feature then stays off). */
async function modelCaps(name) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `model` is the current key, `name` the older one — sending both keeps
      // this working across server versions; unknown fields are ignored.
      body: JSON.stringify({ model: name, name }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const info = await res.json().catch(() => null)
    return Array.isArray(info?.capabilities) ? info.capabilities : []
  } catch {
    return []
  }
}
async function ollamaState() {
  if (ollamaUp !== null && Date.now() - ollamaUp.at < 15000) {
    return { up: ollamaUp.up, model: ollamaResolvedModel }
  }
  let up = false
  let model = OLLAMA_MODEL || null
  let caps = []
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.ok) {
      up = true
      const tags = await res.json().catch(() => null)
      const models = Array.isArray(tags?.models) ? tags.models : []
      if (!model) {
        // /api/tags summaries do NOT carry capabilities — the old check here
        // always missed and fell through to models[0], which can pick a model
        // that cannot call tools and quietly end every agent turn with plain
        // text. Ask /api/show per candidate (bounded; nobody has hundreds) and
        // take the first tool-capable one, exactly what the tags check meant.
        const candidates = models.slice(0, 12).map((m) => m?.model).filter(Boolean)
        for (const name of candidates) {
          const c = await modelCaps(name)
          if (c.includes('tools')) {
            model = name
            caps = c
            break
          }
        }
        if (!model) model = models[0]?.model ?? null
        if (model && caps.length) console.log(`[brain-proxy] ollama auto-selected ${model} (tools)`)
      }
    }
  } catch {}
  // Capabilities of whichever model was resolved — explicitly configured ones
  // were never scanned above, so look them up here too. Failures leave [] and
  // the thinking mapping stays off (the pre-fix behaviour).
  if (up && model && !caps.length) caps = await modelCaps(model)
  ollamaModelCaps = caps
  ollamaUp = { up, at: Date.now() }
  if (up && model) ollamaResolvedModel = model
  return { up, model: up ? ollamaResolvedModel : null }
}

/* ------------------------------------------------------------------ *
 * Anthropic -> Ollama translation                                     *
 * ------------------------------------------------------------------ */

const textOfContent = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function toOllamaMessages(payload) {
  const messages = []
  const sys = textOfContent(payload.system)
  if (sys) messages.push({ role: 'system', content: sys })
  for (const m of payload.messages ?? []) {
    if (!Array.isArray(m?.content)) {
      const text = typeof m?.content === 'string' ? m.content : ''
      if (text) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text })
      continue
    }
    // A tool_result arrives as a user turn carrying the tool's answer.
    const toolResults = m.content.filter((b) => b?.type === 'tool_result')
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        // Ollama matches tool answers to calls by id; when ids round-trip
        // they line up, and a missing id falls back to positional matching
        // on the receiving side.
        tool_call_id: tr.tool_use_id,
        content: textOfContent(tr.content) || (typeof tr.content === 'string' ? tr.content : ''),
      })
    }
    const texts = []
    const images = []
    const toolCalls = []
    for (const b of m.content) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      else if (b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
        images.push(b.source.data)
      } else if (b?.type === 'tool_use' && b.name) {
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: b.input ?? {} } })
      }
      // thinking blocks (extended reasoning echoes) are dropped.
    }
    const text = texts.join('\n')
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (text || images.length || toolCalls.length) {
      const msg = { role }
      if (text || images.length) msg.content = text
      if (images.length) msg.images = images
      if (toolCalls.length) msg.tool_calls = toolCalls
      messages.push(msg)
    }
  }
  return messages
}

function toOllamaTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = tools
    .filter((t) => typeof t?.name === 'string')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
      },
    }))
  return out.length ? out : undefined
}

function anthropicToOllama(payload) {
  const options = {}
  if (Number.isFinite(payload.max_tokens)) options.num_predict = payload.max_tokens
  if (Number.isFinite(payload.temperature)) options.temperature = payload.temperature
  if (Number.isFinite(payload.top_p)) options.top_p = payload.top_p
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) options.stop = payload.stop_sequences
  const body = {
    model: ollamaResolvedModel,
    messages: toOllamaMessages(payload),
    stream: Boolean(payload.stream),
    options,
  }
  const tools = toOllamaTools(payload.tools)
  if (tools) body.tools = tools
  const tc = payload.tool_choice
  if (tc?.type === 'any') body.tool_choice = 'required'
  else if (tc?.type === 'tool' && tc.name) body.tool_choice = { type: 'function', function: { name: tc.name } }
  // 'auto' is Ollama's default — omit.
  //
  // The agent SDK thinks in Anthropic configs (adaptive by default); Ollama
  // wants its own `think` value and rejects the object as-is. Only thinking-
  // capable models are touched at all: `think: true` against a model without
  // the capability is a 400, and that would break every turn on it. GPT-OSS
  // family takes a LEVEL instead of a boolean — OLLAMA_THINK_LEVEL maps that
  // (low|medium|high) when you run one.
  const th = payload.thinking
  if (th && typeof th === 'object' && (ollamaModelCaps.includes('thinking') || OLLAMA_THINK_LEVEL)) {
    if (th.type === 'disabled') body.think = false
    else if (th.type === 'enabled' || th.type === 'adaptive') body.think = OLLAMA_THINK_LEVEL || true
  }
  return body
}

const estimateTokens = (payload) =>
  Math.max(1, Math.ceil(JSON.stringify(payload.messages ?? payload).length / 4))

const nowId = () => `msg_${crypto.randomBytes(10).toString('hex')}`
const blockId = () => `toolu_${crypto.randomBytes(10).toString('hex')}`

const sseEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`

/**
 * Ollama's final (non-streaming) message -> a complete Anthropic SSE stream.
 * Translating even the non-streaming shape into SSE keeps exactly ONE
 * response grammar for the CLI on this path — it always consumes a stream.
 */
function ollamaToAnthropicSSE(data) {
  const msg = data?.message ?? {}
  const id = nowId()
  const parts = []
  const inputTokens = estimateTokens({ messages: [{ content: (msg.content || '') + (msg.thinking || '') }] })
  parts.push(sseEvent({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: data?.model ?? 'ollama', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }))
  // Thinking models (qwen3.5, deepseek-r1, …) put reasoning in `message.thinking`
  // and the answer in `message.content` — with small budgets content can come
  // back EMPTY while thinking is all there is. Map thinking to Anthropic's
  // thinking block, and when nothing visible was produced, let the reasoning
  // stand in as text: an audible ramble beats a silent turn.
  const thinking = typeof msg.thinking === 'string' ? msg.thinking : ''
  const text = typeof msg.content === 'string' ? msg.content : ''
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  let visible = text
  if (!visible && !toolCalls.length && thinking) visible = thinking.trim()
  let index = 0
  if (thinking) {
    parts.push(sseEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }))
    parts.push(sseEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }))
    parts.push(sseEvent({ type: 'content_block_stop', index }))
    index++
  }
  if (visible) {
    parts.push(sseEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
    parts.push(sseEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: visible } }))
    parts.push(sseEvent({ type: 'content_block_stop', index }))
    index++
  }
  for (const call of toolCalls) {
    const args = call.function?.arguments ?? {}
    const json = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    parts.push(sseEvent({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id || blockId(), name: call.function?.name || '', input: {} } }))
    parts.push(sseEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }))
    parts.push(sseEvent({ type: 'content_block_stop', index }))
    index++
  }
  if (!index) {
    // Absolutely nothing came back — still emit one legal empty text block so
    // the CLI never sees a malformed message.
    parts.push(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    parts.push(sseEvent({ type: 'content_block_stop', index: 0 }))
  }
  const stopReason = toolCalls.length ? 'tool_use' : 'end_turn'
  const outputTokens = Math.max(1, Math.ceil(((msg.content || '') + (msg.thinking || '') + JSON.stringify(toolCalls)).length / 4))
  parts.push(sseEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }))
  parts.push(sseEvent({ type: 'message_stop' }))
  return parts.join('')
}

const anthropicError = (type, message) => JSON.stringify({ error: { type, message } })

/**
 * The Ollama provider: translate the Anthropic payload, call /api/chat, and
 * hand the CLI back a proper Anthropic response — streaming if asked.
 */
async function callOllama(payload) {
  const state = await ollamaState()
  if (!state.up || !state.model) {
    return { status: 503, headers: { 'content-type': 'application/json' }, body: anthropicError('api_error', 'no brain available: Ollama is not reachable at ' + OLLAMA_URL) }
  }
  ollamaResolvedModel = state.model
  const body = anthropicToOllama({ ...payload, stream: payload.stream === true })
  let upstream
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
    })
  } catch (e) {
    ollamaUp = { up: false, at: Date.now() }
    return { status: 502, headers: { 'content-type': 'application/json' }, body: anthropicError('api_error', `ollama call failed: ${e.message}`) }
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    console.log(`[brain-proxy] ollama error ${upstream.status}: ${text.slice(0, 200)}`)
    return { status: 502, headers: { 'content-type': 'application/json' }, body: anthropicError('api_error', `ollama error ${upstream.status}: ${text.slice(0, 200)}`) }
  }
  if (payload.stream === true) {
    // Ollama streams NDJSON; re-emerge as Anthropic SSE.
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        let started = false
        let sawText = false
        let sawThinking = false
        let sawTool = false
        let index = 0
        let thinkingText = ''
        const push = (obj) => controller.enqueue(enc.encode(sseEvent(obj)))
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let nl
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (!line) continue
              let chunk
              try { chunk = JSON.parse(line) } catch { continue }
              if (typeof chunk.message?.thinking === 'string') thinkingText += chunk.message.thinking
              if (!started) {
                started = true
                push({ type: 'message_start', message: { id: nowId(), type: 'message', role: 'assistant', model: chunk.model || state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(payload), output_tokens: 0 } } })
              }
              const msg = chunk.message ?? {}
              // Thinking chunks arrive before the answer (see the note in
              // ollamaToAnthropicSSE). They open their own block; text opens
              // the text block; tools close whatever is open first.
              if (typeof msg.thinking === 'string' && msg.thinking.length) {
                if (!sawThinking) {
                  sawThinking = true
                  push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
                }
                push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: msg.thinking } })
              } else if (sawThinking && !sawText && !sawTool) {
                push({ type: 'content_block_stop', index })
                index++
                sawThinking = false
              }
              if (typeof msg.content === 'string' && msg.content.length) {
                if (!sawText && !sawTool) {
                  if (sawThinking) {
                    push({ type: 'content_block_stop', index })
                    index++
                    sawThinking = false
                  }
                  sawText = true
                  push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
                }
                push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: msg.content } })
              }
              for (const call of msg.tool_calls ?? []) {
                if ((sawText || sawThinking) && !sawTool) {
                  push({ type: 'content_block_stop', index })
                  index++
                  sawText = false
                  sawThinking = false
                }
                sawTool = true
                const args = call.function?.arguments ?? {}
                const json = typeof args === 'string' ? args : JSON.stringify(args ?? {})
                push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id || blockId(), name: call.function?.name || '', input: {} } })
                push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } })
                push({ type: 'content_block_stop', index })
                index++
              }
            }
          }
          if (!started) {
            // Ollama returned nothing usable — still give the CLI a legal
            // (empty) message rather than a truncated stream.
            push({ type: 'message_start', message: { id: nowId(), type: 'message', role: 'assistant', model: state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(payload), output_tokens: 0 } } })
            push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
            push({ type: 'content_block_stop', index })
            push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
            push({ type: 'message_stop' })
            return
          }
          // The whole answer is still open: close the text/thinking block.
          if (sawText || sawThinking) push({ type: 'content_block_stop', index })
          // Nothing visible at all, but reasoning happened? Let it stand in
          // as the text — an audible ramble beats a silent turn.
          if (!sawText && !sawTool && thinkingText.trim()) {
            index++
            push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
            push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: thinkingText.trim() } })
            push({ type: 'content_block_stop', index })
          }
          const outTokens = Math.max(1, Math.ceil(200 / 4))
          push({ type: 'message_delta', delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outTokens } })
          push({ type: 'message_stop' })
        } catch (e) {
          console.error('[brain-proxy] ollama stream error:', e.message)
        } finally {
          controller.close()
        }
      },
    })
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: stream }
  }
  const data = await upstream.json().catch(() => null)
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: ollamaToAnthropicSSE(data) }
}

/**
 * The OpenRouter provider: the old passthrough, wrapped in the provider
 * contract. Returns the raw upstream so the caller can inspect rate-limit
 * headers and decide on cooldowns/failover.
 *
 * The header wait is bounded (OPENROUTER_TIMEOUT_MS): Undici's default
 * response-header timeout is 300s, so a silent upstream used to stall the
 * whole provider loop — and with it the Ollama failover — for five minutes
 * before the catch could act. The abort lands in that same catch, so the
 * 502-and-fall-over path is unchanged, just prompt.
 */
const OPENROUTER_TIMEOUT_MS = Number(envv('OPENROUTER_TIMEOUT_MS') || 60000)
async function callOpenRouter(payload) {
  let upstream
  try {
    upstream = await fetch(`${UPSTREAM}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // OpenRouter authenticates with a Bearer token; x-api-key is the
        // Anthropic convention and gets every request rejected here.
        authorization: `Bearer ${KEY}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...payload, model: TARGET }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    })
  } catch (e) {
    return { status: 502, headers: new Headers(), body: anthropicError('api_error', `proxy upstream failed: ${e.message}`) }
  }
  if (upstream.ok && upstream.body) {
    const verdict = await sniffOpenRouterBody(upstream.body.getReader())
    if (!verdict.ok) {
      // A healthy status carrying a failure. Report the real thing so the
      // chain cools OpenRouter down and Ollama takes the turn — piping this
      // through made the CLI read "api error" out loud as if it were an answer.
      console.log('[brain-proxy] openrouter 200 carried an error body — failing over')
      return { status: 502, headers: upstream.headers, body: verdict.text || anthropicError('api_error', 'upstream error behind a 200') }
    }
    return { status: upstream.status, headers: upstream.headers, body: recombinedBody(verdict.prefix, verdict.reader) }
  }
  return { status: upstream.status, headers: upstream.headers, body: await upstream.text().catch(() => '') }
}

/** An SSE line that already decides the body is an error, not an answer. */
function sseLineHasError(line) {
  const s = line.replace(/\r$/, '')
  if (/^event:\s*error\b/i.test(s)) return true
  if (!s.startsWith('data:')) return false
  const data = s.slice(5).trim()
  if (!data || data === '[DONE]') return false
  try {
    const j = JSON.parse(data)
    return !!(j && (j.type === 'error' || j.error))
  } catch {
    return false // a half-delivered line stays undecidable until it completes
  }
}

/**
 * A 2xx from OpenRouter is not the whole truth: when the upstream provider
 * itself chokes ("Upstream error from Nvidia: Service temporarily overloaded"),
 * the failure arrives as a 200 whose body is an error object — or as an SSE
 * stream that only ever yields an error event. Decide from the leading bytes
 * so the provider loop can fail over instead of piping the failure on.
 * Returns the consumed prefix, so a healthy body still forwards byte-exact.
 */
async function sniffOpenRouterBody(reader) {
  const decoder = new TextDecoder()
  const prefix = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    prefix.push(value)
    buf += decoder.decode(value, { stream: true })
    const seen = buf.slice(0, buf.lastIndexOf('\n') + 1) // complete lines only
    if (/event:\s*message_start/.test(seen)) return { ok: true, prefix, reader }
    if (seen && seen.split('\n').some(sseLineHasError)) return { ok: false, prefix, reader, text: buf }
    if (buf.length > 16 * 1024) return { ok: true, prefix, reader } // healthy stream, past the interesting part
  }
  // No SSE verdict — a plain (non-stream) JSON body, most likely. Structural
  // check, not a substring hunt: an answer that merely contains the word
  // "error" must pass through untouched.
  try {
    const j = JSON.parse(buf)
    if (j && (j.type === 'error' || j.error)) return { ok: false, prefix, reader, text: buf }
  } catch {}
  return { ok: true, prefix, reader }
}

/** Rebuild a body stream: the sniffed prefix first, then everything else. */
function recombinedBody(prefix, reader) {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}

const PROVIDERS = {
  openrouter: callOpenRouter,
  ollama: callOllama,
}

/** Pipe a provider result back to the CLI — body is a string or a stream. The
 *  one forwarder for every success path, so stream errors are handled (logged,
 *  response still ends) the same way no matter which branch produced them. */
async function forwardToClient(res, out, provider) {
  res.writeHead(out.status, out.headers && typeof out.headers.get === 'function'
    ? { 'content-type': out.headers.get('content-type') || 'application/json' }
    : out.headers)
  if (typeof out.body === 'string') {
    res.end(out.body)
    return
  }
  if (!out.body) {
    res.end()
    return
  }
  const reader = out.body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (!res.write(value)) await new Promise((r) => res.once('drain', r))
    }
  } catch (e) {
    console.error('[brain-proxy] stream error:', e.message)
  }
  console.log(`[brain-proxy] streamed ${bytes} bytes back from ${provider}`)
  res.end()
}

/** A 429 whose headers carry a reset time is the daily cap — remember it. */
function noteFailure(provider, status, headers) {
  if (provider === 'openrouter' && headers) noteRatelimit(headers)
  if (status === 429) {
    const reset = provider === 'openrouter' ? ratelimit.reset : null
    // A reset we can read beats one we can't: if the value is missing or
    // unparseable, cool down for 5 minutes instead of not at all — otherwise
    // every following turn re-probes a provider that is still capped.
    const fallback = Date.now() + 5 * 60 * 1000
    const epoch = reset && /^\d+$/.test(reset) ? Number(reset) : NaN
    const parsed = Number.isFinite(epoch) ? epoch : reset ? Date.parse(reset) : NaN
    const until =
      Number.isFinite(parsed) && parsed > Date.now()
        ? Math.min(parsed, Date.now() + 24 * 3600 * 1000)
        : fallback
    if (until > cooldownUntil[provider]) {
      cooldownUntil[provider] = until
      console.log(`[brain-proxy] ${provider} cooling down until ${new Date(until).toISOString()} (quota)`)
    }
  } else if (status === 402) {
    // Out of credits — pointless to re-probe this hour.
    cooldownUntil[provider] = Math.max(cooldownUntil[provider], Date.now() + 60 * 60 * 1000)
  } else if (status === 401 || status === 403) {
    cooldownUntil[provider] = Math.max(cooldownUntil[provider], Date.now() + 10 * 60 * 1000)
  } else if (status >= 500) {
    cooldownUntil[provider] = Math.max(cooldownUntil[provider], Date.now() + 60 * 1000)
  }
}

const KNOWN = ['claude-opus-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250514']

const modelEntry = (id) => ({
  id,
  type: 'model',
  display_name: 'JARVIS brain',
})

const server = http.createServer(async (req, res) => {
  // Match on the PATH only — the CLI appends query strings like ?beta=true,
  // and a suffix match on the full URL silently 404s every real request.
  const path = new URL(req.url, 'http://localhost').pathname
  // /quota is read by the local page via the bridge; no secret needed and no
  // logging noise — it polls every minute.
  if (req.method === 'GET' && path === '/quota') {
    const now = Date.now()
    const providers = PRIORITY.map((p) => ({
      name: p,
      active: (cooldownUntil[p] ?? 0) <= now && (p !== 'ollama' || (ollamaUp?.up ?? true)),
      cooldownUntil: (cooldownUntil[p] ?? 0) > now ? new Date(cooldownUntil[p]).toISOString() : null,
    }))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...ratelimit, active: providers.find((p) => p.active)?.name ?? null, providers }))
    return
  }
  console.log(`[brain-proxy] ${req.method} ${path}${req.url.includes('?') ? ' (query stripped)' : ''}`)
  // The CLI validates the requested model against GET /v1/models when
  // running with an API token. Serve a small catalog of names it accepts.
  if (req.method === 'GET' && path.includes('/v1/models')) {
    let body
    const single = req.url.match(/\/v1\/models\/([^/?]+)/)
    if (single) {
      const id = decodeURIComponent(single[1])
      if (!KNOWN.includes(id)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'model not found' } }))
        return
      }
      body = JSON.stringify(modelEntry(id))
    } else {
      body = JSON.stringify({ data: KNOWN.map(modelEntry), has_more: false, first_id: KNOWN[0], last_id: KNOWN[KNOWN.length - 1] })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }

  if (req.method === 'POST' && path.endsWith('/count_tokens')) {
    // Rough estimate is fine: the CLI only uses it for context management.
    let body = ''
    for await (const chunk of req) body += chunk
    let tokens = 2000
    try { tokens = Math.ceil(JSON.stringify(JSON.parse(body)).length / 4) } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: tokens }))
    return
  }

  if (req.method === 'POST' && path.endsWith('/messages')) {
    // Caller authentication. The proxy binds to the loopback interface only,
    // but loopback is not a trust boundary — any process on this machine can
    // dial 127.0.0.1:8790 and spend the configured OpenRouter key's quota.
    // A shared secret, read from the same env file the bridge already parses,
    // closes that: only callers that can read openrouter.env may forward.
    // Off (backward compatible) until BRAIN_PROXY_SECRET is set anywhere.
    // Compared as fixed-length sha256 digests: timingSafeEqual throws on
    // unequal buffer lengths, and a latin1 header with any byte above 0x7F
    // re-encodes to two UTF-8 bytes — comparing raw buffers lets a malformed
    // header crash the process. Digests are always 32 bytes and never throw.
    if (SECRET) {
      const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest()
      const ok = crypto.timingSafeEqual(digest(String(req.headers['x-brain-secret'] ?? '')), digest(SECRET))
      if (!ok) {
        console.log(`[brain-proxy] rejected /messages: bad or missing x-brain-secret`)
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'proxy caller authentication failed' } }))
        return
      }
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400).end('{"error":{"type":"invalid_request_error","message":"bad json"}}')
      return
    }
    const asked = payload.model
    const now = Date.now()
    const chain = PRIORITY.filter((p) => (cooldownUntil[p] ?? 0) <= now)
    if (!chain.length) {
      // Everything is cooling down — take the earliest recovery rather than
      // a bare failure; the next seconds of patience beat a dead answer.
      const soonest = PRIORITY.reduce((a, b) => (cooldownUntil[a] <= cooldownUntil[b] ? a : b))
      chain.push(soonest)
    }
    let last = null
    for (const provider of chain) {
      const fn = PROVIDERS[provider]
      if (!fn) continue
      const t0 = Date.now()
      const out = await fn(payload)
      const ok = out.status >= 200 && out.status < 300
      console.log(`[brain-proxy] ${asked} -> ${provider}${provider === 'openrouter' ? ` (${TARGET})` : provider === 'ollama' ? ` (${ollamaResolvedModel})` : ''} : ${out.status}${ok ? ` in ${Date.now() - t0}ms` : ''}`)
      if (ok) {
        // OpenRouter with a 200: any leftover cooldown from a transient blip
        // can go; the provider just proved itself. Also record rate limits.
        // (Error-behind-a-200 is already caught structurally in callOpenRouter
        // before it ever gets here — no substring guessing at this level.)
        if (provider === 'openrouter' && out.headers) {
          noteRatelimit(out.headers)
          cooldownUntil.openrouter = 0
        }
        await forwardToClient(res, out, provider)
        return
      }
      last = out
      const retrySafe = out.status === 429 || out.status >= 500 || out.status === 404 || out.status === 402 || out.status === 401 || out.status === 403 || out.status === 503
      if (out.status === 429 && provider === 'openrouter' && ratelimit.remaining !== 0) {
        // Free tiers flap: a transient 429 gets one quick retry before we
        // give up on this provider for the turn. remaining === 0 means the
        // daily cap, though — re-probing is pointless until reset.
        const second = await fn(payload)
        if (second.status >= 200 && second.status < 300) {
          console.log(`[brain-proxy] ${asked} -> ${provider} recovered on retry`)
          await forwardToClient(res, second, provider)
          return
        }
        noteFailure(provider, second.status, second.headers)
        last = second
        continue
      }
      if (retrySafe) {
        noteFailure(provider, out.status, out.headers)
        continue // next provider in the chain
      }
      // A 4xx that won't change with a different brain (bad payload) — fail
      // fast with the upstream's own error.
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify({ error: { type: 'api_error', message: 'upstream rejected the request' } }))
      return
    }
    // Every provider failed — surface the last error so the bridge can speak it.
    console.log(`[brain-proxy] all brains failed (chain: ${chain.join(', ')})`)
    res.writeHead(last?.status ?? 502, { 'content-type': 'application/json' })
    res.end(typeof last?.body === 'string' && last.body ? last.body : anthropicError('api_error', 'no brain available right now'))
    return
  }

  console.log(`[brain-proxy] UNROUTED: ${req.method} ${req.url}`)
  res.writeHead(404).end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[brain-proxy] listening on http://127.0.0.1:${PORT} — chain: ${PRIORITY.join(' -> ')}`)
  console.log(`[brain-proxy]   openrouter: ${TARGET}`)
  ollamaState().then((s) => {
    console.log(`[brain-proxy]   ollama: ${s.up ? `up (${s.model ?? 'no model'})` : 'not reachable'}`)
  })
})
