/**
 * Records the README clip from the website's own demo (site/film.js).
 *
 *   node scripts/demo/record-site-demo.mjs [scene] [outdir]
 *
 * scene is the tab under the demo, counted from 0 (default 1, "Fix a bug"). Serves site/
 * on a local port, opens it in a headless Edge with a DevTools port of its own, clicks
 * the scene's tab and records the demo while that scene plays, through
 * Page.startScreencast. Frames land in <outdir>/frames with their timestamps in
 * frames.txt (an ffmpeg concat list), and ffmpeg (on PATH) crops them to the demo and
 * writes docs/media/ember-demo.gif and .mp4.
 *
 * Needs Edge (every Windows 10/11 has it) and ffmpeg. Kills only the Edge it started.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SITE = join(REPO, 'site')
const SCENE = Number(process.argv[2] ?? 1)
const TMP = realpathSync.native(process.env.TEMP ?? '.')
const OUT = process.argv[3] ?? join(TMP, 'ember-site-demo-out')
const FRAMES = join(OUT, 'frames')
const MEDIA = join(REPO, 'docs', 'media')
const VIEW = { width: 1600, height: 1000 }
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

// ---- the site, served as Cloudflare Pages would (clean URLs) ----------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' }
const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '')
  let file = join(SITE, p)
  if (!file.startsWith(SITE)) return res.writeHead(403).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`
  if (!existsSync(file)) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const SITE_URL = `http://127.0.0.1:${server.address().port}/`

// ---- a headless Edge of its own -------------------------------------------------------------
const EDGE = ['ProgramFiles(x86)', 'ProgramFiles']
  .map((v) => process.env[v] && join(process.env[v], 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .find((p) => p && existsSync(p))
if (!EDGE) throw new Error('Edge not found')
const PORT = 9400 + Math.floor(Math.random() * 400)
const profile = join(OUT, 'profile')
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${VIEW.width},${VIEW.height}`, '--hide-scrollbars', '--force-color-profile=srgb',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })
const stop = () => {
  try {
    execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  server.close()
}

try {
  let target
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  if (!target) throw new Error('Edge did not open a DevTools port')

  // ---- a small CDP client ----------------------------------------------------------------
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let seq = 0
  const pending = new Map()
  const listeners = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) listeners.get(m.method)?.(m.params)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const js = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value

  await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await send('Page.enable')
  await send('Page.navigate', { url: SITE_URL })
  await sleep(2500)
  // The demo alone in view: no sticky top bar, the window centred.
  await js(`document.querySelector('.topbar').style.display = 'none';
    document.querySelector('[data-demo]').scrollIntoView({ block: 'center' }); true`)
  await sleep(400)
  await js(`document.querySelector('[data-sc="${SCENE}"]').click(); true`)
  await sleep(200)
  const rect = await js(`(() => { const r = document.querySelector('[data-demo]').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`)

  // ---- record until the next scene starts ------------------------------------------------
  const frames = []
  listeners.set('Page.screencastFrame', (p) => {
    const file = join(FRAMES, `f${String(frames.length).padStart(5, '0')}.png`)
    writeFileSync(file, Buffer.from(p.data, 'base64'))
    // timed on arrival: the screencast's own timestamps are not a usable clock here
    frames.push({ file, t: performance.now() / 1000 })
    send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  })
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: VIEW.width, maxHeight: VIEW.height })
  const t0 = Date.now()
  while (Date.now() - t0 < 120_000) {
    await sleep(500)
    const now = await js(`document.querySelector('[data-sc].is-on')?.dataset.sc`)
    if (Number(now) !== SCENE) break
  }
  await send('Page.stopScreencast')
  ws.close()
  if (frames.length < 10) throw new Error(`only ${frames.length} frames recorded`)

  // ---- frames -> clip ----------------------------------------------------------------------
  const list = frames.map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${(((frames[i + 1]?.t ?? f.t + 0.05) - f.t)).toFixed(3)}`)
  list.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
  const concat = join(OUT, 'frames.txt')
  writeFileSync(concat, list.join('\n'))
  mkdirSync(MEDIA, { recursive: true })
  const crop = `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, ...args], { stdio: 'inherit' })
  ff(['-vf', `${crop},fps=30,scale=1280:-2:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', join(MEDIA, 'ember-demo.mp4')])
  ff(['-vf', `${crop},fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, join(MEDIA, 'ember-demo.gif')])
  const size = (f) => `${(statSync(join(MEDIA, f)).size / 1e6).toFixed(1)} MB`
  console.log(`${frames.length} frames, ${((frames.at(-1).t - frames[0].t)).toFixed(1)} s -> ember-demo.gif (${size('ember-demo.gif')}), ember-demo.mp4 (${size('ember-demo.mp4')})`)
} finally {
  stop()
}
