/**
 * What is animating when nothing should be.
 *
 * A CSS animation runs on the compositor without touching JS, so it is invisible to a
 * CPU profile and shows up only as GPU and paint time — which is exactly the shape of
 * Ember's unexplained idle cost. `document.getAnimations()` is the ground truth: it
 * lists what the engine is actually running right now, regardless of what any stylesheet
 * says should apply.
 *
 * Properties matter as much as count. Animating opacity or transform is composited and
 * nearly free; animating background, box-shadow, filter, width or height repaints every
 * frame forever.
 *
 *   node scripts/probe-anim.mjs
 */
const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9222)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('No renderer target — launch Ember with --remote-debugging-port=%d', PORT)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

// Runs in the page. Keyframe properties come from the stylesheet rules, because the
// animation object itself only carries the name.
const expression = `(() => {
  const props = new Map()
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      if (rule.type !== CSSRule.KEYFRAMES_RULE) continue
      const set = new Set()
      for (const kf of rule.cssRules) {
        for (let i = 0; i < kf.style.length; i++) set.add(kf.style[i])
      }
      props.set(rule.name, [...set])
    }
  }
  const CHEAP = new Set(['opacity', 'transform'])
  const out = []
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue
    const name = a.animationName || (a.effect && a.effect.getKeyframes && '(transition)') || '?'
    const el = a.effect && a.effect.target
    const p = props.get(name) || []
    out.push({
      name,
      selector: el ? (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : el.tagName) : '?',
      props: p,
      composited: p.length > 0 && p.every((x) => CHEAP.has(x)),
      visible: el ? !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) : false,
    })
  }
  return JSON.stringify(out)
})()`

const r = await send('Runtime.evaluate', { expression, returnByValue: true })
const anims = JSON.parse(r.result.value)

if (anims.length === 0) {
  console.log('Nothing is animating. The idle cost is not CSS.')
} else {
  console.log(`${anims.length} animation(s) running right now:\n`)
  for (const a of anims) {
    const flag = a.composited ? 'composited' : 'REPAINTS EVERY FRAME'
    const vis = a.visible ? '' : '  [not visible — animating off-screen]'
    console.log(`  ${a.name}  ${flag}${vis}`)
    console.log(`    on    ${a.selector}`)
    console.log(`    props ${a.props.join(', ') || '(unknown)'}\n`)
  }
}
ws.close()
