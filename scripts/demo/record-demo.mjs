/**
 * Records the README clip, "Which agent needs you?".
 *
 *   node scripts/demo/record-demo.mjs [outdir]
 *
 * Starts an isolated Ember (its own EMBER_HOME, user-data-dir and DevTools port, house
 * theme, opaque window), opens four tabs and runs scripts/demo/fake-agent.mjs in each:
 * a stand-in that paints Claude Code's screens, so the cards read them exactly as they
 * would a real session. Then it plays the story — four agents at work, one stops on a
 * permission prompt, it is answered from its card, it goes back to work — and records
 * the window through Page.startScreencast. Frames land in <outdir>/frames with their
 * timestamps in frames.txt (an ffmpeg concat list), and ffmpeg (on PATH) turns them into
 * docs/media/ember-demo.gif and .mp4, with a caption strip under the window.
 *
 * Kills only the Electron it started, by PID tree. Never by name: the Ember you are
 * reading this in is an Electron too.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const TMP = realpathSync.native(process.env.TEMP ?? '.')
const OUT = process.argv[2] ?? join(TMP, 'ember-demo-out')
const FRAMES = join(OUT, 'frames')
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
const PORT = 9477
const W = 1000
const H = 620
const EMBER_HOME = join(TMP, `ember-probe-${basename(process.argv[1])}`)
rmSync(EMBER_HOME, { recursive: true, force: true })
const CTRL = join(EMBER_HOME, 'ctrl')
const NOTES = join(EMBER_HOME, 'notes')
const CODE = join(EMBER_HOME, 'code')
for (const d of [CTRL, NOTES]) mkdirSync(d, { recursive: true })
// Tab order is creation order; the last one created is the one on screen, which is api.
const SCENES = ['docs', 'web', 'infra', 'api']
for (const s of SCENES) mkdirSync(join(CODE, s), { recursive: true })

writeFileSync(
  join(EMBER_HOME, 'config.json'),
  JSON.stringify(
    {
      window: { opacity: 100, inactiveOpacity: 100 },
      font: { size: 14 },
      sound: { enabled: false, volume: 0 },
      claude: { usageLimits: false, statusLine: false },
      agent: { default: 'claude', onboarded: true },
      labs: { enabled: false },
      effects: { glow: 1, scanlines: 0, vignette: 0, ambient: true, outputMotion: true, outputMotionMaxRate: 24000, adaptive: false },
    },
    null,
    2,
  ),
)

const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(EMBER_HOME, 'ud')}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1' },
})
const killTree = () => {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
}
process.on('exit', killTree)

async function target() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('http://127.0.0.1') && !t.url.startsWith('devtools://'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}

const ws = new WebSocket((await target()).webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
const frames = []
let recording = false
let t0 = 0
const END = 15500
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.method === 'Page.screencastFrame') {
    const { data, metadata, sessionId } = msg.params
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId } }))
    if (recording) {
      const file = join(FRAMES, `f${String(frames.length).padStart(5, '0')}.jpg`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      frames.push({ file, t: Date.now() - t0 })
    }
    return
  }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    pending.set(++seq, { res, rej })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}
const write = (i, text) => ev(`window.ember.write(window.__ember.sessions()[${i}].id, ${JSON.stringify(text)})`)
const sessions = () => ev(`window.__ember.sessions().map((s) => ({ id: s.id, title: s.title, state: s.activity.state, attention: s.activity.attention, agent: s.activity.agent }))`)

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
for (let i = 0; i < 40; i++) {
  if ((await ev(`window.__ember?.sessions().length ?? 0`)) > 0) break
  await sleep(300)
}
await sleep(2500)
for (let i = 1; i < SCENES.length; i++) {
  await ev(`window.__ember.newTab()`)
  await sleep(1800)
}
await sleep(1500)

// Each tab: into its folder, named after it, then the stand-in agent.
const agent = join(HERE, 'fake-agent.mjs')
for (const [i, s] of SCENES.entries()) {
  await write(i, `cd '${join(CODE, s)}'; ember rename ${s}; cls; node '${agent}' ${s} '${CTRL}'\r`)
  await sleep(700)
}
// The last tab opened (api) stays in front; the others work in the background. No
// switch here on purpose: one issued while the last tab's entrance is still in flight
// can leave two tabs superimposed on a loaded machine.
await sleep(6000)
const visible = await ev(`[...document.querySelectorAll('.ember-group')].filter((g) => getComputedStyle(g).visibility !== 'hidden' && Number(getComputedStyle(g).opacity) > 0.05).length`)
if (visible !== 1) throw new Error(`${visible} tabs on screen, expected 1`)
console.log('before:', JSON.stringify(await sessions()))

// A pointer, drawn into the page, so the click reads in the recording.
await ev(`(() => {
  const p = document.createElement('div')
  p.id = 'demo-pointer'
  p.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  Object.assign(p.style, { position: 'fixed', left: '0px', top: '0px', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(${W - 260}px, ${H - 180}px)', transition: 'transform 900ms cubic-bezier(.3,.7,.2,1)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))' })
  document.body.appendChild(p)
})()`)

t0 = Date.now()
recording = true
await send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: W * 2, maxHeight: H * 2 })
const at = async (ms) => {
  const wait = t0 + ms - Date.now()
  if (wait > 0) await sleep(wait)
}

// 0–3s: four agents at work.
await at(3000)
writeFileSync(join(CTRL, 'web.ask'), '1')
// The captions and the zoom are timed off when the card actually changes, which varies
// by a second or so with machine load.
const webCard = `window.__ember.sessions()[${SCENES.indexOf('web')}].activity.state`
const waitState = async (want) => {
  for (let i = 0; i < 60; i++) {
    if ((await ev(webCard)) === want) break
    await sleep(100)
  }
  return (Date.now() - t0) / 1000
}
const blockedAt = await waitState('attention')
// ~4–7.5s: web stops on a permission prompt; its card asks for you. Held long enough to
// read, with the assembly below zooming in on the sidebar for this beat.
await at(5000)
const card = await ev(`(() => {
  const cards = [...document.querySelectorAll('.ember-card')]
  const c = cards.find((c) => c.querySelector('.ember-card-title')?.textContent.trim() === 'web') ?? cards[1]
  const r = c.getBoundingClientRect()
  return { x: Math.round(r.left + r.width * 0.45), y: Math.round(r.top + r.height * 0.5), state: c.dataset.state, attention: c.dataset.attention }
})()`)
console.log('web card during the blocked beat:', JSON.stringify(card))
await at(7500)
await ev(`document.getElementById('demo-pointer').style.transform = 'translate(${card.x}px, ${card.y}px)'`)
await at(8600)
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: card.x, y: card.y, button: 'left', clickCount: 1 })
  await sleep(70)
}
// 8.6–10.6s: the prompt, in its own tab. Answer it.
await at(9300)
await ev(`document.getElementById('demo-pointer').style.transform = 'translate(${W - 300}px, ${H - 160}px)'`)
await at(10600)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', text: '1', windowsVirtualKeyCode: 49 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 })
const resumedAt = await waitState('working')
console.log(`blocked at ${blockedAt.toFixed(1)}s, working again at ${resumedAt.toFixed(1)}s`)
// 10.6–15.5s: back to work.
await at(END)
recording = false
await send('Page.stopScreencast')
console.log('after:', JSON.stringify(await sessions()))

// ffmpeg concat list: each frame held until the next one arrived.
// Times are ms since t0; the first frame stands in for the moment before it arrived,
// so the captions below line up with the timeline above.
frames[0].t = 0
const lines = []
for (let i = 0; i < frames.length; i++) {
  const next = (frames[i + 1]?.t ?? END) / 1000
  frames[i].t /= 1000
  lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${Math.max(0.001, next - frames[i].t).toFixed(4)}`)
}
lines.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
writeFileSync(join(OUT, 'frames.txt'), `${lines.join('\n')}\n`)
console.log(`${frames.length} frames over ${(END / 1000).toFixed(1)}s -> ${OUT}`)
for (const s of SCENES) await write(SCENES.indexOf(s), '\x03')
ws.close()
killTree()

// Captions follow the timeline above.
const font = (bold) => `fontfile='C\\:/Windows/Fonts/segoeui${bold ? 'b' : ''}.ttf'`
const caption = (text, color, when, bold = false) =>
  `drawtext=${font(bold)}:fontsize=22:fontcolor=${color}:x=24:y=h-37:text='${text}':enable='${when}'`
const captions = [
  caption('Four Claude Code sessions, each working on its own task', '0xd9cfe8', `lt(t,${blockedAt})`),
  caption('web is blocked on a permission prompt. Its card asks for you.', '0xffb547', `between(t,${blockedAt},8.6)`, true),
  caption('Click the card, answer the prompt', '0xd9cfe8', `between(t,8.6,${resumedAt})`),
  caption('web is back at work', '0x7fe0b0', `gte(t,${resumedAt})`),
].join(',\n')
const MEDIA = join(REPO, 'docs', 'media')
mkdirSync(MEDIA, { recursive: true })
// Framing only, on the 2x frames: the bottom 56px (the sidebar's machine strip, which
// has no setting) are cropped away, and the blocked beat zooms in on the web card —
// a straight cut in just after the card changes and back out at 7.4s, before the pointer moves. (Animated
// ramps were tried: every frame of a zoom repaints the whole GIF, ~2MB per ramp.)
const SRC_W = W * 2
const SRC_H = H * 2 - 56
const Z = 1.8
const ease = `between(it,${(blockedAt + 0.4).toFixed(2)},7.4)`
const focusY = Math.max(0, Math.min(SRC_H - SRC_H / Z, card.y * 2 - SRC_H / Z / 2))
const zoom = (fps) =>
  `fps=${fps},crop=${SRC_W}:${SRC_H}:0:0,zoompan=z='1+${Z - 1}*${ease}':x='0':y='${focusY.toFixed(0)}*${ease}':d=1:s=${SRC_W}x${SRC_H}:fps=${fps}`
const strip = (fps, width) => `${zoom(fps)},scale=${width}:-2:flags=lanczos,pad=iw:ih+52:0:0:color=0x1a1326,\n${captions}`
writeFileSync(
  join(OUT, 'gif.txt'),
  `${strip(12, 1200)},\nsplit[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle\n`,
)
writeFileSync(join(OUT, 'mp4.txt'), `${strip(30, 1600)},format=yuv420p\n`)
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'frames.txt'), ...args], { stdio: 'inherit' })
ff('-/filter_complex', join(OUT, 'gif.txt'), '-loop', '0', join(MEDIA, 'ember-demo.gif'))
ff('-/filter_complex', join(OUT, 'mp4.txt'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', join(MEDIA, 'ember-demo.mp4'))
console.log(`wrote ${join(MEDIA, 'ember-demo.gif')} and .mp4`)
process.exit(0)
