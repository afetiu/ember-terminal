/**
 * Replays a recorded PTY stream (scripts/record-stream.mjs) through a hidden xterm and the
 * stream engine, frame by frame. Used by scripts/test-stream-engine.mjs; run it alone to see
 * what the engine read at each mark:
 *
 *   node scripts/replay-stream.mjs scripts/fixtures/streams/claude-menus.jsonl [--frames]
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { StreamEngine } from '../src/shared/streamEngine.ts'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')

/** Replays `file`: returns every frame the engine emitted and the regions at each mark. */
export async function replay(file, opts = {}) {
  const L = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const meta = L[0].meta
  const term = new Terminal({ cols: meta.cols, rows: meta.rows, scrollback: 5000, allowProposedApi: true })
  let clock = 0
  const engine = new StreamEngine(term, { agent: meta.agent, now: () => clock })
  const write = (d) => new Promise((r) => term.write(d, r))
  const rows = () => {
    const b = term.buffer.active
    const out = []
    for (let y = 0; y < term.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '')
    return out
  }
  const frames = []
  let exitAt = Infinity
  const marks = []
  for (let i = 1; i < L.length; i++) {
    const l = L[i]
    if (l.t !== undefined) clock = l.t
    if (l.resize) {
      term.resize(l.resize[0], l.resize[1])
      continue
    }
    if (l.o !== undefined) {
      await write(l.o)
      const r = engine.frame()
      if (r) frames.push({ i, t: l.t, ...r, screen: opts.screens ? rows() : undefined, text: r.mode === 'split' ? rows().slice(r.top, r.bottom + 1) : [] })
      continue
    }
    if (l.i !== undefined) {
      // Ctrl+C: the agent is on its way out; what it draws after is its goodbye.
      if (l.i === '' && exitAt === Infinity) exitAt = l.t
      engine.noteInput(l.i)
      continue
    }
    if (l.mark) {
      // A timer's look at a still screen (the live view re-reads when an animation lapses).
      const r = engine.frame() ?? engine.region
      const screen = rows()
      marks.push({ i, t: l.t, mark: l.mark, region: r, screen, live: r && r.mode === 'split' ? screen.slice(r.top, r.bottom + 1) : r?.mode === 'full' ? screen : [] })
    }
  }
  engine.dispose()
  return { meta, frames, marks, exitAt, committed: engine.takeCommitted() }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const file = process.argv[2]
  const { marks, frames } = await replay(file)
  if (process.argv.includes('--frames'))
    for (const f of frames) console.log(`#${f.i} t=${f.t} ${f.mode} ${f.top}..${f.bottom} (${f.why})`)
  for (const m of marks) {
    const r = m.region
    console.log(`\n### ${m.mark}: ${r ? `${r.mode} ${r.top}..${r.bottom} [${r.why}] cursor ${r.cursor.y}${r.cursor.visible ? '' : ' hidden'}` : 'no region'}`)
    m.screen.forEach((row, y) => {
      if (!row.trim()) return
      const inside = r && r.mode === 'split' && y >= r.top && y <= r.bottom
      console.log(`${inside ? '█' : ' '}${String(y).padStart(2)}|${row.slice(0, 110)}`)
    })
  }
}
