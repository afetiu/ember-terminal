// Usage: copy the old and new panel servers next to this file as mcp-before.mjs / mcp-after.mjs
// (e.g. git show <rev>:resources/mcp-panel.mjs > mcp-before.mjs), then: node bench-canvas-cost.mjs
// Costs real tokens (~$1.50 with Opus 5.5).
// Before/after: the same prompts through real `claude -p` sessions, with the panel server
// as it was this morning and as it is now. A stub bridge answers every call, so the tools
// succeed; tokens and dollars come from Claude Code's own result JSON, and Ember's share
// from the session transcript (tool_use input sizes of mcp__ember-panel__* calls).
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 9472

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    let j = {}
    try {
      j = JSON.parse(body || '{}')
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, id: 'x', shown: 1, edits: (j.edits || []).length || 1, items: [], title: j.title || 'file', name: j.name || 'view', found: 0, missing: [] }))
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const SCENARIOS = [
  { id: 'chart', turns: ['Show me a bar chart of my projects by state: Live 10, In motion 8, Dormant 2, Dead 7.'] },
  { id: 'report', turns: ['Write a short markdown report (about 50 lines) on the pros and cons of MCP servers versus CLIs as tools for coding agents, save it as report.md in this folder, and show it to me on the canvas.'] },
  { id: 'dashboard', turns: ['Show me a small stats dashboard: Projects 27, Live 10, Spend $41, Open PRs 4.', 'Change Spend to $38.'] },
  { id: 'table', turns: ['Show these as a table on the canvas: ember 812 commits live; acme-web 240 in motion; acme-api 133 live; old-site 54 dead.'] },
]

function run(cwd, cfg, prompt, resume) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--mcp-config', cfg, '--strict-mcp-config',
      '--allowedTools', 'mcp__ember-panel__*', 'Write', 'Read', '--disallowedTools', 'Bash', 'WebSearch', 'WebFetch', 'Agent', 'Task']
    if (resume) args.push('--resume', resume)
    const child = spawn('C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe', args, { cwd, env: { ...process.env } })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', () => {})
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        resolve({ error: out.slice(-400) })
      }
    })
  })
}

/** Tokens the session wrote into Ember's tools, from its transcript. */
function emberChars(sessionId) {
  const root = join(homedir(), '.claude', 'projects')
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`)
    if (!existsSync(f)) continue
    let chars = 0
    const calls = []
    const outById = new Map()
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      try {
        const j = JSON.parse(l)
        if (j.type === 'assistant' && j.message?.id) outById.set(j.message.id, Math.max(outById.get(j.message.id) ?? 0, j.message.usage?.output_tokens ?? 0))
        for (const b of j.message?.content ?? []) {
          if (b.type === 'tool_use' && /^mcp__ember-panel__/.test(b.name)) {
            const n = JSON.stringify(b.input).length
            chars += n
            calls.push(`${b.name.replace('mcp__ember-panel__', '')}:${n}`)
          }
        }
      } catch {}
    }
    return { chars, calls, out: [...outById.values()].reduce((a, b) => a + b, 0) }
  }
  return { chars: 0, calls: [], out: 0 }
}

const results = []
for (const arm of ['before', 'after']) {
  const cfg = join(HERE, `mcp-${arm}.json`)
  writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      'ember-panel': {
        command: 'node',
        args: [join(HERE, `mcp-${arm}.mjs`)],
        env: { EMBER_BRIDGE_URL: `http://127.0.0.1:${PORT}`, EMBER_BRIDGE_TOKEN: 'bench', EMBER_TAB_ID: 'bench', EMBER_SURFACE: 'canvas' },
      },
    },
  }))
  for (const sc of SCENARIOS) {
    const cwd = join(HERE, `run-${arm}-${sc.id}`)
    rmSync(cwd, { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
    const row = { arm, scenario: sc.id, cost: 0, out: 0, inp: 0, cacheRead: 0, cacheWrite: 0, turns: 0, emberChars: 0, calls: [] }
    let sid = null
    for (const t of sc.turns) {
      const r = await run(cwd, cfg, t, sid)
      if (r.error) {
        row.error = r.error
        break
      }
      sid = r.session_id
      row.cost += r.total_cost_usd ?? 0
      row.out += r.usage?.output_tokens ?? 0
      row.inp += r.usage?.input_tokens ?? 0
      row.cacheRead += r.usage?.cache_read_input_tokens ?? 0
      row.cacheWrite += r.usage?.cache_creation_input_tokens ?? 0
      row.turns += r.num_turns ?? 0
    }
    if (sid) {
      const e = emberChars(sid)
      row.emberChars = e.chars
      row.calls = e.calls
      row.outAll = e.out
    }
    results.push(row)
    console.log(JSON.stringify(row))
  }
}
writeFileSync(join(HERE, 'results.json'), JSON.stringify(results, null, 2))
server.close()
console.log('DONE')
