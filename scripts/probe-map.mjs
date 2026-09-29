import { join, basename } from 'node:path'
/**
 * The map, end to end in a real window, with a screenshot at every step: the whole map,
 * hover focus, a part's card, a connection's card, a traced flow, the blast radius, the
 * legend, the timeline, and a close zoom.
 *
 * It needs a project that has already been surveyed. The first one under the real
 * ~/.ember/maps (or MAP_ID) is copied into the probe's own EMBER_HOME, so nothing the
 * probe does can touch the real model. Live activity is real: the probe's Ember reads
 * the machine's actual Claude transcripts.
 *
 *   node scripts/probe-map.mjs [outDir]
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
const OUT = process.argv[2] ?? EMBER_HOME
mkdirSync(join(EMBER_HOME, 'maps'), { recursive: true })
const real = join(homedir(), '.ember', 'maps')
const mapId = process.env.MAP_ID ?? (existsSync(real) ? readdirSync(real)[0] : undefined)
if (!mapId) throw new Error('no surveyed project in ~/.ember/maps to show')
rmSync(join(EMBER_HOME, 'maps', mapId), { recursive: true, force: true })
cpSync(join(real, mapId), join(EMBER_HOME, 'maps', mapId), { recursive: true })

const PORT = 9341
const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME },
})

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(400)
  }
  throw new Error('no devtools target')
}

const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `map-${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log('shot', name)
}
const mouse = async (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 })
const click = async (x, y, button = 'left') => {
  await mouse('mouseMoved', x, y, 'none')
  await mouse('mousePressed', x, y, button)
  await mouse('mouseReleased', x, y, button)
}
const key = async (k, code, mods = 0, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk })
}
/** Centre of the first visible element matching `sel` whose centre is on the stage. */
const centreOf = (sel, extra = '') =>
  evaluate(`(() => {
    const st = document.querySelector('.mstage').getBoundingClientRect()
    for (const n of document.querySelectorAll(${JSON.stringify(sel)})) {
      ${extra}
      const r = n.getBoundingClientRect()
      const cx = r.x + r.width / 2, cy = r.y + Math.min(r.height / 2, 30)
      if (r.width > 40 && cx > st.x + 60 && cy > st.y + 90 && cx < st.right - 60 && cy < st.bottom - 80) return { x: cx, y: cy, id: n.dataset.id }
    }
    return null
  })()`)

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(3500)
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false })
  await sleep(500)

  await key('G', 'KeyG', 2 | 8, 71)
  await sleep(1200)
  await evaluate(`document.querySelector('.ember-map-row').click()`)
  await sleep(2600)
  console.log('map', JSON.stringify(await evaluate(`({
    nodes: document.querySelectorAll('.mnode:not(.is-hidden)').length,
    open: document.querySelectorAll('.mnode.is-open').length,
    edges: document.querySelectorAll('.medge:not(.is-hidden)').length,
    lod: document.querySelector('.mworld').dataset.lod,
    live: document.querySelectorAll('.mnode.is-live, .mnode.is-live-read').length,
    flows: !document.querySelector('.mhud-tr .mbtn').hidden,
    strip: document.querySelector('.mstrip').innerText.slice(0, 200),
  })`)))
  await shot('1-fit')

  // hover focus
  const leaf = await centreOf('.mnode.is-leaf:not(.is-hidden)')
  if (leaf) {
    await mouse('mouseMoved', leaf.x, leaf.y, 'none')
    await sleep(500)
    await shot('2-hover')
    await click(leaf.x, leaf.y)
    await sleep(700)
    console.log('card', await evaluate(`document.querySelector('.mcard')?.innerText.slice(0, 300)`))
    await shot('3-card')
  }

  // a connection's card: click the middle of the first visible line
  await key('Escape', 'Escape', 0, 27)
  await sleep(300)
  const edge = await evaluate(`(() => {
    for (const p of document.querySelectorAll('.medge:not(.is-hidden) .medge-hit')) {
      const len = p.getTotalLength(); if (len < 80) continue
      const pt = p.getPointAtLength(len / 2).matrixTransform(p.getScreenCTM())
      return { x: pt.x, y: pt.y }
    }
    return null
  })()`)
  if (edge) {
    await click(edge.x, edge.y)
    await sleep(700)
    console.log('edge card', await evaluate(`document.querySelector('.mcard.is-edge')?.innerText.slice(0, 200) ?? 'none'`))
    await shot('4-edge')
    await key('Escape', 'Escape', 0, 27)
  }

  // a flow
  const hasFlows = await evaluate(`document.querySelectorAll('.mhud-tr .mbtn')[0].hidden === false`)
  if (hasFlows) {
    await evaluate(`document.querySelectorAll('.mhud-tr .mbtn')[0].click()`)
    await sleep(400)
    await evaluate(`[...document.querySelectorAll('.mmenu-item')][0].click()`)
    await sleep(4400)
    console.log('flow', await evaluate(`document.querySelector('.mflowbar').innerText.replace(/\\n/g, ' | ')`))
    await shot('5-flow')
    await key('Escape', 'Escape', 0, 27)
    await sleep(300)
  }

  // blast radius from the most connected part
  const hub = await evaluate(`(() => {
    const els = [...document.querySelectorAll('.mnode:not(.is-hidden):not(.is-container)')]
    return els[0]?.dataset.id
  })()`)
  await evaluate(`(() => { const n = [...document.querySelectorAll('.mnode.is-leaf:not(.is-hidden)')].find(x => /heroku|live site|server/i.test(x.innerText)) ?? document.querySelector('.mnode.is-leaf:not(.is-hidden)'); n.querySelector('.mnode-body').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); n.querySelector('.mnode-body').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 })) })()`)
  await sleep(500)
  await evaluate(`[...document.querySelectorAll('.mcard-acts .mbtn')].find(b => /goes down/i.test(b.title))?.click()`)
  await sleep(900)
  console.log('blast', await evaluate(`document.querySelector('.mcaption').innerText`), hub)
  await shot('6-blast')
  await key('Escape', 'Escape', 0, 27)
  await sleep(300)

  // legend and timeline
  await key('l', 'KeyL', 0, 76)
  await evaluate(`document.querySelectorAll('.mhud-tr .mbtn')[1].click()`)
  await sleep(600)
  await shot('7-legend-timeline')
  await key('l', 'KeyL', 0, 76)
  await evaluate(`document.querySelectorAll('.mhud-tr .mbtn')[1].click()`)
  await sleep(300)

  // close zoom
  await key('f', 'KeyF', 0, 70)
  await sleep(700)
  const c = await evaluate(`(() => { const r = document.querySelector('.mstage').getBoundingClientRect(); return { x: r.x + r.width * 0.3, y: r.y + r.height * 0.4 } })()`)
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -120 })
    await sleep(50)
  }
  await sleep(700)
  console.log('zoomed', JSON.stringify(await evaluate(`({ lod: document.querySelector('.mworld').dataset.lod, open: document.querySelectorAll('.mnode.is-open').length, crumbs: document.querySelector('.mcrumbs').innerText })`)))
  await shot('8-zoomed')

  // An update arriving while watching: a new part, written into the probe's own copy,
  // then a reload nudged through the bridge. It should arrive animated and announced.
  {
    const dir = join(EMBER_HOME, 'maps', mapId)
    const { readFileSync } = await import('node:fs')
    const model = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'))
    const changes = JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8'))
    const host = model.nodes.find((n) => n.kind === 'group' && /host/i.test(n.name)) ?? model.nodes.find((n) => !n.parent)
    const other = model.nodes.find((n) => n.kind === 'infra' || n.kind === 'service') ?? model.nodes[1]
    model.nodes.push({ id: 'svc-status-page', name: 'Status page', kind: 'service', parent: host.id, summary: 'Probe: a status page added by an update, to see news arrive.', status: 'ok', deploy: 'Cloudflare Pages' })
    model.edges.push({ id: 'svc-status-page--' + other.id, from: 'svc-status-page', to: other.id, label: 'pings' })
    model.version += 1
    model.updatedAt = new Date().toISOString()
    writeFileSync(join(dir, 'model.json'), JSON.stringify(model))
    changes.push({ id: 'cprobe', at: new Date().toISOString(), kind: 'update', trigger: ['probe'], summary: 'A status page was added and now pings ' + other.name + '.', items: [{ node: 'svc-status-page', text: 'New status page on Cloudflare Pages', impact: 'notable' }], touched: ['svc-status-page', other.id], version: model.version, added: ['svc-status-page'] })
    writeFileSync(join(dir, 'changes.json'), JSON.stringify(changes))
    await key('f', 'KeyF', 0, 70)
    await sleep(600)
    await evaluate(`window.ember.map.edit(${JSON.stringify(mapId)}, {})`)
    await sleep(1400)
    console.log('arrived', JSON.stringify(await evaluate(`({ born: document.querySelectorAll('.mnode.is-born').length, caption: document.querySelector('.mcaption.is-on')?.innerText ?? '' })`)))
    await shot('9-arrived')
  }
  console.log('errors', logs.length ? logs.join('\n') : 'none')
} finally {
  ws.close()
  child.kill()
}
process.exit(0)
