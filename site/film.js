// The demo in the hero: Ember's window, rebuilt in HTML, playing one chapter per feature.
// Everything is drawn here; nothing is a video. Chapters run in order and loop while the
// demo is on screen; a click on a chapter jumps to it. Reduced motion shows each chapter's
// end state, still.

const root = document.querySelector('[data-demo]')
if (root) start()

function start() {
  const q = (s) => root.querySelector(s)
  const desk = q('.desk')
  const win = q('[data-win]')
  const pane = q('[data-pane]')
  const cv = q('[data-cv]')
  const col = q('[data-col]')
  const you = q('[data-you]')
  const youT = q('[data-you-t]')
  const say = q('[data-say]')
  const say2 = q('[data-say2]')
  const obj = q('[data-obj]')
  const rz = q('[data-rz]')
  const inp = q('[data-inp]')
  const inpT = q('[data-inp-t]')
  const ph = q('[data-ph]')
  const sticky = q('[data-sticky]')
  const stickyT = q('[data-sticky-t]')
  const legend = q('[data-legend]')
  const full = q('[data-full]')
  const zoom = q('[data-zoom]')
  const zpct = q('[data-zpct]')
  const sheet = q('[data-sheet]')
  const board = q('[data-board]')
  const plan = q('[data-plan]')
  const stop = q('[data-stop]')
  const keysEl = q('[data-keys]')
  const ptr = q('[data-ptr]')
  const tag = q('[data-tag]')
  const chip = q('[data-chip]')
  const chipName = q('[data-chip-name]')
  const pmenu = q('[data-pmenu]')
  const plus = q('[data-plus]')
  const cards = q('[data-cards]')
  const todoN = q('[data-todo-n]')
  const model = q('[data-model]')
  const startEl = q('[data-start]')
  const startT = q('[data-start-t]')
  const cap = document.querySelector('[data-cap]')
  const chapterBtns = [...document.querySelectorAll('[data-ch]')]
  const pauseBtn = document.querySelector('[data-pause]')

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------------------------------------------------------------- the spreadsheet, for computer use
  const ROWS = [
    ['Region', 'Revenue', 'Target', 'vs target'],
    ['EMEA', '412,300', '400,000', '103%'],
    ['North America', '655,900', '700,000', '94%'],
    ['LATAM', '128,400', '120,000', '107%'],
    ['APAC', '301,750', '280,000', '108%'],
    [],
    ['Total'],
  ]
  function buildSheet() {
    let g = '<span class="rh"></span>' + 'ABCD'.split('').map((c) => `<span class="ch">${c}</span>`).join('')
    for (let r = 0; r < 15; r++) {
      const row = ROWS[r] || []
      g += `<span class="rh">${r + 1}</span>`
      for (let c = 0; c < 4; c++) {
        const cls = [r === 0 && 'th', c > 0 && r > 0 && 'num', r === 6 && c === 0 && 'tot'].filter(Boolean).join(' ')
        g += `<span data-c="${'ABCD'[c]}${r + 1}" class="${cls}">${row[c] ?? ''}</span>`
      }
    }
    // the chart it inserts: revenue by region
    const vals = [412, 656, 128, 302]
    const bars = vals.map((v, i) => `<rect x="${22 + i * 44}" y="${104 - v / 7}" width="28" height="${v / 7}" rx="3" style="--d:${i * 90}ms"/>`).join('')
    const names = ['EMEA', 'N. Am.', 'LATAM', 'APAC'].map((n, i) => `<text x="${36 + i * 44}" y="118">${n}</text>`).join('')
    sheet.innerHTML =
      `<div class="sheet__t"><b><span data-sheet-name>Q3 revenue.xlsx</span><i data-dirty></i></b><span>— ▢ ✕</span></div>` +
      `<div class="sheet__tabs"><span class="is-on">Home</span><span>Insert</span><span>Data</span><span>View</span></div>` +
      `<div class="sheet__tools"><span>Σ AutoSum</span><span data-tool="chart">▥ Chart</span><span><b>B</b></span><span>%</span><span>,00</span></div>` +
      `<div class="sheet__fx"><span data-ref>A1</span><i>fx</i><span data-fx></span></div>` +
      `<div class="sheet__g">${g}</div>` +
      `<div class="sheet__chart" data-chart><b>Revenue by region</b><svg viewBox="0 0 200 124">${bars}${names}</svg></div>`
  }

  // ---------------------------------------------------------------- pieces on the canvas
  // What an agent puts on the canvas: files (PDF, Markdown, CSV, video), views drawn
  // from data (kanban, stats, a chart, a timeline), and the plan of the work on top.
  function piece(cls, title, kind, body) {
    const el = document.createElement('div')
    el.className = `pc ${cls}`
    el.innerHTML = `<div class="pc__h"><b>${title}</b><span>${kind}</span></div><div class="pc__b">${body}</div>`
    board.appendChild(el)
    return el
  }
  /** Place a piece at [x, y, w, h] in the canvas, let it land, then snap. */
  async function arrive(el, [x, y, w, h]) {
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    void el.offsetWidth
    el.classList.add('is-on')
    await wait(240)
    el.classList.add('is-snap')
    setTimeout(() => el.classList.remove('is-snap'), 520)
  }
  /** Move an element in the DOM and let it travel there, instead of jumping. */
  function flip(el, mutate) {
    const a = el.getBoundingClientRect()
    mutate()
    if (reduced) return
    const b = el.getBoundingClientRect()
    el.animate(
      [{ transform: `translate(${(a.left - b.left) / scale}px, ${(a.top - b.top) / scale}px)` }, { transform: 'none' }],
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    )
  }

  function startPlan(title, steps) {
    plan.innerHTML =
      `<div class="plan__h"><b>${title}</b><span data-plan-n>0/${steps.length}</span></div>` +
      `<div class="plan__bar"><i data-plan-bar></i></div>` +
      `<ol>${steps.map((s) => `<li data-s="pending"><i></i><span>${s}</span></li>`).join('')}</ol>`
    plan.classList.add('is-on')
  }
  function planStep(i, state) {
    const li = plan.querySelectorAll('li')
    li[i].dataset.s = state
    const done = plan.querySelectorAll('li[data-s="done"]').length
    plan.querySelector('[data-plan-n]').textContent = `${done}/${li.length}`
    plan.querySelector('[data-plan-bar]').style.width = `${(done / li.length) * 100}%`
  }

  const TICKETS = [
    ['API-142', 'Rate-limit the login endpoint'],
    ['API-145', 'Return 429 with Retry-After'],
    ['WEB-88', 'Friendly message on 429'],
    ['QA-31', 'Load test for login'],
  ]
  const kanbanBody = () =>
    `<div class="kb">${['To do', 'Doing', 'Done']
      .map(
        (name, i) =>
          `<div class="kb__c" data-col="${i}"><h6>${name}<i>${i ? 0 : TICKETS.length}</i></h6>${
            i ? '' : TICKETS.map(([id, t]) => `<div class="kc" data-id="${id}"><b>${id}</b><small>${t}</small></div>`).join('')
          }</div>`
      )
      .join('')}</div>`
  function moveCard(kb, id, col) {
    const card = kb.querySelector(`[data-id="${id}"]`)
    flip(card, () => kb.querySelector(`[data-col="${col}"]`).appendChild(card))
    kb.querySelectorAll('.kb__c').forEach((c) => (c.querySelector('h6 i').textContent = c.querySelectorAll('.kc').length))
  }

  const pdfBody = () =>
    `<div class="pdf"><div class="pdf__bar"><span>‹ 3 / 12 ›</span><span>− 100% +</span></div><div class="pdf__page">` +
    `<h4>Master Services Agreement</h4><p class="ln" style="width:94%"></p><p class="ln" style="width:88%"></p><p class="ln" style="width:72%"></p>` +
    `<p class="cl" data-clause><b>7.2 Termination.</b> Either party may end this agreement with thirty (30) days’ written notice.</p>` +
    `<p class="ln" style="width:90%"></p><p class="ln" style="width:84%"></p><p class="ln" style="width:60%"></p></div></div>`
  const mdBody = () =>
    `<div class="md"><h4>payments-api</h4><p>Card and invoice payments for the store.</p><h5>Run locally</h5>` +
    `<pre>pnpm install\npnpm dev</pre><ul><li>Node 22 or later</li><li>Test keys in <code>.env.local</code></li></ul></div>`
  const INVOICES = [
    ['INV-2041', 'Northwind', '4,800', 'Nov 12'],
    ['INV-2042', 'Contoso', '12,350', 'Nov 15'],
    ['INV-2043', 'Fabrikam', '2,190', 'Nov 18'],
    ['INV-2044', 'Tailspin', '7,600', 'Nov 20'],
  ]
  const csvBody = () =>
    `<table class="csv"><thead><tr><th>Invoice</th><th>Client</th><th data-sort>Amount <i>↕</i></th><th>Due</th></tr></thead>` +
    `<tbody>${INVOICES.map((r) => `<tr data-v="${r[2].replace(',', '')}">${r.map((v, i) => `<td${i === 2 ? ' class="num"' : ''}>${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  const videoBody = () =>
    `<div class="vid"><div class="vid__frame"><div class="vid__ui"><i></i><i></i><i></i><b></b></div><span class="vid__play">▶</span></div>` +
    `<div class="vid__ctl"><span>❚❚</span><span class="vid__bar"><i data-vbar></i></span><span data-vt>0:00 / 3:15</span></div></div>`

  const statsBody = () =>
    `<div class="st">${[
      ['Uptime', '99.98%', ''],
      ['p95 latency', '182 ms', '<em class="up">▼ 12%</em>'],
      ['Error rate', '0.12%', '<em class="dn">▲ 0.05</em>'],
      ['Deploys', '14', ''],
    ]
      .map(([l, v, d]) => `<div><small>${l}</small><b>${v}</b>${d}</div>`)
      .join('')}</div>`
  // 5xx per minute over a week, with Wednesday's spike
  const chartBody = () => {
    const ys = [12, 10, 13, 11, 12, 9, 11, 10, 12, 96, 14, 11, 10, 12, 9, 10, 11, 9, 10, 8, 9]
    const pts = ys.map((y, i) => [10 + i * 24, 128 - y])
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
    const [sx, sy] = pts[9]
    // The svg stretches to the piece; the dot and the day names are html, so they keep their shape.
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => `<span>${n}</span>`).join('')
    return (
      `<div class="ch"><div class="ch__plot"><svg viewBox="0 0 500 132" preserveAspectRatio="none"><g class="ch__grid"><path d="M0 34H500M0 68H500M0 102H500"/></g>` +
      `<path class="ch__area" d="${d} L${pts.at(-1)[0]} 132 L10 132Z"/><path class="ch__l" d="${d}"/></svg>` +
      `<i data-spike style="left:${(sx / 500) * 100}%;top:${(sy / 132) * 100}%"></i></div><div class="ch__days">${days}</div></div>`
    )
  }
  const timelineBody = () =>
    `<ol class="tl">${[
      ['Mon', 'v2.31 deployed'],
      ['Wed 14:05', '503s on checkout, 4 min'],
      ['Wed 14:09', '#418 restores the pool size'],
      ['Fri', 'v2.32 deployed'],
    ]
      .map(([w, t]) => `<li><b>${w}</b><span>${t}</span></li>`)
      .join('')}</ol>`

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
  function box(el) {
    const d = desk.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { x: (r.left - d.left) / scale, y: (r.top - d.top) / scale, w: r.width / scale, h: r.height / scale }
  }
  const mid = (el) => {
    const b = box(el)
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  }

  // ---------------------------------------------------------------- time, that can be stopped
  class Stop extends Error {}
  let run = 0
  let paused = false
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function wait(ms) {
    const id = run
    if (reduced) {
      if (id !== run) throw new Stop()
      return
    }
    // Counted on the clock, not in timer steps: each setTimeout overshoots a little,
    // and over a chapter's few hundred waits that added seconds.
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
  /** Drive f(t) for t 0..1 over ms, eased; stops with the run. */
  async function tween(ms, f, ease = easeInOut) {
    const id = run
    if (reduced) return f(1)
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
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const easeOut = (t) => 1 - Math.pow(1 - t, 3)

  // ---------------------------------------------------------------- the pointer
  const P = { x: 980, y: 640 }
  function placePtr() {
    ptr.style.transform = `translate3d(${P.x.toFixed(1)}px, ${P.y.toFixed(1)}px, 0)`
  }
  placePtr()
  // Ember's glide (the same curve the app draws): a bow to one side, a hair past, settle.
  const glideMs = (d) => (d < 2 ? 0 : Math.max(140, Math.min(480, 140 + 75 * Math.log2(1 + d / 60))))
  async function glide(to, slow = 1.25) {
    ptr.classList.add('is-on')
    const sx = P.x
    const sy = P.y
    const dx = to.x - sx
    const dy = to.y - sy
    const len = Math.hypot(dx, dy) || 1
    const ms = glideMs(len) * slow
    if (!ms) return
    const bow = Math.min(50, len * 0.12)
    const cx = (sx + to.x) / 2 + (-dy / len) * bow
    const cy = (sy + to.y) / 2 + (dx / len) * bow
    await tween(ms, (u) => {
      const v = 1 - u
      P.x = v * v * sx + 2 * u * v * cx + u * u * to.x
      P.y = v * v * sy + 2 * u * v * cy + u * u * to.y
      placePtr()
    })
  }
  function ripple(at) {
    if (reduced) return
    const r = document.createElement('div')
    r.className = 'ripple'
    r.style.left = `${at.x}px`
    r.style.top = `${at.y}px`
    desk.appendChild(r)
    setTimeout(() => r.remove(), 600)
    ptr.querySelector('svg').animate([{ scale: '1' }, { scale: '0.82' }, { scale: '1' }], { duration: 220, easing: 'ease-out' })
  }
  async function click(el, offset = { x: 0, y: 0 }) {
    const m = mid(el)
    const at = { x: m.x + offset.x, y: m.y + offset.y }
    await glide(at)
    await wait(90)
    ripple(at)
    el.classList.add('is-press')
    await wait(160)
    el.classList.remove('is-press')
  }

  // ---------------------------------------------------------------- keys and text
  async function keys(...names) {
    keysEl.innerHTML = names.map((k) => `<kbd>${k}</kbd>`).join('')
    await wait(380)
  }
  async function typeInto(el, text, base = 34) {
    el.textContent = ''
    for (const ch of text) {
      el.textContent += ch
      await wait(base + Math.random() * 40 + (ch === ' ' ? 30 : 0))
    }
  }
  async function stream(el, text) {
    el.innerHTML = ''
    const p = document.createElement('p')
    el.appendChild(p)
    for (const w of text.split(' ')) {
      p.textContent += (p.textContent ? ' ' : '') + w
      await wait(38 + Math.random() * 30)
    }
  }
  const caption = (t) => {
    cap.textContent = t
  }

  // ---------------------------------------------------------------- the states
  const PROMPT = 'how does auth flow through the API?'
  const ANSWER = 'The browser signs in through the gateway. The auth service issues a short-lived token, keeps the refresh token in the store, and the gateway opens a session.'
  const AFTER = 'Tokens expire after 15 minutes; the session renews them quietly.'

  function reset() {
    pane.classList.remove('is-cli')
    q('[data-v="canvas"]').classList.add('is-on')
    q('[data-v="cli"]').classList.remove('is-on')
    cv.classList.remove('is-room')
    cv.style.removeProperty('--room')
    you.classList.remove('is-on')
    youT.textContent = ''
    say.innerHTML = ''
    say2.innerHTML = ''
    if (obj.parentElement !== col) col.insertBefore(obj, say2)
    obj.className = 'obj'
    obj.removeAttribute('style')
    sticky.classList.remove('is-on')
    stickyT.textContent = ''
    legend.classList.remove('is-on')
    full.classList.remove('is-on')
    zoom.style.transform = ''
    sheet.classList.remove('is-on')
    buildSheet()
    board.innerHTML = ''
    plan.className = 'plan'
    plan.innerHTML = ''
    stop.classList.remove('is-on')
    keysEl.innerHTML = ''
    ptr.classList.remove('is-on', 'is-ember')
    tag.textContent = ''
    pmenu.classList.remove('is-on')
    pmenu.querySelectorAll('.is-hover').forEach((e) => e.classList.remove('is-hover'))
    inpT.textContent = ''
    inp.classList.remove('is-away')
    startEl.classList.remove('is-on')
    setAgent('claude')
    cards.querySelectorAll('.is-new').forEach((c) => c.remove())
    col.querySelectorAll('.gap').forEach((g) => g.remove())
    cards.querySelectorAll('.card').forEach((c, i) => {
      c.classList.toggle('is-on', i === 0)
      c.classList.remove('is-busy')
    })
    todoN.textContent = '3'
  }
  function setAgent(a) {
    const codex = a === 'codex'
    chipName.textContent = codex ? 'Codex CLI' : 'Claude Code'
    chip.style.setProperty('--chip', codex ? '#9fb7c9' : '#e58a55')
    ph.textContent = codex ? 'Ask Codex… / for commands' : 'Ask Claude… / for commands'
    model.textContent = codex ? 'Codex CLI' : 'Opus 5.5 (1M context)'
    pmenu.querySelectorAll('.pmenu__i[data-p]').forEach((i) => {
      const on = i.dataset.p === a
      i.classList.toggle('is-on', on)
      const t = i.querySelector('.tick')
      if (on && !t) i.insertAdjacentHTML('beforeend', '<span class="tick">✓</span>')
      if (!on && t) t.remove()
    })
  }
  /** The end of chapter 1, at once: asked, answered, the diagram in the reply. */
  function asked() {
    youT.textContent = PROMPT
    you.classList.add('is-on')
    say.innerHTML = `<p>${ANSWER}</p>`
    obj.classList.add('is-on')
    say2.innerHTML = `<p>${AFTER}</p>`
  }
  const busy = (on) => cards.firstElementChild.classList.toggle('is-busy', on)
  /** Type a request, send it, and show it as the turn's prompt. */
  async function ask_(text) {
    await wait(400)
    await typeInto(inpT, text)
    await wait(300)
    await keys('Enter')
    inpT.textContent = ''
    youT.textContent = text
    you.classList.add('is-on')
    busy(true)
  }
  /** Where the pieces of a chapter go, [x, y, w, h] in the canvas: a wide canvas, or a phone's. */
  const at = (wide, phone) => (narrow ? phone : wide)

  // ---------------------------------------------------------------- the chapters
  const chapters = [
    {
      ms: 10800,
      cap: 'Ask in plain words. The answer comes as something you can see.',
      async play() {
        await wait(500)
        await typeInto(inpT, PROMPT)
        await wait(350)
        await keys('Enter')
        inpT.textContent = ''
        youT.textContent = PROMPT
        you.classList.add('is-on')
        cards.firstElementChild.classList.add('is-busy')
        say.innerHTML = '<p class="think">Thinking…</p>'
        await wait(1300)
        await stream(say, ANSWER)
        await wait(250)
        obj.classList.add('is-on')
        await wait(1500)
        await stream(say2, AFTER)
        cards.firstElementChild.classList.remove('is-busy')
        await wait(2200)
      },
    },
    {
      ms: 7700,
      cap: 'Resize it where it is, or drag it out and place it. The words make room.',
      async play() {
        asked()
        await wait(400)
        P.x = 900
        P.y = narrow ? 560 : 640
        placePtr()
        await glide(mid(obj))
        obj.classList.add('is-hover')
        await wait(400)
        // the corner: bigger, in place
        const b0 = box(obj)
        const corner = { x: b0.x + b0.w - 7, y: b0.y + b0.h - 7 }
        await glide(corner)
        obj.classList.add('is-rz')
        await wait(200)
        const w0 = obj.offsetWidth
        const grow = narrow ? 50 : 110
        await tween(650, (u) => {
          obj.style.width = `${w0 + grow * u}px`
          P.x = corner.x + grow * u
          P.y = corner.y + 30 * u
          placePtr()
        })
        obj.classList.remove('is-rz')
        await wait(500)
        // "Drag out": take it out of the reply and put it on the right
        const handle = obj.querySelector('.lift__h')
        await glide(mid(handle))
        ripple(mid(handle))
        await wait(150)
        const c = box(cv)
        const o = box(obj)
        const grab = { x: P.x - o.x, y: P.y - o.y }
        // A gap holds the object's place in the reply, then closes as it leaves, and
        // the column narrows at the same time: the words make room while it moves.
        const gap = document.createElement('div')
        gap.className = 'gap'
        gap.style.height = `${obj.offsetHeight + 14}px`
        col.insertBefore(gap, obj)
        obj.classList.add('is-placed')
        cv.appendChild(obj)
        obj.style.left = `${o.x - c.x}px`
        obj.style.top = `${o.y - c.y}px`
        obj.style.width = `${o.w}px`
        const tw = narrow ? 270 : 430
        const tx = c.w - tw - 20
        const ty = 62
        void gap.offsetHeight
        gap.style.height = '0px'
        cv.style.setProperty('--room', `${tw + 40}px`)
        cv.classList.add('is-room')
        const sx = o.x - c.x
        const sy = o.y - c.y
        await tween(800, (u) => {
          const x = sx + (tx - sx) * u
          const y = sy + (ty - sy) * u
          const w = o.w + (tw - o.w) * u
          obj.style.left = `${x}px`
          obj.style.top = `${y}px`
          obj.style.width = `${w}px`
          P.x = c.x + x + grab.x * (w / o.w)
          P.y = c.y + y + grab.y * (w / o.w)
          placePtr()
        })
        obj.classList.remove('is-hover')
        await wait(500)
        await glide({ x: P.x - 160, y: P.y + 260 })
        await wait(2200)
      },
    },
    {
      ms: 13900,
      cap: 'Hand it the sprint. The plan ticks itself off at the top, and the board moves with it.',
      async play() {
        await ask_('work through my sprint tickets, one at a time')
        say.innerHTML = '<p class="think">Reading the sprint…</p>'
        await wait(900)
        say.innerHTML = ''
        if (!narrow) {
          cv.style.setProperty('--room', '470px')
          cv.classList.add('is-room')
        }
        startPlan('Sprint 14 · your tickets', TICKETS.map(([id, t]) => `<b>${id}</b> ${t}`))
        const kb = piece('pc--kanban', 'Sprint 14', 'kanban', kanbanBody())
        await arrive(kb, at([430, 62, 430, 330], [20, 250, 504, 200]))
        if (!narrow) await stream(say, 'Four tickets. Starting with API-142; the board follows as each one lands.')
        for (let i = 0; i < TICKETS.length; i++) {
          await wait(350)
          planStep(i, 'active')
          moveCard(kb, TICKETS[i][0], 1)
          await wait(1100)
          planStep(i, 'done')
          moveCard(kb, TICKETS[i][0], 2)
        }
        busy(false)
        await wait(2000)
      },
    },
    {
      ms: 12400,
      cap: 'PDFs, Markdown, spreadsheets and video open right on the canvas, side by side, and stay live.',
      async play() {
        await ask_('show the contract, the README, the invoices and the demo video')
        say.innerHTML = '<p class="think">Opening 4 files…</p>'
        await wait(800)
        const wide = [[24, 124, 412, 202], [450, 124, 412, 202], [24, 340, 412, 202], [450, 340, 412, 202]]
        const phone = [[20, 124, 247, 158], [277, 124, 247, 158], [20, 292, 247, 158], [277, 292, 247, 158]]
        const spots = narrow ? phone : wide
        const pdf = piece('pc--pdf', 'Vendor agreement.pdf', 'PDF', pdfBody())
        const md = piece('pc--md', 'README.md', 'Markdown', mdBody())
        const csv = piece('pc--csv', 'invoices.csv', 'CSV', csvBody())
        const vid = piece('pc--vid', 'checkout-demo.mp4', 'video', videoBody())
        say.innerHTML = ''
        for (const [i, el] of [pdf, md, csv, vid].entries()) {
          await arrive(el, spots[i])
          await wait(120)
        }
        // the video plays on its own while the rest happens
        const vbar = vid.querySelector('[data-vbar]')
        const vt = vid.querySelector('[data-vt]')
        vid.querySelector('.vid').classList.add('is-playing')
        tween(7000, (u) => {
          vbar.style.width = `${u * 38}%`
          const s = Math.round(u * 74)
          vt.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / 3:15`
        }, (t) => t).catch(() => {})
        await stream(say, narrow ? 'Clause 7.2 is marked.' : 'Here they are. Clause 7.2 of the contract sets 30 days’ notice; I’ve marked it.')
        pdf.querySelector('[data-clause]').classList.add('is-hl')
        await wait(900)
        // sort the invoices by amount
        const th = csv.querySelector('[data-sort]')
        P.x = narrow ? 300 : 700
        P.y = narrow ? 420 : 520
        placePtr()
        await click(th)
        th.querySelector('i').textContent = '▼'
        const body = csv.querySelector('tbody')
        const rows = [...body.children]
        const sorted = [...rows].sort((a, b) => b.dataset.v - a.dataset.v)
        const first = rows.map((r) => r.getBoundingClientRect())
        sorted.forEach((r) => body.appendChild(r))
        if (!reduced) rows.forEach((r, i) => {
          const b = r.getBoundingClientRect()
          r.animate([{ transform: `translateY(${(first[i].top - b.top) / scale}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
        })
        await wait(600)
        ptr.classList.remove('is-on')
        busy(false)
        await wait(2400)
      },
    },
    {
      ms: 11000,
      cap: 'Numbers come back as stats, charts and timelines, and it points at what matters.',
      async play() {
        await ask_('how is production doing this week?')
        say.innerHTML = '<p class="think">Pulling the numbers…</p>'
        await wait(900)
        say.innerHTML = ''
        const stats = piece('pc--stats', 'This week', 'stats', statsBody())
        const chart = piece('pc--chart', '5xx per minute', 'chart', chartBody())
        const tl = piece('pc--tl', 'What happened', 'timeline', timelineBody())
        await stream(say, 'Healthy. One 4-minute spike of 503s on Wednesday, fixed by #418.')
        await arrive(stats, at([24, 112, 838, 92], [20, 128, 504, 82]))
        await wait(150)
        await arrive(chart, at([24, 216, 520, 326], [20, 220, 504, 132]))
        await wait(150)
        await arrive(tl, at([556, 216, 306, 326], [20, 362, 504, 92]))
        await wait(1000)
        // point at the spike, the way an agent points at something on the canvas
        const dot = chart.querySelector('[data-spike]')
        ptr.classList.add('is-ember')
        P.x = narrow ? 420 : 760
        P.y = narrow ? 200 : 260
        placePtr()
        await glide(mid(dot))
        dot.classList.add('is-hot')
        tag.textContent = '503s for 4 min · fixed by #418'
        await wait(2600)
        tag.textContent = ''
        ptr.classList.remove('is-on')
        busy(false)
        await wait(900)
      },
    },
    {
      ms: 11800,
      cap: 'Keyboard first: Ctrl+↑ walks the objects, Enter opens one full screen, + zooms, Esc is always back.',
      async play() {
        asked()
        await wait(700)
        await keys('Ctrl', '↑')
        obj.classList.add('is-ring')
        legend.classList.add('is-on')
        await wait(1500)
        await keys('Enter')
        zoom.innerHTML = obj.querySelector('svg').outerHTML
        zoom.style.transformOrigin = '50% 50%'
        zpct.textContent = '100%'
        full.classList.add('is-on')
        await wait(1100)
        for (const z of [1.15, 1.3, 1.45]) {
          await keys('+')
          zoom.style.transform = `scale(${z})`
          zpct.textContent = `${Math.round(z * 100)}%`
          await wait(450)
        }
        await wait(1200)
        await keys('0')
        zoom.style.transform = ''
        zpct.textContent = '100%'
        await wait(800)
        await keys('Esc')
        full.classList.remove('is-on')
        await wait(500)
        await keys('Esc')
        obj.classList.remove('is-ring')
        legend.classList.remove('is-on')
        await wait(1200)
      },
    },
    {
      ms: 6600,
      cap: 'Canvas or the agent’s own screen: one switch, and it doesn’t move. Ember remembers your pick.',
      async play() {
        asked()
        P.x = 820
        P.y = 420
        placePtr()
        await wait(500)
        const cli = q('[data-v="cli"]')
        const canvas = q('[data-v="canvas"]')
        await click(cli)
        pane.classList.add('is-cli')
        cli.classList.add('is-on')
        canvas.classList.remove('is-on')
        await wait(2600)
        await click(canvas)
        pane.classList.remove('is-cli')
        canvas.classList.add('is-on')
        cli.classList.remove('is-on')
        await wait(1800)
      },
    },
    {
      ms: 14200,
      cap: 'Sticky notes and a todo list that live outside your sessions. Every agent can read them and add to them.',
      async play() {
        asked()
        // a phone's canvas is short: the last line would sit under the note
        if (narrow) say2.innerHTML = ''
        await wait(600)
        await keys('Ctrl', 'Shift', 'N')
        sticky.classList.add('is-on')
        await wait(300)
        await typeInto(stickyT, 'Rotate the staging signing keys before Friday’s release', 40)
        await wait(900)
        await typeInto(inpT, 'add “rotate the signing keys” to my todos')
        await wait(300)
        await keys('Enter')
        inpT.textContent = ''
        youT.textContent = 'add “rotate the signing keys” to my todos'
        obj.classList.remove('is-on')
        say2.innerHTML = ''
        say.innerHTML = '<p class="think">Thinking…</p>'
        await wait(1000)
        await stream(say, 'Added to your todo list: rotate the signing keys.')
        todoN.textContent = '4'
        todoN.classList.remove('is-bump')
        void todoN.offsetWidth
        todoN.classList.add('is-bump')
        await wait(2600)
      },
    },
    {
      ms: 14000,
      cap: 'Computer use: it reads a window as numbered controls and works it with a pointer you can watch, and stop.',
      async play() {
        const ask = 'in Q3 revenue.xlsx, add the total and a chart by region'
        await ask_(ask)
        say.innerHTML = '<p class="think">Opening Q3 revenue.xlsx…</p>'
        await wait(600)
        // the window opens beside the reply, and the words make room for it
        if (!narrow) {
          cv.style.setProperty('--room', '500px')
          cv.classList.add('is-room')
        }
        sheet.classList.add('is-on')
        stop.classList.add('is-on')
        await wait(500)
        // look: the controls come back numbered, and one act runs the whole sequence
        say.innerHTML = '<p class="think">Working in Q3 revenue.xlsx…</p><p class="tool"><b>look</b> Q3 revenue.xlsx · 64 controls</p><p class="tool"><b>act</b> <span data-acts></span></p>'
        const acts = say.querySelector('[data-acts]')
        const add = (s) => (acts.textContent += `${acts.textContent ? '; ' : ''}${s}`)
        await wait(400)
        ptr.classList.add('is-ember')
        P.x = narrow ? 160 : 600
        P.y = 300
        placePtr()
        const b7 = sheet.querySelector('[data-c="B7"]')
        const ref = sheet.querySelector('[data-ref]')
        const fx = sheet.querySelector('[data-fx]')
        tag.textContent = '#41'
        add('click #41')
        await click(b7)
        b7.classList.add('is-sel')
        ref.textContent = 'B7'
        tag.textContent = 'type'
        add('type "=SUM(B2:B5)"')
        for (const ch of '=SUM(B2:B5)') {
          b7.textContent += ch
          fx.textContent = b7.textContent
          await wait(55)
        }
        await wait(200)
        tag.textContent = 'Enter'
        add('key enter')
        await wait(250)
        b7.textContent = '1,498,350'
        b7.classList.add('is-new')
        sheet.querySelector('[data-dirty]').textContent = ' •'
        await wait(400)
        tag.textContent = '#12'
        add('click #12')
        await click(sheet.querySelector('[data-tool="chart"]'))
        sheet.querySelector('[data-chart]').classList.add('is-on')
        await wait(900)
        tag.textContent = 'Ctrl+S'
        add('key ctrl+s')
        await wait(450)
        sheet.querySelector('[data-dirty]').textContent = ''
        tag.textContent = ''
        await wait(400)
        stop.classList.remove('is-on')
        ptr.classList.remove('is-on')
        // a phone's canvas is all window: it steps back so the answer can be read
        if (narrow) sheet.classList.remove('is-on')
        say.querySelector('.think').remove()
        const done = document.createElement('div')
        say.appendChild(done)
        await stream(done, 'The total is 1,498,350. The chart by region sits under the table, and the file is saved.')
        busy(false)
        await wait(2400)
      },
    },
    {
      ms: 9900,
      cap: 'Claude Code, Codex, Gemini and more. Pick one beside the +, and every new session starts with it.',
      async play() {
        asked()
        if (!narrow) {
          P.x = 700
          P.y = 420
          placePtr()
          await wait(400)
          await click(chip)
          pmenu.classList.add('is-on')
          await wait(700)
          const codex = pmenu.querySelector('[data-p="codex"]')
          await glide(mid(codex))
          codex.classList.add('is-hover')
          await wait(300)
          ripple(mid(codex))
          await wait(150)
          pmenu.classList.remove('is-on')
          setAgent('codex')
          await wait(600)
          await click(plus)
          cards.querySelectorAll('.card').forEach((c) => c.classList.remove('is-on'))
          cards.insertAdjacentHTML('afterbegin', '<div class="card is-on is-new"><span class="card__dot"></span><div><b>Codex CLI</b><small>starting…</small></div></div>')
        } else {
          await wait(400)
          await keys('Ctrl', 'Shift', 'T')
          setAgent('codex')
        }
        startT.textContent = 'Starting Codex CLI…'
        startEl.classList.add('is-on')
        await wait(900)
        reset_canvas()
        // the old reply fades out behind the overlay before it lifts
        await wait(450)
        startEl.classList.remove('is-on')
        const small = cards.querySelector('.is-new small')
        if (small) small.textContent = 'Codex · 0%'
        ptr.classList.remove('is-on')
        await wait(500)
        await typeInto(inpT, 'write the release notes for v2.4')
        await wait(2000)
      },
    },
  ]
  function reset_canvas() {
    you.classList.remove('is-on')
    say.innerHTML = ''
    say2.innerHTML = ''
    obj.classList.remove('is-on')
    cv.classList.remove('is-room')
  }

  // ---------------------------------------------------------------- playing them
  let current = 0
  let chapterAt = 0
  const took = []
  let visible = false
  let playing = false

  function mark(i) {
    chapterBtns.forEach((b, j) => {
      b.classList.toggle('is-on', j === i)
      b.querySelector('b').style.width = j < i && !reduced ? '100%' : '0%'
      if (j !== i) b.querySelector('b').style.width = '0%'
    })
  }
  async function play(from) {
    const id = ++run
    playing = true
    let i = from
    for (;;) {
      current = i
      mark(i)
      caption(chapters[i].cap)
      reset()
      chapterAt = performance.now()
      try {
        await chapters[i].play()
      } catch (e) {
        if (e instanceof Stop) return
        throw e
      }
      if (id !== run) return
      // Typing and frame timing vary a little, so the bar learns each chapter's real length.
      took[i] = performance.now() - chapterAt
      if (reduced) return
      i = (i + 1) % chapters.length
    }
  }
  // The progress bar under the chapter that is playing.
  let pausedAt = 0
  ;(function progress() {
    const b = chapterBtns[current]?.querySelector('b')
    if (b && playing && !reduced) {
      if (paused) {
        if (!pausedAt) pausedAt = performance.now()
      } else if (pausedAt) {
        chapterAt += performance.now() - pausedAt
        pausedAt = 0
      }
      const t = Math.min(0.99, ((pausedAt || performance.now()) - chapterAt) / (took[current] || chapters[current].ms))
      b.style.width = `${(t * 100).toFixed(1)}%`
    }
    requestAnimationFrame(progress)
  })()

  chapterBtns.forEach((b) =>
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
  new IntersectionObserver(
    ([e]) => {
      visible = e.isIntersecting
      if (visible && !playing) void play(0)
      if (!reduced && pauseBtn && !pauseBtn.classList.contains('is-paused')) paused = !visible
    },
    { threshold: 0.25 }
  ).observe(root)
}
