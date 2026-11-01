/**
 * The council's order of play, headless.
 *
 *   node scripts/probe-council.mjs          fake runner: rounds, notes, failures, stop
 *   node scripts/probe-council.mjs --real   plus one real 2-member council (claude + codex)
 *
 * Bundles src/main/councilRun.ts and src/main/agents.ts with esbuild into node_modules/.cache
 * (electron stubbed: nothing here touches it at load), so it runs under plain node.
 * EMBER_HOME points at a temp folder so nothing reads or writes the real ~/.ember.
 */
import { createRequire } from 'node:module'
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
process.env.EMBER_HOME ??= join(tmpdir(), 'ember-probe-council')

function loadEsbuild() {
  try {
    return require('esbuild')
  } catch {
    const pnpm = join(ROOT, 'node_modules', '.pnpm')
    const dir = readdirSync(pnpm).filter((d) => d.startsWith('esbuild@')).sort().pop()
    if (!dir) throw new Error('esbuild not found')
    return require(join(pnpm, dir, 'node_modules', 'esbuild'))
  }
}

// Inside the repo's node_modules so the bundle's own requires (node-pty) still resolve.
const out = join(ROOT, 'node_modules', '.cache', 'ember-probe-council', 'bundle.mjs')
mkdirSync(dirname(out), { recursive: true })
const entry = join(dirname(out), 'entry.ts')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(ROOT, 'src/main/councilRun.ts'))}\nexport { runAgent, killTree } from ${JSON.stringify(join(ROOT, 'src/main/agents.ts'))}\n`
)
// Nothing the council touches uses Electron at load; a stub stands in for it.
const stub = join(dirname(out), 'electron-stub.mjs')
writeFileSync(stub, 'export const app = undefined; export const ipcMain = undefined; export default {}')
loadEsbuild().buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  alias: { electron: stub },
  external: ['@lydell/node-pty'],
  logLevel: 'error',
})
const C = await import(pathToFileURL(out).href)

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}

/** Run a council, return its events. */
async function council(req, ask, { noteAt, stopAfterMs } = {}) {
  const events = []
  const ac = new AbortController()
  let note = req.interject
  const ctl = {
    signal: ac.signal,
    takeNote: () => {
      const n = note
      note = undefined
      return n
    },
  }
  const emit = (e) => {
    events.push(e)
    if (noteAt && e.kind === 'speak' && e.round === noteAt.afterRound && note === undefined && !noteAt.sent) {
      noteAt.sent = true
      note = noteAt.text
    }
  }
  if (stopAfterMs) setTimeout(() => ac.abort(), stopAfterMs)
  await C.runCouncil(req, ask, emit, ctl)
  return events
}

const sleep = (ms, signal) =>
  new Promise((res) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      res()
    })
  })

// ---------------------------------------------------------------- fake runs

const prompts = []
const fake = (behaviour = {}) => async (agent, prompt, _cwd, signal) => {
  prompts.push({ agent, prompt })
  await sleep(behaviour.delay?.[agent] ?? 20, signal)
  if (signal.aborted) return { ok: false, text: '', error: 'stopped' }
  if (behaviour.fail?.includes(agent)) return { ok: false, text: '', error: 'gave up after 3 minutes' }
  const kind = prompt.includes('conclusion') ? 'conclusion' : prompt.includes('last answers') ? 'reply' : 'opening'
  return { ok: true, text: `${agent} ${kind}` }
}

const base = { id: 'c1', question: 'Tabs or spaces?', members: ['claude', 'codex', 'gemini'], rounds: 2, chair: 'codex', cwd: ROOT }

{
  prompts.length = 0
  const ev = await council(base, fake(), { noteAt: { afterRound: 0, text: 'Assume a Python repo.' } })
  const speaks = ev.filter((e) => e.kind === 'speak')
  check(ev[0].kind === 'status' && /Asking Claude Code, Codex CLI and Gemini CLI/.test(ev[0].text), `status first: "${ev[0].text}"`)
  check(speaks.length === 9, `3 members x 3 rounds spoke (${speaks.length})`)
  check([0, 1, 2].every((r) => speaks.filter((s) => s.round === r).length === 3), 'every round has all three')
  const order = speaks.map((s) => s.round)
  check(order.every((r, i) => i === 0 || r >= order[i - 1]), 'rounds are sequential')
  const r1 = prompts.find((p) => p.agent === 'gemini' && p.prompt.includes('last answers'))
  check(!!r1 && r1.prompt.includes('Claude Code:\nclaude opening') && r1.prompt.includes('Gemini CLI (you):'), 'round 1 sees everyone, labelled')
  check(!!r1 && r1.prompt.includes('Assume a Python repo.'), 'note reaches round 1')
  const r2 = prompts.filter((p) => p.prompt.includes('last answers')).at(-1)
  check(!r2.prompt.includes('Assume a Python repo.'), 'note is read once, not again in round 2')
  const concl = ev.find((e) => e.kind === 'conclusion')
  check(concl?.member === 'codex' && concl.round === -1, 'chair (codex) concludes, round -1')
  const cp = prompts.find((p) => p.prompt.includes("council's conclusion"))
  check(cp.prompt.includes('## Opening positions') && cp.prompt.includes('## Round 2') && cp.prompt.includes('Assume a Python repo.'), 'conclusion sees the whole debate and notes')
  check(ev.at(-1).kind === 'done' && ev.at(-1).text === 'finished', 'done last')
}

{
  prompts.length = 0
  const ev = await council({ ...base, id: 'c2', chair: 'gemini' }, fake({ fail: ['gemini'] }))
  const err = ev.find((e) => e.kind === 'error')
  check(err?.member === 'gemini' && err.round === 0 && /gave up/.test(err.text), 'failed member gets an error event')
  check(!prompts.some((p) => p.agent === 'gemini' && p.prompt.includes('last answers')), 'and sits out later rounds')
  check(ev.find((e) => e.kind === 'conclusion')?.member === 'claude', 'a failed chair is replaced by the first member standing')
}

{
  const ev = await council({ ...base, id: 'c3', rounds: 0 }, fake())
  check(ev.filter((e) => e.kind === 'speak').length === 3 && !!ev.find((e) => e.kind === 'conclusion'), 'rounds 0: openings then conclusion')
}

{
  const t0 = Date.now()
  const ev = await council({ ...base, id: 'c4' }, fake({ delay: { claude: 5000, codex: 5000, gemini: 5000 } }), { stopAfterMs: 100 })
  check(Date.now() - t0 < 1000, `stop is prompt (${Date.now() - t0}ms)`)
  check(!ev.some((e) => e.kind === 'speak' || e.kind === 'conclusion'), 'nothing is said after stop')
  check(ev.at(-1).kind === 'done' && ev.at(-1).text === 'stopped', 'done(stopped) last')
}

{
  const ev = await council({ ...base, id: 'c5', members: ['claude'], rounds: 2, chair: 'claude' }, fake())
  check(ev.filter((e) => e.kind === 'speak').length === 1 && !!ev.find((e) => e.kind === 'conclusion'), 'one member: no debate with itself, still concludes')
}

// ---------------------------------------------------------------- a real council

if (process.argv.includes('--real')) {
  console.log('\n--- real council: claude + codex, 1 round, chair claude ---')
  const realAsk = (agent, prompt, cwd, signal) => {
    const run = C.runAgent(prompt, { agent, cwd, timeoutMs: 180_000 })
    signal.addEventListener('abort', () => C.killTree(run.child), { once: true })
    return run.done
  }
  const t0 = Date.now()
  const ev = await council(
    {
      id: 'real',
      question: 'For a small Electron app, should settings be stored in a JSON file or in SQLite? One-line answer is fine.',
      members: ['claude', 'codex'],
      rounds: 1,
      chair: 'claude',
      cwd: tmpdir(),
    },
    realAsk
  )
  for (const e of ev) {
    const s = ((e.at - t0) / 1000).toFixed(1).padStart(6)
    const who = e.member ? `${e.member}${e.round !== undefined ? `/r${e.round}` : ''}` : ''
    console.log(`${s}s ${e.kind.padEnd(10)} ${who.padEnd(10)} ${(e.text ?? '').replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  check(ev.some((e) => e.kind === 'conclusion'), 'real council reached a conclusion')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
