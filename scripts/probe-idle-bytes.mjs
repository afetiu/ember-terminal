/**
 * Is the pty still talking when nobody is?
 *
 * A terminal at a prompt should be silent. If it is not — a blinking cursor is output
 * too — then every "idle" second is a stream of tiny writes, each one parsed, scanned
 * and rendered, and no amount of tuning the render path fixes a shell that will not
 * stop talking. This reads bytesIn twice and reports the rate.
 *
 *   node scripts/probe-idle-bytes.mjs [seconds]
 */
const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9222)
const SECONDS = Number(process.argv[2] ?? 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    const { resolve } = waiting.get(m.id)
    waiting.delete(m.id)
    resolve(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    waiting.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })

const read = async () => {
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__ember.sessions())',
    returnByValue: true,
  })
  return JSON.parse(r.result.value)
}

const a = await read()
await sleep(SECONDS * 1000)
const b = await read()

console.log(`over ${SECONDS}s at an idle prompt:\n`)
for (const s of b) {
  const was = a.find((x) => x.id === s.id)
  if (!was) continue
  const bytes = s.bytesIn - was.bytesIn
  console.log(
    `  ${s.title || s.id}\n` +
      `    bytesIn   ${bytes}  (${(bytes / SECONDS).toFixed(1)}/s)\n` +
      `    sinceLastOutput ${s.sinceOutputMs}ms\n` +
      `    ${bytes > 0 ? '>>> the shell is still writing at an idle prompt' : 'silent'}`,
  )
}
ws.close()
