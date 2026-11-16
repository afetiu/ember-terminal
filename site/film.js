// The demo in the hero: Ember's window, rebuilt in HTML, playing real pieces of work from
// start to finish. Four show first (running a project, fixing a bug, building a page,
// reviewing a contract); twelve more sit behind "More examples". Nothing is a video.
// #use/<slug> links straight to one.
//
// Each scene is one script. `beat(n)` marks where each of its moments starts: the buttons
// under the demo show them, and a click on one replays the script instantly up to that
// moment and plays on from there, so every moment arrives in its true state. When a scene
// ends the next one starts. Reduced motion shows each scene's finished canvas, still.

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
  const tag = q('[data-tag]')
  const cards = q('[data-cards]')
  const todoN = q('[data-todo-n]')
  const cap = document.querySelector('[data-cap]')
  const scenesEl = document.querySelector('[data-scenes]')
  const momentsEl = document.querySelector('[data-chapters]')
  const pauseBtn = document.querySelector('[data-pause]')
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------------------------------------------------------------- fitting the stage
  let narrow = false
  let scale = 1
  function fit() {
    const w = root.clientWidth
    narrow = w < 720
    const dw = narrow ? 660 : 1440
    const dh = narrow ? 700 : 880
    root.classList.toggle('is-narrow', narrow)
    root.style.setProperty('--ar', `${dw} / ${dh}`)
    desk.style.setProperty('--dw', `${dw}px`)
    desk.style.setProperty('--dh', `${dh}px`)
    scale = w / dw
    desk.style.setProperty('--s', String(scale))
  }
  fit()
  new ResizeObserver(fit).observe(root)

  /** Where an element is, in the stage's own pixels (or relative to another element). */
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

  // ---------------------------------------------------------------- the pointer: yours (white) or Ember's (amber)
  const P = { x: 900, y: 640 }
  const placePtr = () => {
    ptr.style.transform = `translate3d(${P.x.toFixed(1)}px, ${P.y.toFixed(1)}px, 0)`
    // near the right edge its note goes on the left, so it never runs off the screen
    ptr.classList.toggle('is-flip', P.x > desk.offsetWidth - 280)
  }
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
  /** Ember's own pointer, with a short note beside it; or back to yours. */
  function ember(on, note = '') {
    ptr.classList.toggle('is-ember', on)
    tag.textContent = on ? note : ''
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
  /** A tool call, shown the way the canvas shows one: the verb, then what it did. */
  function tool(verb, what) {
    unthink()
    const p = document.createElement('p')
    p.className = 'tool'
    p.innerHTML = `<b>${verb}</b> <span></span>`
    p.querySelector('span').textContent = what
    say.appendChild(p)
    return p.querySelector('span')
  }
  /** The agent asks with buttons; you press one. */
  async function choose(question, yes, no = 'Not yet') {
    const card = document.createElement('div')
    card.className = 'askc'
    card.innerHTML = `<b>${question}</b><div><span class="askc__yes">${yes}</span><span>${no}</span></div>`
    say.appendChild(card)
    busy(false)
    await wait(900)
    ember(false)
    await click(card.querySelector('.askc__yes'))
    card.classList.add('is-done')
    ptr.classList.remove('is-on')
    await ask(yes, false)
  }

  // ---------------------------------------------------------------- the plan, an object like the others
  // As in the app: the plan is a piece in the reply, with its own bar, that ticks itself off.
  let planEl = null
  function startPlan(title, steps) {
    const p = piece(
      title,
      'plan',
      `<div class="plan is-on"><div class="plan__h"><span data-plan-n>0/${steps.length}</span></div>` +
        `<div class="plan__bar"><i data-plan-bar></i></div>` +
        `<ol>${steps.map((s) => `<li data-s="pending"><i></i><span>${s}</span></li>`).join('')}</ol></div>`
    )
    planEl = p.querySelector('.plan')
    return p
  }
  function step(i, state) {
    const li = planEl.querySelectorAll('li')
    li[i].dataset.s = state
    const done = planEl.querySelectorAll('li[data-s="done"]').length
    planEl.querySelector('[data-plan-n]').textContent = `${done}/${li.length}`
    planEl.querySelector('[data-plan-bar]').style.width = `${(done / li.length) * 100}%`
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

  // ---------------------------------------------------------------- dragging out, snapping
  const snaps = { right: null }
  // the bottom band can hold several pieces side by side, each taking its share (data-w)
  const bottoms = []
  const GAP = 10
  // how deep the bottom band is: two fifths of the canvas, or more for a page that needs it
  let depth = 0.42
  function snapRect(side) {
    const W = cv.offsetWidth
    const H = cv.offsetHeight
    const rw = Math.round(W * (narrow ? 0.44 : 0.36))
    if (side === 'right') return { x: W - rw - GAP, y: 56, w: rw, h: H - 56 - GAP }
    const bh = Math.round(H * (narrow ? Math.min(depth, 0.5) : depth))
    const r = snaps.right ? W - rw - 2 * GAP : W - GAP
    return { x: GAP, y: H - bh - GAP, w: r - GAP, h: bh }
  }
  /** Where each piece in the bottom band goes, by its share of the width. */
  function bottomRects(list) {
    const band = snapRect('bottom')
    const total = band.w - GAP * (list.length - 1)
    const sum = list.reduce((a, e) => a + (Number(e.dataset.w) || 1), 0)
    let x = band.x
    return list.map((e) => {
      const w = (total * (Number(e.dataset.w) || 1)) / sum
      const r = { x, y: band.y, w, h: band.h }
      x += w + GAP
      return r
    })
  }
  /** The words keep clear of what is snapped. */
  function makeRoom() {
    col.style.width = snaps.right ? `${snapRect('right').x - GAP}px` : ''
    col.style.height = bottoms.length ? `${snapRect('bottom').y - GAP}px` : ''
  }
  const setRect = (el, r) => Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })

  /** Take a piece out of the reply by its handle and drop it at an edge, where it snaps. */
  async function dragTo(el, side, deep = 0.42) {
    if (side === 'bottom') depth = deep
    ember(false)
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
    setRect(el, r0)
    void gap.offsetHeight
    gap.style.height = '0px'
    const c0 = box(cv)
    const grab = { x: P.x - c0.x - r0.x, y: P.y - c0.y - r0.y }
    const target = side === 'right' ? snapRect('right') : bottomRects([...bottoms, el]).at(-1)
    // Carried towards the edge at its own size; near it, the snap shows where it will land.
    const end = side === 'right' ? { x: target.x + 30, y: Math.max(40, r0.y - 10) } : { x: r0.x + 20, y: target.y + 20 }
    let shown = false
    await tween(1000, (u) => {
      const x = r0.x + (end.x - r0.x) * u
      const y = r0.y + (end.y - r0.y) * u
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      P.x = c0.x + x + grab.x
      P.y = c0.y + y + grab.y
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
    if (side === 'right') snaps.right = el
    else {
      // the pieces already in the band move over to share it
      bottoms.forEach((b, i) => {
        b.classList.add('is-relayout')
        setRect(b, bottomRects([...bottoms, el])[i])
      })
      bottoms.push(el)
    }
    makeRoom()
    zone.classList.remove('is-on')
    await tween(420, (u) =>
      setRect(el, {
        x: from.x + (target.x - from.x) * u,
        y: from.y + (target.y - from.y) * u,
        w: from.w + (target.w - from.w) * u,
        h: from.h + (target.h - from.h) * u,
      })
    )
    gap.remove()
  }

  // ---------------------------------------------------------------- the context menu
  function openMenu(at, head) {
    menu.innerHTML =
      `<div class="menu__head">${head}</div>` +
      `<div class="menu__ask"><span class="menu__box" data-box></span><span class="menu__ph">Ask about this, or say what to change…</span></div>` +
      `<div class="menu__hint">A question is answered here · anything else changes it</div>` +
      `<div class="menu__ans" data-ans></div>` +
      `<div class="menu__grid"><span><i>⤢</i>Full screen</span><span><i>▁</i>Minimize</span><span data-tile="note"><i>✎</i>Save note</span><span><i>✕</i>Remove</span></div>`
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

  /** Right-click it, ask a question, and read the answer in the menu. */
  async function askAbout(el, head, question, answer) {
    ember(false)
    await click(el, true)
    const m = openMenu(mid(el), head)
    await wait(400)
    await typeInto(m.box, question)
    await wait(250)
    await keys('Enter')
    m.ans.classList.add('is-on', 'is-busy')
    await wait(1000)
    m.ans.classList.remove('is-busy')
    const a = document.createElement('p')
    m.ans.appendChild(a)
    await stream(a, answer)
    await wait(2200)
    await keys('Esc')
    closeMenu()
    await wait(400)
  }
  /** Right-click it and say what to change: it goes to the session as the next message. */
  async function change(el, head, words, about) {
    ember(false)
    await click(el, true)
    const m = openMenu(mid(el), head)
    await wait(400)
    await typeInto(m.box, words)
    await wait(250)
    await keys('Enter')
    closeMenu()
    ptr.classList.remove('is-on')
    await ask(`Change ${about}: ${words}`, false)
  }

  function showToast(text) {
    toast.textContent = text
    toast.classList.add('is-on')
    setTimeout(() => toast.classList.remove('is-on'), skipping() ? 0 : 3200)
  }
  function addTodo(text) {
    showToast(`Added to your todos: ${text}`)
    todoN.textContent = String(Number(todoN.textContent) + 1)
    todoN.classList.remove('is-bump')
    void todoN.offsetWidth
    todoN.classList.add('is-bump')
  }

  // ================================================================ 0 · run a project
  // Three parts of a release, one subagent each, and a board that follows them.
  const TICKETS = [
    ['PAY-311', 'Retry failed charges', 'pay'],
    ['SRCH-88', 'Index the new fields', 'search'],
    ['WEB-142', 'Saved carts', 'web'],
  ]
  const boardBody = () =>
    `<div class="kb">${['To do', 'Doing', 'Done']
      .map((name, i) => {
        const cards = i === 1 ? TICKETS.map(([id, t, k]) => `<div class="kc" data-id="${k}"><b>${id}</b><small>${t}</small></div>`).join('') : ''
        return `<div class="kb__c" data-col="${i}"><h6>${name}<i></i></h6>${cards}</div>`
      })
      .join('')}</div>`
  const countCards = (board) => board.querySelectorAll('.kb__c').forEach((c) => (c.querySelector('h6 i').textContent = c.querySelectorAll('.kc').length))
  function moveCard(board, k, col) {
    const card = board.querySelector(`[data-id="${k}"]`)
    const a = card.getBoundingClientRect()
    board.querySelector(`[data-col="${col}"]`).appendChild(card)
    if (!skipping()) {
      const b = card.getBoundingClientRect()
      card.animate([{ transform: `translate(${(a.left - b.left) / scale}px, ${(a.top - b.top) / scale}px)` }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    }
    countCards(board)
  }
  /** The session's subagents, as pills: what each is on, and whether it is done. */
  function agentsRow() {
    const row = document.createElement('div')
    row.className = 'subagents'
    row.innerHTML = [
      ['pay', 'payments', 'working'],
      ['search', 'search', 'working'],
      ['web', 'web', 'working'],
    ]
      .map(([k, n, a]) => `<span class="agent is-run" data-agent="${k}"><i></i><b>${n}</b><small>${a}</small></span>`)
      .join('')
    plan.after(row)
    return row
  }
  function agentState(row, k, state, text) {
    const p = row.querySelector(`[data-agent="${k}"]`)
    p.className = `agent is-${state}`
    p.querySelector('small').textContent = text
  }
  /** Land one part: its pill, its card and its step all say done. */
  function land(row, board, k, i, files) {
    agentState(row, k, 'done', `done · ${files} files`)
    board.querySelector(`[data-id="${k}"]`).classList.remove('is-fail')
    moveCard(board, k, 2)
    step(i, 'done')
  }

  async function projectStory() {
    await beat(0)
    await wait(500)
    await ask('v2.4 ships Friday. split the work across agents')
    think('Reading the v2.4 milestone…')
    await wait(1200)
    const row = agentsRow()
    await line('Three subagents are on it, one per part.')
    const planPiece = startPlan('Ship v2.4', ['Payments: retry failed charges', 'Search: index the new fields', 'Web: saved carts'])
    TICKETS.forEach((_, i) => step(i, 'active'))
    await show(planPiece)
    const board = piece('v2.4 board', 'kanban', boardBody())
    countCards(board)
    await show(board)
    busy(false)
    await wait(1200)

    await beat(1)
    await dragTo(board, 'bottom', 0.4)
    ptr.classList.remove('is-on')
    await wait(900)

    await beat(2)
    land(row, board, 'search', 1, 4)
    await wait(1000)
    agentState(row, 'pay', 'fail', '1 test failing')
    board.querySelector('[data-id="pay"]').classList.add('is-fail')
    await wait(900)
    // what it did, one click on its pill
    const pill = row.querySelector('[data-agent="pay"]')
    await click(pill)
    const pop = document.createElement('div')
    pop.className = 'apop'
    pop.innerHTML =
      `<b>payments</b><ol>${['edit retry.ts', 'run the tests · 1 failing', 'reading the failing test'].map((s) => `<li>${s}</li>`).join('')}</ol>` +
      `<p>A retried charge was counted twice. Fixing it.</p>`
    const pb = box(pill, cv)
    pop.style.left = `${Math.min(pb.x, cv.offsetWidth - 300)}px`
    pop.style.top = `${pb.y + pb.h + 8}px`
    cv.appendChild(pop)
    void pop.offsetWidth
    pop.classList.add('is-on')
    await wait(3400)
    pop.classList.remove('is-on')
    ptr.classList.remove('is-on')
    await wait(300)
    pop.remove()
    land(row, board, 'pay', 0, 3)
    await wait(900)
    land(row, board, 'web', 2, 7)
    await wait(700)

    await beat(3)
    await line('All three are in, and the tests pass.')
    await choose('Tag v2.4-rc1?', 'Tag it')
    think('Tagging…')
    await wait(900)
    tool('git', 'tag v2.4-rc1 · pushed')
    await line('Tagged, two days early. Three PRs are open for review.')
    addTodo('review the three v2.4 PRs')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 1 · fix a bug
  // 5xx per minute today, every ten minutes from 08:00; the last stretch is after the fix.
  const YS = [3, 4, 3, 5, 8, 22, 41, 18, 6, 4, 3, 5, 4, 6, 5, 7, 6, 9, 12, 19, 44, 79, 86, 61, 30, 14, 9, 7, 6, 8, 7, 6, 5, 4, 2, 1, 1, 0, 1, 0]
  const FIX = 33
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
      .replace(/\b(import|from|export|const)\b/g, '<em class="k">$1</em>')
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

  async function bugStory() {
    await beat(0)
    await ask('checkout is throwing 503s since this morning. why?')
    think('Reading the logs…')
    await wait(1300)
    await line('The database runs out of connections at lunch. Only 10 are allowed.')
    const chart = piece('5xx per minute · today', 'chart', chartBody())
    await show(chart)
    busy(false)
    await wait(1600)

    await beat(1)
    await dragTo(chart, 'right')
    ptr.classList.remove('is-on')
    await wait(500)
    await line('The limit is set here:')
    const code = piece('src/db/pool.ts', 'code', codeBody())
    await show(code)
    await wait(1400)

    await beat(2)
    const max = code.querySelector('[data-max]')
    await change(max, 'src/db/pool.ts · max: 10', 'make it 40', 'src/db/pool.ts, “max: 10”')
    think('Editing pool.ts…')
    await wait(1000)
    unthink()
    max.classList.remove('is-hl')
    max.classList.add('is-del')
    max.insertAdjacentHTML('afterend', codeLine(15, '  max: 40,', 'is-add'))
    const t = tool('run', 'pnpm test')
    await wait(1500)
    t.textContent = 'pnpm test · 128 passed'
    busy(false)
    await wait(1200)

    await beat(3)
    await choose('Open a pull request?', 'Open the PR')
    think('Pushing…')
    await wait(1100)
    chart.querySelector('.ch').classList.add('is-more')
    await line('PR #418 is open. No 503s on staging since the fix.')
    busy(false)
    await wait(4200)
  }

  // ================================================================ 2 · build a page
  const pageBody = () =>
    `<div class="web"><div class="web__bar"><i></i><i></i><i></i><span>localhost:5173/#pricing</span><b data-reload>↻</b></div>` +
    `<div class="web__page" data-page><h4>Simple pricing</h4><p>Start free. Upgrade when your team grows.</p><div class="tiers">` +
    `<div class="tier" data-tier="starter"><b>Starter</b><em>$0</em><small>1 project</small><span class="tier__btn">Get started</span></div>` +
    `<div class="tier is-hot" data-tier="pro"><i class="tier__badge" data-badge>Most picked</i><b>Pro</b><em data-price>$12</em><small>Unlimited projects</small><span class="tier__btn">Choose Pro</span></div>` +
    `<div class="tier" data-tier="team"><b>Team</b><em>$29</em><small>Shared workspaces</small><span class="tier__btn" data-team>Choose Team</span></div>` +
    `</div></div></div>`
  /** A numbered mark on the open page, with a short note: what annotate draws. */
  function mark(pageEl, target, n, note, left = false) {
    const b = box(target, pageEl)
    const m = document.createElement('div')
    m.className = left === true ? 'mark is-left' : 'mark'
    // 'above': just over the target's top right, where it covers nothing else on the page
    if (left === 'above') {
      m.style.left = `${b.x + b.w - 4}px`
      m.style.top = `${b.y - 20}px`
    } else {
      if (left) m.style.right = `${pageEl.offsetWidth - b.x + 2}px`
      else m.style.left = `${b.x + b.w + 2}px`
      m.style.top = `${b.y + b.h / 2 - 9}px`
    }
    m.innerHTML = `<i>${n}</i><span>${note}</span>`
    pageEl.appendChild(m)
    void m.offsetWidth
    m.classList.add('is-on')
  }

  async function pageStory() {
    await beat(0)
    await ask('add a pricing section with three plans')
    think('Writing the section…')
    await wait(1300)
    await line('Here it is, live from your dev server.')
    const page = piece('localhost:5173 · Pricing', 'page', pageBody())
    await show(page)
    busy(false)
    await wait(1600)

    await beat(1)
    await dragTo(page, 'bottom', 0.56)
    ptr.classList.remove('is-on')
    await wait(900)

    await beat(2)
    await ask('where does the price come from?')
    think('Marking the page…')
    await wait(1000)
    unthink()
    const pageEl = page.querySelector('[data-page]')
    mark(pageEl, page.querySelector('[data-price]'), 1, 'plans.json', 'above')
    await line('From plans.json. I’ve marked it on the page.')
    busy(false)
    await wait(1800)

    await beat(3)
    const btn = page.querySelector('[data-team]')
    await change(btn, 'localhost:5173 · button “Choose Team”', 'make Team the featured plan', 'the page, button “Choose Team”')
    think('Editing plans.json…')
    await wait(1100)
    // the page reloads by itself, the way a dev server's does
    page.querySelector('[data-reload]').classList.add('is-spin')
    await wait(500)
    pageEl.querySelectorAll('.mark').forEach((m) => m.remove())
    const team = page.querySelector('[data-tier="team"]')
    page.querySelector('[data-tier="pro"]').classList.remove('is-hot')
    team.classList.add('is-hot', 'is-new')
    team.prepend(page.querySelector('[data-badge]'))
    page.querySelector('[data-reload]').classList.remove('is-spin')
    await line('Done. The page has reloaded.')
    busy(false)
    await wait(4200)
  }

  // ================================================================ 3 · review a contract
  // A few pages of the contract, one under another, the way a PDF scrolls.
  const lines = (...ws) => ws.map((w) => `<p class="ln" style="width:${w}%"></p>`).join('')
  const pdfBody = () =>
    `<div class="pdf"><div class="pdf__bar"><span>‹ <b data-pg>1</b> / 12 ›</span><span>− 100% +</span></div><div class="pdf__doc" data-doc>` +
    `<div class="pdf__page" data-p="1"><h4>Master Services Agreement</h4>${lines(94, 88, 91, 70, 86, 93, 64, 90, 82)}</div>` +
    `<div class="pdf__page" data-p="7"><h4>7. Term and termination</h4>${lines(92, 86)}` +
    `<p class="cl" data-clause="7.2"><b>7.2</b> Either party may terminate this Agreement for convenience on thirty (30) days’ written notice.</p>${lines(90, 78, 88, 64)}</div>` +
    `<div class="pdf__page" data-p="9"><h4>9. Liability</h4>${lines(88)}` +
    `<p class="cl" data-clause="9.1"><b>9.1</b> Each party’s total liability is limited to the fees paid in the three (3) months before the claim.</p>${lines(93, 80, 86)}</div>` +
    `<div class="pdf__page" data-p="11"><h4>11. Term</h4>${lines(90, 84)}` +
    `<p class="cl" data-clause="11.4"><b>11.4</b> This Agreement renews for successive twelve (12) month terms unless either party cancels in writing.</p>${lines(88, 72, 90)}</div>` +
    `</div></div>`
  /** Scroll the PDF so a clause sits near the top, and show its page number. */
  async function turnTo(pdf, clause) {
    const doc = pdf.querySelector('[data-doc]')
    const el = pdf.querySelector(`[data-clause="${clause}"]`)
    const from = doc.scrollTop
    const to = Math.max(0, el.closest('.pdf__page').offsetTop - 8)
    pdf.querySelector('[data-pg]').textContent = el.closest('.pdf__page').dataset.p
    await tween(700, (u) => (doc.scrollTop = from + (to - from) * u))
    return el
  }
  const mailBody = () =>
    `<div class="mail"><p><b>To</b> legal@northwind.example</p><p><b>Subject</b> Notice period in 7.2</p><hr>` +
    `<p>Hi Dana,</p><p>Before we sign, could we change the notice period in 7.2 from 30 to 60 days?</p><p>Thanks,<br>Sam</p></div>`

  async function contractStory() {
    await beat(0)
    await ask('what should I watch out for in this contract?')
    think('Reading Northwind MSA.pdf…')
    await wait(1300)
    await line('Three clauses: 7.2, 9.1 and 11.4.')
    const pdf = piece('Northwind MSA.pdf', 'PDF', pdfBody())
    await show(pdf)
    busy(false)
    await wait(900)
    await dragTo(pdf, 'right')
    ptr.classList.remove('is-on')
    await wait(600)

    await beat(1)
    await ask('walk me through them')
    // it scrolls the PDF to each one and points at it, a step at a time
    const walk = [
      ['7.2', 'Either side can leave on 30 days’ notice'],
      ['9.1', 'Liability stops at 3 months of fees'],
      ['11.4', 'Renews each year unless you cancel'],
    ]
    ember(true)
    P.x = narrow ? 200 : 620
    P.y = narrow ? 260 : 300
    placePtr()
    for (const [i, [id, note]] of walk.entries()) {
      tag.textContent = ''
      const el = await turnTo(pdf, id)
      await glide(mid(el))
      pdf.querySelectorAll('.cl.is-hl').forEach((c) => c.classList.remove('is-hl'))
      el.classList.add('is-hl')
      tag.innerHTML = `<b>Step ${i + 1} of 3</b>${note}`
      await wait(2400)
    }
    tag.textContent = ''
    ember(false)
    ptr.classList.remove('is-on')
    await line('7.2 is the one to push back on.')
    busy(false)
    await wait(900)

    await beat(2)
    const clause = await turnTo(pdf, '7.2')
    pdf.querySelectorAll('.cl.is-hl').forEach((c) => c.classList.remove('is-hl'))
    clause.classList.add('is-hl')
    await askAbout(clause, 'Northwind MSA.pdf · 7.2', 'can we ask for 60 days?',
      'Yes. Clause 14.1 lets you change it in writing.')

    await beat(3)
    await ask('draft the email asking for 60 days')
    think('Writing…')
    await wait(1000)
    unthink()
    const mail = piece('Email to Northwind', 'draft', mailBody())
    await show(mail)
    busy(false)
    await wait(600)
    showToast('Saved to your notes: Email to Northwind')
    await wait(4200)
  }

  // ================================================================ more scenes: the shapes they show
  // Each is a body the canvas really draws: show_view's table, stats, bar, timeline and compare,
  // show_file's spreadsheet and Markdown, show_panel's diagrams, show_image, show_steps.
  const numCol = (c) => c.startsWith('#')
  const tableBody = (cols, rows) =>
    `<div class="tbw"><table class="tbl"><thead><tr>${cols.map((c) => `<th${numCol(c) ? ' class="num"' : ''}>${c.replace(/^#/, '')}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r, i) => `<tr data-r="${i}">${r.map((c, j) => `<td${numCol(cols[j]) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  const sheetBody = (cols, rows) =>
    `<div class="sheet"><table><thead><tr><th></th>${cols.map((_, i) => `<th>${'ABCDEFGH'[i]}</th>`).join('')}</tr></thead><tbody>` +
    `<tr><th>1</th>${cols.map((c) => `<td><b>${c}</b></td>`).join('')}</tr>` +
    rows.map((r, i) => `<tr><th>${i + 2}</th>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    `</tbody></table></div>`
  const statsBody = (items) =>
    `<div class="sts">${items.map(([label, value, delta, tone]) => `<div class="sts__i"><small>${label}</small><b>${value}</b>${delta ? `<em class="is-${tone || 'flat'}">${delta}</em>` : ''}</div>`).join('')}</div>`
  const barsBody = (rows) =>
    `<div class="hb">${rows.map(([label, v, text, hot], i) => `<div class="hb__r${hot ? ' is-hot' : ''}" data-b="${i}"><span>${label}</span><i><b style="--v:${v}%"></b></i><em>${text}</em></div>`).join('')}</div>`
  const timelineBody = (items) =>
    `<ol class="tl">${items.map(([when, title, text, tone], i) => `<li data-t="${i}"${tone ? ` class="is-${tone}"` : ''}><time>${when}</time><div><b>${title}</b>${text ? `<small>${text}</small>` : ''}</div></li>`).join('')}</ol>`
  const compareBody = (items) =>
    `<div class="cmp">${items
      .map(
        (it, i) =>
          `<div class="cmp__c${it.best ? ' is-best' : ''}" data-c="${i}"><h5>${it.title}${it.best ? '<i>Pick</i>' : ''}</h5>` +
          `<ul>${it.points.map(([sign, text], j) => `<li class="${sign === '+' ? 'is-pro' : 'is-con'}" data-p="${j}">${text}</li>`).join('')}</ul><p>${it.verdict}</p></div>`
      )
      .join('')}</div>`
  const docBody = (html) => `<div class="doc">${html}</div>`
  const nodeHtml = (n) =>
    `<div class="dg__n${n.cls ? ' ' + n.cls : ''}" data-n="${n.id}" style="left:${n.x}%;top:${n.y}%"><b>${n.label}</b>${n.sub ? `<small>${n.sub}</small>` : ''}</div>`
  const edgeHtml = (at, [a, b]) => `<line data-e="${a}-${b}" x1="${at[a].x}" y1="${at[a].y}" x2="${at[b].x}" y2="${at[b].y}"/>`
  /** A diagram: boxes, and the lines between them flowing the way the calls go. */
  function diagramBody(nodes, edges) {
    const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
    return `<div class="dg"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges.map((e) => edgeHtml(at, e)).join('')}</svg>${nodes.map(nodeHtml).join('')}</div>`
  }
  /** Redraw a diagram in place: a box comes in, and the lines that change move with it. */
  function addNode(pc, nodes, node, add, drop = []) {
    const dg = pc.querySelector('.dg')
    const at = Object.fromEntries([...nodes, node].map((n) => [n.id, n]))
    drop.forEach((id) => dg.querySelector(`[data-e="${id}"]`)?.remove())
    const svg = dg.querySelector('svg')
    add.forEach((e) => svg.insertAdjacentHTML('beforeend', edgeHtml(at, e).replace('<line', '<line class="is-new"')))
    dg.insertAdjacentHTML('beforeend', nodeHtml({ ...node, cls: 'is-new' }))
  }
  /** A sequence diagram: who talks to whom, in order. */
  function seqBody(actors, msgs) {
    const x = (i) => ((i * 2 + 1) / (actors.length * 2)) * 100
    return (
      `<div class="sq"><div class="sq__h">${actors.map((a, i) => `<b style="left:${x(i)}%">${a}</b>`).join('')}</div>` +
      actors.map((_, i) => `<i class="sq__life" style="left:${x(i)}%"></i>`).join('') +
      `<ol>${msgs
        .map(([f, t, label], k) => {
          const l = Math.min(x(f), x(t))
          return `<li data-m="${k}"${t < f ? ' class="is-back"' : ''} style="--l:${l}%;--w:${Math.abs(x(t) - x(f))}%"><span>${label}</span><i></i></li>`
        })
        .join('')}</ol></div>`
    )
  }
  /** Ember's pointer goes over each target in turn, a numbered note beside it. */
  async function walkThrough(list, startAt) {
    ember(true)
    if (startAt) {
      P.x = startAt.x
      P.y = startAt.y
      placePtr()
    }
    for (const [i, [el, note]] of list.entries()) {
      tag.textContent = ''
      await glide(mid(el))
      list.forEach(([e]) => e.classList.remove('is-hl'))
      el.classList.add('is-hl')
      tag.innerHTML = `<b>Step ${i + 1} of ${list.length}</b>${note}`
      await wait(2300)
    }
    tag.textContent = ''
    list.forEach(([e]) => e.classList.remove('is-hl'))
    ember(false)
    ptr.classList.remove('is-on')
  }
  /** Another session in the sidebar, opened from this one. */
  function newCard(title, sub) {
    const c = document.createElement('div')
    c.className = 'card is-busy is-new'
    c.dataset.extra = ''
    c.innerHTML = `<span class="card__dot"></span><div><b></b><small></small></div>`
    c.querySelector('b').textContent = title
    c.querySelector('small').textContent = sub
    cards.appendChild(c)
  }
  function tickTodo(text) {
    showToast(`Ticked off: ${text}`)
    todoN.textContent = String(Math.max(0, Number(todoN.textContent) - 1))
  }

  // ================================================================ 4 · map the system
  const SYS = [
    { id: 'web', label: 'Web app', sub: 'Next.js', x: 16, y: 24 },
    { id: 'mob', label: 'Mobile', sub: 'iOS · Android', x: 16, y: 74 },
    { id: 'api', label: 'API', sub: 'one service', x: 50, y: 34 },
    { id: 'db', label: 'Postgres', sub: 'one database', x: 84, y: 24 },
    { id: 'q', label: 'Queue', sub: 'jobs', x: 84, y: 74 },
  ]
  const SYS_E = [['web', 'api'], ['mob', 'api'], ['api', 'db'], ['api', 'q']]

  async function systemStory() {
    await beat(0)
    await ask('draw how our services talk to each other')
    think('Reading docker-compose.yml and the API routes…')
    await wait(1300)
    await line('Five parts, and everything goes through the API.')
    const dg = piece('How the services talk', 'diagram', diagramBody(SYS, SYS_E))
    await show(dg)
    busy(false)
    await wait(1200)
    await dragTo(dg, 'right')
    ptr.classList.remove('is-on')
    await wait(600)

    await beat(1)
    await askAbout(dg.querySelector('[data-n="db"]'), 'How the services talk · Postgres', 'what breaks if this goes down?',
      'Everything but the static pages. Web and mobile both read through the API, and the jobs write to it.')

    await beat(2)
    await change(dg.querySelector('[data-n="api"]'), 'How the services talk · API', 'split billing out into its own service', 'the diagram, “API”')
    think('Reading src/billing… redrawing')
    await wait(1200)
    addNode(dg, SYS, { id: 'bill', label: 'Billing', sub: 'new service', x: 50, y: 78 }, [['api', 'bill'], ['bill', 'q']], ['api-q'])
    await line('Billing is its own service now. It takes over the jobs; nothing else moves.')
    busy(false)
    await wait(1400)

    await beat(3)
    await choose('Write the migration plan?', 'Write it')
    think('Planning…')
    await wait(900)
    const pl = startPlan('Split out billing', ['Move the billing tables behind a view', 'Stand up the billing service', 'Send /billing to it', 'Remove the old code'])
    await show(pl)
    step(0, 'active')
    tool('write', 'docs/plans/billing-split.md')
    await line('Four steps, each one safe to ship alone.')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 5 · learn a codebase
  const FLOW = [
    { id: 'route', label: 'Route', sub: 'routes/orders.ts', x: 15, y: 28 },
    { id: 'svc', label: 'Service', sub: 'services/orders.ts', x: 38, y: 72 },
    { id: 'repo', label: 'Repository', sub: 'repos/orders.ts', x: 62, y: 28 },
    { id: 'pg', label: 'Postgres', sub: 'orders', x: 85, y: 72 },
  ]
  const FLOW_E = [['route', 'svc'], ['svc', 'repo'], ['repo', 'pg']]

  async function learnStory() {
    await beat(0)
    await ask('I’m new here. how does a request get to the database?')
    think('Reading src/…')
    await wait(1300)
    await line('Three hops. Here they are, in order.')
    const dg = piece('POST /orders, start to end', 'diagram', diagramBody(FLOW, FLOW_E))
    await show(dg)
    busy(false)
    await wait(1000)
    await dragTo(dg, 'bottom', 0.42)
    ptr.classList.remove('is-on')
    await wait(500)

    await beat(1)
    await ask('walk me through it')
    const n = (id) => dg.querySelector(`[data-n="${id}"]`)
    await walkThrough(
      [
        [n('route'), 'Checks the input, nothing else'],
        [n('svc'), 'The business rules live here'],
        [n('repo'), 'The only place that writes SQL'],
        [n('pg'), 'orders and order_items'],
      ],
      { x: narrow ? 220 : 640, y: narrow ? 200 : 260 }
    )
    await line('Start in services/. That is where the rules are.')
    busy(false)
    await wait(900)

    await beat(2)
    await askAbout(n('svc'), 'POST /orders · Service', 'why is there no SQL here?',
      'On purpose. Services call repositories, so the rules can be tested without a database.')

    await beat(3)
    await ask('remember that for next time')
    tool('remember', 'services never write SQL; repositories do')
    await wait(500)
    await line('Saved. Codex and your other agents will know it too.')
    showToast('Remembered for all your agents')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 6 · read a spreadsheet
  async function sheetStory() {
    await beat(0)
    await ask('which plan loses the most customers? customers.csv')
    think('Reading customers.csv · 2,418 rows…')
    await wait(1400)
    await line('Team, by far: 9% leave every month.')
    const sh = piece('customers.csv', 'spreadsheet', sheetBody(['plan', 'seats', 'months', 'status'], [
      ['Team', '3', '2', 'cancelled'],
      ['Pro', '1', '14', 'active'],
      ['Team', '5', '1', 'cancelled'],
      ['Starter', '1', '6', 'active'],
    ]))
    await show(sh)
    const bars = piece('Monthly churn by plan', 'bar', barsBody([
      ['Free', 41, '4.1%'],
      ['Starter', 32, '3.2%'],
      ['Pro', 24, '2.4%'],
      ['Team', 90, '9.0%', true],
    ]))
    await show(bars)
    busy(false)
    await wait(1000)

    await beat(1)
    await dragTo(bars, 'right')
    ptr.classList.remove('is-on')
    await wait(800)

    await beat(2)
    await askAbout(bars.querySelector('[data-b="3"]'), 'Monthly churn · Team', 'why is Team so high?',
      'Most leave in month two, when the trial seats run out. 61% never invited a second person.')

    await beat(3)
    await ask('save that as a note for Monday')
    tool('notes', 'create “Churn: the Team plan”')
    await wait(600)
    await line('Saved to your notes, with the chart.')
    showToast('Saved to your notes: Churn: the Team plan')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 7 · make a decision
  async function decideStory() {
    await beat(0)
    await ask('postgres or dynamodb for the events table?')
    think('Reading how events/ is queried…')
    await wait(1400)
    await line('Postgres. You look events up by user and by date, and join them to orders.')
    const cmp = piece('Events table', 'compare', compareBody([
      { title: 'Postgres', best: true, points: [['+', 'Joins with orders'], ['+', 'Already running'], ['-', 'Slows past ~500M rows']], verdict: 'Fits how you query' },
      { title: 'DynamoDB', points: [['+', 'Scales on its own'], ['-', 'No joins'], ['-', 'A second database to run']], verdict: 'Only for one key' },
      { title: 'ClickHouse', points: [['+', 'Fast for reports'], ['-', 'Slow single updates'], ['-', 'New to the team']], verdict: 'Later, for analytics' },
    ]))
    await show(cmp)
    busy(false)
    await wait(1000)

    await beat(1)
    await dragTo(cmp, 'bottom', 0.46)
    ptr.classList.remove('is-on')
    await wait(800)

    await beat(2)
    await askAbout(cmp.querySelector('[data-c="0"] [data-p="2"]'), 'Events table · Postgres', 'when would we hit that?',
      'In about four years at today’s rate. Splitting the table by month pushes it far past that.')

    await beat(3)
    await choose('Remember this decision?', 'Remember it')
    tool('remember', 'events stay in Postgres, split by month')
    await wait(600)
    await line('Saved for all your agents, with the reasons.')
    showToast('Remembered: events stay in Postgres')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 8 · write release notes
  async function notesStory() {
    await beat(0)
    await ask('write the release notes for v3.1 from the merged PRs')
    think('Reading the merged PRs…')
    await wait(1000)
    tool('gh', 'pr list --state merged · 23')
    await wait(500)
    await line('Twenty-three PRs. These are the ones a customer would notice.')
    const tl = piece('v3.1 · what changed', 'timeline', timelineBody([
      ['Nov 4', 'Search is 4× faster', '#401 · new index'],
      ['Nov 6', 'Export to CSV', '#409'],
      ['Nov 9', 'Dark mode for invoices', '#414'],
      ['Nov 12', 'Fixed: double emails', '#420', 'ok'],
    ]))
    await show(tl)
    busy(false)
    await wait(900)
    await dragTo(tl, 'right')
    ptr.classList.remove('is-on')
    await wait(500)

    await beat(1)
    await line('And the draft:')
    const doc = piece('RELEASE-v3.1.md', 'markdown', docBody(
      `<h4>v3.1</h4><p data-lead>Search queries now use a composite GIN index on (tenant_id, tsv), cutting p95 latency from 820 ms to 190 ms.</p>` +
      `<ul><li>Export any table to CSV</li><li>Invoices follow dark mode</li><li>Fixed: some emails were sent twice</li></ul>`
    ))
    await show(doc)
    busy(false)
    await wait(800)
    await dragTo(doc, 'bottom', 0.46)
    ptr.classList.remove('is-on')
    await wait(700)

    await beat(2)
    const lead = doc.querySelector('[data-lead]')
    await change(lead, 'RELEASE-v3.1.md · first paragraph', 'say it for customers, not engineers', 'RELEASE-v3.1.md, the first paragraph')
    think('Rewriting…')
    await wait(1000)
    unthink()
    lead.classList.add('is-new')
    lead.textContent = 'Search is four times faster. Results now show up as you type.'
    await line('Rewritten in plain words.')
    busy(false)
    await wait(1200)

    await beat(3)
    await choose('Publish it on GitHub Releases?', 'Publish')
    think('Publishing…')
    await wait(900)
    tool('gh', 'release create v3.1 · published')
    await line('Published.')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 9 · write a postmortem
  async function incidentStory() {
    await beat(0)
    await ask('write up last night’s outage')
    think('Reading the alerts, #incidents and the deploy log…')
    await wait(1500)
    await line('47 minutes down. A config push emptied the cache.')
    const st = piece('Outage · Nov 14', 'stats', statsBody([
      ['Down for', '47 min'],
      ['Failed orders', '1,204', '3.1% of the day', 'down'],
      ['Time to alert', '9 min', 'goal: 2', 'down'],
    ]))
    await show(st)
    const tl = piece('What happened', 'timeline', timelineBody([
      ['23:02', 'Config v88 pushed', 'cache TTL set to 0'],
      ['23:04', 'Cache hits drop to 0%'],
      ['23:11', 'Alert: checkout over 4 s', 'paged on-call', 'bad'],
      ['23:41', 'Config rolled back'],
      ['23:49', 'Back to normal', '', 'ok'],
    ]))
    await show(tl)
    busy(false)
    await wait(800)

    await beat(1)
    await dragTo(tl, 'right')
    await dragTo(st, 'bottom', 0.24)
    ptr.classList.remove('is-on')
    await wait(700)

    await beat(2)
    await askAbout(tl.querySelector('[data-t="2"]'), 'What happened · 23:11', 'why 9 minutes to alert?',
      'The alert waits for five bad minutes in a row. The cache alarm went off at 23:05, but it only sends email.')

    await beat(3)
    await ask('draft the postmortem and the follow-ups')
    think('Writing…')
    await wait(1100)
    unthink()
    const doc = piece('Postmortem · Nov 14', 'markdown', docBody(
      `<h4>Checkout outage, 23:02–23:49</h4><p>A config change set the cache lifetime to zero. Every request went to the database, and checkout timed out.</p>` +
      `<ul><li>Page on-call when cache hits fall, not email</li><li>Check config values before a push</li></ul>`
    ))
    await show(doc)
    showToast('Saved to your notes: Postmortem · Nov 14')
    await wait(1600)
    addTodo('page on cache hits, not email')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 10 · explain a bill
  async function costStory() {
    await beat(0)
    await ask('why did the AWS bill jump this month?')
    think('Reading Cost Explorer…')
    await wait(1400)
    await line('Up $3,180, and $2,740 of that is one line: NAT Gateway data.')
    const st = piece('AWS · November', 'stats', statsBody([
      ['This month', '$14,920', '+27%', 'down'],
      ['NAT Gateway', '$3,410', '+410%', 'down'],
      ['EC2', '$6,120', '+2%'],
    ]))
    await show(st)
    const bars = piece('Cost by service', 'bar', barsBody([
      ['EC2', 82, '$6,120'],
      ['NAT Gateway', 46, '$3,410', true],
      ['RDS', 33, '$2,460'],
      ['S3', 14, '$1,050'],
    ]))
    await show(bars)
    busy(false)
    await wait(900)

    await beat(1)
    await dragTo(bars, 'right')
    ptr.classList.remove('is-on')
    await wait(700)

    await beat(2)
    await askAbout(bars.querySelector('[data-b="1"]'), 'Cost by service · NAT Gateway', 'what is going through it?',
      'The image resizer reads from S3 over the public route since Nov 3. An S3 endpoint in the VPC makes that free.')

    await beat(3)
    await choose('Add the S3 endpoint?', 'Add it')
    think('Editing infra/network.tf…')
    await wait(1100)
    const t = tool('run', 'terraform plan')
    await wait(1300)
    t.textContent = 'terraform plan · 1 to add, 0 to change'
    await line('Planned, not applied. It should save about $2,700 a month.')
    addTodo('apply the S3 endpoint after review')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 11 · review a design
  const shotBody = () =>
    `<div class="shot" data-shot><div class="shot__ph"><span class="shot__x" data-close>✕</span><h4>Checkout</h4>` +
    `<label>Card number</label><div class="shot__in">4242 4242 4242 4242</div>` +
    `<div class="shot__row"><div><label class="shot__lb">Expiry</label><div class="shot__in" data-exp>MM / YY</div></div><div><label class="shot__lb">CVC</label><div class="shot__in">123</div></div></div>` +
    `<p class="shot__fine" data-fine>By paying you agree to the terms of sale</p><span class="shot__btn">Pay $48.00</span></div></div>`

  async function designStory() {
    await beat(0)
    await ask('check checkout.png for accessibility')
    think('Looking at checkout.png…')
    await wait(1300)
    await line('Three problems. Here is the screen.')
    const img = piece('checkout.png', 'image', shotBody())
    await show(img)
    busy(false)
    await wait(900)

    await beat(1)
    await dragTo(img, 'bottom', 0.56)
    ptr.classList.remove('is-on')
    await wait(500)
    const shot = img.querySelector('[data-shot]')
    mark(shot, img.querySelector('[data-fine]'), 1, 'Too faint to read')
    await wait(500)
    mark(shot, img.querySelector('[data-exp]'), 2, 'No label', true)
    await wait(500)
    mark(shot, img.querySelector('[data-close]'), 3, 'Too small to tap')
    await wait(1600)

    await beat(2)
    await askAbout(img.querySelector('[data-exp]'), 'checkout.png · MM / YY', 'why does that matter?',
      'A screen reader only says “edit text”. And once you start typing, the hint is gone too.')

    await beat(3)
    await ask('fix all three in checkout.tsx')
    think('Editing checkout.tsx and checkout.css…')
    await wait(1200)
    tool('edit', 'checkout.tsx, checkout.css · 3 changes')
    shot.querySelectorAll('.mark').forEach((m) => m.remove())
    shot.classList.add('is-fixed')
    img.querySelector('.pc__h b').textContent = 'localhost:5173/checkout'
    img.querySelector('.pc__k').textContent = 'page'
    await line('Fixed. That is the live page now, not the picture.')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 12 · plan the day
  async function dayStory() {
    await beat(0)
    await ask('what do I need to do today?')
    think('Checking mail, Slack and GitHub…')
    await wait(1100)
    tool('gmail', '14 new · 2 need you')
    addTodo('reply to finance about the Q4 invoice')
    await wait(1500)
    tool('slack', '5 mentions · 1 needs you')
    addTodo('answer the layout question in #web')
    await wait(1500)
    tool('github', '1 review asked')
    addTodo('review PR #422')
    await wait(1500)

    await beat(1)
    await line('Three new, six in all. I’d go in this order:')
    const tb = piece('Today', 'table', tableBody(['What', 'From', 'Why now'], [
      ['Review PR #422', 'GitHub', 'blocks the release'],
      ['Q4 invoice', 'Gmail', 'due at 12:00'],
      ['Layout question', 'Slack', 'waiting since Friday'],
    ]))
    await show(tb)
    busy(false)
    await wait(900)
    await dragTo(tb, 'right')
    ptr.classList.remove('is-on')
    await wait(600)

    await beat(2)
    await ask('the invoice one is done already')
    tool('todo', 'done · reply to finance about the Q4 invoice')
    tb.querySelector('[data-r="1"]').classList.add('is-done')
    tickTodo('the Q4 invoice')
    await line('Ticked off.')
    busy(false)
    await wait(1400)

    await beat(3)
    await choose('Start a session on PR #422?', 'Start it')
    newCard('Review PR #422', 'Opus 5.5 · 2%')
    await wait(600)
    await line('It is open in a new session, reading the diff.')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 13 · learn how something works
  async function explainStory() {
    await beat(0)
    await ask('how does “Sign in with Google” work? I’m new to this')
    think('Drawing it…')
    await wait(1200)
    await line('Your app never sees the password. Google gives it a short code instead.')
    const sq = piece('Sign in with Google', 'diagram', seqBody(['You', 'Your app', 'Google'], [
      [0, 1, 'Click “Sign in with Google”'],
      [1, 2, 'Send you to Google'],
      [0, 2, 'Type your password'],
      [2, 1, 'Hand back a one-time code'],
      [1, 2, 'Trade the code for a token'],
      [2, 1, 'Token: who you are'],
    ]))
    await show(sq)
    busy(false)
    await wait(900)
    await dragTo(sq, 'right')
    ptr.classList.remove('is-on')
    await wait(600)

    await beat(1)
    await ask('walk me through it')
    const m = (k) => sq.querySelector(`[data-m="${k}"] span`)
    await walkThrough(
      [
        [m(1), 'Your app sends you away'],
        [m(2), 'Only Google sees the password'],
        [m(3), 'A code, useless on its own'],
        [m(4), 'The real trade, server to server'],
      ],
      { x: narrow ? 160 : 560, y: narrow ? 240 : 300 }
    )
    await line('That is the whole idea. The password stays with Google.')
    busy(false)
    await wait(900)

    await beat(2)
    await askAbout(m(4), 'Sign in with Google · step 5', 'why not send the token straight away?',
      'The code passes through the browser, where it can leak. The trade is server to server, with your app’s secret.')
  }

  // ================================================================ 14 · triage issues
  async function triageStory() {
    await beat(0)
    await ask('sort the open issues by how much they hurt users')
    think('Reading the open issues…')
    await wait(1000)
    tool('gh', 'issue list · 41 open')
    await wait(600)
    await line('Three matter now. Eleven are duplicates.')
    const tb = piece('Open issues, worst first', 'table', tableBody(['Issue', '#Reports', 'Impact'], [
      ['#512 Login loops on Safari', '212', '<em class="hi">High</em>'],
      ['#498 Export times out', '64', '<em class="hi">High</em>'],
      ['#505 Wrong currency on receipts', '31', '<em class="md">Medium</em>'],
      ['11 duplicates', '—', '<em class="lo">Close</em>'],
    ]))
    await show(tb)
    busy(false)
    await wait(900)

    await beat(1)
    await dragTo(tb, 'bottom', 0.4)
    ptr.classList.remove('is-on')
    await wait(800)

    await beat(2)
    await askAbout(tb.querySelector('[data-r="0"] td'), 'Open issues · #512', 'is this new?',
      'Since Tuesday’s release. Safari drops the session cookie after the change in PR #491.')

    await beat(3)
    await choose('Close the 11 duplicates, linking each to its original?', 'Close them')
    think('Closing…')
    await wait(1000)
    tool('gh', 'issue close · 11 closed, each with a link')
    tb.querySelector('[data-r="3"]').classList.add('is-done')
    await line('Done. 30 open now.')
    addTodo('fix #512 first')
    busy(false)
    await wait(4000)
  }

  // ================================================================ 15 · audit packages
  async function auditStory() {
    await beat(0)
    await ask('are any of our packages vulnerable?')
    think('Running the audit…')
    await wait(1000)
    tool('run', 'pnpm audit · 4 found')
    await wait(500)
    await line('Four. One is serious, and the upload route reaches it.')
    const tb = piece('pnpm audit', 'table', tableBody(['Package', 'Severity', 'Fixed in'], [
      ['img-probe 1.0.2', '<em class="hi">High</em>', '1.2.1'],
      ['xmlish 3.4.0', '<em class="md">Medium</em>', '3.4.3'],
      ['tinyduration 2.1.1', '<em class="lo">Low</em>', '2.1.3'],
      ['urlkit 6.9.0', '<em class="lo">Low</em>', '6.9.4'],
    ]))
    await show(tb)
    busy(false)
    await wait(900)
    await dragTo(tb, 'right')
    ptr.classList.remove('is-on')
    await wait(600)

    await beat(1)
    await ask('fix them, one at a time, tests after each')
    const pl = startPlan('Upgrade 4 packages', ['img-probe → 1.2.1', 'xmlish → 3.4.3', 'tinyduration → 2.1.3', 'urlkit → 6.9.4'])
    await show(pl)
    for (let i = 0; i < 4; i++) {
      step(i, 'active')
      await wait(900)
      step(i, 'done')
      tb.querySelector(`[data-r="${i}"]`).classList.add('is-done')
    }
    const t = tool('run', 'pnpm test')
    await wait(1200)
    t.textContent = 'pnpm test · 211 passed'
    busy(false)
    await wait(1000)

    await beat(2)
    await askAbout(tb.querySelector('[data-r="0"] td'), 'pnpm audit · img-probe', 'were we actually exposed?',
      'No. The bug needs uploads over 20 MB, and the proxy stops anything over 10 MB.')

    await beat(3)
    await choose('Open a pull request?', 'Open the PR')
    think('Pushing…')
    await wait(1000)
    await line('PR #431 is open, with the audit in the description.')
    busy(false)
    await wait(4000)
  }

  // ================================================================ the scenes
  const SCENES = [
    {
      tab: 'Run a project',
      session: ['Ship v2.4', 'Opus 5.5 · 24%'],
      story: projectStory,
      moments: [
        ['Split the work', 10000, 'Hand it a release. It plans the work and sends a subagent to each part.'],
        ['Pin the board', 4500, 'Pin the board along the bottom. It moves as the work lands.'],
        ['Check one', 10500, 'One hits a failing test. Click it to see what it did, and watch it fix it.'],
        ['Ship', 9000, 'All in and passing. One click to tag the release.'],
      ],
    },
    {
      tab: 'Fix a bug',
      session: ['Checkout 503s', 'Opus 5.5 · 18%'],
      story: bugStory,
      moments: [
        ['Ask', 9500, 'Ask what is wrong, in plain words. The answer comes with the evidence.'],
        ['Pin it', 7500, 'Pin the chart to the side. The agent shows you the code that causes it.'],
        ['Change it', 10000, 'Right-click the line and say what to change. It is edited, and the tests run.'],
        ['Ship', 7500, 'One click opens the PR. The chart shows the fix holding.'],
      ],
    },
    {
      tab: 'Build a page',
      session: ['Pricing page', 'Opus 5.5 · 9%'],
      story: pageStory,
      moments: [
        ['Ask', 9000, 'Ask for a change. The page comes back live from your dev server.'],
        ['Pin it', 4500, 'Pin the page along the bottom, and keep talking above it.'],
        ['Point', 7500, 'Ask where something comes from. It marks it on the page.'],
        ['Change it', 9500, 'Right-click the page and say what to change. It reloads in front of you.'],
      ],
    },
    {
      tab: 'Review a contract',
      session: ['Vendor contract', 'Opus 5.5 · 22%'],
      story: contractStory,
      moments: [
        ['Ask', 11000, 'Hand it a contract. It finds what to watch, and pins the PDF beside you.'],
        ['Walk through', 11500, 'It scrolls the PDF and points at each clause, one step at a time.'],
        ['Ask about it', 9000, 'Right-click a clause to ask about it, right there.'],
        ['Draft', 8500, 'It drafts the email, and keeps it in your notes.'],
      ],
    },
    // ---- behind "More examples"
    {
      tab: 'Map the system',
      more: true,
      session: ['Architecture', 'Opus 5.5 · 12%'],
      story: systemStory,
      moments: [
        ['Ask', 12000, 'Ask for a picture of the system. It reads the code and draws it.'],
        ['Ask about it', 9000, 'Right-click any box to ask about it.'],
        ['Change it', 9500, 'Say what should change. The diagram is redrawn in place.'],
        ['Plan it', 8500, 'One click turns it into a plan, saved with the code.'],
      ],
    },
    {
      tab: 'Learn a codebase',
      more: true,
      session: ['New repo', 'Opus 5.5 · 7%'],
      story: learnStory,
      moments: [
        ['Ask', 10500, 'New to a codebase? Ask how it fits together.'],
        ['Walk through', 12000, 'It points at each part, one step at a time.'],
        ['Ask about it', 9000, 'Right-click a part to ask why it is built that way.'],
        ['Remember', 6500, 'Ask it to remember. Every agent you use will know it next time.'],
      ],
    },
    {
      tab: 'Read a spreadsheet',
      more: true,
      session: ['Churn', 'Opus 5.5 · 10%'],
      story: sheetStory,
      moments: [
        ['Ask', 10000, 'Hand it a CSV and ask a plain question. The answer comes as a chart.'],
        ['Pin it', 4500, 'Pin the chart beside you.'],
        ['Ask about it', 9500, 'Right-click a bar to ask what is behind it.'],
        ['Keep it', 6000, 'Keep the answer in your notes.'],
      ],
    },
    {
      tab: 'Make a decision',
      more: true,
      session: ['Events storage', 'Opus 5.5 · 14%'],
      story: decideStory,
      moments: [
        ['Ask', 10000, 'Ask which option fits. It compares them against your own code.'],
        ['Pin it', 4500, 'Pin the comparison along the bottom.'],
        ['Ask about it', 9500, 'Right-click a point to dig into it.'],
        ['Remember', 6500, 'Keep the decision, and the reasons, for every agent.'],
      ],
    },
    {
      tab: 'Release notes',
      more: true,
      session: ['v3.1 notes', 'Opus 5.5 · 9%'],
      story: notesStory,
      moments: [
        ['Ask', 10000, 'Ask for release notes. It reads the merged PRs and lays them out.'],
        ['Draft', 6000, 'The draft comes as a document you can pin.'],
        ['Change it', 9500, 'Right-click a paragraph and say how to change it.'],
        ['Publish', 6500, 'One click publishes it.'],
      ],
    },
    {
      tab: 'Write a postmortem',
      more: true,
      session: ['Outage Nov 14', 'Opus 5.5 · 21%'],
      story: incidentStory,
      moments: [
        ['Ask', 11000, 'Ask what happened. It reads the alerts, the chat and the deploys.'],
        ['Pin it', 6000, 'Pin the timeline and the numbers.'],
        ['Ask about it', 9500, 'Right-click a moment to ask about it.'],
        ['Draft', 8000, 'It drafts the postmortem and adds the follow-ups to your todos.'],
      ],
    },
    {
      tab: 'Explain a bill',
      more: true,
      session: ['AWS bill', 'Opus 5.5 · 11%'],
      story: costStory,
      moments: [
        ['Ask', 10000, 'Ask why the bill went up. It shows where the money went.'],
        ['Pin it', 4500, 'Pin the costs beside you.'],
        ['Ask about it', 9500, 'Right-click the line that grew to find out why.'],
        ['Fix it', 9000, 'It makes the change and plans it. Nothing is applied until you say so.'],
      ],
    },
    {
      tab: 'Review a design',
      more: true,
      session: ['Checkout a11y', 'Opus 5.5 · 13%'],
      story: designStory,
      moments: [
        ['Ask', 9000, 'Drop in a screenshot and ask for a review.'],
        ['Mark it', 7000, 'Pin it, and each problem is marked on the picture.'],
        ['Ask about it', 9000, 'Right-click a mark to ask why it matters.'],
        ['Fix it', 7500, 'Ask for the fix. The picture becomes the live page.'],
      ],
    },
    {
      tab: 'Plan the day',
      more: true,
      session: ['Morning', 'Opus 5.5 · 6%'],
      story: dayStory,
      moments: [
        ['Ask', 10000, 'Ask what needs you today. It reads your mail, Slack and GitHub.'],
        ['Order it', 7000, 'Your todos, in the order to do them.'],
        ['Tick one', 5500, 'Tell it what is done. It comes off the list.'],
        ['Start one', 7000, 'Start a session on the next one, in a new tab.'],
      ],
    },
    {
      tab: 'Learn how it works',
      more: true,
      session: ['Sign-in', 'Opus 5.5 · 5%'],
      story: explainStory,
      moments: [
        ['Ask', 10000, 'Ask how something works. The answer comes as a picture.'],
        ['Walk through', 12500, 'It points at each step and says what happens.'],
        ['Ask about it', 10000, 'Right-click a step to ask why.'],
      ],
    },
    {
      tab: 'Triage issues',
      more: true,
      session: ['Issues', 'Opus 5.5 · 15%'],
      story: triageStory,
      moments: [
        ['Ask', 10000, 'Ask which issues hurt users most.'],
        ['Pin it', 4500, 'Pin the list along the bottom.'],
        ['Ask about it', 9000, 'Right-click one to ask about it.'],
        ['Clean up', 8000, 'One click closes the duplicates.'],
      ],
    },
    {
      tab: 'Audit packages',
      more: true,
      session: ['Security', 'Opus 5.5 · 16%'],
      story: auditStory,
      moments: [
        ['Ask', 10500, 'Ask if anything you depend on is unsafe.'],
        ['Fix them', 9000, 'It upgrades them one at a time and runs the tests.'],
        ['Ask about it', 9000, 'Right-click a package to ask if you were exposed.'],
        ['Ship', 6000, 'One click opens the PR.'],
      ],
    },
  ]
  const FIRST_MORE = SCENES.findIndex((s) => s.more)
  const slugOf = (s) => s.tab.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  // ---------------------------------------------------------------- the buttons under the demo
  let sceneNow = 0
  const extra = SCENES.length - FIRST_MORE
  scenesEl.innerHTML =
    SCENES.map((s, i) => `<button type="button" role="tab" data-sc="${i}"${s.more ? ' hidden' : ''}>${s.tab}</button>`).join('') +
    `<button type="button" class="scenes__more" data-more aria-expanded="false">More examples <span>+${extra}</span></button>`
  const sceneBtns = [...scenesEl.querySelectorAll('[data-sc]')]
  const moreBtn = scenesEl.querySelector('[data-more]')
  // The extra examples stay out of the list, and out of the autoplay, until asked for.
  let showAll = false
  function setMore(on) {
    showAll = on
    sceneBtns.forEach((b, i) => {
      if (!SCENES[i].more) return
      b.hidden = !on
      b.classList.toggle('is-reveal', on)
    })
    moreBtn.setAttribute('aria-expanded', String(on))
    moreBtn.innerHTML = on ? 'Fewer examples' : `More examples <span>+${extra}</span>`
  }
  moreBtn.addEventListener('click', () => {
    setMore(!showAll)
    if (!showAll && SCENES[sceneNow].more) {
      paused = false
      pauseBtn.classList.remove('is-paused')
      history.replaceState(null, '', location.pathname + location.search)
      void play(0, 0)
    }
  })
  const nextScene = (sc) => (showAll ? (sc + 1) % SCENES.length : sc + 1 >= FIRST_MORE ? 0 : sc + 1)
  let beatBtns = []
  function buildMoments(sc) {
    momentsEl.querySelectorAll('[data-ch]').forEach((b) => b.remove())
    const html = SCENES[sc].moments.map(([label], i) => `<button type="button" data-ch="${i}"><span>${i + 1}</span>${label}<i><b></b></i></button>`).join('')
    pauseBtn.insertAdjacentHTML('beforebegin', html)
    beatBtns = [...momentsEl.querySelectorAll('[data-ch]')]
    beatBtns.forEach((b) => b.addEventListener('click', () => {
      paused = false
      pauseBtn.classList.remove('is-paused')
      void play(sceneNow, Number(b.dataset.ch))
    }))
    sceneBtns.forEach((b, i) => {
      b.classList.toggle('is-on', i === sc)
      b.setAttribute('aria-selected', String(i === sc))
    })
    // a tab bar that scrolls sideways (phones) keeps the playing one in view
    if (scenesEl.scrollWidth > scenesEl.clientWidth + 1) {
      const b = sceneBtns[sc]
      scenesEl.scrollTo({ left: Math.max(0, b.offsetLeft - 12), behavior: reduced ? 'auto' : 'smooth' })
    }
  }

  // ---------------------------------------------------------------- playing them
  const took = SCENES.map(() => [])
  let beatAt = 0
  let pausedAt = 0
  let playing = false

  async function beat(i) {
    beatNow = i
    // a breath before each new moment, so the eye can catch up
    if (i > 0 && !skipping()) await wait(550)
    if (i >= skipTo && skipTo >= 0) {
      skipTo = -1
      // Let the replayed state settle without animating, then play on.
      await frame()
      root.classList.remove('is-ff')
    }
    const t = took[sceneNow]
    if (i > 0 && !skipping() && beatAt && !reduced) t[i - 1] = t[i - 1] || performance.now() - beatAt
    beatAt = performance.now()
    cap.textContent = SCENES[sceneNow].moments[i][2]
    beatBtns.forEach((b, j) => b.classList.toggle('is-on', j === i))
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
    ember(false)
    snaps.right = null
    bottoms.length = 0
    depth = 0.42
    col.querySelector('.subagents')?.remove()
    cv.querySelector('.apop')?.remove()
    col.style.width = col.style.height = ''
    todoN.textContent = '3'
    busy(false)
    cards.children[1].classList.remove('is-busy')
    cards.children[1].querySelector('small').textContent = 'Codex · idle'
    cards.querySelectorAll('[data-extra]').forEach((c) => c.remove())
    beatNow = 0
    say = null
  }

  async function play(sc, from = 0) {
    const id = ++run
    playing = true
    for (;;) {
      sceneNow = sc
      buildMoments(sc)
      const [title, sub] = SCENES[sc].session
      cards.firstElementChild.querySelector('b').textContent = title
      cards.firstElementChild.querySelector('small').textContent = sub
      reset()
      skipTo = reduced ? Infinity : from
      root.classList.toggle('is-ff', skipTo > 0)
      try {
        await SCENES[sc].story()
      } catch (e) {
        if (e instanceof Stop) return
        throw e
      }
      if (id !== run) return
      const t = took[sc]
      t[SCENES[sc].moments.length - 1] = t[SCENES[sc].moments.length - 1] || performance.now() - beatAt
      if (reduced) {
        root.classList.remove('is-ff')
        return
      }
      sc = nextScene(sc)
      from = 0
    }
  }

  sceneBtns.forEach((b) => b.addEventListener('click', () => {
    paused = false
    pauseBtn.classList.remove('is-paused')
    const sc = Number(b.dataset.sc)
    // a link straight to this example, to share
    history.replaceState(null, '', `#use/${slugOf(SCENES[sc])}`)
    void play(sc, 0)
  }))

  // #use/<slug> opens on that example.
  const linked = (() => {
    const m = /^#use\/([a-z0-9-]+)$/.exec(location.hash)
    return m ? SCENES.findIndex((s) => slugOf(s) === m[1]) : -1
  })()
  if (linked >= 0) {
    if (SCENES[linked].more) setMore(true)
    requestAnimationFrame(() => document.getElementById('demo')?.scrollIntoView({ block: 'start' }))
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
      const moments = SCENES[sceneNow].moments
      beatBtns.forEach((b, j) => {
        const bar = b.querySelector('b')
        if (j < beatNow) bar.style.width = '100%'
        else if (j > beatNow) bar.style.width = '0%'
        else {
          const t = Math.min(0.99, ((pausedAt || performance.now()) - beatAt) / (took[sceneNow][j] || moments[j][1]))
          bar.style.width = `${(t * 100).toFixed(1)}%`
        }
      })
    }
    requestAnimationFrame(progress)
  })()

  pauseBtn.addEventListener('click', () => {
    paused = !paused
    pauseBtn.classList.toggle('is-paused', paused)
    pauseBtn.setAttribute('aria-label', paused ? 'Play the demo' : 'Pause the demo')
  })

  // Only plays while it can be seen.
  let visible = false
  new IntersectionObserver(
    ([e]) => {
      visible = e.isIntersecting
      if (visible && !playing) void play(Math.max(0, linked), 0)
      if (!reduced && !pauseBtn.classList.contains('is-paused')) paused = !visible
    },
    { threshold: 0.25 }
  ).observe(root)
}
