/**
 * The stream engine live (docs/specs/stream-engine.md): the canvas above, the CLI box below
 * showing exactly the agent CLI's live area, with the real `claude --model haiku` in
 * ~/agent-box and, with --codex, the real `codex`.
 *
 * At every step, read from the live page:
 *   - the real terminal is the whole tab and its PTY is its size (never resized for the box);
 *   - the box's rows are the live region's rows (all of them, or its bottom part at the cap),
 *     the box is exactly that tall, and its text is the real terminal's rows, row for row;
 *   - nothing is drawn over the box (elementsFromPoint over a grid, and every visible
 *     element's clipped rect), no transform / mask on it, no clip but its own rounded inner
 *     rect (a safety net);
 *   - the box's columns end inside it (inside the well a theme draws in it), the same
 *     margin left and right, and its terminal has the real terminal's columns;
 *   - none of the conversation's words are in the box.
 * Every transition is sampled each animation frame (the box's own terminal): no frame may
 * lack the prompt line or the dialog's keys, and no frame may hold conversation text.
 * Screenshots of each scenario go to the out dir.
 *
 *   npm run build; node scripts/probe-engine.mjs [--codex] [--only=claude|codex] [--theme=basalt] [--verbose] [out-dir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const args = process.argv.slice(2)
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7)
const CODEX = args.includes('--codex') || ONLY === 'codex'
const OUT = args.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-engine-shots')
const PORT = Number(process.env.PROBE_PORT) || 9591
const CWD = join(homedir(), 'agent-box')
const PROBE_FILE = join(CWD, 'probe-se.txt')
const VERBOSE = args.includes('--verbose')
const THEME = (args.find((a) => a.startsWith('--theme=')) ?? '').slice(8)
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
  return ok
}

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken; close what holds it first`)
  process.exit(1)
}
const home = join(process.env.TEMP ?? '.', 'ember-probe-engine')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
if (THEME) {
  // The palette out of the source, as probe-theme-basalt.mjs reads it.
  let src = readFileSync(join(REPO, 'src/main/themes.ts'), 'utf8')
  for (const [, k, v] of src.matchAll(/export const (\w+) = ('[^']+')/g)) src = src.replaceAll(`name: ${k},`, `name: ${v},`)
  const at = src.toLowerCase().indexOf(`name: '${THEME.toLowerCase()}'`)
  if (at < 0) throw new Error(`no ${THEME} theme in themes.ts`)
  const theme = new Function(`return ${src.slice(src.lastIndexOf('{', at), src.indexOf('}', at) + 1)}`)()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ theme }, null, 2))
}
seedHome(home)
rmSync(PROBE_FILE, { force: true })
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x860', EMBER_PROBE_INACTIVE: '1' },
})
const kill = () => {
  try {
    process.getBuiltinModule('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}
process.on('exit', kill)

let target
for (let i = 0; i < 60 && !target; i++) {
  await wait(500)
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
  } catch {}
}
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
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) console.log('  [eval error]', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r?.result?.value
}
const shots = []
const shot = async (file) => {
  await wait(250)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const f = join(OUT, `${file}.png`)
  writeFileSync(f, Buffer.from(r.data, 'base64'))
  shots.push(f)
  console.log('shot', f)
  return f
}
/** The bottom-right 300×200 of the window: where the box's right edge meets its corner. */
const crop = async (file) => {
  await wait(250)
  const vw = await ev('[innerWidth, innerHeight]')
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: vw[0] - 300, y: vw[1] - 200, width: 300, height: 200, scale: 2 } })
  const f = join(OUT, `${file}-corner.png`)
  writeFileSync(f, Buffer.from(r.data, 'base64'))
  shots.push(f)
  console.log('shot', f)
  return f
}
const key = (k, code, vk, modifiers = 0, text) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }).then(() =>
    send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  )
// Text arrives in the PTY as one chunk, which Claude Code reads as a paste; an Enter that
// follows too closely is taken as part of it (a newline in the prompt, nothing sent). So an
// Enter waits until the text has been in for a while, longer for a long text: on a busy
// machine (another Electron, a build) 350 ms was not always enough.
let typed = { at: 0, len: 0 }
const enter = async () => {
  const left = typed.at + 450 + Math.min(600, typed.len * 4) - Date.now()
  await wait(Math.max(150, left))
  return key('Enter', 'Enter', 13, 0, '\r')
}
const esc = () => key('Escape', 'Escape', 27)
const tabKey = () => key('Tab', 'Tab', 9, 0, '\t')
const switchKey = () => key('`', 'Backquote', 192, 2)
const typeText = async (text) => {
  const r = await send('Input.insertText', { text })
  typed = { at: Date.now(), len: text.length }
  return r
}
const until = async (fn, ms, every = 200) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await wait(every)
  }
  return null
}
await wait(4000)
const first = await ev('window.__ember.activeTab()')
const newTab = async () => {
  const tab = await ev(`window.__ember.newLoom(${JSON.stringify(CWD)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  return tab
}
const loom = (tab) => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
const focusTerm = (tab) => ev(`(() => { const l = window.__ember.loom(${JSON.stringify(tab)}); document.querySelector('[data-session-id="' + l.sessionId + '"] .xterm-helper-textarea').focus() })()`)

// ------------------------------------------------------------------ the hard rules

/** The box, the real terminal and what covers the box, from the page. */
const geometry = (tab) =>
  ev(`(() => {
    const l = window.__ember.loom(${JSON.stringify(tab)})
    const lv = window.__ember.loomLive(${JSON.stringify(tab)})
    const pane = document.querySelector('[data-session-id="' + l.sessionId + '"]')
    const panes = pane.closest('.ember-group-panes') ?? pane.parentElement
    const box = lv.el
    const screen = box.querySelector('.xterm-screen')
    const br = box.getBoundingClientRect()
    const sr = screen ? screen.getBoundingClientRect() : br
    const pr = pane.getBoundingClientRect()
    const gr = panes.getBoundingClientRect()
    const bad = []
    const cols = 16, rowsN = Math.max(2, lv.shown.rows)
    const cellH = l.cli.cellH
    const padTop = parseFloat(getComputedStyle(box).paddingTop) || 0
    for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
      const px = br.left + 10 + (br.width - 20) * i / (cols - 1)
      const py = br.top + padTop + cellH * (j + 0.5)
      const top = document.elementFromPoint(px, py)
      if (!top || !box.contains(top)) bad.push({ px: Math.round(px), py: Math.round(py), top: (top?.className || top?.tagName || '').toString().slice(0, 60) })
    }
    const painted = []
    const group = pane.closest('.ember-group')
    for (const e of document.body.querySelectorAll('*')) {
      if (box.contains(e) || e.contains(box)) continue
      const g = e.closest('.ember-group')
      if (g && g !== group) continue
      // The real terminal (under the box, not seen) and what holds it are not drawn over it.
      if (pane.contains(e) || e.contains(pane)) continue
      if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      const r = e.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      let q = { l: r.left, t: r.top, r: r.right, b: r.bottom }
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
        const c = getComputedStyle(a)
        if (c.overflowX !== 'visible' || c.overflowY !== 'visible' || c.contain.includes('paint')) {
          const z = a.getBoundingClientRect()
          q = { l: Math.max(q.l, z.left), t: Math.max(q.t, z.top), r: Math.min(q.r, z.right), b: Math.min(q.b, z.bottom) }
        }
      }
      const ix = Math.min(q.r, br.right) - Math.max(q.l, br.left)
      const iy = Math.min(q.b, br.bottom - 0.5) - Math.max(q.t, br.top + 0.5)
      if (ix > 1 && iy > 1) {
        // Painted over the box only counts if it is stacked above it.
        const z = getComputedStyle(e).zIndex
        painted.push(((e.className && e.className.baseVal === undefined ? e.className : e.tagName) + '').slice(0, 50) + '@z' + z)
      }
    }
    const st = (e) => { const c = getComputedStyle(e); return [c.transform, c.clipPath, c.maskImage].join('|') }
    // What is seen of the box: the well a theme draws inside it (its ::before), else the box.
    const bs = getComputedStyle(box)
    const well = getComputedStyle(box, '::before')
    const drawn = well.content !== 'none' && well.content !== 'normal' && well.position === 'absolute'
    const inL = br.left + (drawn ? parseFloat(well.left) || 0 : 0)
    const inR = br.right - (drawn ? parseFloat(well.right) || 0 : 0)
    const dterm = lv.term
    const dcore = dterm._core
    const cellW = dcore?._renderService?.dimensions?.css?.cell?.width ?? 0
    const fit = {
      boxL: br.left, boxR: br.right, inL, inR, well: drawn,
      contentW: br.width - (parseFloat(bs.paddingLeft) || 0) - (parseFloat(bs.paddingRight) || 0),
      screenL: sr.left, screenR: sr.right, screenW: sr.width,
      textR: sr.left + dterm.cols * cellW, cellW,
      cols: dterm.cols, realCols: l.cli.cols, pty: l.cli.pty?.cols,
      left: sr.left - inL, right: inR - (sr.left + dterm.cols * cellW),
      paneL: pr.left, paneW: pr.width, realScreenW: pane.querySelector('.xterm-screen')?.getBoundingClientRect().width,
      realXtermW: pane.querySelector('.xterm')?.getBoundingClientRect().width, realPad: getComputedStyle(pane.querySelector('.xterm')).padding,
      boxPad: bs.padding,
    }
    return {
      fit,
      l,
      region: lv.region,
      shown: lv.shown,
      text: lv.text(),
      live: lv.liveRows(),
      box: { top: br.top - gr.top, bottom: br.bottom - gr.top, h: br.height, padTop, padBottom: parseFloat(getComputedStyle(box).paddingBottom) || 0, screenH: sr.height },
      pane: { top: pr.top - gr.top, h: pr.height, opacity: getComputedStyle(pane).opacity },
      panesH: gr.height,
      cellH,
      bad,
      painted,
      styles: [box, screen].filter(Boolean).map(st),
    }
  })()`)

/** The hard rules, now; `words`: conversation text that must not be in the box. */
const rules = async (tab, where, words = []) => {
  await wait(300)
  let g = await geometry(tab)
  // Read mid-frame (the real terminal one write ahead of the box): once more, a beat later.
  if (g.text.join('|') !== g.live.slice(g.shown.from - (g.region?.top ?? 0), g.shown.from - (g.region?.top ?? 0) + g.shown.rows).join('|')) {
    await wait(600)
    g = await geometry(tab)
  }
  const c = g.l.cli
  const r = g.region
  const fullTab = g.pane.top === 0 && Math.abs(g.pane.h - g.panesH) < 1 && c.pty.rows === c.rows && c.pty.cols === c.cols && c.rows * c.cellH <= c.paneH
  check(`${where}: the real terminal is the whole tab and its PTY is its size`, fullTab, `rows=${c.rows} pty=${c.pty.rows}x${c.pty.cols} paneTop=${g.pane.top} paneH=${g.pane.h} opacity=${g.pane.opacity}`)
  const rows = r && r.mode === 'split' ? r.bottom - r.top + 1 : 0
  const exact = rows > 0 && (g.shown.rows === rows || (g.shown.rows < rows && g.shown.rows === g.shown.total - (g.shown.from - r.top) && g.shown.from + g.shown.rows - 1 === r.bottom))
  const tall = Math.abs(g.box.h - (g.shown.rows * g.cellH + g.box.padTop + g.box.padBottom)) < 1.5
  const same = g.text.length === g.shown.rows && g.text.every((t, i) => t.replace(/\s+$/, '') === (g.live[g.shown.from - r.top + i] ?? '').replace(/\s+$/, ''))
  check(`${where}: the box shows the live region's rows, exactly as tall, row for row`, exact && tall && same, `region=${r?.top}..${r?.bottom} (${r?.why}) shown=${g.shown.rows} from=${g.shown.from} boxH=${g.box.h.toFixed(1)} want=${(g.shown.rows * g.cellH + g.box.padTop + g.box.padBottom).toFixed(1)}${same ? '' : ' TEXT DIFFERS'}`)
  // The box may clip to its own rounded inner rect (a safety net); its screen is never clipped.
  const clean = g.styles.every((s, i) => (i === 0 ? /^none\|(?:none|inset\([^)]*\))\|none$/ : /^none\|none\|none$/).test(s))
  check(`${where}: nothing drawn over the box, nothing transformed`, g.bad.length === 0 && g.painted.length === 0 && clean, g.bad.length || g.painted.length ? JSON.stringify({ bad: g.bad.slice(0, 3), painted: g.painted.slice(0, 5) }) : '')
  const f = g.fit
  check(`${where}: the CLI's columns end inside the box, the same margin left and right`,
    f.screenW <= f.contentW + 0.5 && f.textR <= f.inR + 0.5 && f.cols === f.realCols && Math.abs(f.right - f.left) <= 2,
    `cols=${f.cols}/${f.realCols} screenW=${f.screenW.toFixed(1)} contentW=${f.contentW.toFixed(1)} margin L=${f.left.toFixed(1)} R=${f.right.toFixed(1)}${f.well ? ' (well)' : ''}`)
  if (VERBOSE) console.log('  fit', JSON.stringify(f))
  const hits = g.text.filter((t) => words.some((w) => w && t.includes(w)))
  check(`${where}: no conversation in the box`, hits.length === 0, hits.length ? JSON.stringify(hits.slice(0, 3)) : '')
  if (VERBOSE || hits.length || !exact || !same) console.log(`  ---- box (${where})\n${g.text.map((t, i) => `  ${String(g.shown.from + i).padStart(2)}|${t}`).join('\n')}`)
  if (!same) console.log(`  ---- real live rows ${JSON.stringify(g.live)}\n  box ${JSON.stringify(g.text)}\n  log ${JSON.stringify(g.l.cli.liveLog.slice(-5))}`)
  return g
}

/**
 * Sample the box every animation frame while `fn` runs: does it show the prompt line
 * (Claude's `❯` between its borders, Codex's `›`) or a dialog's keys? And none of `words`?
 */
const SAMPLER = `(() => {
  if (window.__eng) return true
  const FOOT = /Esc to (?:cancel|close|exit|go back)|Enter to (?:confirm|set|select|continue)|enter to (?:confirm|continue|select)|esc to (?:cancel|close|skip|back)|Press enter to confirm|enter select/i
  const E = { on: false, frames: [] }
  E.start = (tab, agent, words) => {
    const lv = window.__ember.loomLive(tab)
    E.frames = []
    E.on = true
    const tick = () => {
      if (!E.on) return
      const rows = lv.text()
      const line = agent === 'codex' ? rows.some((r) => /^›(?:\\s|$)/.test(r)) : rows.some((r) => /^[❯>]/.test(r))
      const foot = rows.some((r) => FOOT.test(r))
      // Words still in the prompt box (between its borders, just sent) are the input's, not the conversation's.
      const inBox = (i) => /^[❯>]/.test(rows[i]) && i > 0 && /^[─━]{20,}/.test(rows[i - 1])
      const talk = rows.filter((r, i) => !inBox(i) && words.some((w) => w && r.includes(w)))
      E.frames.push({ t: performance.now(), n: rows.length, ok: line || foot, talk: talk.length, text: rows })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  }
  E.stop = () => {
    E.on = false
    let run = 0, worst = 0, at = -1, talk = 0, talkAt = -1
    E.frames.forEach((f, i) => {
      if (f.ok) run = 0
      else { run++; if (run > worst) { worst = run; at = i } }
      if (f.talk) { talk++; if (talkAt < 0) talkAt = i }
    })
    const hs = []
    for (const f of E.frames) if (hs[hs.length - 1] !== f.n) hs.push(f.n)
    return { frames: E.frames.length, worst, talk, heights: hs.slice(0, 24), worstText: at >= 0 ? E.frames[at].text : null, talkText: talkAt >= 0 ? E.frames[talkAt].text : null }
  }
  window.__eng = E
  return true
})()`
const worst = []
const sampled = async (tab, label, fn, agent = 'claude', words = []) => {
  await ev(SAMPLER)
  await ev(`window.__eng.start(${JSON.stringify(tab)}, ${JSON.stringify(agent)}, ${JSON.stringify(words)})`)
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    const s = await ev(`window.__eng.stop()`)
    worst.push({ label, worst: s.worst, frames: s.frames, talk: s.talk, heights: s.heights })
    check(`${label}: every frame of the box shows the prompt or the dialog's keys (worst ${s.worst} without)`, s.worst === 0, `${s.frames} frames over ${Date.now() - t0} ms, heights ${s.heights.join('→')}`)
    check(`${label}: no frame of the box holds conversation text`, s.talk === 0, s.talk ? `${s.talk} frames, e.g. ${JSON.stringify(s.talkText?.filter((r) => r.trim()).slice(0, 4))}` : '')
    if (s.worst && s.worstText) console.log(s.worstText.map((r, i) => `   ${String(i).padStart(2)}|${r}`).join('\n'))
  }
}
const boxHas = async (tab, re) => (await ev(`window.__ember.loomLive(${JSON.stringify(tab)}).text()`)).some((r) => re.test(r))
const steady = async (tab, quiet = 700, ms = 10_000) => {
  let last = ''
  let since = Date.now()
  return until(async () => {
    const t = JSON.stringify(await ev(`window.__ember.loomLive(${JSON.stringify(tab)}).text()`))
    if (t !== last) {
      last = t
      since = Date.now()
    }
    return Date.now() - since >= quiet
  }, ms, 100)
}

// ================================================================== Claude Code
if (ONLY !== 'codex') {
  const tab = await newTab()
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  const lm = () => loom(tab)
  await until(async () => (await lm())?.rows?.some((r) => /PS .*>|agent-box/.test(r)), 20_000)
  await focusTerm(tab)
  await typeText('claude --model haiku --permission-mode default')
  await enter()
  const up = await until(async () => { const x = await lm(); return x.mode === 'claude' && x.cli.promptSeen && x }, 60_000)
  check('`claude` splits the tab: canvas above, the live area below', !!up && up.cli.canvasOn && up.cli.liveOn && up.cli.under)
  await steady(tab, 1200)
  let g = await rules(tab, 'at rest', ['Claude Code v', 'agent-box>'])
  check('at rest: the box is the prompt box and its status lines (≤ 7 rows)', g.shown.rows >= 3 && g.shown.rows <= 7 && /^[─━]/.test(g.text[0] ?? ''), `rows=${g.shown.rows} first=${JSON.stringify(g.text[0]?.slice(0, 20))}`)
  check('the keyboard is in the real terminal', (await lm()).cli.focusInTerm)
  await shot('claude-1-rest')
  await crop('claude-1-rest')
  if (process.env['PROBE_REST_ONLY']) { kill(); process.exit(failed ? 1 : 0) }

  // ---- a reply
  const ASK1 = 'Reply with a one-line intro, then a markdown table of 3 planets and their number of moons. No tools.'
  const W1 = ['one-line intro', 'Jupiter', 'Saturn', 'moons']
  await focusTerm(tab)
  await sampled(tab, 'a turn (working line, reply)', async () => {
    await typeText(ASK1)
    await enter()
    check('mid-turn: the working line is in the box', !!(await until(() => boxHas(tab, /…/), 20_000, 100)))
    await shot('claude-2-working')
    const replied = await until(async () => { const x = await lm(); return /moons/i.test(x.text) && /Jupiter|Mars|Saturn|Earth/.test(x.text) && !x.working && x }, 90_000)
    check('the reply is on the canvas', !!replied)
    await steady(tab, 1200)
  }, 'claude', ['Jupiter', 'Saturn', 'one-line intro'])
  await rules(tab, 'after a reply', W1)
  await shot('claude-3-replied')
  await crop('claude-3-replied')

  // ---- `/`
  await focusTerm(tab)
  await sampled(tab, '`/` typed', async () => {
    await key('/', 'Slash', 191, 0, '/')
    await until(() => boxHas(tab, /^\s+(?:[❯>]\s*)?\/[\w:.-]+\s{2,}\S/), 6000, 50)
    await steady(tab)
  }, 'claude', W1)
  g = await rules(tab, '`/` list open', W1)
  check('`/` list: the prompt line and the list are in the box', g.text.some((r) => /^[❯>]\s*\//.test(r)) && g.text.filter((r) => /^\s+(?:[❯>]\s*)?\/[\w:.-]+\s{2,}\S/.test(r)).length >= 3, `rows=${g.shown.rows}`)
  await shot('claude-4-slash')
  await crop('claude-4-slash')
  await sampled(tab, '`/` closed (Backspace)', async () => {
    await key('Backspace', 'Backspace', 8)
    await steady(tab)
  }, 'claude', W1)
  await rules(tab, '`/` closed', W1)

  // ---- /mcp, /model
  for (const cmd of ['/mcp', '/model']) {
    await focusTerm(tab)
    await typeText(cmd)
    await wait(500)
    await sampled(tab, `${cmd} opened`, async () => {
      await enter()
      await until(() => boxHas(tab, /Esc to cancel/), 10_000, 50)
      await steady(tab)
    }, 'claude', W1)
    g = await rules(tab, `${cmd} open`, [...W1, `❯ ${cmd}`])
    const title = cmd === '/mcp' ? /Manage MCP servers/ : /Select model/
    // Taller than the box (Claude sizes /mcp to the screen): its bottom part, choices and footer.
    check(`${cmd}: the picker's choices and footer are in the box (its title too unless capped)`, (g.shown.rows < g.shown.total || g.text.some((r) => title.test(r))) && g.text.some((r) => /^\s*[❯>]/.test(r)) && g.text.some((r) => /Esc to cancel/.test(r)),`rows=${g.shown.rows}/${g.shown.total}`)
    await shot(`claude-5-${cmd.slice(1)}`)
    await sampled(tab, `${cmd} closed (Esc)`, async () => {
      await esc()
      await steady(tab, 900)
    }, 'claude', W1)
    await rules(tab, `${cmd} closed`, [...W1, 'dialog dismissed', 'Kept model'])
  }

  // ---- six lines
  await focusTerm(tab)
  await sampled(tab, 'a six-line prompt typed', async () => {
    for (let i = 1; i <= 6; i++) {
      await typeText(`line ${i} of a six line prompt${i < 6 ? ' \\' : ''}`)
      if (i < 6) await enter()
    }
    await steady(tab)
  }, 'claude', W1)
  g = await rules(tab, 'six-line prompt', W1)
  check('the six-line prompt: all six lines in the box', [1, 2, 3, 4, 5, 6].every((n) => g.text.some((r) => r.includes(`line ${n} of a six`))), `rows=${g.shown.rows}`)
  await shot('claude-6-six-lines')
  await sampled(tab, 'six-line prompt cleared (Ctrl+C)', async () => {
    await key('c', 'KeyC', 67, 2)
    await steady(tab)
  }, 'claude', W1)
  await rules(tab, 'cleared', W1)

  // ---- permission prompt
  const ASK2 = 'Use your Bash or PowerShell tool to run exactly this command and nothing else: New-Item probe-se.txt'
  await focusTerm(tab)
  await sampled(tab, 'the permission prompt opening', async () => {
    await typeText(ASK2)
    await enter()
    await until(() => boxHas(tab, /Do you want to proceed/), 90_000, 100)
    await steady(tab)
  }, 'claude', W1)
  g = await rules(tab, 'permission prompt', [...W1, ASK2.slice(0, 40)])
  check('permission prompt: the question, every choice and the keys in the box', g.text.some((r) => /Do you want to proceed/.test(r)) && g.text.some((r) => /1\.\s*Yes/.test(r)) && g.text.some((r) => /\d\.\s*No\b/.test(r)) && g.text.some((r) => /Esc to cancel/.test(r)))
  await shot('claude-7-permission')
  await sampled(tab, 'the permission prompt denied (Esc)', async () => {
    await esc()
    await until(async () => !(await lm()).working, 30_000)
    await steady(tab, 1000)
  }, 'claude', [...W1, ASK2.slice(0, 40)])
  await rules(tab, 'after the denial', [...W1, ASK2.slice(0, 40), 'Interrupted'])

  // ---- three queued messages
  await focusTerm(tab)
  await sampled(tab, 'three messages queued mid-turn', async () => {
    await typeText('Write a numbered list of 25 facts about the ocean, one short sentence each. No tools.')
    await enter()
    await until(async () => !!(await lm()).working, 30_000, 100)
    for (const n of [1, 2, 3]) {
      await typeText(`queued message number ${n}`)
      await enter()
      await wait(400)
    }
    await until(async () => [1, 2, 3].every((n) => 0) || (await boxHas(tab, /queued message number 3/)), 6000, 100)
    await shot('claude-8-queued')
    g = await rules(tab, 'queued messages', ['facts about the ocean', 'The ocean'])
    check('queued messages: the queue and the prompt are in the box', g.text.some((r) => /queued message number/.test(r)) && g.text.some((r) => /^[❯>]/.test(r)), `rows=${g.shown.rows}`)
    await until(async () => !(await lm()).working, 180_000, 500)
    await steady(tab, 1500)
  }, 'claude', ['facts about the ocean', '1. ', 'Pacific'])
  await rules(tab, 'after the queue', ['facts about the ocean', 'queued message number', 'Pacific'])

  // ---- Ctrl+`
  await focusTerm(tab)
  await switchKey()
  await wait(900)
  let l = await lm()
  check('Ctrl+` shows the real terminal, the whole tab', l.raw && !l.cli.canvasOn && !l.cli.liveOn && !l.cli.under, `raw=${l.raw}`)
  await shot('claude-9-full-cli')
  await switchKey()
  l = await until(async () => { const x = await lm(); return !x.raw && x.cli.canvasOn && x.cli.liveOn && x }, 5000)
  check('Ctrl+` again: the canvas and the box', !!l && l.cli.focusInTerm)
  await rules(tab, 'back from the full terminal', ['facts about the ocean', 'Jupiter'])

  // ---- the Canvas | CLI switch, clicked with the mouse (a real press at the button)
  const clickView = async (view) => {
    const r = await ev(`(() => { const b = [...document.querySelectorAll('[data-view="${view}"]')].find((x) => x.offsetParent); if (!b) return null; const q = b.getBoundingClientRect(); const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { x: q.left + q.width / 2, y: q.top + q.height / 2, hit: !!top && (top === b || b.contains(top)), under: top ? top.className : '' } })()`)
    if (!r) return { found: false }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    return { found: true, ...r }
  }
  let c = await clickView('cli')
  l = await until(async () => { const x = await lm(); return x.raw && x }, 5000)
  check('clicking CLI shows the real terminal', !!l, JSON.stringify(c))
  c = await clickView('canvas')
  l = await until(async () => { const x = await lm(); return !x.raw && x.cli.canvasOn && x.cli.liveOn && x }, 5000)
  check('clicking Canvas brings the canvas and the box back', !!l, JSON.stringify(c))

  // ---- the window resized: the page made smaller, wider and back (the panes refit, the PTY with them)
  await sampled(tab, 'the window resized (smaller, wider, back)', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 0, mobile: false })
    await wait(1500)
    await steady(tab)
    await rules(tab, 'resized', ['facts about the ocean', 'Jupiter'])
    await shot('claude-10-resized')
    await crop('claude-10-resized')
    await send('Emulation.setDeviceMetricsOverride', { width: 1460, height: 900, deviceScaleFactor: 0, mobile: false })
    await wait(1500)
    await steady(tab)
    await rules(tab, 'resized wider', ['facts about the ocean', 'Jupiter'])
    await crop('claude-10-resized-wider')
    await send('Emulation.clearDeviceMetricsOverride', {})
    await wait(1500)
    await steady(tab)
  }, 'claude', ['facts about the ocean', 'Jupiter'])
  await rules(tab, 'resized back', ['facts about the ocean', 'Jupiter'])
  await crop('claude-10b-resized-back')

  // ---- the person's own `"tui": "fullscreen"` (this machine's setting) and `/tui fullscreen`.
  // The whole run above already had it: Ember's classic renderer won. `/tui fullscreen` saves
  // the setting and restarts Claude Code, dropping CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN from
  // the environment; Ember's `--settings` (and the variable in its `env`) come back with the
  // restart. Run only where the setting already says fullscreen, so it changes nothing.
  let userTui
  try {
    userTui = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).tui
  } catch {}
  console.log(`  (this machine's own Claude setting: tui ${userTui ?? 'unset'})`)
  if (userTui === 'fullscreen') {
    await focusTerm(tab)
    await typeText('/tui fullscreen')
    await enter()
    // The restart: the screen goes and comes back with the session resumed.
    await until(async () => (await lm()).rows.some((r) => /Claude Code v\d/.test(r)), 30_000, 200)
    l = await until(async () => { const x = await lm(); return x.mode === 'claude' && x.cli.liveOn && x.cli.promptSeen && x }, 40_000)
    check('/tui fullscreen in Ember: Claude Code restarts and stays classic (canvas and box)', !!l, l ? '' : `mode=${(await lm()).mode}`)
    await steady(tab, 1500)
    await shot('claude-11-after-tui-fullscreen')
    await rules(tab, 'after /tui fullscreen', ['facts about the ocean', 'Jupiter', 'Claude Code v'])
  }

  // Exit: the tab is a shell again.
  await focusTerm(tab)
  await key('c', 'KeyC', 67, 2)
  await wait(300)
  await key('c', 'KeyC', 67, 2)
  l = await until(async () => { const x = await lm(); return x.mode === 'shell' && x }, 15_000)
  check('Claude exits: the tab is a plain shell again, the box gone', !!l && !l.cli.liveOn && !l.cli.under)
  await ev(`window.__ember.closeTab(${JSON.stringify(tab)})`)
}

// ================================================================== Codex
if (CODEX) {
  const tab = await newTab()
  const lm = () => loom(tab)
  await until(async () => (await lm())?.rows?.some((r) => /PS .*>|agent-box/.test(r)), 20_000)
  await focusTerm(tab)
  await typeText('codex -a on-request -s read-only')
  await enter()
  const up = await until(async () => { const x = await lm(); return x.mode === 'claude' && x.agent === 'codex' && (await boxHas(tab, /^›/)) && x }, 60_000)
  check('`codex` splits the tab: canvas above, the live area below', !!up)
  await steady(tab, 1500)
  // (Codex keeps its session card in its viewport while it says "model: loading": its own live cell.)
  const W = ['Tip: ', 'Update available', 'shell line']
  let g = await rules(tab, 'codex at rest', W)
  if (!check('codex at rest: the prompt and its footer (≤ 6 rows, or with its session card, which Codex keeps live until the first message)', (g.shown.rows <= 6 || g.text.some((r) => /OpenAI Codex/.test(r))) && g.text.some((r) => /^›/.test(r)), `rows=${g.shown.rows}`))
    console.log(`  region ${JSON.stringify(g.region)}\n${g.l.rows.map((r, i) => `  ${String(i).padStart(2)}|${r}`).join('\n')}\n  log ${JSON.stringify(g.l.cli.liveLog.slice(-12))}`)
  await shot('codex-1-rest')
  if (process.env['PROBE_REST_ONLY']) {
    kill()
    process.exit(failed ? 1 : 0)
  }
  await focusTerm(tab)
  await sampled(tab, 'codex: `/` typed', async () => {
    await key('/', 'Slash', 191, 0, '/')
    await until(() => boxHas(tab, /\/model\s{2,}/), 6000, 50)
    await steady(tab)
  }, 'codex', W)
  g = await rules(tab, 'codex `/` list', W)
  check('codex `/`: the list and the prompt in the box', g.text.some((r) => /\/model\s{2,}/.test(r)) && g.text.some((r) => /^›/.test(r)))
  await shot('codex-2-slash')
  await sampled(tab, 'codex: `/` closed', async () => {
    await key('Backspace', 'Backspace', 8)
    await steady(tab)
  }, 'codex', W)
  await focusTerm(tab)
  await typeText('/model')
  await wait(400)
  await sampled(tab, 'codex: /model opened', async () => {
    await enter()
    await until(() => boxHas(tab, /Select Model/), 8000, 50)
    await steady(tab)
  }, 'codex', W)
  g = await rules(tab, 'codex /model', W)
  check('codex /model: the picker and its keys in the box', g.text.some((r) => /Select Model/.test(r)) && g.text.some((r) => /esc/i.test(r)))
  await shot('codex-3-model')
  await sampled(tab, 'codex: /model closed (Esc)', async () => {
    await esc()
    await wait(300)
    await esc()
    await steady(tab, 900)
  }, 'codex', W)
  await rules(tab, 'codex /model closed', W)

  const ASKC = 'Write three short paragraphs about rivers. Do not run any commands.'
  await focusTerm(tab)
  await sampled(tab, 'codex: a turn with three queued messages', async () => {
    await typeText(ASKC)
    await enter()
    await until(() => boxHas(tab, /Working|esc to interrupt/), 30_000, 100)
    await shot('codex-4-working')
    for (const n of [1, 2, 3]) {
      await typeText(`queued message number ${n}`)
      await tabKey()
      await wait(400)
    }
    if (await until(() => boxHas(tab, /queued message number 3/), 5000, 100)) {
      await shot('codex-5-queued')
      g = await rules(tab, 'codex queued', [...W, ASKC.slice(0, 30)])
      check('codex queued: the queue and the prompt in the box', g.text.some((r) => /queued message number 1/.test(r)) && g.text.some((r) => /^›/.test(r)))
    } else check('codex queued: the queue shows in the box', false)
    await until(async () => !(await boxHas(tab, /Working|esc to interrupt/)), 180_000, 500)
    await steady(tab, 2000)
  }, 'codex', W)
  await rules(tab, 'codex after the turn', [...W, ASKC.slice(0, 30), 'Received'])
  await shot('codex-6-replied')

  rmSync(PROBE_FILE, { force: true })
  await focusTerm(tab)
  await sampled(tab, 'codex: the approval prompt', async () => {
    await typeText('Run the PowerShell command: New-Item probe-se.txt')
    await enter()
    await until(() => boxHas(tab, /Would you like to run/), 120_000, 200)
    await steady(tab)
  }, 'codex', W)
  g = await rules(tab, 'codex approval', [...W, 'Run the PowerShell command:'])
  check('codex approval: the question, the choices and the keys in the box', g.text.some((r) => /Would you like to run/.test(r)) && g.text.some((r) => /Yes, proceed/.test(r)) && g.text.some((r) => /esc to cancel/i.test(r)))
  await shot('codex-7-approval')
  await sampled(tab, 'codex: the approval denied (Esc)', async () => {
    await esc()
    await steady(tab, 1500)
  }, 'codex', W)
  await rules(tab, 'codex after the denial', [...W, 'canceled'])
  await focusTerm(tab)
  await key('c', 'KeyC', 67, 2)
  await wait(400)
  await key('c', 'KeyC', 67, 2)
}

console.log('\nframes: worst run without the prompt or the dialog keys, per transition')
for (const w of worst) console.log(`  ${String(w.worst).padStart(2)}  ${w.label}  (${w.frames} frames, ${w.talk} with conversation, heights ${w.heights.join('→')})`)
console.log(`  worst overall: ${Math.max(0, ...worst.map((w) => w.worst))} frame(s)`)
console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}; ${shots.length} screenshots in ${OUT}`)
rmSync(PROBE_FILE, { force: true })
kill()
process.exit(failed ? 1 : 0)
