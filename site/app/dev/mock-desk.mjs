/**
 * A pretend Ember desk, for testing the phone app without Ember.
 *
 *   node site/app/dev/mock-desk.mjs <relay-url> [key]
 *
 * Joins the account as kind 'desk', answers hello/watch/get/send/key/act per
 * docs/specs/phone.md, and logs every message it receives. Prints the join URL.
 * Node 22+ (global WebSocket and crypto.subtle).
 */
import { AccountLink, newAccountKey, newDeviceId } from '../protocol.js'

const RELAY = process.argv[2] || 'http://localhost:8799'
const KEY = process.argv[3] || process.env.EMBER_KEY || newAccountKey()
const APP = process.env.APP_URL || 'http://localhost:8790/app/'

const now = Date.now()
const at = (minAgo) => now - minAgo * 60_000

const MERMAID_DOC = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;background:transparent;color:#E8E0D5;font:14px/1.5 'Segoe UI Variable',-apple-system,system-ui,sans-serif}
  body{padding:14px 16px}
  pre.mermaid{background:none;border:0;text-align:center;margin:8px 0;color:transparent}
  .ember-fit pre.mermaid svg{max-height:calc(100vh - 24px)}
  p{color:#A99F92;margin:0 0 8px}
</style>
<script src="/vendor/mermaid.min.js"></script>
</head><body>
<p>How a message travels from the phone to the session.</p>
<pre class="mermaid">flowchart TD
  P[Phone app] -->|sealed frame| R[(Relay)]
  R -->|routes by account id| D[Ember desk]
  D --> B[Bridge]
  B --> S[Claude Code session]
  S -->|transcript| G[Digest to Ev]
  G -->|ev| R
  R --> P</pre>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'dark', themeVariables: { primaryColor: '#2a221b', primaryBorderColor: '#F2A43A', lineColor: '#A99F92', primaryTextColor: '#E8E0D5', fontFamily: 'Segoe UI Variable, system-ui, sans-serif' } })
  mermaid.run({ querySelector: 'pre.mermaid' })
</script>
<script>(function(){if(window.parent===window)return;var last=-1;function post(){var d=document.documentElement,b=document.body;var h=Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0));if(Math.abs(h-last)<2)return;last=h;try{parent.postMessage({emberDocHeight:h},'*')}catch(e){}}addEventListener('load',post);try{var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}catch(e){}setTimeout(post,30);setTimeout(post,400);setTimeout(post,1500)})()</script>
</body></html>`

const TABLE_DOC = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;color:#E8E0D5;font:14px/1.5 system-ui,sans-serif}body{padding:12px 14px}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}th{color:#A99F92}
.ember-ask button{margin:8px 6px 0 0;padding:8px 12px;border-radius:10px;border:0;background:#F2A43A;color:#20160b;font-weight:600}</style>
</head><body>
<table><tr><th>Check</th><th>Result</th></tr><tr><td>Build</td><td>passes</td></tr><tr><td>Tests</td><td>42 / 42</td></tr><tr><td>Bundle</td><td>184 KB</td></tr></table>
<div class="ember-ask"><button onclick="parent.postMessage({__emberPanel:true,kind:'send',text:'Ship it',submit:true,act:'x'},'*')">Ship it</button><button onclick="parent.postMessage({__emberPanel:true,kind:'send',text:'Wait',submit:true,act:'x'},'*')">Wait</button></div>
</body></html>`

// A small amber gradient PNG, made here so it is certainly valid.
import { deflateSync } from 'node:zlib'
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const t = x / w; raw[o] = 40 + 202 * t; raw[o + 1] = 30 + 134 * t * (1 - y / h / 2); raw[o + 2] = 25 + 33 * t }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
const PNG_B64 = png(320, 200)

const DOCS = {
  '/doc/d1': { type: 'text/html; charset=utf-8', body: MERMAID_DOC },
  '/doc/d2': { type: 'text/html; charset=utf-8', body: TABLE_DOC },
  '/doc/d3': { type: 'text/html; charset=utf-8', body: TABLE_DOC.replace('42 / 42', '43 / 43').replace('passes', 'passes (updated)') },
  '/media/m1': { type: 'image/png', b64: PNG_B64 },
}

const TABS = [
  { id: 't-shell', title: 'pwsh', cwd: 'C:\\Users\\you', working: false, loom: false, active: false },
  { id: 't-ember', title: 'ember', cwd: 'C:\\Users\\you\\projects\\ember', working: true, loom: true, active: true },
  { id: 't-site', title: 'demo-site', cwd: 'C:\\Users\\you\\projects\\demo-site', working: false, loom: true, active: false },
]

const EVENTS = {
  't-ember': [
    { k: 'you', id: 'u1', text: 'Sketch how the phone link works end to end, and check the build.', at: at(30) },
    { k: 'act', id: 'a1', label: 'Read docs/specs/phone.md', at: at(29) },
    { k: 'act', id: 'a2', label: 'Grep "AccountLink" in src', at: at(29) },
    {
      k: 'steps', id: 's1', title: 'Phone link', at: at(28),
      steps: [
        { text: 'Read the spec', status: 'completed' },
        { text: 'Draw the flow', status: 'completed' },
        { text: 'Check the build', status: 'completed' },
      ],
    },
    { k: 'obj', id: 'o1', title: 'Phone link flow', format: 'mermaid', path: '/doc/d1', at: at(27) },
    { k: 'obj', id: 'o2', title: 'Build check', format: 'table', path: '/doc/d2', at: at(26) },
    { k: 'link', id: 'l1', title: 'Cloudflare Durable Objects', url: 'https://developers.cloudflare.com/durable-objects/', at: at(26) },
    {
      k: 'say', id: 'y1', end: true, at: at(25),
      text:
        '## How it works\n\nThe phone never talks to your computer directly. Both dial **out** to the relay, which routes by `SHA-256(key)` and reads nothing.\n\n' +
        '1. The phone seals each message with the account key\n2. The relay forwards it to the desk\n   - by device id\n   - without opening it\n3. The desk answers with `tabs`, `snap` and `ev`\n\n' +
        '| Piece | Where |\n|---|---:|\n| Relay | Cloudflare Worker |\n| Desk | Ember |\n| Phone | `site/app/` |\n\n' +
        '```js\nlink.send(desk, { t: \'hello\', v: 1 })\n```\n\n> The QR code is the whole account. Treat it like a house key.\n\nSee https://ember.deepanswerlabs.com for more.',
    },
    { k: 'you', id: 'u2', text: 'Now add the turn strip and run the tests.', at: at(5) },
    { k: 'act', id: 'a3', label: 'Edit LoomView.ts', at: at(4) },
    {
      k: 'steps', id: 's2', title: 'Turn strip', at: at(4),
      steps: [
        { text: 'Add the strip component', status: 'completed' },
        { text: 'Wire swipe gestures', status: 'in_progress' },
        { text: 'Run the tests', status: 'pending' },
      ],
    },
    { k: 'agent', id: 'g1', agentId: 'ag1', label: 'Explore tests', state: 'run', at: at(3) },
    { k: 'agent', id: 'g2', agentId: 'ag2', label: 'Review CSS', state: 'done', at: at(3) },
    { k: 'media', id: 'm1', title: 'Screenshot', items: [{ path: '/media/m1', kind: 'image', name: 'strip.png', caption: 'The strip at 390px' }], at: at(2) },
    { k: 'note', id: 'n1', text: 'Context compacted', at: at(2) },
    { k: 'act', id: 'a4', label: 'Bash npm test -- --run strip', at: at(1) },
  ],
  't-site': [
    { k: 'you', id: 'su1', text: 'Fix the gallery spacing on mobile.', at: at(120) },
    { k: 'act', id: 'sa1', label: 'Edit styles.css', at: at(119) },
    { k: 'say', id: 'sy1', end: true, text: 'Done. The gallery now uses a **12px** gap below 480px.', at: at(118) },
  ],
  't-shell': [],
}

let watching = null
let phone = null

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const link = new AccountLink({
  relay: RELAY,
  key: KEY,
  deviceId: process.env.DESK_ID || newDeviceId(),
  kind: 'desk',
  name: (process.env.DESK_NAME || 'Studio PC'),
  onStatus: (s) => log('[status]', s),
  onRoster: (devices) => log('[roster]', devices.map((d) => `${d.kind}:${d.name}${d.online ? '' : '(off)'}${d.self ? '(me)' : ''}`).join(', ')),
  onMessage: (msg, from) => {
    phone = from
    log('[recv]', JSON.stringify(msg))
    handle(msg, from)
  },
})

function handle(msg, from) {
  switch (msg.t) {
    case 'hello':
      return link.send(from, { t: 'tabs', tabs: TABS, desk: { name: (process.env.DESK_NAME || 'Studio PC') } })
    case 'watch':
      watching = msg.tab
      if (msg.tab === 't-ember') startTicks()
      return link.send(from, { t: 'snap', tab: msg.tab, events: EVENTS[msg.tab] ?? [] })
    case 'get': {
      const doc = DOCS[msg.path]
      if (!/^\/(doc|media)\//.test(String(msg.path))) return link.send(from, { t: 'err', id: msg.id, error: 'not allowed' })
      if (!doc) return link.send(from, { t: 'got', id: msg.id, seq: 0, last: true, status: 404, type: 'text/plain', b64: '' })
      const b64 = doc.b64 ?? Buffer.from(doc.body, 'utf8').toString('base64')
      // Chunk small on purpose so reassembly is exercised.
      const size = 4000
      const parts = []
      for (let i = 0; i < b64.length; i += size) parts.push(b64.slice(i, i + size))
      parts.forEach((p, seq) =>
        setTimeout(() => link.send(from, { t: 'got', id: msg.id, seq, last: seq === parts.length - 1, status: 200, type: doc.type, b64: p }), 60 + (parts.length - seq) * 15)
      )
      return
    }
    case 'send': {
      const id = `u${Date.now()}`
      push(msg.tab, [{ k: 'you', id, text: msg.text, at: Date.now() }])
      setTimeout(() => push(msg.tab, [{ k: 'act', id: id + 'a', label: 'Read README.md', at: Date.now() }]), 700)
      setTimeout(() => push(msg.tab, [{ k: 'say', id: id + 's', end: true, text: `Got it: *${msg.text.slice(0, 60)}*`, at: Date.now() }]), 2000)
      return
    }
    case 'key':
    case 'act':
      return
  }
}

function push(tab, events) {
  ;(EVENTS[tab] ??= []).push(...events)
  if (phone && watching === tab) link.send(phone, { t: 'ev', tab, events })
}

// Keep the working turn alive: finish the plan step by step, then the agent.
let tick = 0
let ticking = false
function startTicks() {
  if (ticking) return
  ticking = true
  setInterval(() => {
    const tab = 't-ember'
    tick++
    if (tick === 3) push(tab, [{ k: 'steps', id: 's3', title: 'Turn strip', at: Date.now(), steps: [{ text: 'Add the strip component', status: 'completed' }, { text: 'Wire swipe gestures', status: 'completed' }, { text: 'Run the tests', status: 'in_progress' }] }])
    if (tick === 4) push(tab, [{ k: 'act', id: 'a5', label: 'Bash npm test -- --run swipe', at: Date.now() }])
    if (tick === 5) push(tab, [{ k: 'obj', id: 'o3', title: 'Test results', format: 'table', path: '/doc/d2', at: Date.now() }])
    if (tick === 8) push(tab, [{ k: 'obj', id: 'o4', title: 'test  results', format: 'table', path: '/doc/d3', at: Date.now() }])
    if (tick === 6) push(tab, [{ k: 'agent', id: 'g3', agentId: 'ag1', label: 'Explore tests', state: 'done', at: Date.now() }])
  }, 2500)
}

await link.start()
log('[desk] key', KEY)
log('[desk] join', `${APP}#k=${KEY}&r=${encodeURIComponent(RELAY)}`)
