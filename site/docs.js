// Ember docs: the table of contents. Collapses behind a button on narrow screens and
// marks the section being read. No dependencies; without JS the list simply stays open.
;(function toc() {
  const nav = document.querySelector('[data-toc]')
  if (!nav) return
  const toggle = nav.querySelector('.toc__toggle')
  const currentLabel = nav.querySelector('[data-toc-current]')
  const links = [...nav.querySelectorAll('a[href^="#"]')]
  const narrow = window.matchMedia('(max-width: 999px)')

  function setOpen(open) {
    nav.classList.toggle('is-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  toggle.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open')
    setOpen(open)
    // Open on the entry being read, not wherever the list was last scrolled to.
    if (open && current) {
      const panel = nav.querySelector('.toc__panel')
      panel.scrollTop = current.a.offsetTop - panel.offsetTop - panel.clientHeight / 3
    }
  })
  nav.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false)
      toggle.focus()
    }
  })
  // Picking a section on a phone closes the list so the section is visible.
  for (const a of links) a.addEventListener('click', () => { if (narrow.matches) setOpen(false) })
  narrow.addEventListener?.('change', () => setOpen(false))

  // Scrollspy: the last section whose heading has passed the top bar is current.
  const targets = links
    .map((a) => ({ a, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
    .filter((t) => t.el)
  let current = null
  function mark() {
    const line = narrow.matches ? 140 : 110
    let hit = targets[0]
    for (const t of targets) {
      if (t.el.getBoundingClientRect().top - line <= 0) hit = t
      else break
    }
    // At the very bottom the last short sections can never reach the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) hit = targets[targets.length - 1]
    if (hit === current) return
    current?.a.classList.remove('is-current')
    current?.a.removeAttribute('aria-current')
    current = hit
    if (!current) return
    current.a.classList.add('is-current')
    current.a.setAttribute('aria-current', 'location')
    if (currentLabel) currentLabel.textContent = current.a.textContent
    // Keep the highlighted entry visible in the sticky desktop list.
    if (!narrow.matches) {
      const box = nav.getBoundingClientRect()
      const r = current.a.getBoundingClientRect()
      if (r.top < box.top || r.bottom > box.bottom) nav.scrollTop += r.top - box.top - box.height / 3
    }
  }
  let queued = false
  window.addEventListener('scroll', () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; mark() })
  }, { passive: true })
  window.addEventListener('resize', mark)
  mark()
})()
