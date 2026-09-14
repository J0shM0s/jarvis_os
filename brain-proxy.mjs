/**
 * Brain proxy — lets the `claude` CLI drive any OpenRouter model.
 *
 * The CLI refuses model ids it doesn't know ("isn't described by this
 * version's model catalog") before it ever sends a request. So it talks to
 * THIS proxy using a model name it does know, and the proxy rewrites the
 * model to the real target on OpenRouter and forwards everything — including
 * the SSE stream — verbatim.
 *
 * Config comes from openrouter.env in this folder:
 *   OPENROUTER_API_KEY   required
 *   OPENROUTER_MODEL     target model (default: nemotron super, free)
 *   BRAIN_PROXY_PORT     default 8790
 */
import http from 'node:http'
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

const KEY = process.env.OPENROUTER_API_KEY || CFG.OPENROUTER_API_KEY
const TARGET = process.env.OPENROUTER_MODEL || CFG.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free'
const PORT = Number(process.env.BRAIN_PROXY_PORT || 8790)
const UPSTREAM = 'https://openrouter.ai/api/v1'

if (!KEY || KEY.startsWith('PASTE')) {
  console.error('[brain-proxy] OPENROUTER_API_KEY missing in openrouter.env')
  process.exit(1)
}

const KNOWN = ['claude-opus-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']

const modelEntry = (id) => ({
  id,
  type: 'model',
  display_name: 'JARVIS brain',
})

const server = http.createServer(async (req, res) => {
  // Match on the PATH only — the CLI appends query strings like ?beta=true,
  // and a suffix match on the full URL silently 404s every real request.
  const path = new URL(req.url, 'http://localhost').pathname
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
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400).end('{"error":{"type":"invalid_request_error","message":"bad json"}}')
      return
    }
    const asked = payload.model
    payload.model = TARGET
    let upstream
    let attempts = 0
    for (;;) {
      try {
        upstream = await fetch(`${UPSTREAM}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': KEY,
            'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          },
          body: JSON.stringify(payload),
        })
      } catch (e) {
        console.log(`[brain-proxy] ${asked} -> fetch FAILED: ${e.message} ${e.cause?.message ?? ''}`)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'api_error', message: `proxy upstream failed: ${e.message}` } }))
        return
      }
      // Free tiers flap: 429/5xx get one automatic retry after a pause.
      if ((upstream.status === 429 || upstream.status >= 500) && attempts < 2) {
        attempts++
        console.log(`[brain-proxy] ${asked} -> ${upstream.status}, retry ${attempts}/2 in 2s`)
        await upstream.text().catch(() => {})
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      break
    }
    console.log(`[brain-proxy] ${asked} -> ${TARGET} : ${upstream.status}${attempts ? ` (after ${attempts} retries)` : ''}`)
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      console.log(`[brain-proxy] upstream error body: ${text.slice(0, 300)}`)
      res.writeHead(upstream.status, { 'content-type': 'application/json' })
      res.end(text)
      return
    }
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    })
    if (upstream.body) {
      const reader = upstream.body.getReader()
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
      console.log(`[brain-proxy] streamed ${bytes} bytes back`)
    }
    res.end()
    return
  }

  console.log(`[brain-proxy] UNROUTED: ${req.method} ${req.url}`)
  res.writeHead(404).end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[brain-proxy] listening on http://127.0.0.1:${PORT} -> ${TARGET}`)
})
