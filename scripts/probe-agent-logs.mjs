// Run the agent-log adapters (src/main/providers/logs.ts) against real session logs on
// this machine and print what Loom would get: canonical lines and blocks per file.
//
//   node scripts/probe-agent-logs.mjs            every Codex rollout under ~/.codex/sessions
//   node scripts/probe-agent-logs.mjs <file>...  just these
//
// Node 24 strips the types from logs.ts itself (it uses only erasable syntax), so this
// needs no build and no tsx.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AGENT_LOGS } from '../src/main/providers/logs.ts'

const codex = AGENT_LOGS.codex
let failures = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL ${msg}`)
}

function walk(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/^rollout-.*\.jsonl$/.test(n)) out.push(p)
  }
  return out
}

function records(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** Counts of canonical line and block types, tool names, and sanity checks. */
function report(name, recs, lines) {
  const blocks = {}
  const tools = {}
  const uses = new Set()
  const results = []
  const uuids = new Map()
  let ends = 0
  for (const l of lines) {
    const u = String(l.uuid ?? '')
    if (!u) fail(`${name}: a line without uuid`)
    else if (uuids.has(u) && JSON.stringify(uuids.get(u)) !== JSON.stringify(l)) fail(`${name}: uuid ${u} reused for different content`)
    uuids.set(u, l)
    if (l.message?.stop_reason === 'end_turn') ends++
    if (l.type === 'system') blocks[`system:${l.subtype}`] = (blocks[`system:${l.subtype}`] ?? 0) + 1
    for (const b of l.message?.content ?? []) {
      const key = `${l.type}:${b.type}`
      blocks[key] = (blocks[key] ?? 0) + 1
      if (b.type === 'tool_use') {
        tools[b.name] = (tools[b.name] ?? 0) + 1
        uses.add(b.id)
      }
      if (b.type === 'tool_result') results.push(b.tool_use_id)
    }
  }
  for (const id of results) if (!uses.has(id)) fail(`${name}: tool_result for unknown call ${id}`)
  const completes = recs.filter((r) => r.type === 'event_msg' && (r.payload?.type === 'task_complete' || r.payload?.type === 'turn_aborted')).length
  if (completes !== ends) fail(`${name}: ${completes} task_complete/turn_aborted but ${ends} end_turn lines`)
  console.log(`${name}  records=${recs.length} lines=${lines.length} end_turn=${ends}`)
  console.log(`  blocks ${JSON.stringify(blocks)}`)
  if (Object.keys(tools).length) console.log(`  tools  ${JSON.stringify(tools)}`)
  return lines
}

// ---------------------------------------------------------------- Codex conversion

const root = join(homedir(), '.codex', 'sessions')
const files = process.argv.slice(2).length ? process.argv.slice(2) : walk(root).sort()
const totals = {}
for (const file of files) {
  const recs = records(file)
  const whole = codex.convert(recs, {})
  report(basename(file).replace(/^rollout-/, '').slice(0, 19), recs, whole)

  // Tailing hands the adapter the file in arbitrary batches with one state; the result
  // must be the same lines as reading it whole.
  const state = {}
  const pieces = []
  for (let i = 0; i < recs.length; ) {
    const n = 1 + Math.floor(Math.random() * 7)
    pieces.push(...codex.convert(recs.slice(i, i + n), state))
    i += n
  }
  if (JSON.stringify(pieces) !== JSON.stringify(whole)) fail(`${basename(file)}: batched conversion differs from whole`)

  for (const l of whole) for (const b of l.message?.content ?? []) totals[`${l.type}:${b.type}`] = (totals[`${l.type}:${b.type}`] ?? 0) + 1
}
console.log(`\nCodex totals over ${files.length} files: ${JSON.stringify(totals)}`)

// User words must appear once, not three times (response_item + event_msg + item_completed).
for (const file of files) {
  const said = codex
    .convert(records(file), {})
    .filter((l) => l.type === 'user' && l.message.content.some((b) => b.type === 'text'))
    .map((l) => l.message.content.map((b) => b.text).join(''))
  if (new Set(said).size !== said.length && !said.every((s) => s === said[0])) {
    const dup = said.filter((s, i) => said.indexOf(s) !== i)
    if (dup.some((d) => !/^\[Request interrupted/.test(d))) fail(`${basename(file)}: user text repeated: ${dup[0].slice(0, 60)}`)
  }
  if (said.some((s) => /<environment_context>|# AGENTS\.md instructions|<recommended_plugins>/.test(s))) fail(`${basename(file)}: injected context shown as user text`)
}

// ---------------------------------------------------------------- Codex locate

if (!process.argv.slice(2).length) {
  const all = walk(root)
  // The newest interactive session: headless `codex exec` runs (Ember's own questions) are never a tab's.
  const interactive = (f) => {
    const p = JSON.parse(readFileSync(f, 'utf8').split('\n')[0]).payload ?? {}
    return p.originator !== 'codex_exec' && p.source !== 'exec'
  }
  const newest = all.filter(interactive).map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0]
  if (newest) {
    const cwd = JSON.parse(readFileSync(newest.f, 'utf8').split('\n')[0]).payload.cwd
    const odd = cwd.toUpperCase().replace(/\\/g, '/') + '/'
    const since = newest.m - 60_000
    const hit = codex.locate(odd, since)
    const ageH = ((Date.now() - newest.m) / 3_600_000).toFixed(1)
    console.log(`\nlocate(${JSON.stringify(odd)}, newest-60s) → ${hit ? basename(hit) : null}  (newest is ${basename(newest.f)}, ${ageH}h old)`)
    if (Date.now() - newest.m < 36 * 3_600_000 && hit !== newest.f) fail('locate did not find the newest rollout for its own folder')
    const miss = codex.locate(odd, Date.now() + 60_000)
    if (miss) fail('locate found a log older than since')
    const taken = codex.locate(odd, since, new Set([newest.f]))
    if (taken === newest.f) fail('locate returned a taken log')
    const other = codex.locate(join(dirname(newest.f), 'no-such-project'), since)
    if (other) fail('locate matched another folder')
  }
}

// ---------------------------------------------------------------- Gemini (synthetic)

// No Gemini session exists on this machine; this checks the converter against records
// shaped exactly as chatRecordingService (gemini-cli-core 0.66) writes them: a metadata
// line, a user message, the model message written once with text and again with its tool
// calls, a $patch with a result, and a $rewindTo.
{
  const g = AGENT_LOGS.gemini
  const recs = [
    { sessionId: 's1', projectHash: 'h', startTime: '2026-11-01T10:00:00Z', lastUpdated: '2026-11-01T10:00:00Z', kind: 'main' },
    { id: 'u1', timestamp: '2026-11-01T10:00:01Z', type: 'user', content: [{ text: 'list the files @x.ts' }], displayContent: [{ text: 'list the files' }] },
    { $set: { lastUpdated: '2026-11-01T10:00:01Z' } },
    { id: 'm1', timestamp: '2026-11-01T10:00:02Z', type: 'gemini', content: 'Listing them.', thoughts: [{ subject: 'Plan', description: 'ls', timestamp: 'x' }], model: 'gemini-3' },
    {
      id: 'm1', timestamp: '2026-11-01T10:00:02Z', type: 'gemini', content: 'Listing them.', model: 'gemini-3',
      toolCalls: [
        { id: 'c1', name: 'run_shell_command', args: { command: 'ls', description: 'list' }, status: 'success', timestamp: 'y', result: [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: 'a\nb' } } }] },
        { id: 'c2', name: 'mcp_ember-panel_show_panel', args: { format: 'markdown', content: '# hi' }, status: 'executing', timestamp: 'y' },
      ],
    },
    { $patch: { updates: [{ id: 'm1', toolCalls: [{ id: 'c2', result: [{ functionResponse: { id: 'c2', name: 'x', response: { output: 'shown' } } }] }] }] } },
    { $rewindTo: 'u1' },
  ]
  const lines = g.convert(recs, {})
  report('gemini (synthetic)', [], lines)
  const names = lines.flatMap((l) => l.message?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name)
  if (names.join() !== 'Bash,mcp__ember-panel__show_panel') fail(`gemini tool names: ${names}`)
  const user = lines.find((l) => l.type === 'user' && l.message.content[0]?.type === 'text')
  if (user?.message.content[0].text !== 'list the files') fail('gemini user text should be displayContent')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
