// The hero film: one Ember window, a chapter per feature.
//
// One Ember window (the .win markup in index.html) plays a sequence of scenes. Every
// frame is a pure function of (scene, seconds into it), so jumping to a beat, looping,
// pausing and the reduced-motion stills all fall out of the same code:
//
//   data-at="s"        element gets .on from s seconds (hidden before, unless .flip)
//   data-until="s"     element gets .gone from s seconds
//   data-type="a,b"    its text types itself in between a and b
//   data-seq="s|text;s|text"   its text is swapped at those times
//   data-pulse="a,b;c,d"       a dash of light travels along the path in each window
//   data-cls="c:a,b;c:a,b"     class c is on inside each window
//   data-clock="s"     its text is an elapsed time: s seconds, counting from data-at (or 0)
//   {house} in a data-seq text becomes the house theme of the App theme switch
//
// Everything that can't live in markup (session cards, the places row and its badges,
// the cursor, the camera, themes) is in SCENES below: `place` is the sidebar place on
// stage, `todo` the Todo badge over time. The Overview badge counts itself, the way the
// app counts it: sessions waiting on you, other than the one you are in. Motion is transform/opacity only; the loop stops off-screen and
// in hidden tabs. Cinder, the session mascot, is the app's own sprite code, bundled
// from src/renderer/src/ui/Mascot.ts into assets/cinder.js.

import { drawMascot } from './assets/cinder.js'

const W = 1200
const H = 720
const reduce = matchMedia('(prefers-reduced-motion: reduce)')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const lerp = (a, b, p) => a + (b - a) * p

// Card moods: [time, state, attention, label, baseSeconds]. A label's {t} counts up.
const idle = (label = 'idle') => [[0, 'idle', null, label]]
const SCENES = {
  panel: {
    dur: 8.8, still: 7.7, sel: 'api',
    cam: [[0, 520, 330, 1.75], [2.7, 520, 330, 1.75], [3.5, 940, 380, 1.75], [5.75, 940, 420, 1.75], [6.35, 520, 380, 1.75]],
    cursor: [[4.95, [700, 600]], [5.6, '[data-cursor=tests]', 'click'], [6.2, '[data-cursor=tests]'], [6.5, [860, 640]]],
    cards: {
      api: [[0, 'working', null, 'working · {t}', 64], [7.4, 'attention', 'handoff', 'your turn']],
      docs: idle(),
      web: [[0, 'attention', 'question', 'waiting on you']],
      scratch: idle(),
    },
  },
  // The overview as a place of its own: no session is selected. web waits on a permission
  // prompt; a log line lands, the cursor answers "1 Yes" on the card, the card relaxes
  // into a working one and the Overview badge in the sidebar empties.
  overview: {
    dur: 8.6, still: 2.2, sel: null, place: 'overview',
    cam: [[0, 600, 386, 1.45], [3.5, 600, 386, 1.45], [4.2, 330, 300, 1.45], [5.4, 330, 300, 1.45], [6.2, 1010, 440, 1.5], [7.6, 1010, 440, 1.5], [8.3, 600, 386, 1.45]],
    cursor: [[1.5, [760, 330]], [2.5, '[data-cursor=yes]'], [2.9, '[data-cursor=yes]', 'click'], [3.4, [700, 470]]],
    cards: {
      api: [[0, 'working', null, 'working · {t}', 64]],
      docs: idle(),
      web: [[0, 'attention', 'question', 'waiting on you'], [3.3, 'working', null, 'working · {t}', 0]],
      scratch: idle(),
    },
  },
  todo: {
    dur: 7.2, still: 6.0, sel: null, place: 'todo',
    todo: [[0, 3], [1.6, 4], [2.05, 5], [2.5, 6], [2.95, 7], [4.0, 6], [4.4, 5], [4.8, 4]],
    cam: [[0, 720, 330, 1.7]],
    cursor: [[3.4, [760, 360]], [4.0, '[data-cursor=check]', 'click'], [4.5, [860, 330]]],
    cards: {
      api: idle(),
      docs: [[0, 'working', null, 'working · {t}', 142]],
      web: idle(),
      scratch: idle(),
    },
  },
  // The api session writes its fix up as a note. The page opens over its own tab, the
  // appends land on it live, the list follows, and Esc gives the shell back.
  notes: {
    dur: 8.8, still: 5.0, sel: 'api',
    cam: [[0, 560, 300, 1.6], [1.7, 560, 300, 1.6], [2.3, 720, 350, 1.6], [7.3, 720, 350, 1.6], [7.9, 560, 300, 1.6]],
    cursor: [[4.95, [620, 300]], [5.65, '[data-cursor=allnotes]', 'click'], [6.2, [640, 330]]],
    cards: {
      api: [[0, 'idle', null, 'idle'], [1.35, 'working', null, 'working · {t}', 0], [2.6, 'working', null, 'writing a note'], [5.1, 'attention', 'handoff', 'done']],
      docs: [[0, 'attention', 'handoff', 'done']],
      web: idle(),
      scratch: idle(),
    },
  },
  cli: {
    dur: 6.4, still: 4.6, sel: 'scratch',
    cam: [[0, 720, 380, 1.5]],
    cursor: [[0.4, [900, 600]], [1.15, '[data-cursor=install]', 'click'], [2.6, [880, 470]], [3.2, '[data-cursor=codex]', 'click'], [3.8, [860, 560]]],
    cards: { api: idle(), docs: idle(), web: idle(), scratch: [[0, 'idle', null, 'new session'], [3.4, 'working', null, 'starting codex']] },
  },
  splits: {
    dur: 7.4, still: 6.0, sel: 'api',
    cam: [[0, 720, 380, 1.3]],
    theme: [[0, ''], [3.4, 'tokyo'], [4.2, 'cat'], [5.0, 'gruv'], [5.8, 'nord'], [6.6, '']],
    cards: { api: [[0, 'working', null, 'npm run dev']], docs: idle(), web: idle(), scratch: idle() },
  },
  palette: {
    dur: 7.2, still: 6.2, sel: 'api',
    cam: [[0, 720, 330, 1.4]],
    theme: [[0, ''], [2.1, 'tokyo'], [6.0, 'nord']],
    cards: { api: [[0, 'working', null, 'npm run dev']], docs: idle(), web: idle(), scratch: idle() },
  },
}

const SEEDS = { api: 0.3, docs: 1.7, web: 2.9, scratch: 4.1 }

function fmt(s) {
  s = Math.max(0, Math.floor(s))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Position of el inside root, ignoring transforms (so it is right mid-animation). */
function offsetIn(el, root) {
  let x = 0, y = 0, n = el
  while (n && n !== root) {
    x += n.offsetLeft
    y += n.offsetTop
    n = n.offsetParent
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight }
}

function parseTimes(s) {
  return s.split(';').filter(Boolean).map((p) => p.split(',').map(Number))
}

class Film {
  constructor(root, { order, mode = 'hero', onScene } = {}) {
    this.root = root
    this.view = root.querySelector('.film__view')
    this.win = root.querySelector('.win')
    this.cursor = root.querySelector('.cursor')
    this.order = order
    this.mode = mode
    this.onScene = onScene
    this.static = reduce.matches
    this.idx = 0
    this.t = 0
    this.clock = 0
    this.visible = false
    this.hover = false
    this.userPaused = false
    this.raf = 0
    this.last = 0
    this.cam = { cx: W / 2, cy: H / 2, z: 1 }
    this.fromCam = null
    this.theme = ''

    root.classList.add('is-js')
    this.bars = {}
    for (const b of root.querySelectorAll('[data-go]')) this.bars[b.dataset.go] = b.querySelector('.beat__bar b')
    this.cards = [...root.querySelectorAll('.scard')].map((el) => ({
      el,
      name: el.dataset.card,
      ctx: el.querySelector('canvas').getContext('2d'),
      label: el.querySelector('small'),
      mood: { state: 'idle', attention: null },
      text: '',
    }))

    // The places row at the top of the sidebar: which one is on stage, and two badges.
    this.places = [...root.querySelectorAll('.place[data-place]')].map((el) => ({ el, name: el.dataset.place, badge: el.querySelector('.place__badge'), n: null, on: null }))
    // Timed elements, grouped by the scene that owns them.
    this.parts = {}
    this.items = {}
    for (const part of root.querySelectorAll('[data-scene]')) {
      const name = part.dataset.scene
      ;(this.parts[name] ||= []).push(part)
      const list = (this.items[name] ||= [])
      const els = [...part.querySelectorAll('[data-at],[data-until],[data-type],[data-seq],[data-pulse],[data-cls],[data-clock]')]
      if (part.matches('[data-at],[data-until],[data-cls]')) els.unshift(part)
      for (const el of els) {
        const it = { el }
        if (el.dataset.at != null) it.at = +el.dataset.at
        if (el.dataset.until != null) it.until = +el.dataset.until
        if (el.dataset.cls) {
          // "class:from,to;class:from,to" — the class is on inside any of its windows
          it.cls = el.dataset.cls.split(';').filter(Boolean).map((p) => {
            const [c, r] = p.split(':')
            const [a, b] = r.split(',').map(Number)
            return [c, a, b ?? Infinity]
          })
          it.names = [...new Set(it.cls.map((c) => c[0]))]
        }
        if (el.dataset.type) {
          it.type = el.dataset.type.split(',').map(Number)
          it.full = el.textContent
          it.n = -1
        }
        if (el.dataset.seq != null) {
          it.seq = el.dataset.seq.split(';').map((p) => {
            const i = p.indexOf('|')
            return [+p.slice(0, i), p.slice(i + 1)]
          })
          it.cur = null
        }
        if (el.dataset.pulse) it.pulse = parseTimes(el.dataset.pulse)
        if (el.dataset.clock != null) { it.clock = +el.dataset.clock; it.cur = null }
        list.push(it)
      }
    }

    const ro = new ResizeObserver(() => { this.layout(); this.frame() })
    ro.observe(this.view)
    const io = new IntersectionObserver((es) => {
      this.visible = es[es.length - 1].isIntersecting
      this.kick()
    }, { threshold: 0.05 })
    io.observe(root)
    document.addEventListener('visibilitychange', () => this.kick())
    this.view.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { this.hover = true } })
    this.view.addEventListener('pointerleave', () => { this.hover = false })
    reduce.addEventListener?.('change', () => { this.static = reduce.matches; this.go(this.order[this.idx]) })
    // The App theme switch can flip Night/Day while the film is paused or a still; words
    // that name the house theme follow at once.
    new MutationObserver(() => this.frame()).observe(this.win, { attributes: true, attributeFilter: ['data-mode'] })

    this.layout()
    this.activate(this.order[0], true)
    ;(document.fonts?.ready || Promise.resolve()).then(() => this.frame())
  }

  // ---- sizing -----------------------------------------------------------------
  layout() {
    this.small = this.view.clientWidth < 640
    this.root.classList.toggle('is-small', this.small)
    this.vw = this.view.clientWidth
    this.vh = this.view.clientHeight
  }

  // ---- playback -----------------------------------------------------------------
  get scene() { return SCENES[this.order[this.idx]] }

  running() {
    return !this.static && !this.userPaused && this.visible && !document.hidden
  }

  kick() {
    if (this.running() && !this.raf) {
      this.last = performance.now()
      this.raf = requestAnimationFrame((n) => this.tick(n))
    }
  }

  tick(now) {
    this.raf = 0
    if (!this.running()) return
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    this.clock += dt
    if (!this.hover) {
      // The hero plays slower than the demos: it is watched, not clicked through.
      this.t += dt * (this.mode === 'hero' ? HERO_SPEED : 1)
      if (this.t >= this.scene.dur) {
        const next = this.mode === 'hero' ? (this.idx + 1) % this.order.length : this.idx
        this.activate(this.order[next])
      }
    }
    this.frame()
    this.raf = requestAnimationFrame((n) => this.tick(n))
  }

  /** Jump to a scene by name (a chapter button or a demo tab). */
  go(name) {
    this.activate(name)
    this.frame()
    this.kick()
  }

  setOrder(order) {
    this.order = order
    this.go(order[0])
  }

  togglePause() {
    this.userPaused = !this.userPaused
    this.root.classList.toggle('is-paused', this.userPaused)
    this.kick()
    return this.userPaused
  }

  activate(name, first = false) {
    const idx = this.order.indexOf(name)
    this.idx = idx < 0 ? 0 : idx
    this.t = this.static ? this.scene.still : 0
    this.fromCam = first ? null : { ...this.cam }
    this.win.classList.remove('is-out')

    // Put the incoming scene back to its first frame without animating the reset.
    const parts = this.parts[name] || []
    for (const p of parts) p.classList.add('no-tr')
    for (const it of this.items[name] || []) { it.n = -1; it.cur = null }
    this.apply(name, this.t)
    void this.win.offsetWidth
    for (const p of parts) p.classList.remove('no-tr')

    for (const [n, list] of Object.entries(this.parts)) {
      for (const p of list) p.classList.toggle('is-active', n === name)
    }
    for (const [n, b] of Object.entries(this.bars)) if (n !== name) b.style.transform = 'scaleX(0)'
    this.onScene?.(name)
  }

  // ---- one frame ------------------------------------------------------------------
  frame() {
    const name = this.order[this.idx]
    const sc = this.scene
    const t = this.t
    this.apply(name, t)
    this.updateCards(sc, t)
    this.updatePlaces(sc, t)
    this.updateCursor(sc, t)
    this.updateCamera(sc, t)
    this.updateTheme(sc, t)
    if (this.mode === 'demo') this.win.classList.toggle('is-out', !this.static && t > sc.dur - 0.4)
    this.drawCards()
    const bar = this.bars[name]
    if (bar) bar.style.transform = `scaleX(${clamp(t / sc.dur, 0, 1).toFixed(4)})`
  }

  apply(name, t) {
    for (const it of this.items[name] || []) {
      const { el } = it
      if (it.at != null) el.classList.toggle('on', t >= it.at)
      if (it.until != null) el.classList.toggle('gone', t >= it.until)
      if (it.cls) {
        for (const c of it.names) {
          let on = false
          for (const [n, a, b] of it.cls) if (n === c && t >= a && t < b) on = true
          el.classList.toggle(c, on)
        }
      }
      if (it.type) {
        const [a, b] = it.type
        const len = it.full.length
        const n = t <= a ? 0 : t >= b ? len : Math.round(((t - a) / (b - a)) * len)
        if (n !== it.n) { el.textContent = it.full.slice(0, n); it.n = n }
        el.classList.toggle('typing', t >= a - 0.2 && t < b + 0.45 && !(it.until != null && t >= it.until))
      }
      if (it.clock != null) {
        const txt = fmt(it.clock + Math.max(0, t - (it.at ?? 0)))
        if (txt !== it.cur) { el.textContent = txt; it.cur = txt }
      }
      if (it.seq) {
        let txt = ''
        for (const [s, v] of it.seq) if (t >= s) txt = v
        if (txt.includes('{house}')) txt = txt.replace('{house}', this.win.dataset.mode === 'day' ? 'Ember Day' : 'Ember Night')
        if (txt !== it.cur) {
          el.textContent = txt
          if (it.cur) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump') }
          it.cur = txt
        }
      }
      if (it.pulse) {
        let p = -1
        for (const [a, b] of it.pulse) if (t >= a && t <= b) p = (t - a) / (b - a)
        if (p < 0) el.style.opacity = '0'
        else {
          el.style.opacity = '1'
          el.style.strokeDashoffset = String(0.16 - ease(p) * 1.2)
        }
      }
    }
  }

  updateCards(sc, t) {
    for (const c of this.cards) {
      const evs = sc.cards[c.name] || idle()
      let ev = evs[0]
      for (const e of evs) if (t >= e[0]) ev = e
      const [at, state, attention, label, base = 0] = ev
      c.mood.state = state
      c.mood.attention = attention
      const text = label.includes('{t}') ? label.replace('{t}', fmt(base + t - at)) : label
      if (text !== c.text) { c.label.textContent = text; c.text = text }
      const tint = state === 'attention' ? (attention === 'handoff' ? 'done' : 'ask') : state
      if (c.el.dataset.mood !== tint) c.el.dataset.mood = tint
      c.el.classList.toggle('is-sel', c.name === sc.sel)
    }
  }

  /** The places row: the one on stage lit, Overview counting the sessions that want you. */
  updatePlaces(sc, t) {
    let waiting = 0
    for (const c of this.cards) if (c.mood.state === 'attention' && c.name !== sc.sel) waiting++
    let open = 4
    for (const [s, v] of sc.todo || []) if (t >= s) open = v
    for (const p of this.places) {
      const on = p.name === sc.place
      if (on !== p.on) { p.el.classList.toggle('is-on', on); p.on = on }
      const n = p.name === 'overview' ? waiting : p.name === 'todo' ? open : 0
      if (n !== p.n) {
        if (n > 0) p.badge.textContent = String(n)
        p.badge.classList.toggle('is-off', n <= 0)
        p.n = n
      }
    }
  }

  drawCards() {
    const time = this.static ? 1.3 : this.clock
    for (const c of this.cards) drawMascot(c.ctx, 76, c.mood, time, SEEDS[c.name] || 0)
  }

  point(target) {
    if (Array.isArray(target)) return { x: target[0], y: target[1] }
    const el = this.win.querySelector(target)
    if (!el) return { x: W / 2, y: H / 2 }
    const o = offsetIn(el, this.win)
    return { x: o.x + Math.min(o.w * 0.5, 60), y: o.y + o.h * 0.62 }
  }

  updateCursor(sc, t) {
    const kfs = sc.cursor
    const cur = this.cursor
    if (!kfs || this.static || t < kfs[0][0] - 0.25 || t > kfs[kfs.length - 1][0] + 0.25) {
      cur.classList.remove('on', 'click')
      return
    }
    let i = 0
    while (i < kfs.length - 1 && t >= kfs[i + 1][0]) i++
    const a = kfs[i]
    const b = kfs[Math.min(i + 1, kfs.length - 1)]
    const pa = this.point(a[1])
    const pb = this.point(b[1])
    const p = b === a ? 1 : ease(clamp((t - a[0]) / (b[0] - a[0]), 0, 1))
    const x = lerp(pa.x, pb.x, p)
    const y = lerp(pa.y, pb.y, p)
    cur.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    cur.classList.toggle('on', t >= kfs[0][0] && t <= kfs[kfs.length - 1][0])
    let click = false
    for (const k of kfs) if (k[2] === 'click' && t >= k[0] - 0.05 && t < k[0] + 0.22) click = true
    cur.classList.toggle('click', click)
  }

  camAt(sc, t, kfs = sc.cam) {
    let i = 0
    while (i < kfs.length - 1 && t >= kfs[i + 1][0]) i++
    const a = kfs[i]
    const b = kfs[Math.min(i + 1, kfs.length - 1)]
    const p = b === a ? 1 : ease(clamp((t - a[0]) / (b[0] - a[0]), 0, 1))
    return { cx: lerp(a[1], b[1], p), cy: lerp(a[2], b[2], p), z: lerp(a[3], b[3], p) }
  }

  updateCamera(sc, t) {
    // How close the camera gets: the whole window in the hero on a wide screen, a
    // fixed 960x680 crop of the main area in the desktop demos, and the scene's full
    // camera move on a phone.
    let c = this.camAt(sc, t)
    if (this.small) c = { cx: c.cx, cy: c.cy, z: c.z * 1.15 }
    else if (this.mode === 'demo') c = { cx: sc.demo ?? 720, cy: 380, z: 1.25 }
    else c = { cx: W / 2, cy: H / 2, z: 1 }
    if (this.fromCam && t < 0.9 && !this.static) {
      const p = ease(t / 0.9)
      c = { cx: lerp(this.fromCam.cx, c.cx, p), cy: lerp(this.fromCam.cy, c.cy, p), z: lerp(this.fromCam.z, c.z, p) }
    }
    this.cam = c
    const s = (this.vw / W) * c.z
    const rw = this.vw / s
    const rh = this.vh / s
    const cx = rw >= W ? W / 2 : clamp(c.cx, rw / 2, W - rw / 2)
    const cy = rh >= H ? H / 2 : clamp(c.cy, rh / 2, H - rh / 2)
    const tx = this.vw / 2 - cx * s
    const ty = this.vh / 2 - cy * s
    this.win.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${s.toFixed(4)})`
  }

  updateTheme(sc, t) {
    let theme = ''
    for (const [s, v] of sc.theme || []) if (t >= s) theme = v
    if (theme !== this.theme) {
      this.theme = theme
      if (theme) this.win.dataset.theme = theme
      else delete this.win.dataset.theme
    }
  }
}

// ---- the caption under the film -----------------------------------------------------
// One line per chapter, and its shortcut: what the feature is, and how you reach it.
const CAPS = {
  panel: ['The agent draws its answer. Buttons type back into the terminal.', ['Ctrl', 'Shift', 'J']],
  overview: ['Every session on one page: the numbers, a question you answer in place, a quiet log of every edit.', ['Ctrl', 'Shift', 'S']],
  todo: ['Your list, beside your sessions. Agents add to it and tick what gets done.', ['Ctrl', 'Shift', 'D']],
  notes: ['Plain .md files you and your agent both write. They open over the tab; the shell keeps running.', 'notes · note'],
  cli: ['Runs the CLI you already use. Never asks for an API key.', 'no API key'],
  splits: ['Split any pane. 51 themes re-tint the whole window.', ['Alt', 'Shift', '+']],
  palette: ['Every action is one command away. Agents can run them too.', ['Ctrl', 'K']],
}

// ---- the hero ------------------------------------------------------------------
const heroRoot = document.querySelector('[data-film="hero"]')
const BEATS = ['panel', 'overview', 'todo', 'notes', 'cli', 'splits', 'palette']
/** Playback rate of the hero film. Below 1 is slower; every beat stretches with it. */
const HERO_SPEED = 0.7
let hero = null

function caption(name) {
  const cap = document.querySelector('[data-cap]')
  const keys = document.querySelector('[data-keys]')
  if (!cap || !keys || !CAPS[name]) return
  const [text, k] = CAPS[name]
  cap.textContent = text
  keys.replaceChildren()
  // Keys are a shortcut; a string is a badge: the promise for "Any CLI", the command for
  // a surface that has none of its own.
  if (Array.isArray(k)) for (const key of k) { const kbd = document.createElement('kbd'); kbd.textContent = key; keys.appendChild(kbd) }
  else if (k) {
    const sp = document.createElement('span')
    sp.className = k === 'no API key' ? 'see__nokey mono' : 'see__cmd mono'
    sp.textContent = k
    keys.appendChild(sp)
  }
}

if (heroRoot) {
  const beats = [...heroRoot.querySelectorAll('[data-go]')]
  const pause = heroRoot.querySelector('[data-pause]')
  hero = new Film(heroRoot, {
    order: BEATS,
    onScene(name) {
      caption(name)
      for (const b of beats) {
        const on = b.dataset.go === name
        b.classList.toggle('is-on', on)
        if (on) b.setAttribute('aria-current', 'step')
        else b.removeAttribute('aria-current')
      }
    },
  })
  for (const b of beats) b.addEventListener('click', () => hero.go(b.dataset.go))
  pause?.addEventListener('click', () => {
    const paused = hero.togglePause()
    pause.setAttribute('aria-label', paused ? 'Play the film' : 'Pause the film')
  })
}

// ---- Cinder at the bottom of the page -----------------------------------------------
;(function bigCinder() {
  const cv = document.querySelector('[data-cinder-big]')
  if (!cv) return
  const ctx = cv.getContext('2d')
  const mood = { state: 'working', attention: null }
  const cta = cv.closest('.closer')?.querySelector('.btn')
  cta?.addEventListener('pointerenter', () => { mood.state = 'attention'; mood.attention = 'handoff' })
  cta?.addEventListener('pointerleave', () => { mood.state = 'working'; mood.attention = null })
  cta?.addEventListener('focus', () => { mood.state = 'attention'; mood.attention = 'handoff' })
  cta?.addEventListener('blur', () => { mood.state = 'working'; mood.attention = null })
  let visible = false
  let raf = 0
  const t0 = performance.now()
  const draw = (now) => {
    raf = 0
    drawMascot(ctx, 240, mood, reduce.matches ? 1.3 : (now - t0) / 1000, 0.8)
    if (visible && !document.hidden && !reduce.matches) raf = requestAnimationFrame(draw)
  }
  new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting
    if (visible && !raf) raf = requestAnimationFrame(draw)
  }).observe(cv)
  document.addEventListener('visibilitychange', () => { if (visible && !raf) raf = requestAnimationFrame(draw) })
})()
