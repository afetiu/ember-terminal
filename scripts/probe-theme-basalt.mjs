/**
 * Basalt, looked at. A dev Ember (own EMBER_HOME, an old config asking for another look) opens a
 * canvas tab and is fed the reply the design mock shows — "why is checkout slow since
 * tuesday?", a headline answer, the latency table, the Client → Orders API → Payments ·
 * lock → Postgres flow and a p95 chart pinned beside it — through window.__ember.loomFeed
 * (no model). Then screenshots of the parts the theme restyles: the whole window, the
 * sidebar, a button held down mid-press (CDP mouse down, no up), a menu, the question
 * deck, Ctrl+K and Settings. Checks the material too: opaque window, no backdrop-filter
 * anywhere, the faces resolved; and that the look is fixed: an old config's theme, glass and
 * fonts are ignored, and Settings, Ctrl+K and the title bar offer no way to change it.
 *
 *   npm run build; node scripts/probe-theme-basalt.mjs [out-dir]
 *
 * Nothing is typed into any terminal: sends are recorded (window.__ember.recordSends()).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-basalt-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-basalt${process.env.PROBE_TAG ?? ''}`)
const PORT = Number(process.env.PROBE_PORT) || 9611
// Which look to stand in: PROBE_LOOK=smoke, and so on. Basalt when not said.
const LOOK = process.env.PROBE_LOOK ?? 'basalt'
const BASALT = LOOK === 'basalt'
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })

// An old config that asked for another look (a theme, glass, a font of its own): Basalt
// holds whatever the file says, so none of it may show.
writeFileSync(
  join(EMBER_HOME, 'config.json'),
  JSON.stringify({ theme: { name: 'Ember Day', background: '#FAF6EF', foreground: '#2A231D', cursor: '#B86E0B' }, window: { opacity: 40, material: 'acrylic' }, font: { family: 'Consolas', uiFamily: 'Georgia', size: 13 }, appearance: { night: 'Ember Night', day: 'Ember Day' }, labs: { enabled: true }, ...(BASALT ? {} : { look: LOOK }) }, null, 2)
)
seedHome(EMBER_HOME)

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken; close what holds it first`)
  process.exit(1)
}
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1440x900', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let n = 0
const user = (text) => ({ type: 'user', uuid: `u${++n}`, timestamp: '2026-11-09T09:00:00Z', message: { role: 'user', content: text } })
const said = (text) => ({ type: 'assistant', uuid: `a${++n}`, timestamp: '2026-11-09T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })

const REPLY = [
  '# Payments run inside the order lock.',
  '',
  'Every checkout waits for the card network while holding the row, so the queue behind it grows.',
  '',
  '| Endpoint | Before | Now |',
  '|---|---|---|',
  '| POST /checkout | 310 ms | **1.9 s** |',
  '| GET /cart | 80 ms | 84 ms |',
  '',
  '```mermaid',
  'flowchart LR',
  '  C[Client] --> O[Orders API] --> P[Payments · lock] --> D[Postgres]',
  '  class P hot',
  '```',
  '',
  '```mermaid',
  'xychart-beta',
  '  title "p95 checkout (s)"',
  '  x-axis [Sat, Sun, Mon, Tue]',
  '  y-axis 0 --> 2',
  '  bar [0, 0, 1.7, 1.9]',
  '  bar [0.31, 0.34, 0, 0]',
  '```',
  '',
  'Move the payment call after the commit. Want me to make that change?',
].join('\n')

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    } catch {}
  }
  if (!target) throw new Error('no Ember renderer')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
  const shot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log(`shot ${join(OUT, `${name}.png`)}`)
  }
  const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const pad = (r, p = 12) => r && { x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p }

  await wait(5000)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await ev('window.__ember.recordSends()')

  // ---- the material
  check(`body is marked ${LOOK}`, await ev(`document.body.classList.contains('theme-basalt') && document.body.classList.contains('look-${LOOK}') && document.body.dataset.themeFamily === '${LOOK}'`))
  check('content layer opaque', (await ev(`getComputedStyle(document.documentElement).getPropertyValue('--c-tint-alpha').trim()`)) === '1')

  // ---- the canvas tab with the mock's reply
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  // Two plain terminals under it, so the tray has cards for the slab to travel between.
  const others = [await ev('window.__ember.newTab()'), await ev('window.__ember.newTab()')]
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(2500)
  // The canvas is the Claude tab's: announce Claude the way Ember's shim does and draw a
  // Claude Code screen at its prompt (the shape scripts/fixtures/streams/claude-idle-typing
  // records) into the tab's xterm. Display only, through xterm's parser — nothing reaches
  // the shell behind it.
  const pane = (await ev('window.__ember.groups()')).find((g) => g.id === tab).panes[0]
  const cols = await ev(`window.__ember.term(${JSON.stringify(pane)}).cols`)
  const rule = `\x1b[38;2;136;136;136m${'─'.repeat(cols)}\x1b[39m\r\n`
  const out =
    '\x1b]133;E;ember-agent=claude\x07\x1b]0;✳ Claude Code\x07\x1b[2J\x1b[H' +
    '\x1b[38;2;215;119;87m ▐▛███▛█\x1b[39m   \x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.318\x1b[39m\r\n' +
    '\x1b[38;2;215;119;87m▝▜██████▀\x1b[39m  \x1b[38;2;153;153;153mOpus 5.5 · Claude Max\x1b[39m\r\n' +
    '\x1b[38;2;215;119;87m ▝▝   ▝▝\x1b[39m   \x1b[38;2;153;153;153m~\\checkout\x1b[39m\r\n\r\n\r\n' +
    rule +
    '❯ move the payments call after the commit\r\n' +
    rule +
    '  \x1b[38;2;153;153;153mOpus 5.5 · ctx 12% · $0.42 · auto mode on\x1b[39m\r\n' +
    '\x1b[7;43H'
  await ev(`new Promise((r) => window.__ember.term(${JSON.stringify(pane)}).write(${JSON.stringify(out)}, r))`)
  await wait(1500)
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify([user('Why is checkout slow since Tuesday?'), said(REPLY)])})`)
  await wait(3500)
  const mouse = (type, x, y, button = 'left', extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra })
  const centre = async (sel) => {
    const r = await rect(sel)
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }

  // ---- the chart, placed beside the answer as the mock pins it: dragged out by its handle
  await ev(`document.querySelectorAll('.loom-say.is-current .loom-liftable')[2]?.scrollIntoView({ block: 'center' })`)
  await wait(300)
  const lifts = await ev(`[...document.querySelectorAll('.loom-say.is-current .loom-liftable')].map((d) => { const r = d.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })`)
  check('table, diagram and chart are objects on the canvas', lifts?.length === 3, JSON.stringify(lifts))
  if (lifts?.length === 3) {
    const c = lifts[2]
    await mouse('mouseMoved', c.x + c.w / 2, c.y + c.h / 2)
    await wait(300)
    const grip = await ev(`(() => { const l = document.querySelectorAll('.loom-say.is-current .loom-liftable')[2].querySelector('.loom-lift'); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    if (grip) {
      await mouse('mousePressed', grip.x, grip.y)
      for (let k = 1; k <= 12; k++) {
        await mouse('mouseMoved', grip.x + (1250 - grip.x) * (k / 12), grip.y + (120 - grip.y) * (k / 12), 'left', { buttons: 1 })
        await wait(16)
      }
      await shot('2-chart-lifted')
      await mouse('mouseReleased', 1250, 120)
      await wait(900)
    }
  }
  const pinned = await ev(`document.querySelectorAll('.loom-piece.is-pinned').length`)
  check('chart pinned beside the answer', pinned === 1, String(pinned))
  // Sized like the mock's card: its left edge pulled in to about 290 wide.
  const edge = await ev(`(() => { const h = document.querySelector('.loom-piece.is-pinned .loom-rz[data-rz="w"]'); const p = document.querySelector('.loom-piece.is-pinned'); if (!h || !p) return null; const r = h.getBoundingClientRect(); const q = p.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: q.width } })()`)
  if (edge) {
    const to = edge.x + Math.max(0, edge.w - 290)
    await mouse('mousePressed', edge.x, edge.y)
    for (let k = 1; k <= 10; k++) {
      await mouse('mouseMoved', edge.x + (to - edge.x) * (k / 10), edge.y, 'left', { buttons: 1 })
      await wait(16)
    }
    await mouse('mouseReleased', to, edge.y)
    await wait(900)
  }
  await ev(`document.querySelector('.loom-scroll').scrollTop = 0`)
  // Parked on the title bar, so nothing in the shot is hovered.
  await mouse('mouseMoved', 720, 8)
  await wait(600)
  await shot('1-window')

  // ---- the material, measured
  const blur = await ev(`[...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none') }).map((e) => e.className && String(e.className).slice(0, 60)).slice(0, 12)`)
  check('no backdrop-filter anywhere', blur.length === 0, JSON.stringify(blur))
  if (BASALT) check('Archivo and DM Mono resolved', await ev(`document.fonts.check('700 16px Archivo') && document.fonts.check('400 13px "DM Mono"')`))
  const look = await ev(`(() => {
    const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null }
    return {
      root: cs('.ember-root')?.backgroundColor,
      tray: cs('.ember-sidebar')?.backgroundColor,
      trayShadow: cs('.ember-sidebar')?.boxShadow,
      card: cs('.ember-card-plate')?.backgroundColor,
      surface: cs('.ember-stack')?.backgroundColor,
      surfaceRadius: cs('.ember-stack')?.borderRadius,
      table: cs('.loom-table')?.backgroundColor,
      headline: cs('.loom-say.is-current > h1') && [cs('.loom-say.is-current > h1').fontFamily, cs('.loom-say.is-current > h1').fontWeight, cs('.loom-say.is-current > h1').letterSpacing],
      prose: cs('.loom-say.is-current > p')?.color,
      ask: cs('.loom-ask')?.fontFamily,
      well: getComputedStyle(document.querySelector('.loom-live'), '::before').backgroundColor,
    }
  })()`)
  console.log('look', JSON.stringify(look))
  if (BASALT) check('frame #1d1e20, tray #17181a, card #2a2b2e, surface #252629', look.root === 'rgb(29, 30, 32)' && look.tray === 'rgb(23, 24, 26)' && look.card === 'rgb(42, 43, 46)' && look.surface === 'rgb(37, 38, 41)', JSON.stringify(look))
  if (BASALT) check('tray is recessed', /inset/.test(look.trayShadow ?? ''))
  if (BASALT) check('canvas radius 20', look.surfaceRadius === '20px')
  if (BASALT) check('table well #1d1e20, CLI well #141517', look.table === 'rgb(29, 30, 32)' && look.well === 'rgb(20, 21, 23)')
  if (BASALT) check('headline Archivo 800 tight', /Archivo/.test(look.headline?.[0] ?? '') && look.headline?.[1] === '800')
  if (BASALT) check('prose #b9b8b4', look.prose === 'rgb(185, 184, 180)', look.prose)

  // ---- the tray: switch tabs, the slab slides (caught mid-way), then back
  const box = await rect('.ember-sidebar')
  await shot('3-sidebar', pad(box, 0))
  await ev(`window.__ember.activate(${JSON.stringify(others[1])})`)
  await wait(70)
  await shot('3b-sidebar-slab-moving', pad(box, 0))
  await wait(400)
  await shot('3c-sidebar-other-tab', pad(box, 0))
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(500)

  // ---- a button mid-press: the question deck's Yes, held down (no release yet)
  await ev(`document.querySelector('.loom-answers:not(.is-stale)')?.scrollIntoView({ block: 'center' })`)
  await wait(400)
  const deck = await rect('.loom-answers:not(.is-stale)')
  check('the reply ends in a question deck', !!deck)
  if (deck) {
    await shot('4-question-deck', pad(deck, 24))
    const yes = await centre('.loom-answers:not(.is-stale) .loom-qd-opt[data-o="0"]')
    const no = await centre('.loom-answers:not(.is-stale) .loom-qd-opt[data-o="1"]')
    await mouse('mouseMoved', no.x, no.y)
    await wait(200)
    await mouse('mouseMoved', yes.x, yes.y)
    await mouse('mousePressed', yes.x, yes.y)
    await wait(140)
    const pressed = await ev(`(() => { const o = document.querySelector('.loom-answers:not(.is-stale) .loom-qd-opt[data-o="0"]'); const s = getComputedStyle(o); return { t: s.transform, sh: s.boxShadow } })()`)
    check('pressed: pushed 1px in, shadow inside', /matrix\(1, 0, 0, 1, 0, 1\)/.test(pressed.t) && /inset/.test(pressed.sh), JSON.stringify(pressed))
    await shot('5-button-pressed', pad(deck, 24))
    // Released away from it: nothing is chosen, it springs back.
    await mouse('mouseMoved', deck.x + deck.width + 60, deck.y - 30)
    await mouse('mouseReleased', deck.x + deck.width + 60, deck.y - 30)
    await wait(300)
    await mouse('mouseMoved', no.x, no.y)
    await wait(250)
    await shot('5b-button-hover', pad(deck, 24))
  }

  // ---- a menu: right-click on the answer
  const say = await rect('.loom-say.is-current > p')
  if (say) {
    // A right-click, as the page receives it (CDP's right button does not raise contextmenu here).
    await ev(`document.elementFromPoint(${say.x + 80}, ${say.y + 8}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${say.x + 80}, clientY: ${say.y + 8}, button: 2 }))`)
    await wait(450)
    const menu = await rect('.loom-menu.is-on')
    check('context menu open', !!menu)
    if (menu) await shot('6-menu', pad(menu, 30))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await wait(300)
  }

  // ---- Ctrl+K: every look by name
  await ev(`window.__ember.openPalette('theme')`)
  await wait(500)
  const rows = await ev(`[...document.querySelectorAll('.ember-palette-row')].map((r) => r.textContent)`)
  const NAMES = ['Basalt', 'Smoke', 'Lacquer', 'Patina', 'Hearth', 'Lamp']
  check('Ctrl+K offers every look', NAMES.every((n) => rows.some((r) => r.includes('Theme: ' + n))), JSON.stringify(rows))
  await shot('7-palette')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(300)

  // ---- Settings: the looks as tiles, this one marked; nothing else changes the look
  await ev(`window.__ember.openSettings()`)
  await wait(700)
  await shot('8-settings')
  const picker = await ev(`({
    tabs: [...document.querySelectorAll('.ember-settings-tab')].map((b) => b.textContent),
    tiles: [...document.querySelectorAll('.ember-look')].map((b) => b.dataset.look),
    current: [...document.querySelectorAll('.ember-look.is-current')].map((b) => b.dataset.look),
    labels: [...document.querySelectorAll('.ember-settings-label')].map((e) => e.textContent),
  })`)
  check('Settings opens on Theme with six tiles, this look marked', picker.tabs[0] === 'Theme' && picker.tiles.length === 6 && picker.current.join() === LOOK, JSON.stringify(picker))
  check('no font, opacity or backdrop to set', !picker.labels.some((l) => /^font$|interface font|opacity|backdrop|scanlines|weight/i.test(l)), JSON.stringify(picker.labels))
  check('no day/night switch in the title bar', !(await ev(`!!document.querySelector('.ember-voicetoggle, .is-mode')`)))
  // The old config's theme, glass and fonts did not take: the look's own palette and face.
  const cfg = await ev(`(() => { const c = window.__ember.config(); return { theme: c.theme.name, font: c.font.family, opacity: c.window.opacity, material: c.window.material, appearance: c.appearance } })()`)
  check("an old config's theme, glass and fonts are ignored", cfg.theme.toLowerCase() === LOOK && !/Consolas/.test(cfg.font.split(',')[0]) && cfg.opacity === undefined && cfg.material === undefined && cfg.appearance === undefined, JSON.stringify(cfg))
  if (BASALT) check('interface in Archivo', /Archivo/.test(await ev(`getComputedStyle(document.documentElement).getPropertyValue('--ui-font')`)))

  // ---- the ground moves, on the compositor only
  const moving = await ev(`(() => {
    const anims = document.querySelector('.ember-ground').getAnimations({ subtree: true }).filter((a) => a.playState === 'running')
    const props = new Set()
    for (const a of anims) for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) props.add(p)
    return { n: anims.length, props: [...props] }
  })()`)
  check('the ground moves', moving.n > 0, JSON.stringify(moving))
  check('only transform and opacity animate', moving.props.every((p) => p === 'transform' || p === 'opacity'), JSON.stringify(moving.props))

  // ---- picking a tile puts the look on at once; and back
  const OTHER = LOOK === 'lamp' ? 'hearth' : 'lamp'
  await ev(`document.querySelector('.ember-look[data-look="${OTHER}"]').click()`)
  await wait(900)
  check('a tile changes the look live', await ev(`document.body.classList.contains('look-${OTHER}') && window.__ember.config().look === '${OTHER}'`))
  await ev(`document.querySelector('.ember-look[data-look="${LOOK}"]').click()`)
  await wait(900)
  check('and back', await ev(`document.body.classList.contains('look-${LOOK}')`))
  await ev(`window.__ember.openSettings()`)
  await wait(300)

  console.log(failed ? `${failed} FAILED` : 'all ok')
  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
}
