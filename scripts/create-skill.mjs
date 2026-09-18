#!/usr/bin/env node
/**
 * Skill-Factory — erstellt neuen MCP Skill in bridge/<name>.mjs
 * Usage: node scripts/create-skill.mjs <skill-name> [Beschreibung]
 * Bsp: node scripts/create-skill.mjs haushalt "Haushalt tracken: Einkäufe, Aufgaben"
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const name = process.argv[2]
const desc = process.argv[3] || 'Eigener Skill'
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: node scripts/create-skill.mjs <skill-name> [Beschreibung]\n  skill-name: nur a-z, 0-9, _')
  process.exit(1)
}
const file = join('bridge', `${name}.mjs`)
if (existsSync(file)) { console.error(`Exists: ${file}`); process.exit(1) }

const template = `import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export function ${name}Server() {
  return createSdkMcpServer({
    name: 'jarvis_${name}',
    version: '1.0.0',
    instructions: '${desc} — nutze für private/business Hilfe.',
    alwaysLoad: true,
    tools: [
      tool('${name}_action', '${desc} — Hauptaktion',
        { input: z.string().describe('Eingabe') },
        async ({ input }) => {
          // TODO: Logik hier
          return { content: [{ type: 'text', text: \`${name} ausgeführt: \${input}\` }] }
        }),
    ]
  })
}
`

writeFileSync(file, template)
console.log(`✓ Skill erstellt: ${file}`)
console.log(`Nächste Schritte:`)
console.log(`  1. Bearbeite ${file} (Tools anpassen)`)
console.log(`  2. In bridge/server.mjs importieren: import { ${name}Server } from './${name}.mjs'`)
console.log(`  3. In mcpServers ergänzen: jarvis_${name}: ${name}Server(),`)
console.log(`  4. In decideTool allowlist ergänzen: if (server === 'jarvis_${name}') return true`)
console.log(`  5. npm run build && npx electron-builder --win dir`)
