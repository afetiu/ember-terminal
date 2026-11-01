// The demo in the hero: Ember's window, rebuilt in HTML, playing one piece of real work
// from start to finish. Checkout is failing; you ask why, keep the evidence on screen,
// ask about it, have the code changed, and ship the fix. Nothing is a video.
//
// The story runs as one script. `beat(n)` marks where each moment starts: the buttons
// under the demo show them, and a click on one replays the script instantly up to that
// moment and plays on from there, so every moment arrives in its true state. Reduced
// motion shows the finished canvas, still.

const root = document.querySelector('[data-demo]')
if (root) start()

function start() {
  const q = (s) => root.querySelector(s)
  const desk = q('.desk')
  const cv = q('[data-cv]')
  const col = q('[data-col]')
  const turns = q('[data-turns]')
  const plan = q('[data-plan]')
  const board = q('[data-board]')
  const zone = q('[data-zone]')
  const menu = q('[data-menu]')
  const toast = q('[data-toast]')
  const inpT = q('[data-inp-t]')
  const keysEl = q('[data-keys]')
  const ptr = q('[data-ptr]')
  const cards = q('[data-cards]')
  const todoN = q('[data-todo-n]')
  const cap = document.querySelector('[data-cap]')
  const beatBtns = [...document.querySelectorAll('[data-ch]')]
  const pauseBtn = document.querySelector('[data-pause]')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------------------------------------------------------------- fitting the stage
  let narrow = false
  let scale = 1
  function fit() {
    const w = root.clientWidth
    narrow = w < 720
    const dw = narrow ? 600 : 1200
    const dh = narrow ? 640 : 760
    root.classList.toggle('is-narrow', narrow)
    root.style.setProperty('--ar', `${dw} / ${dh}`)
    desk.style.setProperty('--dw', `${dw}px`)
    desk.style.setProperty('--dh', `${dh}px`)
    scale = w / dw
    desk.style.setProperty('--s', String(scale))
  }
  fit()
  new ResizeObserver(fit).observe(root)

  /** Where an element is, in the stage's own pixels. */
  function box(el, rel = desk) {
    const d = rel.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: (r.left - d.left) / scale, y: (r.top - d.top) / scale, w: r.width / scale, h: r.height / scale }
  }
  const mid = (el) => {
    const b = box(el)
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  }

  // ---------------------------------------------------------------- time, that can be stopped or skipped
  class Stop extends Error {}
  let run = 0
  let paused = false
  // While replaying up to a chosen moment, every wait and motion is instant.
  let skipTo = -1
  let beatNow = 0
  const skipping = () => reduced || beatNow < skipTo
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function wait(ms) {
    const id = run
    if (skipping()) {
      if (id !== run) throw new Stop()
      return
    }
    // Counted on the clock, not in timer steps, which overshoot.
    let left = ms
    let last = performance.now()
    while (left > 0) {
      await sleep(Math.min(left, 40))
      if (id !== run) throw new Stop()
      const now = performance.now()
      if (!paused) left -= now - last
      last = now
    }
  }
  const frame = () => new Promise((r) => requestAnimationFrame(r))
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  /** Drive f(t) for t 0..1 over ms, eased; stops with the run. */
  async function tween(ms, f, ease = easeInOut) {
    const id = run
    if (skipping()) return f(1)
    let t0 = performance.now()
    let held = 0
    for (;;) {
      await frame()
      if (id !== run) throw new Stop()
      const now = performance.now()
      if (paused) {
        held = now - t0
        continue
      }
      if (held) {
        t0 = now - held
        held = 0
      }
      const t = Math.min(1, (now - t0) / ms)
      f(ease(t))
      if (t >= 1) return
    }
  }

  // ---------------------------------------------------------------- your pointer
  const P = { x: 900, y: 640 }
  const placePtr = () => (ptr.style.transform = `translate3d(${P.x.toFixed(1)}px, ${P.y.toFixed(1)}px, 0)`)
  placePtr()
  const glideMs = (d) => (d < 2 ? 0 : Math.max(160, Math.min(560, 160 + 85 * Math.log2(1 + d / 60))))
  async function glide(to) {
    ptr.classList.add('is-on')
    const sx = P.x
    const sy = P.y
    const len = Math.hypot(to.x - sx, to.y - sy) || 1
    const ms = glideMs(len) * 1.3
    if (!ms) return
    const bow = Math.min(50, len * 0.12)
    const cx = (sx + to.x) / 2 + (-(to.y - sy) / len) * bow
    const cy = (sy + to.y) / 2 + ((to.x - sx) / len) * bow
    await tween(ms, (u) => {
      const v = 1 - u
      P.x = v * v * sx + 2 * u * v * cx + u * u * to.x
      P.y = v * v * sy + 2 * u * v * cy + u * u * to.y
      placePtr()
    })
  }
  function ripple(at, right = false) {
    if (skipping()) return
    const r = document.createElement('div')
    r.className = right ? 'ripple is-right' : 'ripple'
    r.style.left = `${at.x}px`
    r.style.top = `${at.y}px`
    desk.appendChild(r)
    setTimeout(() => r.remove(), 600)
    ptr.querySelector('svg').animate([{ scale: '1' }, { scale: '0.82' }, { scale: '1' }], { duration: 220, easing: 'ease-out' })
  }
  async function click(el, right = false) {
    const at = mid(el)
    await glide(at)
    await wait(110)
    ripple(at, right)
    el.classList.add('is-press')
    await wait(170)
    el.classList.remove('is-press')
  }
  async function keys(...names) {
    if (!skipping()) keysEl.innerHTML = names.map((k) => `<kbd>${k}</kbd>`).join('')
    await wait(380)
  }
  async function typeInto(el, text, base = 36) {
    if (skipping()) return void (el.textContent = text)
    el.textContent = ''
    for (const ch of text) {
      el.textContent += ch
      await wait(base + Math.random() * 40 + (ch === ' ' ? 30 : 0))
    }
  }
  async function stream(el, text) {
    if (skipping()) return void (el.textContent = text)
    el.textContent = ''
    for (const w of text.split(' ')) {
      el.textContent += (el.textContent ? ' ' : '') + w
      await wait(36 + Math.random() * 28)
    }
  }

  // ---------------------------------------------------------------- the conversation
  const busy = (on) => cards.firstElementChild.classList.toggle('is-busy', on)
  let say = null
  /** Type a request, send it, and open a new turn for the answer. */
  async function ask(text, typed = true) {
    if (typed) {
      await typeInto(inpT, text)
      await wait(300)
      await keys('Enter')
      inpT.textContent = ''
    }
    const t = document.createElement('div')
    t.className = 'turn'
    t.innerHTML = `<div class="you"><span class="you__dot"></span><span></span></div><div class="say"></div>`
    t.querySelector('.you span:last-child').textContent = text
    turns.appendChild(t)
    say = t.querySelector('.say')
    busy(true)
  }
  function think(text) {
    let p = say.querySelector('.think')
    if (!p) {
      p = document.createElement('p')
      p.className = 'think'
      say.appendChild(p)
    }
    p.textContent = text
  }
  const unthink = () => say.querySelector('.think')?.remove()
  async function line(text, cls = '') {
    unthink()
    const p = document.createElement('p')
    if (cls) p.className = cls
    say.appendChild(p)
    await stream(p, text)
    return p
  }

  // ---------------------------------------------------------------- the plan, on top
  const STEPS = ['Find the cause', 'Raise the pool, fail fast', 'Run the tests', 'Open a PR']
  function startPlan() {
    plan.innerHTML =
      `<div class="plan__h"><b>Fix checkout 503s</b><span data-plan-n>0/${STEPS.length}</span></div>` +
      `<div class="plan__bar"><i data-plan-bar></i></div>` +
      `<ol>${STEPS.map((s) => `<li data-s="pending"><i></i><span>${s}</span></li>`).join('')}</ol>`
    plan.classList.add('is-on')
  }
  function step(i, state) {
    const li = plan.querySelectorAll('li')
    li[i].dataset.s = state
    const done = plan.querySelectorAll('li[data-s="done"]').length
    plan.querySelector('[data-plan-n]').textContent = `${done}/${li.length}`
    plan.querySelector('[data-plan-bar]').style.width = `${(done / li.length) * 100}%`
  }

  // ---------------------------------------------------------------- pieces
  function piece(title, kind, body) {
    const el = document.createElement('div')
    el.className = 'pc is-inline'
    el.innerHTML = `<div class="pc__h"><b>${title}</b><span class="pc__grip"><i></i>Drag out</span><span class="pc__k">${kind}</span></div><div class="pc__b">${body}</div>`
    return el
  }
  async function show(el) {
    say.appendChild(el)
    void el.offsetWidth
    el.classList.add('is-on')
    await wait(500)
  }

  // 5xx per minute today, every ten minutes from 08:00; the last stretch is after the fix.
  const YS = [3, 4, 3, 5, 8, 22, 41, 18, 6, 4, 3, 5, 4, 6, 5, 7, 6, 9, 12, 19, 44, 79, 86, 61, 30, 14, 9, 7, 6, 8, 7, 6, 5, 4, 2, 1, 1, 0, 1, 0]
  const FIX = 33 // the index where the fix reaches staging
  const chartBody = () => {
    const n = YS.length - 1
    const pts = YS.map((y, i) => [(i / n) * 500, 128 - y * 1.3])
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
    const [sx, sy] = pts[22]
    const fx = (FIX / n) * 100
    return (
      `<div class="ch" style="--keep:${(100 - fx).toFixed(1)}%"><div class="ch__plot"><svg viewBox="0 0 500 132" preserveAspectRatio="none"><g class="ch__grid"><path d="M0 34H500M0 68H500M0 102H500"/></g>` +
      `<path class="ch__area" d="${d} L500 132 L0 132Z"/><path class="ch__l" d="${d}"/></svg>` +
      `<i class="ch__dot" data-spike style="left:${(sx / 500) * 100}%;top:${(sy / 132) * 100}%"></i>` +
      `<span class="ch__fix" style="left:${fx}%">fix on staging</span></div>` +
      `<div class="ch__days">${['08', '09', '10', '11', '12', '13', '14'].map((h) => `<span>${h}:00</span>`).join('')}</div></div>`
    )
  }

  const hl = (s) =>
    s
      .replace(/\b(export|const)\b/g, '<em class="k">$1</em>')
      .replace(/\b(\d[\d_]*)\b/g, '<em class="n">$1</em>')
      .replace(/\b(createPool|env)\b/g, '<em class="f">$1</em>')
  const codeLine = (n, text, cls = '') => `<div class="cl ${cls}"><i>${n}</i><span>${hl(text)}</span></div>`
  const codeBody = () =>
    `<pre class="code">${[
      codeLine(11, "import { createPool } from './driver'"),
      codeLine(12, ''),
      codeLine(13, 'export const pool = createPool({'),
      codeLine(14, '  host: env.DB_HOST,'),
      codeLine(15, '  max: 10,', 'is-hl" data-max="'),
      codeLine(16, '  idleTimeoutMillis: 30_000,'),
      codeLine(17, '})'),
    ].join('')}</pre>`

  // ---------------------------------------------------------------- dragging out, snapping
  const snaps = { right: null, bottom: null }
  const GAP = 10
  function snapRect(side) {
    const W = cv.offsetWidth
    const H = cv.offsetHeight
    const rw = Math.round(W * (narrow ? 0.44 : 0.36))
    if (side === 'right') return { x: W - rw - GAP, y: 56, w: rw, h: H - 56 - GAP }
    const bh = Math.round(H * (narrow ? 0.36 : 0.4))
    const r = snaps.right ? W - rw - 2 * GAP : W - GAP
    return { x: GAP, y: H - bh - GAP, w: r - GAP, h: bh }
  }
  /** The words keep clear of what is snapped. */
  function makeRoom() {
    const W = cv.offsetWidth
    const H = cv.offsetHeight
    col.style.width = snaps.right ? `${snapRect('right').x - GAP}px` : ''
    col.style.height = snaps.bottom ? `${snapRect('bottom').y - GAP}px` : ''
    void W
    void H
  }
  const setRect = (el, r) => Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })

  /** Take a piece out of the reply by its handle and drop it at an edge, where it snaps. */
  async function dragTo(el, side) {
    const grip = el.querySelector('.pc__grip')
    await glide(mid(el.querySelector('.pc__h')))
    el.classList.add('is-hover')
    await wait(300)
    await glide(mid(grip))
    await wait(120)
    ripple(mid(grip))
    // Its place in the reply closes up as it leaves.
    const r0 = box(el, cv)
    const gap = document.createElement('div')
    gap.className = 'gap'
    gap.style.height = `${el.offsetHeight + 12}px`
    el.before(gap)
    board.appendChild(el)
    el.classList.remove('is-inline')
    el.classList.add('is-lift')
    setRect(el, { x: r0.x, y: r0.y, w: r0.w, h: r0.h })
    void gap.offsetHeight
    gap.style.height = '0px'
    const grab = { x: P.x - box(cv).x - r0.x, y: P.y - box(cv).y - r0.y }
    const target = snapRect(side)
    // Carried towards the edge at its own size; near it, the snap shows where it will land.
    const end = side === 'right' ? { x: target.x + 30, y: r0.y - 10 } : { x: r0.x + 20, y: target.y + 20 }
    let shown = false
    await tween(1000, (u) => {
      const x = r0.x + (end.x - r0.x) * u
      const y = r0.y + (end.y - r0.y) * u
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      P.x = box(cv).x + x + grab.x
      P.y = box(cv).y + y + grab.y
      placePtr()
      if (u > 0.6 && !shown) {
        shown = true
        setRect(zone, target)
        zone.classList.add('is-on')
      }
    })
    if (!shown) {
      setRect(zone, target)
      zone.classList.add('is-on')
    }
    await wait(280)
    // Let go: it takes the snap's place, and the words make room.
    el.classList.remove('is-lift', 'is-hover')
    el.classList.add('is-snapped')
    const from = { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: r0.w, h: r0.h }
    snaps[side] = el
    makeRoom()
    zone.classList.remove('is-on')
    await tween(420, (u) => setRect(el, {
      x: from.x + (target.x - from.x) * u,
      y: from.y + (target.y - from.y) * u,
      w: from.w + (target.w - from.w) * u,
      h: from.h + (target.h - from.h) * u,
    }))
    gap.remove()
  }

  // ---------------------------------------------------------------- the context menu
  function openMenu(at, head) {
    menu.innerHTML =
      `<div class="menu__head">${head}</div>` +
      `<div class="menu__ask"><span class="menu__box" data-box></span><span class="menu__ph">Ask about this, or say what to change…</span></div>` +
      `<div class="menu__hint">A question is answered here · anything else changes it</div>` +
      `<div class="menu__ans" data-ans></div>` +
      `<div class="menu__grid"><span><i>⤢</i>Full screen</span><span><i>▁</i>Minimize</span><span><i>✎</i>Save note</span><span><i>✕</i>Remove</span></div>`
    const c = box(cv)
    const w = narrow ? 270 : 320
    menu.style.width = `${w}px`
    menu.style.left = `${Math.max(8, Math.min(cv.offsetWidth - w - 8, at.x - c.x + 6))}px`
    menu.style.top = `${Math.max(8, Math.min(cv.offsetHeight - 250, at.y - c.y + 6))}px`
    void menu.offsetWidth
    menu.classList.add('is-on')
    return { box: menu.querySelector('[data-box]'), ans: menu.querySelector('[data-ans]') }
  }
  const closeMenu = () => menu.classList.remove('is-on')

  function showToast(text) {
    toast.textContent = text
    toast.classList.add('is-on')
    setTimeout(() => toast.classList.remove('is-on'), skipping() ? 0 : 3200)
  }

  // ---------------------------------------------------------------- the story
  const MOMENTS = [
    { ms: 11500, cap: 'Checkout is failing. Ask what is going on, in plain words. The answer comes with the evidence.' },
    { ms: 4600, cap: 'Drag the chart to the right edge and it snaps there. The conversation makes room.' },
    { ms: 4500, cap: 'The agent puts its plan on top, and shows you the code it means.' },
    { ms: 4400, cap: 'Pin the code along the bottom. The cause, the code and the conversation, all in view.' },
    { ms: 9500, cap: 'Right-click anything to ask about it. The answer comes right there, without interrupting the work.' },
    { ms: 12000, cap: 'Or say what to change. The agent edits it in place, runs the tests, and the plan moves on.' },
    { ms: 11500, cap: 'Decide with one click. The PR is open, the chart shows the fix holding, and a follow-up lands on your todo list.' },
  ]
  let chart = null
  let code = null

  async function story() {
    // 1 · Ask
    await beat(0)
    await wait(500)
    await ask('checkout is throwing 503s since this morning. what is going on?')
    think('Reading the logs…')
    await wait(1300)
    await line('Checkout runs out of database connections at peak. Each request waits for one of 10 pooled connections; after 5 s it gives up with a 503.')
    await wait(200)
    chart = piece('5xx per minute · today', 'chart', chartBody())
    await show(chart)
    await wait(1500)

    // 2 · Pin it to the right
    await beat(1)
    await dragTo(chart, 'right')
    await wait(900)

    // 3 · The plan, and the code
    await beat(2)
    startPlan()
    step(0, 'done')
    step(1, 'active')
    await wait(500)
    await line('The pool is set here; 10 is too few for lunch traffic.')
    code = piece('src/db/pool.ts', 'code', codeBody())
    await show(code)
    busy(false)
    await wait(1300)

    // 4 · Pin it along the bottom
    await beat(3)
    await dragTo(code, 'bottom')
    ptr.classList.remove('is-on')
    await wait(900)

    // 5 · Ask about a point on the chart, in place
    await beat(4)
    const dot = chart.querySelector('[data-spike]')
    await click(dot, true)
    const m1 = openMenu(mid(dot), '5xx per minute · 12:10')
    await wait(400)
    await typeInto(m1.box, 'why is noon worse than 9 am?')
    await wait(250)
    await keys('Enter')
    m1.ans.classList.add('is-on', 'is-busy')
    await wait(1000)
    m1.ans.classList.remove('is-busy')
    const a = document.createElement('p')
    m1.ans.appendChild(a)
    await stream(a, 'Lunch: about 2.4× the checkouts per minute, so the 10 connections run out sooner and the queue backs up.')
    await wait(2200)
    await keys('Esc')
    closeMenu()
    await wait(500)

    // 6 · Say what to change, on the code itself
    await beat(5)
    const max = code.querySelector('[data-max]')
    await click(max, true)
    const m2 = openMenu(mid(max), 'src/db/pool.ts · max: 10')
    await wait(400)
    await typeInto(m2.box, 'make it 40, and fail fast after 5 s')
    await wait(250)
    await keys('Enter')
    closeMenu()
    ptr.classList.remove('is-on')
    await ask('Change src/db/pool.ts, “max: 10”: make it 40, and fail fast after 5 s', false)
    think('Editing pool.ts…')
    await wait(1100)
    max.classList.remove('is-hl')
    max.classList.add('is-del')
    max.insertAdjacentHTML('afterend', codeLine(15, '  max: 40,', 'is-add') + codeLine(16, '  acquireTimeoutMillis: 5_000,', 'is-add'))
    code.querySelectorAll('.cl').forEach((l, i) => {
      if (i > 6) l.querySelector('i').textContent = String(11 + i - 1)
    })
    step(1, 'done')
    step(2, 'active')
    await wait(700)
    unthink()
    const run1 = document.createElement('p')
    run1.className = 'tool'
    run1.innerHTML = '<b>run</b> <span>pnpm test</span>'
    say.appendChild(run1)
    await wait(1600)
    run1.querySelector('span').textContent = 'pnpm test · 128 passed'
    step(2, 'done')
    step(3, 'active')
    await wait(800)

    // 7 · Decide, and ship
    await beat(6)
    const card = document.createElement('div')
    card.className = 'askc'
    card.innerHTML = '<b>Open a pull request with this fix?</b><div><span class="askc__yes">Open the PR</span><span>Not yet</span></div>'
    say.appendChild(card)
    busy(false)
    await wait(900)
    P.x = narrow ? 300 : 700
    P.y = narrow ? 300 : 260
    placePtr()
    await click(card.querySelector('.askc__yes'))
    card.classList.add('is-done')
    ptr.classList.remove('is-on')
    await ask('Open the PR', false)
    think('Pushing fix/checkout-pool…')
    await wait(1300)
    step(3, 'done')
    chart.querySelector('.ch').classList.add('is-more')
    await line('PR #418 is open. Staging has had no 503s since the fix went in.')
    await wait(500)
    showToast('Added to your todos: watch checkout 5xx after the deploy')
    todoN.textContent = '4'
    todoN.classList.remove('is-bump')
    void todoN.offsetWidth
    todoN.classList.add('is-bump')
    busy(false)
    await wait(4200)
  }

  function reset() {
    turns.innerHTML = ''
    board.innerHTML = ''
    plan.className = 'plan'
    plan.innerHTML = ''
    zone.classList.remove('is-on')
    menu.classList.remove('is-on')
    toast.classList.remove('is-on')
    keysEl.innerHTML = ''
    inpT.textContent = ''
    ptr.classList.remove('is-on')
    snaps.right = snaps.bottom = null
    col.style.width = col.style.height = ''
    todoN.textContent = '3'
    busy(false)
    say = null
  }

  // ---------------------------------------------------------------- playing it
  const took = []
  let beatAt = 0
  let pausedAt = 0
  let playing = false

  async function beat(i) {
    beatNow = i
    if (i >= skipTo && skipTo >= 0) {
      skipTo = -1
      // Let the replayed state settle without animating, then play on.
      await frame()
      root.classList.remove('is-ff')
    }
    // the moment before this one took this long
    if (i > 0 && !skipping() && beatAt && !reduced) took[i - 1] = took[i - 1] || performance.now() - beatAt
    beatAt = performance.now()
    cap.textContent = MOMENTS[i].cap
    beatBtns.forEach((b, j) => {
      b.classList.toggle('is-on', j === i)
      b.classList.toggle('is-past', j < i)
    })
  }

  async function play(from = 0) {
    const id = ++run
    playing = true
    for (;;) {
      reset()
      skipTo = reduced ? Infinity : from
      root.classList.toggle('is-ff', skipTo > 0)
      try {
        await story()
      } catch (e) {
        if (e instanceof Stop) return
        throw e
      }
      if (id !== run) return
      took[MOMENTS.length - 1] = took[MOMENTS.length - 1] || performance.now() - beatAt
      if (reduced) {
        root.classList.remove('is-ff')
        return
      }
      from = 0
    }
  }

  // The bar under the moment that is playing, and the conversation following its newest line.
  ;(function progress() {
    const end = turns.scrollHeight - turns.clientHeight
    if (Math.abs(turns.scrollTop - end) > 0.5) turns.scrollTop = skipping() ? end : turns.scrollTop + (end - turns.scrollTop) * 0.18
    turns.classList.toggle('is-scrolled', turns.scrollTop > 2)
    if (playing && !reduced) {
      if (paused) {
        if (!pausedAt) pausedAt = performance.now()
      } else if (pausedAt) {
        beatAt += performance.now() - pausedAt
        pausedAt = 0
      }
      beatBtns.forEach((b, j) => {
        const bar = b.querySelector('b')
        if (j < beatNow) bar.style.width = '100%'
        else if (j > beatNow) bar.style.width = '0%'
        else {
          const t = Math.min(0.99, ((pausedAt || performance.now()) - beatAt) / (took[j] || MOMENTS[j].ms))
          bar.style.width = `${(t * 100).toFixed(1)}%`
        }
      })
    }
    requestAnimationFrame(progress)
  })()

  beatBtns.forEach((b) =>
    b.addEventListener('click', () => {
      paused = false
      pauseBtn?.classList.remove('is-paused')
      void play(Number(b.dataset.ch))
    })
  )
  pauseBtn?.addEventListener('click', () => {
    paused = !paused
    pauseBtn.classList.toggle('is-paused', paused)
    pauseBtn.setAttribute('aria-label', paused ? 'Play the demo' : 'Pause the demo')
  })

  // Only plays while it can be seen.
  let visible = false
  new IntersectionObserver(
    ([e]) => {
      visible = e.isIntersecting
      if (visible && !playing) void play(0)
      if (!reduced && pauseBtn && !pauseBtn.classList.contains('is-paused')) paused = !visible
    },
    { threshold: 0.25 }
  ).observe(root)
}
