/**
 * The hybrid tab: the canvas above, the agent's REAL CLI below (docs/specs/hybrid.md), with
 * the real `claude --model haiku` in ~/agent-box and, with --codex, the real `codex`.
 *
 * Every step checks the hard rules, read from the live page:
 *   - the PTY's size is the terminal's (term rows/cols = what was sent to the PTY), and the
 *     rows fill the bottom box exactly (no row below the visible area, none missing);
 *   - nothing is cut, masked or transformed: no transform / clip-path / mask on the pane or
 *     its xterm, and document.elementsFromPoint over the whole terminal rect finds only the
 *     terminal (no canvas element, divider, menu or piece over it);
 *   - what the TUI needs to show is in view: the prompt (or the dialog's choices) is in the
 *     viewport rows.
 *
 * Claude: a new tab is a shell; `claude` → split; a reply with a table and a diagram on the
 * canvas; `/mcp`, `/model` and the `/` list grow the CLI and Esc shrinks it; a long
 * multi-line prompt grows it; a permission prompt grows it and "1" answers it; three
 * messages queued mid-turn are all in view with the prompt; the divider resizes the PTY
 * (and stops at its minimum); Ctrl+` is the whole tab and back; a reply's questions → the
 * deck's Send types into the TUI; the canvas's parts (pins, snaps, plan, rail, ask box,
 * panel push, notes) still work; /exit gives the shell back.
 *
 * Keys go into the terminal as the person would type them (CDP key events into xterm).
 *
 *   npm run build; node scripts/probe-hybrid.mjs [--codex] [--only=claude|codex|pills] [out-dir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { seedHome } from './probelib.mjs'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const args = process.argv.slice(2)
const ONLY = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7)
const OUT = args.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-hybrid-shots')
const PORT = Number(process.env.PROBE_PORT) || 9561
const CWD = join(homedir(), 'agent-box')
const PROBE_FILE = join(CWD, 'probe-hybrid.txt')
const VERBOSE = args.includes('--verbose')
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const results = []
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken; close what holds it first`)
  process.exit(1)
}
const home = join(process.env.TEMP ?? '.', 'ember-probe-hybrid')
rmSync(home, { recursive: true, force: true })
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

let ws
try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
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
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(r.data, 'base64'))
    return join(OUT, `${file}.png`)
  }
  const key = (k, code, vk, modifiers = 0, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    )
  // A beat first: an Enter right after typed text reads to the TUI as part of a paste (a newline).
  const enter = async () => {
    await wait(350)
    return key('Enter', 'Enter', 13, 0, '\r')
  }
  const esc = () => key('Escape', 'Escape', 27)
  const switchKey = () => key('`', 'Backquote', 192, 2)
  const typeText = (text) => send('Input.insertText', { text })
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

  /** A tab of its own in ~/agent-box, the boot tab closed. */
  const newTab = async () => {
    const tab = await ev(`window.__ember.newLoom(${JSON.stringify(CWD)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    return tab
  }

  // ------------------------------------------------------------------ the hard rules

  /** The terminal's geometry and what covers it, from the page. */
  const geometry = (tab) =>
    ev(`(() => {
      const l = window.__ember.loom(${JSON.stringify(tab)})
      const pane = document.querySelector('[data-session-id="' + l.sessionId + '"]')
      const x = pane.querySelector('.xterm')
      const screen = pane.querySelector('.xterm-screen')
      const pr = pane.getBoundingClientRect()
      const sr = screen.getBoundingClientRect()
      const bad = []
      const cols = 16, rowsN = 12
      for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
        const px = sr.left + 2 + (sr.width - 4) * i / (cols - 1)
        const py = sr.top + 2 + (sr.height - 4) * j / (rowsN - 1)
        const stack = document.elementsFromPoint(px, py)
        // Everything above the pane in the stack must be the pane's own.
        const at = stack.findIndex((e) => e === pane)
        const over = (at < 0 ? stack : stack.slice(0, at)).filter((e) => !pane.contains(e))
        const canvasy = stack.filter((e) => e.closest && (e.closest('.loom') || e.closest('.loom-divider') || e.closest('.loom-piece') || e.closest('.loom-menu') || e.closest('.loom-pop') || e.closest('.ember-toast')))
        if (at < 0 || over.length || canvasy.length) bad.push({ px: Math.round(px), py: Math.round(py), top: (stack[0]?.className || stack[0]?.tagName || '').toString().slice(0, 60) })
      }
      // And by geometry: anything drawn over the terminal's rows, pointer-events or not
      // (a tooltip, a caret, a toast), clipped by its overflow-hidden ancestors as it is drawn.
      const painted = []
      const group = pane.closest('.ember-group')
      for (const e of document.body.querySelectorAll('*')) {
        if (pane.contains(e) || e.contains(pane)) continue
        // Another tab's group (a parked tab, the pre-warmed spare) sits under this one.
        const g = e.closest('.ember-group')
        if (g && g !== group) continue
        if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
        let r = e.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        let box = { l: r.left, t: r.top, r: r.right, b: r.bottom }
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const c = getComputedStyle(a)
          if (c.overflowX !== 'visible' || c.overflowY !== 'visible' || c.contain.includes('paint')) {
            const q = a.getBoundingClientRect()
            box = { l: Math.max(box.l, q.left), t: Math.max(box.t, q.top), r: Math.min(box.r, q.right), b: Math.min(box.b, q.bottom) }
          }
        }
        const ix = Math.min(box.r, sr.right) - Math.max(box.l, sr.left)
        const iy = Math.min(box.b, sr.bottom) - Math.max(box.t, sr.top)
        if (ix > 1 && iy > 1) painted.push(((e.className && e.className.baseVal === undefined ? e.className : e.tagName) + '').slice(0, 50))
      }
      if (painted.length) bad.push({ painted: painted.slice(0, 6) })
      const st = (e) => { const c = getComputedStyle(e); return [c.transform, c.clipPath, c.maskImage, c.webkitMaskImage].join('|') }
      const styles = [pane, x, screen].map(st)
      return {
        cli: l.cli,
        pane: { top: pr.top, bottom: pr.bottom, h: pr.height },
        screen: { top: sr.top, bottom: sr.bottom, h: sr.height },
        win: innerHeight,
        bad,
        styles,
      }
    })()`)

  /** The hard rules, checked now: name says where. */
  const rules = async (tab, where) => {
    // The fit is debounced: let it land.
    await wait(450)
    const g = await geometry(tab)
    const c = g.cli
    const fitted = c.pty.rows === c.rows && c.pty.cols === c.cols
    const usable = c.paneH - c.padY
    const fills = c.rows * c.cellH <= usable + 0.5 && (c.rows + 1) * c.cellH > usable - 0.5
    const inView = g.screen.bottom <= g.pane.bottom + 0.5 && g.pane.bottom <= g.win + 0.5
    const clean = g.styles.every((s) => /^none\|none\|none\|none$/.test(s))
    const ok = fitted && fills && inView && clean && g.bad.length === 0
    check(
      `${where}: PTY = terminal, rows fill the box, nothing cut or covered`,
      ok,
      `rows=${c.rows} pty=${c.pty.rows}x${c.pty.cols} paneH=${c.paneH} cellH=${c.cellH?.toFixed?.(2)} screenBottom=${g.screen.bottom.toFixed(1)} paneBottom=${g.pane.bottom.toFixed(1)}` +
        (clean ? '' : ` styles=${g.styles.join(' / ')}`) +
        (g.bad.length ? ` covered=${JSON.stringify(g.bad.slice(0, 3))}` : '')
    )
    return g
  }

  const dump = async (tab, label) => {
    const l = await ev(`window.__ember.loom(${JSON.stringify(tab)})`)
    if (VERBOSE) console.log(`---- ${label} (rows=${l.cli.rows} grown=${l.cli.grown} why=${l.cli.why} need=${l.cli.need} want=${l.cli.wantRows})\n${l.rows.map((r, i) => `${String(i).padStart(2)}|${r}`).join('\n')}`)
    return l
  }

  const focusTerm = (tab) => ev(`(() => { const l = window.__ember.loom(${JSON.stringify(tab)}); document.querySelector('[data-session-id="' + l.sessionId + '"] .xterm-helper-textarea').focus() })()`)
  const writePty = (tab, data) => ev(`window.ember.write(window.__ember.loom(${JSON.stringify(tab)}).sessionId, ${JSON.stringify(data)})`)

  // ================================================================== Claude Code
  if (ONLY !== 'codex' && ONLY !== 'pills') {
    const tab = await newTab()
    await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
    const cli = async () => (await loom())?.cli
    const rowsHave = async (re) => (await loom()).rows.some((r) => re.test(r))
    const grownFor = (ms = 8000) => until(async () => ((await cli()).grown ? await cli() : null), ms)
    const shrunk = (ms = 8000) => until(async () => { const c = await cli(); return !c.grown && c.rows <= c.userRows + 1 ? c : null }, ms)
    const idle = (ms = 90_000) => until(async () => { const c = await cli(); return c.prompt && !c.live && !c.grown ? c : null }, ms, 300)

    await until(async () => (await loom())?.rows?.some((r) => /PS .*>/.test(r)), 20_000)
    let l = await loom()
    check('a new tab is a plain shell', l.mode === 'shell' && !l.claude && l.cli.paneTop === 0, `mode=${l.mode}`)
    await focusTerm(tab)
    await typeText('claude --model haiku --permission-mode default')
    await enter()
    const up = await until(async () => { const x = await loom(); return x.mode === 'claude' && x.cli.promptSeen && x }, 60_000)
    check('`claude` splits the tab: canvas above, the real CLI below', !!up && up.cli.canvasOn && up.cli.paneTop > 100 && up.cli.rows >= 10, up ? `paneTop=${up.cli.paneTop} rows=${up.cli.rows}` : 'no prompt')
    await wait(1500)
    l = await dump(tab, 'idle')
    check('the CLI starts at its default height (15 rows)', l.cli.rows === 15, `rows=${l.cli.rows}`)
    check('the keyboard is in the terminal', l.cli.focusInTerm)
    check('the plain prompt is in view and the CLI is not grown', l.cli.prompt && !l.cli.grown, `why=${l.cli.why}`)
    await rules(tab, 'at rest')

    // ---- a reply with a table and a diagram, typed into the real prompt
    await focusTerm(tab)
    await typeText('Reply with exactly: a one-line intro, a markdown table of 3 planets with their number of moons, then a ```mermaid fenced flowchart LR with A-->B-->C. No tools.')
    await enter()
    const replied = await until(async () => { const x = await loom(); return /moons/i.test(x.text) && /Jupiter|Mars|Saturn|Earth/.test(x.text) && x }, 90_000)
    check('a prompt typed into the real TUI shows its reply on the canvas', !!replied)
    await idle()
    await wait(2500)
    const hasTable = await ev(`!!document.querySelector('.loom.is-on .loom-say table')`)
    const hasDiagram = await ev(`!!document.querySelector('.loom.is-on .loom-diagram')`)
    check('the reply is formatted: a table and a diagram on the canvas', hasTable && hasDiagram, `table=${hasTable} diagram=${hasDiagram}`)
    await rules(tab, 'after a reply')
    console.log('shot', await shot('1-rest-reply'))

    // ---- /mcp, /model and the `/` list grow it; Esc shrinks it
    for (const cmd of ['/mcp', '/model']) {
      await focusTerm(tab)
      await typeText(cmd)
      await wait(400)
      await enter()
      const g = await grownFor()
      await dump(tab, cmd)
      check(`${cmd} grows the CLI`, !!g, g ? `rows=${g.rows} why=${g.why}` : `why=${(await cli()).why}`)
      // The picker draws a moment after the CLI has grown; its pointer is `❯` or `>`.
      const choices = !!(await until(async () => (await rowsHave(/^\s*[❯>]\s|^\s*\d+\.\s|Esc to|Enter to/i)) || null, 5000))
      check(`${cmd}: its picker is in the viewport rows`, choices)
      await rules(tab, `${cmd} open`)
      if (cmd === '/mcp') console.log('shot', await shot('2-grown-mcp'))
      await esc()
      const s = await shrunk()
      check(`Esc closes ${cmd} and the CLI shrinks back`, !!s, s ? `rows=${s.rows}` : JSON.stringify(await cli()))
      await wait(400)
    }
    await focusTerm(tab)
    await typeText('/')
    const gs = await grownFor()
    await dump(tab, '/ list')
    check('the `/` list grows the CLI', !!gs, gs ? `rows=${gs.rows} why=${gs.why}` : `why=${(await cli()).why}`)
    check('the `/` list is in the viewport rows', await rowsHave(/^\s*\/[a-z]/))
    await rules(tab, '`/` list open')
    await key('Backspace', 'Backspace', 8)
    check('the `/` list closed: the CLI shrinks back', !!(await shrunk()))

    // ---- a long multi-line prompt
    await focusTerm(tab)
    // Typed as the person would: each line ends in `\` and Enter, Claude Code's newline.
    for (let i = 1; i <= 16; i++) {
      await typeText(`line ${i} of a long prompt${i < 16 ? ' \\' : ''}`)
      if (i < 16) await enter()
    }
    const gl = await grownFor()
    l = await dump(tab, 'long prompt')
    check('a long multi-line prompt grows the CLI', !!gl, gl ? `rows=${gl.rows} need=${gl.need}` : `need=${l.cli.need} rows=${l.cli.rows}`)
    await wait(600)
    l = await loom()
    // Claude Code scrolls a prompt taller than about a third of its screen inside its box:
    // the CLI then takes all the tab can give, and the box, its last line and its rules are in view.
    const shown = l.rows.filter((r) => /line \d+ of a long prompt/.test(r)).length
    check('the long prompt: its box and its last line are in the viewport, as many lines as the TUI shows', l.rows.some((r) => /line 16 of a long prompt/.test(r)) && l.cli.prompt && shown >= 10, `lines shown=${shown} of 16, rows=${l.cli.rows}`)
    await rules(tab, 'long prompt')
    await key('c', 'KeyC', 67, 2)
    await wait(300)
    check('cleared (Ctrl+C): the CLI shrinks back', !!(await shrunk()))

    // ---- a permission prompt
    await focusTerm(tab)
    await typeText('Use your Bash or PowerShell tool to run exactly this command and nothing else: New-Item probe-hybrid.txt')
    await enter()
    const gp = await until(async () => { const x = await loom(); return x.cli.grown && x.rows.some((r) => /Do you want|❯\s*1\.|1\.\s*Yes/i.test(r)) && x }, 90_000)
    await dump(tab, 'permission')
    check("a permission prompt grows the CLI and shows Claude's own dialog", !!gp, gp ? `rows=${gp.cli.rows}` : '')
    await rules(tab, 'permission prompt')
    console.log('shot', await shot('3-grown-permission'))
    await focusTerm(tab)
    await typeText('1')
    await wait(500)
    if (!existsSync(PROBE_FILE) && (await rowsHave(/Do you want/))) await enter()
    const done = await until(async () => existsSync(PROBE_FILE), 30_000)
    check('answering "1" runs it', !!done)
    await idle()
    check('the dialog gone: the CLI shrinks back', !!(await shrunk(10_000)))

    // ---- three messages queued mid-turn
    await focusTerm(tab)
    await typeText('Write a numbered list of 25 interesting facts about the ocean, one sentence each. No tools.')
    await enter()
    await until(async () => !!(await cli()).live, 30_000, 150)
    for (const n of [1, 2, 3]) {
      await typeText(`queued message number ${n}`)
      await enter()
      await wait(350)
    }
    await wait(1200)
    l = await dump(tab, 'queued')
    const queuedShown = [1, 2, 3].every((n) => l.rows.some((r) => r.includes(`queued message number ${n}`)))
    check('three queued messages and the prompt are all in the viewport', queuedShown && l.cli.prompt, `need=${l.cli.need} rows=${l.cli.rows} live=${!!l.cli.live}`)
    await rules(tab, 'queued messages')
    console.log('shot', await shot('4-queued'))
    await idle(180_000)
    await wait(1000)

    // ---- a picture pasted with Ctrl+V: the TUI's [Image #1], its thumbnail above the divider
    const clip = await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 96
      const x = c.getContext('2d'); x.fillStyle = '#e01010'; x.fillRect(0, 0, 96, 96)
      const b = await new Promise((r) => c.toBlob(r, 'image/png'))
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); return true } catch (e) { return String(e) }
    })()`)
    if (clip !== true) console.log('  clipboard:', clip)
    await focusTerm(tab)
    await key('v', 'KeyV', 86, 2)
    const marked = await until(async () => { const x = await loom(); return x.cli.pasted.includes('Image #1') && x.rows.some((r) => /\[Image #1\]/.test(r)) && x }, 15_000)
    check('Ctrl+V with a picture: the TUI shows [Image #1] and the canvas its thumbnail, labelled "Image #1"', !!marked, JSON.stringify((await cli()).pasted))
    const strip = await ev(`(() => { const s = document.querySelector('.loom.is-on .loom-pasted.is-on'); const d = document.querySelector('.loom-divider.is-on'); if (!s || !d) return null; return { bottom: s.getBoundingClientRect().bottom, divider: d.getBoundingClientRect().top } })()`)
    check('the thumbnail sits above the divider, never over the CLI', !!strip && strip.bottom <= strip.divider + 0.5, JSON.stringify(strip))
    await rules(tab, 'with a picture attached')
    console.log('shot', await shot('4b-pasted-image'))
    await focusTerm(tab)
    await typeText(' What colour is this picture? Answer with one word.')
    await enter()
    const red = await until(async () => { const x = await loom(); return /\bred\b/i.test(x.text.split(/What colour is this picture/).pop() ?? '') && x }, 90_000)
    const inTurn = await ev(`!!document.querySelector('.loom.is-on .loom-ask .loom-thumb')`)
    check('sent: the turn on the canvas carries the picture, and Claude says red', !!red && inTurn, `thumbInTurn=${inTurn}`)
    check('the thumbnail above the divider is gone once sent', ((await cli()).pasted ?? []).length === 0)
    await idle()
    console.log('shot', await shot('4c-image-in-turn'))

    // ---- the divider
    const before = await cli()
    const drect = await ev(`(() => { const r = document.querySelector('.loom-divider.is-on').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    const drag = async (dy) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drect.x, y: drect.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drect.x, y: drect.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drect.x, y: drect.y + (dy * i) / 8, button: 'left', buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drect.x, y: drect.y + dy, button: 'left', clickCount: 1 })
      await wait(900)
    }
    await drag(-160)
    let after = await cli()
    l = await loom()
    check('dragging the divider up gives the CLI more rows and resizes the PTY', after.rows > before.rows + 4 && after.pty.rows === after.rows, `${before.rows} → ${after.rows} (pty ${after.pty.rows})`)
    check('the TUI redrew at the new size (its prompt in view)', l.cli.prompt)
    await rules(tab, 'after a drag')
    const remembered = await ev(`localStorage.getItem('ember.cliRows')`)
    check('the size is remembered', Number(remembered) === after.userRows, `stored=${remembered}`)
    // Down past the bottom: it stops at its minimum.
    const drect2 = await ev(`(() => { const r = document.querySelector('.loom-divider.is-on').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    Object.assign(drect, drect2)
    await drag(700)
    after = await cli()
    check('the divider stops at the minimum (10 rows)', after.rows === 10, `rows=${after.rows}`)
    await rules(tab, 'at the minimum')
    await ev(`document.querySelector('.loom-divider.is-on').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await wait(900)
    after = await cli()
    check('double-click resets the CLI to 15 rows', after.rows === 15, `rows=${after.rows}`)

    // ---- Ctrl+` : the whole tab and back
    await focusTerm(tab)
    await switchKey()
    await wait(900)
    l = await loom()
    check('Ctrl+` gives the CLI the whole tab', l.raw && !l.cli.canvasOn && l.cli.paneTop === 0 && l.cli.rows > 30 && l.cli.pty.rows === l.cli.rows, `rows=${l.cli.rows}`)
    console.log('shot', await shot('5-full-cli'))
    await switchKey()
    await wait(900)
    l = await loom()
    check('Ctrl+` again: canvas above, CLI below at its height', !l.raw && l.cli.canvasOn && l.cli.rows === 15 && l.cli.focusInTerm, `rows=${l.cli.rows}`)
    await rules(tab, 'back from the full CLI')

    // ---- the canvas still does its things
    const canvas = await ev(`(async () => {
      const out = {}
      const loom = document.querySelector('.loom.is-on')
      // right-click on the reply: the menu, inside the canvas
      const say = loom.querySelector('.loom-say')
      const r = say.getBoundingClientRect()
      say.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
      await new Promise((res) => setTimeout(res, 300))
      const menu = document.querySelector('.loom-menu.is-on')
      out.menu = !!menu
      if (menu) {
        const mr = menu.getBoundingClientRect(), lr = loom.getBoundingClientRect()
        out.menuInside = mr.bottom <= lr.bottom + 1
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return out
    })()`)
    check('right-click on a reply opens the canvas menu, inside the canvas', canvas.menu && canvas.menuInside !== false, JSON.stringify(canvas))
    await esc()
    // a panel push from Ember's MCP tool (show_panel), asked of the real session
    await focusTerm(tab)
    await typeText("Call the ember-panel MCP tool show_panel once with format markdown, title 'Probe push' and content 'From the panel tool.' Then reply OK.")
    await enter()
    const asking = (x) => x.rows.some((r) => /Do you want|❯\s*1\./.test(r))
    const canvasHas = () => ev(`(document.querySelector('.loom.is-on')?.innerText ?? '').includes('From the panel tool')`)
    for (let i = 0; i < 6; i++) {
      const p = await until(async () => { const x = await loom(); return (asking(x) || (await canvasHas())) && x }, 60_000)
      if (!p || !asking(p)) break
      await focusTerm(tab)
      await typeText('1')
      await wait(1500)
    }
    const pushed = await until(canvasHas, 30_000)
    check('a panel push from the MCP tool (show_panel) appears on the canvas', !!pushed)
    if (!pushed) await dump(tab, 'push failed')
    // Any further approval the turn asks for is answered, as the person would, until it ends.
    await until(async () => {
      const x = await loom()
      if (asking(x)) {
        await focusTerm(tab)
        await typeText('1')
        return null
      }
      return x.cli.prompt && !x.cli.live && !x.cli.grown ? x : null
    }, 90_000, 800)
    await rules(tab, 'with a pushed panel')

    // ---- a reply with questions: the deck's Send types into the TUI
    await focusTerm(tab)
    await typeText("Reply with exactly these three lines and nothing else: 'Questions:' then '1. Which colour do you like? A, red; B, blue; or C, green.' then '2. Which animal do you like? A, cat; B, dog; or C, fox.' No tools.")
    await enter()
    const deck = await until(async () => (await ev(`!!document.querySelector('.loom.is-on .loom-answers:not(.is-stale) .loom-qd')`)), 90_000)
    check("a reply's questions get the deck", !!deck)
    await idle()
    const turnsBefore = (await loom()).says
    if (!deck) {
      console.log('  canvas said:', ((await loom()).text ?? '').slice(-400))
      await dump(tab, 'no deck')
    }
    if (deck) {
      // Pick A for each question (picking moves on), then Submit on the review: real clicks.
      const live = `document.querySelector('.loom.is-on .loom-answers:not(.is-stale)')`
      const click = async (sel) => {
        const at = await ev(`(() => { const e = [...${live}.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
        if (!at) return false
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
        await wait(350)
        return true
      }
      await click('.loom-qd-opt[data-o="0"]')
      await click('.loom-qd-opt[data-o="0"]')
      await click('.loom-qd-btn.is-primary')
      const sent = await until(async () => { const x = await loom(); return x.says > turnsBefore && x }, 30_000)
      const focus = (await cli()).focusInTerm
      check("the deck's Send typed the answer into the TUI (a new turn), the keyboard back in the terminal", !!sent && focus, `says ${turnsBefore}→${(await loom()).says} focus=${focus}`)
      await idle()
    }

    // ---- the session's name on its card (/rename, typed in the TUI)
    await focusTerm(tab)
    await typeText('/rename Hybrid probe')
    await enter()
    await wait(1500)
    await focusTerm(tab)
    await typeText('Reply with the single word: named. No tools.')
    await enter()
    const named = await until(async () => /Hybrid probe/.test(await ev(`window.__ember.card(${JSON.stringify(tab)})`)), 60_000)
    check("/rename: the session's name shows on the tab's card", !!named, JSON.stringify(await ev(`window.__ember.card(${JSON.stringify(tab)})`)))
    await idle()

    // ---- /clear starts the canvas over
    await focusTerm(tab)
    await typeText('/clear')
    await wait(300)
    await enter()
    const cleared = await until(async () => { const x = await loom(); return x.says === 0 && x }, 20_000)
    check('/clear typed in the TUI starts the canvas over', !!cleared, `says=${(await loom()).says}`)

    // ---- /exit
    await focusTerm(tab)
    await typeText('/exit')
    await wait(300)
    await enter()
    const shell = await until(async () => { const x = await loom(); return x.mode === 'shell' && x }, 20_000)
    check('/exit gives the tab back to a plain shell, the terminal the whole tab', !!shell && shell.cli.paneTop === 0 && !shell.cli.canvasOn)
    rmSync(PROBE_FILE, { force: true })
  }

  // ================================================================== subagent pills (fed, no model)
  if (ONLY !== 'codex') {
    const t2 = await newTab()
    await wait(1200)
    await ev(`window.__ember.loomFeed(${JSON.stringify(t2)}, [
      { type: 'user', uuid: 'su1', timestamp: '2026-11-05T09:00:00Z', message: { role: 'user', content: 'look into it' } },
      { type: 'assistant', uuid: 'sa1', timestamp: '2026-11-05T09:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'Survey the repo', subagent_type: 'Explore', prompt: 'x' } }] } },
    ])`)
    await wait(600)
    const pill = await ev(`!!document.querySelector('.loom-agent[data-state="running"]')`)
    check('a subagent shows as a pill on the canvas', pill)
    await ev(`window.__ember.closeTab(${JSON.stringify(t2)})`)
  }

  // ================================================================== Codex
  if (args.includes('--codex') || ONLY === 'codex') {
    const tab = await newTab()
    const loom = () => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
    const cli = async () => (await loom())?.cli
    await until(async () => (await loom())?.rows?.some((r) => /PS .*>/.test(r)), 20_000)
    await focusTerm(tab)
    await typeText('codex')
    await enter()
    const on = await until(async () => { const x = await loom(); return x.mode === 'claude' && x }, 30_000)
    check('`codex` splits the tab too', !!on && on.cli.canvasOn && on.cli.paneTop > 100)
    // Codex may open on a dialog of its own (trust, update): it is shown grown, answered as the person would.
    for (let i = 0; i < 6; i++) {
      await wait(2500)
      const x = await dump(tab, `codex start ${i}`)
      if (x.cli.prompt && !x.cli.grown) break
      if (x.cli.grown) {
        await rules(tab, `codex dialog (${x.cli.why})`)
        await focusTerm(tab)
        // Codex's own startup screens, answered as the person would: a hook to review is
        // skipped (Esc), anything else takes its first choice (Enter).
        if (x.rows.some((r) => /hook/i.test(r))) await esc()
        else await enter()
      }
    }
    let x = await dump(tab, 'codex idle')
    check("Codex's prompt is in view at the CLI's height", x.cli.prompt && !x.cli.grown, `why=${x.cli.why} rows=${x.cli.rows}`)
    await rules(tab, 'codex at rest')
    await focusTerm(tab)
    await typeText('/')
    const g = await until(async () => ((await cli()).grown ? await cli() : null), 8000)
    await dump(tab, 'codex /')
    check("Codex's `/` list grows the CLI", !!g, g ? `rows=${g.rows}` : '')
    await rules(tab, 'codex `/` list')
    await key('Backspace', 'Backspace', 8)
    check("…and shrinks back", !!(await until(async () => (!(await cli()).grown ? true : null), 8000)))
    await focusTerm(tab)
    await typeText('Reply with a markdown table of two fruits and their colours. Do not run any command.')
    await enter()
    const r = await until(async () => { const y = await loom(); return /colou?r/i.test(y.text) && /apple|banana|orange|cherry|grape|lemon/i.test(y.text) && y }, 120_000)
    check("Codex's reply shows on the canvas", !!r)
    await until(async () => { const c = await cli(); return c.prompt && !c.live ? c : null }, 60_000)
    await wait(1500)
    await rules(tab, 'codex after a reply')
    console.log('shot', await shot('6-codex'))
    await focusTerm(tab)
    await key('c', 'KeyC', 67, 2)
    await wait(400)
    await key('c', 'KeyC', 67, 2)
    const back = await until(async () => { const y = await loom(); return y.mode === 'shell' && y }, 20_000)
    check('Codex exits (Ctrl+C twice): a plain shell again', !!back && back.cli.paneTop === 0)
  }
} catch (err) {
  failed++
  console.log('FAIL  probe threw', err?.stack ?? err)
} finally {
  ws?.close()
  kill()
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failed ? 1 : 0)
