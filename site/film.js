// The demo in the hero: Ember's window, rebuilt in HTML, playing real pieces of work from
// start to finish. Four of them: fixing a bug, building a page, reviewing a contract, and
// working another app. Nothing is a video.
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
  const sheet = q('[data-sheet]')
  const stop = q('[data-stop]')
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

  // ---------------------------------------------------------------- the plan, on top
  function startPlan(title, steps) {
    plan.innerHTML =
      `<div class="plan__h"><b>${title}</b><span data-plan-n>0/${steps.length}</span></div>` +
      `<div class="plan__bar"><i data-plan-bar></i></div>` +
      `<ol>${steps.map((s) => `<li data-s="pending"><i></i><span>${s}</span></li>`).join('')}</ol>`
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
    startPlan('Ship v2.4', ['Payments: retry failed charges', 'Search: index the new fields', 'Web: saved carts'])
    TICKETS.forEach((_, i) => step(i, 'active'))
    const row = agentsRow()
    await line('Three subagents are on it, one per part.')
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

  // ================================================================ 4 · work another app
  const CSV = [
    ['EMEA', '412,300'],
    ['North America', '655,900'],
    ['LATAM', '128,400'],
    ['APAC', '301,750'],
  ]
  function buildSheet() {
    const rows = [['Region', 'Q3 revenue', 'Target'], ...CSV.map(([r], i) => [r, '', ['400,000', '700,000', '120,000', '280,000'][i]]), [], ['Total', '', '1,500,000']]
    let g = '<span class="rh"></span>' + 'ABC'.split('').map((c) => `<span class="colh">${c}</span>`).join('')
    for (let r = 0; r < 12; r++) {
      const row = rows[r] || []
      g += `<span class="rh">${r + 1}</span>`
      for (let c = 0; c < 3; c++) {
        const cls = [r === 0 && 'th', c > 0 && r > 0 && 'num', r === 6 && 'tot'].filter(Boolean).join(' ')
        const n = c === 1 && r >= 1 && r <= 4 ? ` data-n="#${20 + r}"` : c === 1 && r === 6 ? ' data-n="#41"' : ''
        g += `<span data-c="${'ABC'[c]}${r + 1}" class="${cls}"${n}>${row[c] ?? ''}</span>`
      }
    }
    sheet.innerHTML =
      `<div class="sheet__t"><b>Q3 revenue.xlsx<i data-dirty></i></b><span class="sheet__share" data-n="#9" data-share>Share</span><span>— ▢ ✕</span></div>` +
      `<div class="sheet__tabs"><span class="is-on">Home</span><span>Insert</span><span>Data</span><span>View</span></div>` +
      `<div class="sheet__fx"><span data-ref>A1</span><i>fx</i><span data-fx></span></div>` +
      `<div class="sheet__g">${g}</div>`
  }

  async function appStory() {
    buildSheet()
    await beat(0)
    await ask('put the Q3 totals from invoices.csv into the finance sheet')
    think('Reading invoices.csv…')
    await wait(1300)
    await line('Four regions. I’ll fill them in; you can watch.')
    busy(false)
    await wait(900)

    await beat(1)
    sheet.classList.add('is-on')
    stop.classList.add('is-on')
    if (!narrow) {
      // the window opens beside the reply, and the words make room for it
      col.style.width = `${cv.offsetWidth - 540}px`
    }
    busy(true)
    await wait(600)
    // what look hands back: every control, numbered
    const look = tool('look', 'Q3 revenue.xlsx')
    await wait(500)
    sheet.classList.add('is-numbered')
    look.textContent = 'Q3 revenue.xlsx · 64 controls'
    await wait(2400)
    sheet.classList.remove('is-numbered')

    await beat(2)
    const act = tool('act', '')
    const add = (s) => (act.textContent += `${act.textContent ? ' · ' : ''}${s}`)
    ember(true)
    P.x = narrow ? 200 : 700
    P.y = 300
    placePtr()
    const ref = sheet.querySelector('[data-ref]')
    const fx = sheet.querySelector('[data-fx]')
    const select = (cell, r) => {
      sheet.querySelectorAll('.is-sel').forEach((c) => c.classList.remove('is-sel'))
      cell.classList.add('is-sel')
      ref.textContent = r
    }
    for (let i = 0; i < CSV.length; i++) {
      const cell = sheet.querySelector(`[data-c="B${i + 2}"]`)
      tag.textContent = `#${21 + i}`
      add(`#${21 + i}`)
      await glide(mid(cell))
      ripple(mid(cell))
      select(cell, `B${i + 2}`)
      await typeInto(cell, CSV[i][1], 30)
      fx.textContent = CSV[i][1]
      await wait(150)
    }
    const b7 = sheet.querySelector('[data-c="B7"]')
    tag.textContent = '#41'
    add('#41')
    await glide(mid(b7))
    ripple(mid(b7))
    select(b7, 'B7')
    await typeInto(b7, '=SUM(B2:B5)', 40)
    fx.textContent = '=SUM(B2:B5)'
    await wait(250)
    b7.textContent = '1,498,350'
    b7.classList.add('is-new')
    tag.textContent = ''
    await wait(500)
    await line('Done. The total matches the invoices.')
    await wait(1000)

    await beat(3)
    await choose('Share it with finance?', 'Share it')
    ember(true)
    P.x = narrow ? 300 : 760
    P.y = 400
    placePtr()
    tag.textContent = '#9'
    await click(sheet.querySelector('[data-share]'))
    tag.textContent = ''
    await wait(500)
    stop.classList.remove('is-on')
    ptr.classList.remove('is-on')
    ember(false)
    // a phone's canvas is all window: it steps back so the answer can be read
    if (narrow) sheet.classList.remove('is-on')
    await line('Shared. STOP is gone: it is done with your computer.')
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
    {
      tab: 'Use another app',
      session: ['Q3 close', 'Opus 5.5 · 15%'],
      story: appStory,
      moments: [
        ['Ask', 7500, 'Ask for work that happens in another app.'],
        ['Look', 4500, 'It reads the window as text, every control numbered. No screenshots.'],
        ['Act', 11000, 'It works the app with its own pointer. STOP is always on screen.'],
        ['Share', 8000, 'It asks before anything leaves your machine.'],
      ],
    },
  ]

  // ---------------------------------------------------------------- the buttons under the demo
  let sceneNow = 0
  scenesEl.innerHTML = SCENES.map((s, i) => `<button type="button" role="tab" data-sc="${i}">${s.tab}</button>`).join('')
  const sceneBtns = [...scenesEl.querySelectorAll('[data-sc]')]
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
    sheet.classList.remove('is-on', 'is-numbered')
    stop.classList.remove('is-on')
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
      sc = (sc + 1) % SCENES.length
      from = 0
    }
  }

  sceneBtns.forEach((b) => b.addEventListener('click', () => {
    paused = false
    pauseBtn.classList.remove('is-paused')
    void play(Number(b.dataset.sc), 0)
  }))

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
      if (visible && !playing) void play(0, 0)
      if (!reduced && !pauseBtn.classList.contains('is-paused')) paused = !visible
    },
    { threshold: 0.25 }
  ).observe(root)
}
