/**
 * A stand-in for a Claude Code session, for recording the demo clip.
 *
 *   node fake-agent.mjs <scene> <controlDir>
 *
 * Paints the two screens Ember reads a Claude session's state from (README, "How
 * session status is worked out"): a turn in flight — tool calls and a spinner with an
 * elapsed time — and a permission picker. It announces itself by title the way Claude
 * Code does. The picker appears when `<controlDir>/<scene>.ask` exists; a keypress
 * answers it and the turn carries on. Nothing here talks to a model.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [scene = 'api', controlDir = '.'] = process.argv.slice(2)

const ORANGE = '\x1b[38;2;215;119;87m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[38;2;78;186;101m'
const BLUE = '\x1b[38;2;177;185;249m'
const GREY = '\x1b[38;2;153;153;153m'
const R = '\x1b[0m'

const SCENES = {
  api: {
    cwd: 'C:\\code\\api',
    ask: 'add rate limiting to the login route',
    verb: 'Working',
    start: 0,
    tokens: 3.1,
    steps: [
      ['say', "I'll put a sliding-window limiter in front of POST /login."],
      ['tool', 'Read', 'src/routes/login.ts', 'Read 84 lines'],
      ['tool', 'Write', 'src/middleware/rateLimit.ts', 'Wrote 41 lines to src/middleware/rateLimit.ts'],
      ['tool', 'Update', 'src/routes/login.ts', 'Updated src/routes/login.ts with 3 additions'],
      ['tool', 'Bash', 'pnpm test -- rateLimit', '6 passed (6)'],
      ['tool', 'Read', 'src/config.ts', 'Read 52 lines'],
    ],
  },
  web: {
    cwd: 'C:\\code\\web',
    ask: 'fix the session timeout on the checkout page',
    verb: 'Pondering',
    start: 0,
    tokens: 1.8,
    steps: [
      ['say', 'The token refresh runs after the timer fires, so checkout logs you out.'],
      ['tool', 'Read', 'src/auth/session.ts', 'Read 120 lines'],
      ['tool', 'Update', 'src/auth/session.ts', 'Updated src/auth/session.ts with 7 additions and 2 removals'],
    ],
    permission: {
      kind: 'Bash command',
      command: 'pnpm test -- --run auth',
      why: 'Run the auth tests',
      options: ['Yes', "Yes, and don't ask again for pnpm test commands", 'No, and tell Claude what to do differently (esc)'],
      after: ['tool', 'Bash', 'pnpm test -- --run auth', '42 passed (42)'],
    },
    then: [
      ['tool', 'Read', 'src/pages/checkout.tsx', 'Read 210 lines'],
      ['say', 'Tests pass. Checking the checkout page uses the new refresh.'],
    ],
  },
  docs: {
    cwd: 'C:\\code\\docs',
    ask: 'document the new /v2/orders endpoints',
    verb: 'Writing',
    start: 0,
    tokens: 7.4,
    steps: [
      ['tool', 'Read', 'openapi/orders.yaml', 'Read 312 lines'],
      ['tool', 'Write', 'docs/api/orders.md', 'Wrote 188 lines to docs/api/orders.md'],
      ['tool', 'Update', 'docs/sidebar.json', 'Updated docs/sidebar.json with 4 additions'],
      ['tool', 'Bash', 'pnpm docs:check', 'No broken links'],
      ['tool', 'Read', 'docs/api/payments.md', 'Read 140 lines'],
    ],
  },
  infra: {
    cwd: 'C:\\code\\infra',
    ask: 'move the worker queue to the new region',
    verb: 'Thinking',
    start: 0,
    tokens: 5.2,
    steps: [
      ['tool', 'Read', 'terraform/queue.tf', 'Read 66 lines'],
      ['tool', 'Update', 'terraform/queue.tf', 'Updated terraform/queue.tf with 2 additions and 2 removals'],
      ['tool', 'Bash', 'terraform plan -out plan.bin', 'Plan: 1 to add, 1 to change, 0 to destroy.'],
      ['tool', 'Read', 'terraform/worker.tf', 'Read 48 lines'],
    ],
  },
}

const s = SCENES[scene] ?? SCENES.api
const out = (t) => process.stdout.write(t)
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const t0 = Date.now()
let pending = s.steps.slice(1)
let mode = 'work'
let answered = false
let frame = 0
const flag = join(controlDir, `${scene}.ask`)
const history = [s.steps[0]]

out('\x1b]0;✳ Claude Code\x07')
out('\x1b[?25l\x1b[2J\x1b[H')

const width = () => Math.max(60, Math.min((process.stdout.columns || 100) - 3, 100))
function box(lines, w, color = GREY) {
  const top = `${color}╭${'─'.repeat(w - 2)}╮${R}`
  const bot = `${color}╰${'─'.repeat(w - 2)}╯${R}`
  const mid = lines.map(([txt, len]) => `${color}│${R} ${txt}${' '.repeat(Math.max(0, w - 4 - len))} ${color}│${R}`)
  return [top, ...mid, bot]
}
function step(st) {
  if (st[0] === 'say') return [`● ${st[1]}`, '']
  const [, name, arg, result] = st
  const good = /passed|No broken|Plan:/.test(result)
  return [`${GREEN}●${R} ${BOLD}${name}${R}(${arg})`, `  ${GREY}⎿${R}  ${good ? GREEN : ''}${result}${R}`, '']
}
function elapsed() {
  const sec = s.start + Math.floor((Date.now() - t0) / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`
}
const tokens = () => (s.tokens + (Date.now() - t0) / 9000).toFixed(1)

function draw() {
  const w = width()
  const head = []
  const banner = [
    [`${ORANGE}✻${R} Welcome to ${BOLD}Claude Code${R}!`, 25],
    ['', 0],
    [`${GREY}  cwd: ${s.cwd}${R}`, 7 + s.cwd.length],
  ]
  head.push(...box(banner, Math.min(w, 52), ORANGE))
  head.push('')
  head.push(`${GREY}>${R} ${s.ask}`)
  head.push('')
  const tail = []
  if (mode === 'ask') {
    const p = s.permission
    tail.push(`${BLUE}${'─'.repeat(w - 2)}${R}`)
    tail.push(` ${BOLD}${BLUE}${p.kind}${R}`)
    tail.push('')
    tail.push(`   ${p.command}`)
    tail.push(`   ${GREY}${p.why}${R}`)
    tail.push('')
    tail.push(' Do you want to proceed?')
    p.options.forEach((o, i) => tail.push(i === 0 ? ` ${BLUE}❯ ${i + 1}. ${o}${R}` : `   ${i + 1}. ${o}`))
    tail.push('')
    tail.push(` ${GREY}Esc to cancel · Tab to add additional instructions${R}`)
  } else {
    const g = SPIN[frame % SPIN.length]
    tail.push(`${ORANGE}${g} ${s.verb}…${R} ${GREY}(${elapsed()} · ↓ ${tokens()}k tokens · esc to interrupt)${R}`)
    tail.push('')
    tail.push(...box([[`${GREY}>${R} `, 2]], w, GREY))
    tail.push(`  ${GREY}? for shortcuts${R}`)
  }
  // As many of the latest steps as fit between the banner and the prompt.
  const room = (process.stdout.rows || 30) - 1 - head.length - tail.length
  let body = []
  for (let i = history.length - 1; i >= 0 && i >= history.length - 4; i--) {
    const lines = step(history[i])
    if (body.length + lines.length > room) break
    body = [...lines, ...body]
  }
  const lines = [...head, ...body, ...tail]
  out('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J')
}

let nextAt = Date.now() + 2200
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', (d) => {
  const k = String(d)
  if (k === '\x03') {
    out('\x1b[?25h\x1b[0m\x1b[2J\x1b[H')
    process.exit(0)
  }
  if (mode === 'ask' && (k === '1' || k === '\r')) {
    mode = 'work'
    answered = true
    rmSync(flag, { force: true })
    history.push(s.permission.after)
    pending = [...(s.then ?? [])]
    nextAt = Date.now() + 2600
    draw()
  }
})

setInterval(() => {
  frame++
  if (mode === 'work' && !answered && s.permission && existsSync(flag)) {
    mode = 'ask'
    out('\x07')
  }
  if (mode === 'work' && Date.now() > nextAt) {
    if (pending.length) history.push(pending.shift())
    else if (!s.permission) pending = s.steps.slice(1)
    nextAt = Date.now() + 2400 + Math.random() * 1600
  }
  draw()
}, 120)
