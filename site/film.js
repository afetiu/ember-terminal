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
  const calc = q('[data-calc]')
  const calcD = q('[data-calc-d]')
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

  // ---------------------------------------------------------------- the calculator's keys
  const KEYS = [
    ['%', 'CE', 'C', '⌫'],
    ['¹⁄ₓ', 'x²', '√x', '÷'],
    ['7', '8', '9', '×'],
    ['4', '5', '6', '−'],
    ['1', '2', '3', '+'],
    ['±', '0', '.', '='],
  ]
  const grid = calc.querySelector('.calc__g')
  grid.innerHTML = KEYS.flat()
    .map((k, i) => `<span data-k="${k}" class="${i % 4 === 3 || i < 8 ? 'op' : ''}${k === '=' ? ' eq' : ''}">${k}</span>`)
    .join('')

  // ---------------------------------------------------------------- fitting the stage
  let narrow = false
  let scale = 1
  function fit() {
    const w = root.clientWidth
    narrow = w < 720
    const dw = narrow ? 760 : 1200
    const dh = narrow ? 680 : 760
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
    let left = ms
    while (left > 0) {
      const step = Math.min(left, 40)
      await sleep(step)
      if (id !== run) throw new Stop()
      if (!paused) left -= step
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
    calc.classList.remove('is-on')
    calcD.innerHTML = '0'
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
    model.textContent = codex ? 'GPT-6 Codex' : 'Opus 5.5 (1M context)'
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

  // ---------------------------------------------------------------- the chapters
  const chapters = [
    {
      ms: 9500,
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
      ms: 9000,
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
        const grow = narrow ? 60 : 110
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
        obj.classList.add('is-placed')
        cv.appendChild(obj)
        obj.style.left = `${o.x - c.x}px`
        obj.style.top = `${o.y - c.y}px`
        obj.style.width = `${o.w}px`
        const tw = narrow ? 330 : 430
        const tx = c.w - tw - 20
        const ty = 62
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
        cv.style.setProperty('--room', `${tw + 40}px`)
        cv.classList.add('is-room')
        obj.classList.remove('is-hover')
        await wait(500)
        await glide({ x: P.x - 160, y: P.y + 260 })
        await wait(2200)
      },
    },
    {
      ms: 9000,
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
        zoom.style.transformOrigin = '72% 42%'
        zpct.textContent = '100%'
        full.classList.add('is-on')
        await wait(1100)
        for (const z of [1.25, 1.56, 1.95]) {
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
      ms: 7000,
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
      ms: 10000,
      cap: 'Sticky notes and a todo list that live outside your sessions. Every agent can read them and add to them.',
      async play() {
        asked()
        await wait(600)
        await keys('Ctrl', 'Shift', 'N')
        sticky.classList.add('is-on')
        await wait(300)
        await typeInto(stickyT, 'Ask Arben about refresh-token rotation', 40)
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
      ms: 11000,
      cap: 'Computer use: the agent reads the screen as text and acts with a pointer you can watch, and stop.',
      async play() {
        await wait(400)
        await typeInto(inpT, 'open Calculator and work out 12 × 7')
        await wait(300)
        await keys('Enter')
        inpT.textContent = ''
        youT.textContent = 'open Calculator and work out 12 × 7'
        you.classList.add('is-on')
        say.innerHTML = '<p class="think">Opening Calculator…</p>'
        cards.firstElementChild.classList.add('is-busy')
        await wait(700)
        calc.style.right = narrow ? '40px' : '70px'
        calc.classList.add('is-on')
        stop.classList.add('is-on')
        await wait(500)
        ptr.classList.add('is-ember')
        P.x = narrow ? 300 : 640
        P.y = 300
        placePtr()
        const k = (name) => grid.querySelector(`[data-k="${name}"]`)
        const steps = [
          ['1', 'One', () => (calcD.innerHTML = '1')],
          ['2', 'Two', () => (calcD.innerHTML = '12')],
          ['×', 'Multiply by', () => (calcD.innerHTML = '<small>12 ×</small>12')],
          ['7', 'Seven', () => (calcD.innerHTML = '<small>12 ×</small>7')],
          ['=', 'Equals', () => (calcD.innerHTML = '<small>12 × 7 =</small>84')],
        ]
        for (const [key, name, show] of steps) {
          tag.textContent = `Ember · press ${name}`
          await click(k(key))
          show()
          await wait(160)
        }
        tag.textContent = ''
        await wait(400)
        stop.classList.remove('is-on')
        ptr.classList.remove('is-on')
        await stream(say, '12 × 7 = 84. It’s on the Calculator’s display.')
        cards.firstElementChild.classList.remove('is-busy')
        await wait(2400)
      },
    },
    {
      ms: 9000,
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
        await wait(1300)
        reset_canvas()
        startEl.classList.remove('is-on')
        const small = cards.querySelector('.is-new small')
        if (small) small.textContent = 'GPT-6 Codex · 0%'
        ptr.classList.remove('is-on')
        await wait(500)
        await typeInto(inpT, 'write the release notes for v1.3')
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
      const t = Math.min(1, ((pausedAt || performance.now()) - chapterAt) / chapters[current].ms)
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
