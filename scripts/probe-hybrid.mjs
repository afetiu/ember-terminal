/**
 * The tight CLI: the canvas above, the agent's REAL CLI below, the CLI's box exactly as tall
 * as the TUI's own bottom area (docs/specs/hybrid.md), with the real `claude --model haiku`
 * in ~/agent-box and, with --codex, the real `codex`.
 *
 * Every step checks the hard rules, read from the live page:
 *   - the PTY's size is the terminal's (term rows/cols = what was sent to the PTY), and the
 *     rows fill the bottom box exactly (no row below the visible area, none missing);
 *   - nothing is cut, masked or transformed: no transform / clip-path / mask on the pane or
 *     its xterm, and document.elementsFromPoint over the whole terminal rect finds only the
 *     terminal (no canvas element, seam, menu or piece over it);
 *   - the box holds only the bottom area: at most one row above it, none of the
 *     conversation's words in it.
 * Each transition (a turn, `/`, /mcp, /model, a permission prompt, queued messages, a long
 * prompt, and each going away) is sampled every animation frame: no more than one frame in
 * a row may lack the prompt line or the dialog's keys. The worst case is printed at the end,
 * with how long the box took to grow.
 *
 * Keys go into the terminal as the person would type them (CDP key events into xterm).
 *
 *   npm run build; node scripts/probe-hybrid.mjs [--codex] [--only=claude|codex|pills] [--verbose] [out-dir]
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
const PORT = Number(process.env.PROBE_PORT) || 9582
const CWD = join(homedir(), 'agent-box')
const PROBE_FILE = join(CWD, 'probe-tight.txt')
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

  const loom = (tab) => ev(`window.__ember.loom(${JSON.stringify(tab)})`)
  /** How long the box took to grow, per transition, for the summary. */
  const growth = []
  const dump = async (tab, label) => {
    const l = await loom(tab)
    if (VERBOSE) console.log(`---- ${label} (rows=${l.cli.rows} dock=${l.cli.dock} cut=${l.cli.cut} grown=${l.cli.grown} why=${l.cli.why} want=${l.cli.wantRows})\n${l.rows.map((r, i) => `${String(i).padStart(2)}|${r}`).join('\n')}`)
    return l
  }

  const focusTerm = (tab) => ev(`(() => { const l = window.__ember.loom(${JSON.stringify(tab)}); document.querySelector('[data-session-id="' + l.sessionId + '"] .xterm-helper-textarea').focus() })()`)
  const writePty = (tab, data) => ev(`window.ember.write(window.__ember.loom(${JSON.stringify(tab)}).sessionId, ${JSON.stringify(data)})`)

  // ------------------------------------------------------------------ every frame of a transition

  /**
   * Sample the terminal every animation frame while `fn` runs: is the prompt line (`❯` with
   * the box's rule after it, Codex's `›`) or a dialog's key line ("Esc to cancel"…) on screen?
   * A transition passes when no run of frames without either is longer than one frame.
   */
  const SAMPLER = `(() => {
    if (window.__tight) return true
    const RULE = /^\\s*[─━]{20,}\\s*$/
    const FOOT = /Esc to (?:cancel|close|exit|go back)|Enter to (?:confirm|set|select|continue)|enter to (?:confirm|continue|select)|esc to (?:cancel|close|skip)|Press enter to confirm|ctrl\\+x ctrl\\+s to send now/i
    const T = { on: false, frames: [] }
    T.start = (sid, agent) => {
      const term = window.__ember.term(sid)
      T.frames = []
      T.on = true
      const tick = () => {
        if (!T.on) return
        const b = term.buffer.active
        const rows = []
        for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
        let line = false
        if (agent === 'codex') line = rows.some((r) => /^›(?:\\s|$)/.test(r))
        else
          for (let y = 0; y < rows.length && !line; y++) {
            if (!/^❯/.test(rows[y])) continue
            let e = y + 1
            while (e < rows.length && /^\\s{2}\\S|^\\s*$/.test(rows[e]) && !RULE.test(rows[e])) e++
            line = e < rows.length && RULE.test(rows[e])
          }
        const foot = rows.some((r) => FOOT.test(r))
        // The TUI drawing nothing under its last line, with rows to spare (Claude Code between
        // closing the box and drawing /mcp's dialog): its own empty frame, not one cut short.
        let blank = 0
        for (let y = rows.length - 1; y >= 0 && !rows[y].trim(); y--) blank++
        const empty = !line && !foot && blank >= 3
        T.frames.push({ t: performance.now(), rows: term.rows, ok: line || foot || empty, empty, text: rows })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return true
    }
    T.stop = () => {
      T.on = false
      let run = 0, worst = 0, at = -1, bad = 0
      T.frames.forEach((f, i) => {
        if (f.ok) run = 0
        else { run++; bad++; if (run > worst) { worst = run; at = i } }
      })
      return { frames: T.frames.length, bad, worst, empty: T.frames.filter((f) => f.empty).length, sizes: [...new Set(T.frames.map((f) => f.rows))], worstText: at >= 0 ? T.frames[at].text : null }
    }
    T.first = (src) => { const re = new RegExp(src); const f = T.frames.find((f) => f.text.some((r) => re.test(r))); return f ? f.t : null }
    window.__tight = T
    return true
  })()`
  /** From the first frame that drew `src` to the first growth after it, in ms (page clock). */
  const drawnToGrown = async (tab, src, since) => {
    const at = await ev(`window.__tight.first(${JSON.stringify(src)})`)
    const sizes = ((await loom(tab)).cli.sizes ?? []).filter((s) => s.t >= since && s.to > s.from)
    if (at == null) return null
    const g = sizes.find((s) => s.t >= at - 1) ?? sizes[sizes.length - 1]
    return g ? Math.max(0, g.t - at) : null
  }
  const worstFrames = []
  globalThis.__summary = () => {
    console.log('\nframes: worst run without the prompt or the dialog keys, per transition')
    for (const w of worstFrames) console.log(`  ${String(w.worst).padStart(2)}  ${w.label}  (${w.frames} frames, heights ${w.sizes.join('→')})`)
    console.log(`  worst overall: ${Math.max(0, ...worstFrames.map((w) => w.worst))} frame(s)`)
    console.log('growth: from the key (or the dialog) to the box grown')
    for (const g of growth) console.log(`  ${g.ms == null ? '   -' : `${Math.round(g.ms)} ms`.padStart(6)}  ${g.what}${g.note ? `  (${g.note})` : ''}`)
  }
  /** Run `fn` with every frame sampled; check that at most one frame in a row lacked the prompt or a dialog's keys. */
  // Codex clears its viewport when the screen's height changes and draws it again on its next
  // frame (~30 ms): one frame more is allowed there.
  const sampled = async (tab, label, fn, agent = 'claude', allow = agent === 'codex' ? 2 : 1) => {
    await ev(SAMPLER)
    await ev(`window.__tight.start(window.__ember.loom(${JSON.stringify(tab)}).sessionId, ${JSON.stringify(agent)})`)
    const t0 = Date.now()
    let out
    try {
      out = await fn()
    } finally {
      const s = await ev(`window.__tight.stop()`)
      worstFrames.push({ label, worst: s.worst, frames: s.frames, sizes: s.sizes })
      check(`${label}: every frame shows the prompt or the dialog's keys (worst ${s.worst} frame${s.worst === 1 ? '' : 's'} without)`, s.worst <= allow, `${s.frames} frames over ${Date.now() - t0} ms, heights ${s.sizes.join('→')}${s.empty ? `, ${s.empty} frame(s) the TUI drew nothing under its last line` : ''}`)
      if (s.worst > 1 && VERBOSE) console.log(s.worstText.map((r, i) => `   ${String(i).padStart(2)}|${r}`).join('\n'))
    }
    return out
  }

  /**
   * The CLI's box holds only the TUI's bottom area: at most SPARE rows above it, and none of
   * the conversation's words (`words`: what was asked, what was replied) in more than that.
   */
  const onlyDock = async (tab, where, words = []) => {
    await wait(500)
    const l = await loom(tab)
    const c = l.cli
    const above = c.rows - c.dock
    const hits = l.rows.filter((r) => words.some((w) => w && r.includes(w)))
    check(`${where}: the CLI box holds only the bottom area (≤1 row above it, no conversation)`, c.dock > 0 && above <= 1 && hits.length <= 1 && !c.cut, `rows=${c.rows} dock=${c.dock} above=${above} why=${c.why || '-'}${hits.length ? ` conversation=${JSON.stringify(hits.slice(0, 2))}` : ''}`)
    return l
  }

  // ================================================================== Claude Code
  if (ONLY !== 'codex' && ONLY !== 'pills') {
    const tab = await newTab()
    await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
    await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
    const lm = () => loom(tab)
    const cli = async () => (await lm())?.cli
    const rowsHave = async (re) => (await lm()).rows.some((r) => re.test(r))
    const sizesSince = async (t) => ((await cli()).sizes ?? []).filter((s) => s.t >= t)
    const pageNow = () => ev('performance.now()')
    const grownFor = (ms = 8000) => until(async () => ((await cli()).grown ? await cli() : null), ms)
    /** Back to the idle prompt's own height: plain, not grown, nothing pending. */
    const shrunk = (ms = 8000) => until(async () => { const c = await cli(); return c.prompt && !c.grown && !c.cut && c.rows === c.wantRows && c.rows <= c.idleRows + 1 ? c : null }, ms)
    /** The height has stopped changing: the same for `quiet` ms, as the screen asks. */
    const steady = async (quiet = 800, ms = 10_000) => {
      let last = null
      let since = Date.now()
      return until(async () => {
        const c = await cli()
        const k = `${c.rows}|${c.wantRows}|${c.dock}`
        if (k !== last) {
          last = k
          since = Date.now()
        }
        return c.rows === c.wantRows && !c.cut && Date.now() - since >= quiet ? c : null
      }, ms, 100)
    }
    const idle = (ms = 90_000) => until(async () => { const c = await cli(); return c.prompt && !c.live && !c.grown ? c : null }, ms, 300)

    await until(async () => (await lm())?.rows?.some((r) => /PS .*>|agent-box/.test(r)), 20_000)
    let l = await lm()
    check('a new tab is a plain shell', l.mode === 'shell' && !l.claude && l.cli.paneTop === 0, `mode=${l.mode}`)
    await focusTerm(tab)
    await typeText('claude --model haiku --permission-mode default')
    await enter()
    const up = await until(async () => { const x = await lm(); return x.mode === 'claude' && x.cli.promptSeen && x }, 60_000)
    check('`claude` splits the tab: canvas above, the real CLI below', !!up && up.cli.canvasOn && up.cli.paneTop > 100, up ? `paneTop=${up.cli.paneTop} rows=${up.cli.rows}` : 'no prompt')
    await shrunk(10_000)
    l = await dump(tab, 'idle')
    check('at rest the CLI is its bottom area: the prompt box and footer (≤ 8 rows)', l.cli.prompt && !l.cli.grown && l.cli.rows <= 8 && l.cli.rows === l.cli.dock + 1, `rows=${l.cli.rows} dock=${l.cli.dock}`)
    check('the keyboard is in the terminal', l.cli.focusInTerm)
    check('no divider to drag: the seam is not a control', await ev(`(() => { const d = document.querySelector('.loom-divider.is-on'); return !!d && getComputedStyle(d).pointerEvents === 'none' && !d.querySelector('.loom-divider-grip') })()`))
    await rules(tab, 'at rest')
    await onlyDock(tab, 'at rest')

    // ---- a reply with a table and a diagram, typed into the real prompt
    const ASK1 = 'Reply with exactly: a one-line intro, a markdown table of 3 planets with their number of moons'
    await focusTerm(tab)
    await sampled(tab, 'a turn (working line in, reply, working line out)', async () => {
      await typeText(`${ASK1}, then a \`\`\`mermaid fenced flowchart LR with A-->B-->C. No tools.`)
      await enter()
      const replied = await until(async () => { const x = await lm(); return /moons/i.test(x.text) && /Jupiter|Mars|Saturn|Earth/.test(x.text) && x }, 90_000)
      check('a prompt typed into the real TUI shows its reply on the canvas', !!replied)
      await idle()
      await shrunk()
    })
    await wait(1500)
    const hasTable = await ev(`!!document.querySelector('.loom.is-on .loom-say table')`)
    const hasDiagram = await ev(`!!document.querySelector('.loom.is-on .loom-diagram')`)
    check('the reply is formatted: a table and a diagram on the canvas', hasTable && hasDiagram, `table=${hasTable} diagram=${hasDiagram}`)
    await rules(tab, 'after a reply')
    await onlyDock(tab, 'after a reply', ['one-line intro', 'Jupiter', 'Saturn', 'moons', 'Mars'])
    console.log('shot', await shot('1-rest'))

    // ---- the `/` list: typed as a key (the pre-grow), and pasted (no key: measured only)
    const slashOk = async (where) => {
      const x = await lm()
      // (Claude Code puts a no-break space after its `❯`.)
      const at = x.rows.findIndex((r) => /^❯\s*\//.test(r))
      const items = x.rows.filter((r) => /^\s+(?:❯\s*)?\/[\w:.-]+\s{2,}\S/.test(r)).length
      // All its rows on screen: the box's top rule above the prompt line, the list under the
      // box, and nothing of it cut at the bottom (the last row is the TUI's own blank).
      const whole = at >= 1 && /^\s*─{20,}/.test(x.rows[at - 1]) && items >= 2
      check(`${where}: the list is fully visible with the prompt line`, whole && x.cli.why.startsWith('slash menu') && !x.cli.cut, `items=${items} rows=${x.cli.rows} dock=${x.cli.dock} why=${x.cli.why}`)
      return x
    }
    await focusTerm(tab)
    const t0 = await pageNow()
    await sampled(tab, '`/` typed', async () => {
      await key('/', 'Slash', 191, 0, '/')
      await until(async () => (await cli()).why.startsWith('slash menu') || null, 5000, 50)
      await steady()
    })
    const pre = (await sizesSince(t0))[0]
    check('`/` grows the CLI on the key itself, before the TUI draws the list', !!pre && pre.why === 'pre-grown', JSON.stringify(pre))
    if (pre) growth.push({ what: '`/` key → box grown', ms: pre.t - t0 })
    await slashOk('`/` typed')
    await onlyDock(tab, '`/` list', [ASK1.slice(0, 30), 'Jupiter'])
    await rules(tab, '`/` list open')
    console.log('shot', await shot('2-slash'))
    await sampled(tab, '`/` list closed (Backspace)', async () => {
      await key('Backspace', 'Backspace', 8)
      check('the `/` list closed: the CLI shrinks back', !!(await shrunk()))
    })
    // Pasted, there is no key to grow on: the measure alone (the list outgrows the box, its
    // top scrolls up, the CLI grows by what scrolled and redraws).
    const t1 = await pageNow()
    await sampled(tab, '`/` pasted', async () => {
      await typeText('/')
      await until(async () => { const c = await cli(); return (c.why.startsWith('slash menu') && !c.cut && c.rows === c.wantRows) || null }, 5000, 50)
      await steady()
    })
    growth.push({ what: '`/` pasted: list first drawn → box grown', ms: await drawnToGrown(tab, '^\\s+(?:❯\\s*)?/[a-z]', t1) })
    await slashOk('`/` pasted')
    await key('Backspace', 'Backspace', 8)
    await shrunk()

    // ---- /mcp and /model: the picker, its title to its footer, and nothing above it
    for (const cmd of ['/mcp', '/model']) {
      await focusTerm(tab)
      await typeText(cmd)
      await wait(500)
      const t = await pageNow()
      await sampled(tab, `${cmd} opened`, async () => {
        await enter()
        await until(async () => { const c = await cli(); return (c.why.startsWith('dialog') && !c.cut && c.rows === c.wantRows && (await rowsHave(/Esc to cancel/))) || null }, 10_000, 50)
        await steady()
      })
      const g = await drawnToGrown(tab, 'Esc to cancel', t)
      growth.push({ what: `${cmd}: picker first drawn → box grown`, ms: g })
      const x = await dump(tab, cmd)
      const title = cmd === '/mcp' ? /Manage MCP servers/ : /Select model/
      check(`${cmd}: the picker is all on screen, its title to its footer ("Esc to cancel")`, x.rows.some((r) => title.test(r)) && x.rows.some((r) => /Esc to cancel/.test(r)) && x.rows.some((r) => /^\s*❯/.test(r)), `rows=${x.cli.rows} dock=${x.cli.dock}`)
      await onlyDock(tab, `${cmd} open`, [ASK1.slice(0, 30), 'Jupiter'])
      await rules(tab, `${cmd} open`)
      if (cmd === '/mcp') console.log('shot', await shot('2b-mcp'))
      await sampled(tab, `${cmd} closed (Esc)`, async () => {
        await esc()
        const s = await shrunk()
        check(`Esc closes ${cmd} and the CLI shrinks back`, !!s, s ? `rows=${s.rows}` : JSON.stringify(await cli()))
      })
      await wait(400)
    }

    // ---- a prompt of six lines (each ends in `\` and Enter, Claude Code's newline)
    await focusTerm(tab)
    await sampled(tab, 'a six-line prompt typed', async () => {
      for (let i = 1; i <= 6; i++) {
        await typeText(`line ${i} of a six line prompt${i < 6 ? ' \\' : ''}`)
        if (i < 6) await enter()
      }
      await until(async () => { const c = await cli(); return (c.rows === c.wantRows && !c.cut && (await rowsHave(/line 6 of a six/))) || null }, 5000, 50)
      await steady()
    })
    l = await dump(tab, 'six lines')
    const six = [1, 2, 3, 4, 5, 6].every((n) => l.rows.some((r) => r.includes(`line ${n} of a six line prompt`)))
    check('the six-line prompt: all six lines, the box and its footer are in the CLI', six && l.cli.prompt, `rows=${l.cli.rows} dock=${l.cli.dock}`)
    await onlyDock(tab, 'six-line prompt', [ASK1.slice(0, 30), 'Jupiter'])
    await rules(tab, 'six-line prompt')
    await sampled(tab, 'six-line prompt cleared (Ctrl+C)', async () => {
      await key('c', 'KeyC', 67, 2)
      check('cleared (Ctrl+C): the CLI shrinks back', !!(await shrunk()))
    })

    // ---- a permission prompt for a tool call
    rmSync(PROBE_FILE, { force: true })
    await focusTerm(tab)
    const ASK2 = 'Use your Bash or PowerShell tool to run exactly this command and nothing else: New-Item probe-tight.txt'
    let gp = null
    const tp = await pageNow()
    await sampled(tab, 'the permission prompt opening', async () => {
      await typeText(ASK2)
      await enter()
      gp = await until(async () => { const x = await lm(); return x.cli.why.startsWith('dialog') && !x.cli.cut && x.cli.rows === x.cli.wantRows && x.rows.some((r) => /Esc to cancel/.test(r)) && x }, 90_000, 100)
      await steady()
    })
    growth.push({ what: 'permission prompt first drawn → box grown', ms: await drawnToGrown(tab, 'Do you want to proceed|Esc to cancel', tp) })
    l = await dump(tab, 'permission')
    const choices = l.rows.some((r) => /Do you want to proceed/.test(r)) && l.rows.some((r) => /1\.\s*Yes/.test(r)) && l.rows.some((r) => /\d\.\s*No\b/.test(r)) && l.rows.some((r) => /Esc to cancel/.test(r))
    check("a permission prompt: Claude's own dialog, all its choices and keys in the CLI", !!gp && choices, `rows=${l.cli.rows} dock=${l.cli.dock}`)
    await onlyDock(tab, 'permission prompt', [ASK1.slice(0, 30), 'Jupiter', ASK2.slice(0, 40)])
    await rules(tab, 'permission prompt')
    console.log('shot', await shot('3-permission'))
    // The tool call is on the canvas while it waits on you.
    const toolOnCanvas = await ev(`[...document.querySelectorAll('.loom.is-on .loom-turn.is-shown .loom-tool')].some((t) => t.checkVisibility() && /New-Item probe-tight/.test(t.innerText))`)
    check('the tool call is on the canvas (the CLI box does not show it)', toolOnCanvas)
    await sampled(tab, 'the permission prompt answered ("1")', async () => {
      await focusTerm(tab)
      await typeText('1')
      await wait(500)
      if (!existsSync(PROBE_FILE) && (await rowsHave(/Do you want/))) await enter()
      check('answering "1" runs it', !!(await until(async () => existsSync(PROBE_FILE), 30_000)))
      await idle()
      check('the dialog gone: the CLI shrinks back', !!(await shrunk(10_000)))
    })
    await wait(1200)
    await onlyDock(tab, 'after the tool turn', [ASK2.slice(0, 40), 'probe-tight.txt', 'New-Item'])
    const turnCanvas = await ev(`(() => { const t = document.querySelector('.loom.is-on .loom-turn.is-shown'); if (!t) return null; const vis = (s) => [...t.querySelectorAll(s)].filter((e) => e.checkVisibility()); return { ask: vis('.loom-ask').map((e) => e.innerText).join(' '), tools: vis('.loom-tool').map((e) => e.innerText.replace(/\\s+/g, ' ').trim()), say: vis('.loom-say.is-current').map((e) => e.innerText.slice(0, 80)) } })()`)
    check('the same turn on the canvas: your words, the tool call and the reply', !!turnCanvas && /New-Item probe-tight/.test(turnCanvas.ask) && turnCanvas.tools.some((t) => /New-Item probe-tight/.test(t)) && turnCanvas.say.length > 0, JSON.stringify(turnCanvas))
    console.log('shot', await shot('3b-canvas-tool-call'))

    // ---- three messages queued mid-turn
    await focusTerm(tab)
    await sampled(tab, 'three messages queued mid-turn', async () => {
      await typeText('Write a numbered list of 30 interesting facts about the ocean, one sentence each. No tools.')
      await enter()
      await until(async () => !!(await cli()).live, 30_000, 100)
      for (const n of [1, 2, 3]) {
        await typeText(`queued message number ${n}`)
        await enter()
        await wait(350)
      }
      await until(async () => { const x = await lm(); return ([1, 2, 3].every((n) => x.rows.some((r) => r.includes(`queued message number ${n}`))) && x.cli.rows === x.cli.wantRows && !x.cli.cut) || null }, 6000, 100)
      await steady(600, 4000)
    })
    l = await dump(tab, 'queued')
    const queuedShown = [1, 2, 3].every((n) => l.rows.some((r) => r.includes(`queued message number ${n}`)))
    check('three queued messages and the prompt are all in the CLI', queuedShown && l.cli.prompt, `rows=${l.cli.rows} dock=${l.cli.dock} live=${!!l.cli.live}`)
    if (l.cli.live) await onlyDock(tab, 'queued messages', ['interesting facts about the ocean'])
    await rules(tab, 'queued messages')
    console.log('shot', await shot('4-queued'))
    await sampled(tab, 'the turn and the queue running out', async () => {
      await idle(180_000)
      await shrunk(15_000)
    })
    await wait(1000)
    await onlyDock(tab, 'after the queue', ['facts about the ocean', 'queued message number'])

    // ---- a picture pasted with Ctrl+V: the TUI's [Image #1], its thumbnail above the CLI
    const clip = await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 96
      const x = c.getContext('2d'); x.fillStyle = '#e01010'; x.fillRect(0, 0, 96, 96)
      const b = await new Promise((r) => c.toBlob(r, 'image/png'))
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); return true } catch (e) { return String(e) }
    })()`)
    if (clip !== true) console.log('  clipboard:', clip)
    await focusTerm(tab)
    await key('v', 'KeyV', 86, 2)
    const marked = await until(async () => { const x = await lm(); return x.cli.pasted.includes('Image #1') && x.rows.some((r) => /\[Image #1\]/.test(r)) && x }, 15_000)
    check('Ctrl+V with a picture: the TUI shows [Image #1] and the canvas its thumbnail, labelled "Image #1"', !!marked, JSON.stringify((await cli()).pasted))
    const strip = await ev(`(() => { const s = document.querySelector('.loom.is-on .loom-pasted.is-on'); const d = document.querySelector('.loom-divider.is-on'); if (!s || !d) return null; return { bottom: s.getBoundingClientRect().bottom, divider: d.getBoundingClientRect().top } })()`)
    check('the thumbnail sits above the seam, never over the CLI', !!strip && strip.bottom <= strip.divider + 0.5, JSON.stringify(strip))
    await rules(tab, 'with a picture attached')
    await focusTerm(tab)
    await typeText(' What colour is this picture? Answer with one word.')
    await enter()
    const red = await until(async () => { const x = await lm(); return /\bred\b/i.test(x.text.split(/What colour is this picture/).pop() ?? '') && x }, 90_000)
    const inTurn = await ev(`!!document.querySelector('.loom.is-on .loom-ask .loom-thumb')`)
    check('sent: the turn on the canvas carries the picture, and Claude says red', !!red && inTurn, `thumbInTurn=${inTurn}`)
    check('the thumbnail above the CLI is gone once sent', ((await cli()).pasted ?? []).length === 0)
    await idle()

    // ---- Ctrl+` : the whole tab and back
    await focusTerm(tab)
    await switchKey()
    await wait(1200)
    l = await lm()
    check('Ctrl+` gives the CLI the whole tab', l.raw && !l.cli.canvasOn && l.cli.paneTop === 0 && l.cli.rows > 30 && l.cli.pty.rows === l.cli.rows, `rows=${l.cli.rows}`)
    console.log('shot', await shot('5-full-cli'))
    await switchKey()
    l = await until(async () => { const x = await lm(); return !x.raw && x.cli.canvasOn && x.cli.rows <= x.cli.idleRows + 1 && x }, 5000)
    check('Ctrl+` again: canvas above, the CLI its bottom area again', !!l && l.cli.focusInTerm, l ? `rows=${l.cli.rows}` : JSON.stringify(await cli()))
    await rules(tab, 'back from the full CLI')

    // ---- the canvas still does its things
    const canvas = await ev(`(async () => {
      const out = {}
      const loom = document.querySelector('.loom.is-on')
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
      const p = await until(async () => { const x = await lm(); return (asking(x) || (await canvasHas())) && x }, 60_000)
      if (!p || !asking(p)) break
      await focusTerm(tab)
      await typeText('1')
      await wait(1500)
    }
    const pushed = await until(canvasHas, 30_000)
    check('a panel push from the MCP tool (show_panel) appears on the canvas', !!pushed)
    if (!pushed) await dump(tab, 'push failed')
    await until(async () => {
      const x = await lm()
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
    const turnsBefore = (await lm()).says
    if (deck) {
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
      const sentT = await until(async () => { const x = await lm(); return x.says > turnsBefore && x }, 30_000)
      const focus = (await cli()).focusInTerm
      check("the deck's Send typed the answer into the TUI (a new turn), the keyboard back in the terminal", !!sentT && focus, `says ${turnsBefore}→${(await lm()).says} focus=${focus}`)
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
    const rawCmd = await ev(`/<command-name>|<local-command-stdout>/.test(document.querySelector('.loom.is-on')?.innerText ?? '')`)
    check('slash commands show as commands on the canvas, never as raw <command-name> tags', !rawCmd)

    // ---- /clear starts the canvas over
    await focusTerm(tab)
    await typeText('/clear')
    await wait(300)
    await enter()
    const cleared = await until(async () => { const x = await lm(); return x.says === 0 && x }, 20_000)
    check('/clear typed in the TUI starts the canvas over', !!cleared, `says=${(await lm()).says}`)

    // ---- /exit
    await focusTerm(tab)
    await typeText('/exit')
    await wait(300)
    await enter()
    const shell = await until(async () => { const x = await lm(); return x.mode === 'shell' && x }, 20_000)
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
    const lm = () => loom(tab)
    const cli = async () => (await lm())?.cli
    const settled = (ms = 8000) => until(async () => { const c = await cli(); return c.prompt && !c.grown && !c.cut && c.rows === c.wantRows ? c : null }, ms)
    await until(async () => (await lm())?.rows?.some((r) => /PS .*>|agent-box/.test(r)), 20_000)
    await focusTerm(tab)
    await typeText('codex')
    await enter()
    const on = await until(async () => { const x = await lm(); return x.mode === 'claude' && x }, 30_000)
    check('`codex` splits the tab too', !!on && on.cli.canvasOn && on.cli.paneTop > 100)
    // Codex may open on a dialog of its own (trust, update): shown whole, answered as the person would.
    for (let i = 0; i < 6; i++) {
      await wait(2500)
      const x = await dump(tab, `codex start ${i}`)
      if (x.cli.prompt && !x.cli.room) break
      if (x.cli.room) {
        await rules(tab, `codex dialog (${x.cli.why})`)
        await focusTerm(tab)
        if (x.rows.some((r) => /hook/i.test(r))) await esc()
        else await enter()
      }
    }
    await settled()
    let x = await dump(tab, 'codex idle')
    check("Codex at rest: the CLI is its prompt and footer (≤ 7 rows)", x.cli.prompt && !x.cli.grown && x.cli.rows <= 7, `why=${x.cli.why} rows=${x.cli.rows} dock=${x.cli.dock}`)
    await rules(tab, 'codex at rest')
    await onlyDock(tab, 'codex at rest')
    await focusTerm(tab)
    await sampled(tab, 'Codex `/` typed', async () => {
      await key('/', 'Slash', 191, 0, '/')
      await until(async () => { const c = await cli(); return (c.why === 'slash menu' && c.rows === c.wantRows) || null }, 6000, 50)
      await wait(1200)
    }, 'codex')
    x = await dump(tab, 'codex /')
    const items = x.rows.filter((r) => /^\s*(?:›\s*)?\/[\w-]+\s{2,}\S/.test(r)).length
    check("Codex's `/` list: fully visible above its prompt", x.cli.why === 'slash menu' && items >= 3 && x.cli.prompt && !x.cli.cut, `items=${items} rows=${x.cli.rows} dock=${x.cli.dock}`)
    await onlyDock(tab, 'codex `/` list')
    await rules(tab, 'codex `/` list')
    console.log('shot', await shot('6-codex-slash'))
    await sampled(tab, 'Codex `/` closed', async () => {
      await key('Backspace', 'Backspace', 8)
      check('…and shrinks back', !!(await settled()))
    }, 'codex')
    await focusTerm(tab)
    const ASK = 'Reply with a markdown table of two fruits and their colours. Do not run any command.'
    await sampled(tab, 'a Codex turn', async () => {
      await typeText(ASK)
      await enter()
      const r = await until(async () => { const y = await lm(); return /colou?r/i.test(y.text) && /apple|banana|orange|cherry|grape|lemon/i.test(y.text) && y }, 120_000)
      check("Codex's reply shows on the canvas", !!r)
      await until(async () => { const c = await cli(); return c.prompt && !c.live ? c : null }, 60_000)
      await settled(10_000)
    }, 'codex')
    await wait(1500)
    await rules(tab, 'codex after a reply')
    await onlyDock(tab, 'codex after a reply', [ASK.slice(0, 30), 'Apple', 'Banana', '| '])
    console.log('shot', await shot('6b-codex-reply'))
    await focusTerm(tab)
    await key('c', 'KeyC', 67, 2)
    await wait(400)
    await key('c', 'KeyC', 67, 2)
    const back = await until(async () => { const y = await lm(); return y.mode === 'shell' && y }, 20_000)
    check('Codex exits (Ctrl+C twice): a plain shell again', !!back && back.cli.paneTop === 0)
  }
} catch (err) {
  failed++
  console.log('FAIL  probe threw', err?.stack ?? err)
} finally {
  ws?.close()
  kill()
}
if (typeof globalThis.__summary === 'function') globalThis.__summary()
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`)
process.exit(failed ? 1 : 0)
