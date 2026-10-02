// Ember landing page. No build step, no dependencies.
// The hero film and the "See it work" demos live in film.js (an ES module).

// ---- Downloads -------------------------------------------------------------------
// Download links are plain same-site paths in the HTML (/download/windows,
// /download/windows-zip, /download/windows-targz), so they work without JS. Where
// those paths actually lead is decided in site/_redirects, the one place to change
// when the hosting moves.
//
// VERSION is the version the site advertises; keep it in step with package.json on
// each release. [data-version] elements show it, [data-repo] gets REPO_URL and
// [data-releases] gets the release list.
const VERSION = '1.0.0'
const REPO_URL = 'https://github.com/afetiu/ember-terminal'
// ---------------------------------------------------------------------------------

document.documentElement.classList.add('js')

for (const a of document.querySelectorAll('[data-repo]')) a.href = REPO_URL
for (const a of document.querySelectorAll('[data-releases]')) a.href = REPO_URL + '/releases'
for (const el of document.querySelectorAll('[data-version]')) {
  el.textContent = 'v' + VERSION
  el.classList.add('has-version')
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

// ---- Travelling caret ------------------------------------------------------------
// Same idea as the app's caret: a stiff head spring and a slack tail spring, with the
// smear drawn between them. It hops between the ends of the headline's phrases.
;(function travellingCaret() {
  const host = document.querySelector('[data-caret-host]')
  if (!host) return
  const stops = [...host.querySelectorAll('[data-caret-stop]')]
  if (!stops.length) return

  const caret = document.createElement('span')
  caret.className = 'tcaret'
  caret.setAttribute('aria-hidden', 'true')
  host.appendChild(caret)

  const spring = (k, c) => ({ x: 0, v: 0, k, c })
  const head = { x: spring(900, 2 * Math.sqrt(900) * 0.82), y: spring(900, 2 * Math.sqrt(900)) }
  const tail = spring(260, 2 * Math.sqrt(260))
  let target = { x: 0, y: 0 }
  let index = stops.length - 1
  let raf = 0
  let last = 0

  function endOf(el) {
    const rects = el.getClientRects()
    const r = rects[rects.length - 1]
    const h = host.getBoundingClientRect()
    return { x: r.right - h.left + 6, y: r.top - h.top + r.height * 0.14, height: r.height * 0.74 }
  }

  function place(snap) {
    const t = endOf(stops[index])
    target = t
    caret.style.height = t.height + 'px'
    if (snap) {
      head.x.x = tail.x = t.x
      head.y.x = t.y
      head.x.v = head.y.v = tail.v = 0
      draw()
    }
  }

  function step(s, to, dt) {
    const a = -s.k * (s.x - to) - s.c * s.v
    s.v += a * dt
    s.x += s.v * dt
  }

  function draw() {
    const w = Math.max(5, parseFloat(getComputedStyle(host).fontSize) * 0.09)
    const left = Math.min(head.x.x, tail.x)
    const span = Math.abs(head.x.x - tail.x)
    caret.style.transform = `translate(${left}px, ${head.y.x}px)`
    caret.style.width = w + span + 'px'
    caret.style.opacity = String(1 - Math.min(0.55, span / 900))
  }

  function frame(now) {
    const dt = Math.min(0.032, (now - last) / 1000 || 0.016)
    last = now
    // A few substeps keep the stiff spring stable at low frame rates.
    for (let i = 0; i < 4; i++) {
      step(head.x, target.x, dt / 4)
      step(head.y, target.y, dt / 4)
      step(tail, head.x.x, dt / 4)
    }
    draw()
    const settled =
      Math.abs(head.x.x - target.x) < 0.3 && Math.abs(tail.x - target.x) < 0.3 &&
      Math.abs(head.x.v) + Math.abs(tail.v) < 1
    if (settled) { raf = 0; place(true); return }
    raf = requestAnimationFrame(frame)
  }

  function hop() {
    index = (index + 1) % stops.length
    place(false)
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame) }
  }

  const start = () => place(true)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start)
  else start()
  window.addEventListener('resize', () => place(true))

  let timer = 0
  function schedule() {
    clearInterval(timer)
    if (!reduceMotion.matches) timer = setInterval(() => { if (!document.hidden) hop() }, 2600)
  }
  schedule()
  reduceMotion.addEventListener?.('change', () => { schedule(); index = stops.length - 1; place(true) })
})()

// ---- App theme switch --------------------------------------------------------------
// "App theme: Night | Day" re-skins the Ember windows in the films (every .win and the
// .film__view frame around it) between Ember Night and Ember Day. The page itself stays
// night. One shared state for every switch on the page, remembered across visits.
// This runs before film.js (both are deferred, in document order), so the demo window,
// which film.js clones from the hero, starts out in the right mode.
;(function appMode() {
  const KEY = 'ember-site:app-mode'
  const buttons = [...document.querySelectorAll('[data-app-mode]')]
  if (!buttons.length) return
  let mode = 'night'
  try { if (localStorage.getItem(KEY) === 'day') mode = 'day' } catch {}

  function apply() {
    for (const el of document.querySelectorAll('.win, .film__view')) {
      if (mode === 'day') el.dataset.mode = 'day'
      else delete el.dataset.mode
    }
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.appMode === mode))
  }
  apply()

  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (b.dataset.appMode === mode) return
      mode = b.dataset.appMode
      try { localStorage.setItem(KEY, mode) } catch {}
      // A cross-fade where the browser has one; the window's own colour transitions otherwise.
      if (document.startViewTransition && !reduceMotion.matches) document.startViewTransition(apply)
      else apply()
    })
  }
})()

// ---- Reveal on scroll --------------------------------------------------------------
;(function reveal() {
  const targets = document.querySelectorAll('.steps li, .faq__list details, .clis li')
  if (!('IntersectionObserver' in window) || reduceMotion.matches) return
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  targets.forEach((t, i) => {
    t.classList.add('reveal')
    t.style.transitionDelay = (i % 4) * 60 + 'ms'
    io.observe(t)
  })
})()
