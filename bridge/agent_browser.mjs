import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.jarvis', 'agent-browser')
try { mkdirSync(PROFILE_DIR, { recursive: true }) } catch {}

let context = null
let page = null
let browser = null
let liveInterval = null
let emitLive = null

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return { context, page }
  if (context) try { await context.close() } catch {}
  if (browser) try { await browser.close() } catch {}
  browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  const pages = browser.pages()
  page = pages[0] || await browser.newPage()
  context = browser
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  // Auto live: wenn Seite navigiert, sende Screenshot
  page.on('framenavigated', () => { setTimeout(emitScreenshot, 800) })
  return { context, page }
}

async function getPage() {
  const { page: p } = await ensureBrowser()
  return p
}

async function emitScreenshot() {
  if (!emitLive || !page || page.isClosed()) return
  try {
    const buf = await page.screenshot({ type: 'png' })
    emitLive(`data:image/png;base64,${buf.toString('base64')}`)
  } catch {}
}

function startLive(intervalMs = 800) {
  if (liveInterval) clearInterval(liveInterval)
  liveInterval = setInterval(emitScreenshot, intervalMs)
  setTimeout(emitScreenshot, 200)
}
function stopLive() {
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null }
}

function toMcpResult(text, isError = false) {
  return { isError, content: [{ type: 'text', text }] }
}

export function agentBrowserServer(emitImage) {
  emitLive = emitImage || null
  return createSdkMcpServer({
    name: 'agent_browser',
    version: '1.0.0',
    instructions: `Agent's OWN browser (Playwright, persistent profile at ~/.jarvis/agent-browser). 
Use for tasks where you need to log in and act as the user: canva.com, zalando, fiverr, etc.
It has its own cookies/storage, stays logged in across tasks. For user's already-logged-in Chrome, use chrome_* instead.
This browser is VISIBLE (headless false) and you can see it via screenshots.`,
    alwaysLoad: true,
    tools: [
      tool('agent_browser_navigate', 'Navigate agent browser to URL. Use for canva.com, zalando.de, fiverr.com, neal.fun etc. - this is YOUR browser, you can log in. Live view auto-starts.',
        { url: z.string().describe('https://... or "back"/"forward"') },
        async ({ url }) => {
          const p = await getPage()
          try {
            startLive(700)
            if (url === 'back') { await p.goBack(); await p.waitForTimeout(800); emitScreenshot(); return toMcpResult(`Navigated back, now at ${p.url()}`) }
            if (url === 'forward') { await p.goForward(); await p.waitForTimeout(800); emitScreenshot(); return toMcpResult(`Forward, now at ${p.url()}`) }
            await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await p.waitForTimeout(1200)
            emitScreenshot()
            return toMcpResult(`Navigated to ${p.url()} - title: ${await p.title()} - LIVE view active in Jarvis (Agent Browser Fenster)`)
          } catch (e) { return toMcpResult(`Navigate failed: ${e.message}`, true) }
        }),

      tool('agent_browser_tabs', 'List open tabs in agent browser',
        {},
        async () => {
          const { context: ctx } = await ensureBrowser()
          const pages = ctx.pages()
          const list = await Promise.all(pages.map(async (pg, i) => {
            try { return `${i}: ${pg.url()} - ${await pg.title()}` } catch { return `${i}: ${pg.url()}` }
          }))
          return toMcpResult(list.join('\n') || 'No tabs')
        }),

      tool('agent_browser_read', 'Read current page as text + interactive elements (like chrome_read_page). Use before clicking/filling.',
        { max_chars: z.number().optional().default(8000) },
        async ({ max_chars }) => {
          const p = await getPage()
          try {
            // Try accessibility tree
            const snapshot = await p.accessibility.snapshot()
            const text = JSON.stringify(snapshot, null, 2).slice(0, max_chars || 8000)
            const title = await p.title()
            const url = p.url()
            return toMcpResult(`URL: ${url}\nTitle: ${title}\n\nAccessibility:\n${text}`)
          } catch (e) {
            try {
              const content = await p.content()
              return toMcpResult(content.slice(0, max_chars || 8000))
            } catch (e2) { return toMcpResult(`Read failed: ${e.message}`, true) }
          }
        }),

      tool('agent_browser_click', 'Click element by selector or text. Use agent_browser_read first.',
        {
          selector: z.string().optional().describe('CSS selector'),
          text: z.string().optional().describe('Text to click'),
          x: z.number().optional(),
          y: z.number().optional(),
        },
        async ({ selector, text, x, y }) => {
          const p = await getPage()
          try {
            if (selector) await p.click(selector, { timeout: 10000 })
            else if (text) await p.getByText(text, { exact: false }).first().click({ timeout: 10000 })
            else if (x !== undefined && y !== undefined) await p.mouse.click(x, y)
            else return toMcpResult('Need selector, text, or x/y', true)
            await p.waitForTimeout(600); emitScreenshot()
            return toMcpResult(`Clicked ${selector||text||`${x},${y}`} at ${p.url()} - live view updated`)
          } catch (e) { return toMcpResult(`Click failed: ${e.message}`, true) }
        }),

      tool('agent_browser_fill', 'Fill input field. Click first if needed.',
        {
          selector: z.string().describe('CSS selector of input'),
          value: z.string().describe('Text to fill'),
          submit: z.boolean().optional().describe('Press Enter after filling'),
        },
        async ({ selector, value, submit }) => {
          const p = await getPage()
          try {
            await p.fill(selector, value, { timeout: 10000 })
            if (submit) await p.keyboard.press('Enter')
            return toMcpResult(`Filled ${selector} with "${value.slice(0,50)}"`)
          } catch (e) { return toMcpResult(`Fill failed: ${e.message}`, true) }
        }),

      tool('agent_browser_type', 'Type text into focused element (click field first if needed)',
        { text: z.string().describe('Text to type'), submit: z.boolean().optional() },
        async ({ text, submit }) => {
          const p = await getPage()
          try {
            await p.keyboard.type(text, { delay: 30 })
            if (submit) await p.keyboard.press('Enter')
            return toMcpResult(`Typed "${text.slice(0,50)}"`)
          } catch (e) { return toMcpResult(`Type failed: ${e.message}`, true) }
        }),

      tool('agent_browser_key', 'Press key/chord, e.g. Enter, Escape, Tab, Control+A',
        { key: z.string().describe('e.g. Enter, Escape, Tab') },
        async ({ key }) => {
          const p = await getPage()
          try { await p.keyboard.press(key); return toMcpResult(`Pressed ${key}`) } catch (e) { return toMcpResult(`Key failed: ${e.message}`, true) }
        }),

      tool('agent_browser_screenshot', 'Take screenshot of current page. Use to see what it looks like, then show to user via blade if needed.',
        {},
        async () => {
          const p = await getPage()
          try {
            const buf = await p.screenshot({ type: 'png' })
            return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
          } catch (e) { return toMcpResult(`Screenshot failed: ${e.message}`, true) }
        }),

      tool('agent_browser_close', 'Close current tab',
        {},
        async () => {
          const p = await getPage()
          try { await p.close(); return toMcpResult('Tab closed') } catch (e) { return toMcpResult(`Close failed: ${e.message}`, true) }
        }),

      tool('agent_browser_new_tab', 'Open new blank tab',
        { url: z.string().optional().describe('Optional URL to open') },
        async ({ url }) => {
          const { context: ctx } = await ensureBrowser()
          const p = await ctx.newPage()
          page = p
          if (url) { await p.goto(url, { waitUntil: 'domcontentloaded' }); emitScreenshot() }
          return toMcpResult(`New tab at ${p.url()}`)
        }),

      tool('agent_browser_live', 'Live view control for Jarvis. Shows browser live in Jarvis window while solving (e.g. neal.fun captchas).',
        {
          enabled: z.boolean().describe('true=start live 700ms stream, false=stop'),
          interval: z.number().optional().describe('ms, default 700'),
        },
        async ({ enabled, interval }) => {
          if (enabled) { startLive(interval || 700); return toMcpResult('Live view AN — Jarvis zeigt Browser live (700ms), ideal für neal.fun am i human') }
          else { stopLive(); return toMcpResult('Live view AUS') }
        }),
    ],
  })
}
