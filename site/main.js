// Ember landing page. No build step, no dependencies.
// The demo in the hero, one chapter per feature, lives in film.js (an ES module).

// ---- Downloads -------------------------------------------------------------------
// Download links are plain same-site paths in the HTML (/download/windows,
// /download/windows-zip, /download/windows-targz), so they work without JS. Where
// those paths actually lead is decided in site/_redirects, the one place to change
// when the hosting moves.
//
// VERSION is the version the site advertises. scripts/deploy-site.mjs stamps it from
// package.json on every deploy. [data-version] elements show it, [data-repo] gets REPO_URL and
// [data-releases] gets the release list.
const VERSION = '1.11.0'
const REPO_URL = 'https://github.com/afetiu/ember-terminal'
// ---------------------------------------------------------------------------------

document.documentElement.classList.add('js')

for (const a of document.querySelectorAll('[data-repo]')) a.href = REPO_URL
for (const a of document.querySelectorAll('[data-releases]')) a.href = REPO_URL + '/releases'
for (const el of document.querySelectorAll('[data-version]')) {
  el.textContent = 'v' + VERSION
  el.classList.add('has-version')
}

// Copy buttons: the install command, ready to paste into a terminal.
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', () => {
    navigator.clipboard?.writeText(b.dataset.copy).then(() => {
      const was = b.textContent
      b.textContent = 'Copied'
      setTimeout(() => (b.textContent = was), 1400)
    })
  })
}

// ---- Reveal on scroll --------------------------------------------------------------
;(function reveal() {
  const els = document.querySelectorAll('.feat, .agents__in, .steps li, .faq details, .closer__in')
  if (!('IntersectionObserver' in window)) return
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('is-in')
        io.unobserve(e.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px' }
  )
  els.forEach((el, i) => {
    el.classList.add('rv')
    el.style.transitionDelay = `${(i % 3) * 70}ms`
    io.observe(el)
  })
})()
