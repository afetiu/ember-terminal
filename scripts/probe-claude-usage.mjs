import { join, basename } from 'node:path'
/**
 * The plan's limits in the strip, and a session's status line on its card.
 *
 * Starts a test Ember, then checks three things a real session would produce:
 *
 *   1. The vitals strip grows `5H n%` / `WK n%` chips within a minute of launch — main
 *      polled the usage endpoint with the OAuth token Claude Code keeps on this machine.
 *      (So this probe needs a signed-in `claude` to pass; signed out, it expects `PLAN ?`.)
 *   2. The shell was handed EMBER_SETTINGS, the file names a status line, and running
 *      that .cmd with a sample of the JSON Claude Code sends prints a line AND lands on
 *      the tab's sidebar card as `Fable · 8% · $0.01`.
 *   3. A POST to /status without the token is refused.
 *
 *   node scripts/probe-claude-usage.mjs [outfile.png]
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ experience: 'v2', restoreSession: false }, null, 2))

const PORT = 9354
const out = process.argv[2] ?? 'claude-usage.png'

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMBER_HOME },
})
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  throw new Error('DevTools endpoint never came up')
}

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async connect(url) {
    const c = new Cdp()
    c.#ws = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#ws.addEventListener('open', res, { once: true })
      c.#ws.addEventListener('error', rej, { once: true })
    })
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.#pending.get(msg.id)
      if (!p) return
      c.#pending.delete(msg.id)
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
    })
    return c
  }

  send(method, params = {}) {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.#pending.set(id, { res, rej }))
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  }

  close() {
    this.#ws.close()
  }
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error(logs.join(''))
  child.kill()
  process.exit(1)
}

async function until(cdp, expression, ok, what, tries = 40) {
  let last
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expression)
    if (ok(last)) return last
    await sleep(200)
  }
  fail(`${what} — last saw ${JSON.stringify(last)}`)
}

const PLAN_CHIPS = `Array.from(document.querySelectorAll('.ember-vitals-plan .ember-vitals-chip')).map((c) => ({ text: c.textContent, title: c.title, cls: c.className }))`

try {
  const page = await target()
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(3000)

  // 1. The plan's windows arrive in the strip. The first poll fires at launch, so this
  //    is a few seconds of network, not a minute.
  const signedIn = existsSync(join(process.env.USERPROFILE ?? '', '.claude', '.credentials.json'))
  const chips = await until(
    cdp,
    PLAN_CHIPS,
    (v) => v.length > 0,
    'no plan chips in the vitals strip',
    100
  )
  console.log('plan chips:', JSON.stringify(chips))
  if (signedIn) {
    if (!/^5H \d+%$/.test(chips[0]?.text ?? '')) fail(`first chip is "${chips[0]?.text}", expected "5H n%"`)
    if (!/^WK \d+%$/.test(chips[1]?.text ?? '')) fail(`second chip is "${chips[1]?.text}", expected "WK n%"`)
    if (!/resets in /.test(chips[0].title)) fail(`session chip has no reset time in its title: ${chips[0].title}`)
    if (chips.some((c) => c.cls.includes('is-stale'))) fail('a fresh fetch is marked stale')
  } else if (chips[0]?.text !== 'PLAN ?') {
    fail(`signed out, expected "PLAN ?", saw "${chips[0]?.text}"`)
  }
  const state = await cdp.eval(`window.ember.usage.state()`)
  console.log('usage state:', JSON.stringify({ ok: state.ok, plan: state.plan, error: state.error, limits: state.limits.length }))

  // 2. The shell got a settings file naming a status line, and the .cmd it points at
  //    both prints a line and reaches the card.
  const wire = await cdp.eval(`(async () => ({
    origin: await window.ember.panel.origin(),
    tabId: document.querySelector('.ember-group')?.dataset.groupId ?? null,
  }))()`)
  if (!wire.origin || !wire.tabId) fail(`no bridge or tab: ${JSON.stringify(wire)}`)

  const env = await readShellEnv(cdp)
  console.log('shell env:', JSON.stringify({ ...env, token: env.token ? 'set' : 'MISSING' }))
  if (!env.token) fail('the shell never reported EMBER_BRIDGE_TOKEN')
  if (!env.settings) fail('the shell did not inherit EMBER_SETTINGS — the shim would not add --settings')
  const settings = JSON.parse(readFileSync(env.settings, 'utf8'))
  const cmd = settings.statusLine?.command ?? ''
  console.log('settings file:', env.settings, '→', cmd)
  if (settings.statusLine?.type !== 'command' || !cmd.endsWith('ember-statusline.cmd')) fail('settings file does not name the status line .cmd')
  if (!existsSync(cmd)) fail(`status line wrapper is missing at ${cmd}`)

  const sample = {
    session_id: 'probe-session',
    model: { id: 'claude-fable-5-1', display_name: 'Fable' },
    cost: { total_cost_usd: 0.01234, total_duration_ms: 45000 },
    context_window: { context_window_size: 200000, used_percentage: 8 },
    prompt_cache: { warm: true },
    rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2 } },
  }
  const run = spawnSync('cmd.exe', ['/d', '/c', cmd], {
    input: JSON.stringify(sample),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      EMBER_BRIDGE_URL: wire.origin,
      EMBER_BRIDGE_TOKEN: env.token,
      EMBER_TAB_ID: wire.tabId,
      EMBER_STATUSLINE_INNER: '',
    },
  })
  console.log('status line printed:', JSON.stringify(run.stdout), run.status !== 0 ? `(exit ${run.status}, stderr ${run.stderr})` : '')
  if (run.status !== 0) fail('the status line wrapper did not exit cleanly')
  if (!/Fable\s+·\s+ctx 8%\s+·\s+\$0\.01\s+·\s+5h 24%\s+·\s+wk 41%/.test(run.stdout)) fail(`unexpected status line: ${run.stdout}`)

  const card = await until(
    cdp,
    `(() => { const c = document.querySelector('.ember-chip.is-claude'); return c ? { text: c.textContent, title: c.title } : null })()`,
    (v) => v !== null,
    'the status never reached the sidebar card'
  )
  console.log('card chip:', JSON.stringify(card))
  if (card.text !== 'Fable · 8% · $0.01') fail(`card chip reads "${card.text}"`)
  if (!card.title.includes('200k') || !card.title.includes('cache warm')) fail(`card title is thin: ${card.title}`)

  // 3. No token, no status.
  const noToken = await fetch(`${wire.origin}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: wire.tabId, status: sample }),
  })
  if (noToken.status !== 401) fail(`bridge accepted a status with no token (${noToken.status})`)

  await cdp.send('Page.bringToFront')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('screenshot ->', out)

  cdp.close()
  child.kill()
  console.log('CLAUDE USAGE OK')
  process.exit(0)
} catch (err) {
  fail(err.stack ?? String(err))
}

/** The bridge variables as the shell sees them — the only place they are true. */
async function readShellEnv(cdp) {
  const file = join(EMBER_HOME, 'env.txt')
  rmSync(file, { force: true })
  const line = `"$env:EMBER_BRIDGE_TOKEN|$env:EMBER_SETTINGS" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'`
  await cdp.eval(`(() => {
    const s = window.__ember.sessions()[0]
    window.ember.write(s.id, ${JSON.stringify(`${line}\r`)})
  })()`)
  for (let i = 0; i < 50; i++) {
    await sleep(300)
    if (!existsSync(file)) continue
    const [token, settings] = readFileSync(file, 'utf8').trim().split('|')
    if (token) return { token, settings: settings ?? '' }
  }
  return { token: '', settings: '' }
}
