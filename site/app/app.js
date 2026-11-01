/**
 * Ember on the phone. See docs/specs/phone.md — this file follows it; the protocol is not
 * negotiable here, it is shared with the desk and the relay.
 *
 * Shape: one AccountLink to the relay, one chosen desk, one watched tab. Everything the
 * stage shows is derived from that tab's Ev list on every render — the list is the only
 * state that came from the desk, and nothing copies it. The DOM is reconciled by key so
 * object frames are never reloaded just because a new event arrived.
 */
import { AccountLink, newDeviceId } from './protocol.js'

/** The relay used when the QR code carries no `r=`. */
const DEFAULT_RELAY = 'https://ember-relay.afetiu3.workers.dev'

const LS = {
  key: 'ember.app.key',
  relay: 'ember.app.relay',
  device: 'ember.app.device',
  desk: 'ember.app.desk',
  tab: 'ember.app.tab',
  keys: 'ember.app.keys',
  /** Every computer's account this phone has joined: [{ id, k, r }]. Scanning adds one. */
  accounts: 'ember.app.accounts',
  /** The account just scanned, so its computer is the one shown next. */
  fresh: 'ember.app.fresh',
}

/** The accounts, migrating the single key the first version kept. */
function loadAccounts() {
  try {
    const list = JSON.parse(store.get(LS.accounts) || '[]')
    if (Array.isArray(list) && list.length) return list.filter((a) => a && a.k)
  } catch {
    /* rebuilt below */
  }
  const k = store.get(LS.key)
  if (!k) return []
  const list = [{ id: 'a0', k, r: store.get(LS.relay) || null }]
  store.set(LS.accounts, JSON.stringify(list))
  return list
}

function saveAccounts(list) {
  store.set(LS.accounts, list.length ? JSON.stringify(list) : null)
}

const GET_TIMEOUT_MS = 20_000
const FRAME_MAX_VH = 0.7

const $ = (id) => document.getElementById(id)
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* private mode: the session still works, it just won't be remembered */
    }
  },
}

// ---------------------------------------------------------------------------------------
// Join: the fragment is read once, stored, and removed from the address bar and history.

function readFragment() {
  const hash = location.hash.replace(/^#/, '')
  if (!hash) return
  const params = {}
  for (const part of hash.split('&')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    try {
      params[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1))
    } catch {
      /* a mangled parameter is ignored, not fatal */
    }
  }
  const key = params.k
  if (key && /^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    const relay = params.r && /^(https?|wss?):\/\//i.test(params.r) ? params.r : null
    const list = loadAccounts()
    let acct = list.find((a) => a.k === key)
    if (!acct) {
      acct = { id: Math.random().toString(36).slice(2, 8), k: key, r: relay }
      list.push(acct)
    } else acct.r = relay
    saveAccounts(list)
    // Show the computer just scanned, whichever accounts were here before.
    store.set(LS.fresh, acct.id)
  }
  history.replaceState(null, '', location.pathname + location.search)
}

readFragment()

// Scanning the QR code while the app is already open only changes the fragment.
window.addEventListener('hashchange', () => {
  const before = store.get(LS.accounts)
  readFragment()
  if (store.get(LS.accounts) !== before || store.get(LS.fresh)) location.reload()
})

// Joining from inside the app: the camera (an installed app is not where the phone's own
// camera sends a link) or a pasted link. Either way it lands as a fragment, like a scan.
function joinWith(text) {
  const err = document.getElementById('join-err')
  try {
    const u = new URL(String(text).trim())
    const k = new URLSearchParams(u.hash.replace(/^#/, '')).get('k')
    if (!k) throw new Error('no key')
    location.hash = u.hash
    return true
  } catch {
    if (err) {
      err.textContent = 'That is not an Ember link. In Ember: Ctrl+K, Connect your phone.'
      err.hidden = false
    }
    return false
  }
}

{
  const scan = document.getElementById('join-scan')
  const cam = document.getElementById('join-cam')
  const video = document.getElementById('join-video')
  let stream = null
  let raf = 0
  const stop = () => {
    cancelAnimationFrame(raf)
    for (const t of stream?.getTracks() ?? []) t.stop()
    stream = null
    if (cam) cam.hidden = true
    if (scan) scan.hidden = false
  }
  scan?.addEventListener('click', async () => {
    const err = document.getElementById('join-err')
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    } catch {
      if (err) {
        err.textContent = 'The camera is not available. Paste the link instead.'
        err.hidden = false
      }
      return
    }
    video.srcObject = stream
    await video.play().catch(() => {})
    cam.hidden = false
    scan.hidden = true
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const look = () => {
      if (!stream) return
      if (video.videoWidth && window.jsQR) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const code = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
        if (code?.data && /#k=/.test(code.data)) {
          stop()
          joinWith(code.data)
          return
        }
      }
      raf = requestAnimationFrame(look)
    }
    look()
  })
  document.getElementById('join-cam-x')?.addEventListener('click', stop)
  document.getElementById('join-paste')?.addEventListener('submit', (e) => {
    e.preventDefault()
    joinWith(document.getElementById('join-link').value)
  })
}

// ---------------------------------------------------------------------------------------
// State. Only `tabs` and the per-tab event lists come from the desk; the rest is local UI.

const S = {
  accounts: loadAccounts(),
  /** Per account id: its roster as the relay last sent it, and its link status. */
  rosters: new Map(),
  statuses: new Map(),
  deviceId: store.get(LS.device) || '',
  status: 'connecting',
  roster: [],
  deskId: store.get(LS.desk),
  deskReady: false,
  deskName: '',
  tabs: null,
  tab: store.get(LS.tab),
  watching: null,
  /** tab id -> { list: Ev[], ids: Set<string>, loaded: boolean } */
  events: new Map(),
  /** null = the newest turn; otherwise the index of the turn being looked at. */
  view: null,
  /** Messages sent from here that the desk has not echoed back as a `you` yet. */
  pending: [],
}

if (!S.deviceId) {
  S.deviceId = newDeviceId()
  store.set(LS.device, S.deviceId)
}

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  return 'Phone'
}

/** One link per account; a desk id here is `<account id>:<device id>`. */
const links = new Map()

function splitDesk(id) {
  const at = String(id ?? '').indexOf(':')
  return at < 0 ? null : { acct: id.slice(0, at), device: id.slice(at + 1) }
}

function sendDesk(msg) {
  const d = splitDesk(S.deskId)
  const link = d && links.get(d.acct)
  if (!link) return false
  link.send(d.device, msg)
  return true
}

// ---------------------------------------------------------------------------------------
// Link lifecycle

function start() {
  if (!S.accounts.length) return showJoin()
  $('join').hidden = true
  $('shell').hidden = false
  for (const a of S.accounts) {
    const link = new AccountLink({
      relay: a.r || DEFAULT_RELAY,
      key: a.k,
      deviceId: S.deviceId,
      kind: 'phone',
      name: deviceName(),
      onMessage: (msg, from) => onMessage(msg, `${a.id}:${from}`),
      onRoster: (devices) => {
        S.rosters.set(a.id, devices)
        onRoster(mergedRoster())
      },
      onStatus: (st) => {
        S.statuses.set(a.id, st)
        const all = [...S.statuses.values()]
        S.status = all.includes('online') ? 'online' : all.includes('connecting') ? 'connecting' : 'offline'
        schedule()
      },
    })
    links.set(a.id, link)
    link.start().catch(() => {
      S.statuses.set(a.id, 'offline')
      schedule()
    })
  }
  schedule()
}

/** Every account's devices in one list, ids qualified by account. */
function mergedRoster() {
  const out = []
  for (const [acct, devices] of S.rosters) for (const d of devices) out.push({ ...d, id: `${acct}:${d.id}`, acct })
  return out
}

function showJoin(adding = false) {
  $('shell').hidden = true
  $('join').hidden = false
  const back = $('join-back')
  if (back) back.hidden = !adding
}

function onRoster(devices) {
  S.roster = devices
  const desks = devices.filter((d) => d.kind === 'desk' && !d.self)
  const online = desks.filter((d) => d.online)
  const stored = store.get(LS.desk)

  // Just scanned a computer: show that one as soon as it is online.
  const fresh = store.get(LS.fresh)
  const freshDesk = fresh && online.find((d) => d.acct === fresh)
  if (freshDesk) {
    store.set(LS.fresh, null)
    chooseDesk(freshDesk.id, !!S.deskId && S.deskId !== freshDesk.id)
  } else if (!S.deskId || !desks.some((d) => d.id === S.deskId)) {
    // Keep a known-but-absent desk selected (it shows as offline and comes back by
    // itself); pick automatically only when there is no doubt which one is meant.
    const pick = online.find((d) => d.id === stored) ?? (online.length === 1 ? online[0] : null)
    if (pick) chooseDesk(pick.id, false)
  }

  const desk = desks.find((d) => d.id === S.deskId)
  if (desk?.name && !S.deskName) S.deskName = desk.name
  const up = !!desk?.online
  if (up && !S.deskReady) {
    S.deskReady = true
    S.watching = null
    sendDesk({ t: 'hello', v: 1 })
  } else if (!up && S.deskReady) {
    S.deskReady = false
    S.watching = null
    // Whatever was in flight will not be answered; say so now rather than in 20 seconds.
    for (const id of [...gets.keys()]) finish(id, new Error('Your computer went offline.'))
  }
  schedule()
}

function chooseDesk(id, fromUser) {
  if (S.deskId === id) return
  const changed = !!S.deskId && S.deskId !== id
  S.deskId = id
  store.set(LS.desk, id)
  S.deskReady = false
  S.watching = null
  S.deskName = S.roster.find((d) => d.id === id)?.name ?? ''
  if (changed || fromUser) {
    // Another machine: its tabs and transcripts are a different world.
    S.tabs = null
    S.events.clear()
    S.view = null
    S.pending = []
    if (changed) {
      S.tab = null
      store.set(LS.tab, null)
    }
  }
  if (fromUser) onRoster(S.roster)
}

function onMessage(msg, from) {
  if (from !== S.deskId || !msg || typeof msg.t !== 'string') return
  switch (msg.t) {
    case 'tabs':
      return onTabs(msg)
    case 'snap':
      return onSnap(msg)
    case 'ev':
      return onEv(msg)
    case 'got':
      return onGot(msg)
    case 'err':
      return onErr(msg)
  }
}

function onTabs(msg) {
  S.tabs = Array.isArray(msg.tabs) ? msg.tabs : []
  if (msg.desk?.name) S.deskName = String(msg.desk.name)
  const ids = S.tabs.map((t) => t.id)
  if (!S.tab || !ids.includes(S.tab)) {
    const remembered = store.get(LS.tab)
    const next =
      (remembered && ids.includes(remembered) && remembered) ||
      S.tabs.find((t) => t.loom && t.active)?.id ||
      S.tabs.find((t) => t.loom)?.id ||
      S.tabs.find((t) => t.active)?.id ||
      S.tabs[0]?.id ||
      null
    if (next !== S.tab) {
      S.tab = next
      S.view = null
    }
  }
  if (S.tab && S.watching !== S.tab) watch(S.tab)
  schedule()
}

function watch(tab) {
  S.watching = tab
  sendDesk({ t: 'watch', tab })
}

function selectTab(id) {
  if (id === S.tab) return
  S.tab = id
  store.set(LS.tab, id)
  S.view = null
  if (S.deskReady) watch(id)
  schedule()
}

function tabState(tab) {
  let st = S.events.get(tab)
  if (!st) {
    st = { list: [], ids: new Set(), loaded: false }
    S.events.set(tab, st)
  }
  return st
}

function onSnap(msg) {
  const st = tabState(msg.tab)
  st.list = []
  st.ids = new Set()
  st.loaded = true
  append(st, msg.events)
  settlePending(st)
  schedule()
}

function onEv(msg) {
  const st = tabState(msg.tab)
  append(st, msg.events)
  settlePending(st)
  schedule()
}

function append(st, events) {
  if (!Array.isArray(events)) return
  for (const ev of events) {
    if (!ev || typeof ev.k !== 'string') continue
    const id = ev.id == null ? null : String(ev.id)
    if (id !== null) {
      if (st.ids.has(id)) continue
      st.ids.add(id)
    }
    st.list.push(ev)
  }
}

/** A sent message is pending until the desk reports it as a `you`. */
function settlePending(st) {
  if (!S.pending.length) return
  const said = new Set(st.list.filter((e) => e.k === 'you').map((e) => norm(e.text)))
  S.pending = S.pending.filter((p) => !(p.tab === S.tab && said.has(norm(p.text))))
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')

// ---------------------------------------------------------------------------------------
// `get`: a file from the desk's bridge, chunked over the relay.

const gets = new Map()
/** path -> { evId, promise } */
const fetched = new Map()
let getCounter = 0

function get(path, evId) {
  const hit = fetched.get(path)
  if (hit && hit.evId === evId) return hit.promise
  const promise = request(path)
  fetched.set(path, { evId, promise })
  promise.catch(() => {
    if (fetched.get(path)?.promise === promise) fetched.delete(path)
  })
  return promise
}

function request(path) {
  return new Promise((resolve, reject) => {
    if (!S.deskReady) return reject(new Error('Your computer is offline.'))
    const id = `g${Date.now().toString(36)}${(++getCounter).toString(36)}`
    const entry = { chunks: new Map(), last: null, status: 200, type: '', resolve, reject, timer: 0 }
    const arm = () => {
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => finish(id, new Error('Timed out waiting for your computer.')), GET_TIMEOUT_MS)
    }
    entry.arm = arm
    gets.set(id, entry)
    arm()
    sendDesk({ t: 'get', id, path })
  })
}

function finish(id, error, value) {
  const entry = gets.get(id)
  if (!entry) return
  gets.delete(id)
  clearTimeout(entry.timer)
  if (error) entry.reject(error)
  else entry.resolve(value)
}

function onGot(msg) {
  const entry = gets.get(msg.id)
  if (!entry) return
  entry.arm()
  const seq = Number(msg.seq) || 0
  entry.chunks.set(seq, String(msg.b64 ?? ''))
  if (msg.status != null) entry.status = Number(msg.status)
  if (msg.type) entry.type = String(msg.type)
  if (msg.last) entry.last = seq
  if (entry.last == null) return
  // Sequences are 0-based and may arrive out of order.
  if (entry.chunks.size < entry.last + 1) return
  const parts = []
  for (let i = 0; i <= entry.last; i++) {
    if (!entry.chunks.has(i)) return
    parts.push(entry.chunks.get(i))
  }
  if (entry.status >= 400) return finish(msg.id, new Error(entry.status === 404 ? 'No longer on your computer.' : `Your computer answered ${entry.status}.`))
  let bytes
  try {
    // One base64 string cut into frames, or each frame encoded on its own (padding inside).
    if (parts.slice(0, -1).some((p) => p.includes('='))) {
      const pieces = parts.map(decodeB64)
      bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of pieces) {
        bytes.set(p, o)
        o += p.length
      }
    } else bytes = decodeB64(parts.join(''))
  } catch {
    return finish(msg.id, new Error('Arrived damaged.'))
  }
  finish(msg.id, null, { status: entry.status, type: entry.type, bytes })
}

function onErr(msg) {
  if (msg.id && gets.has(msg.id)) finish(msg.id, new Error(String(msg.error || 'Your computer refused.')))
}

function decodeB64(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const getText = (path, evId) => get(path, evId).then((r) => new TextDecoder().decode(r.bytes))

/** Blob URLs, one per path+event, kept for the life of the page (they back <img>s). */
const blobUrls = new Map()
function getBlobUrl(path, evId) {
  const k = `${path}\n${evId}`
  if (blobUrls.has(k)) return blobUrls.get(k)
  const p = get(path, evId).then((r) => URL.createObjectURL(new Blob([r.bytes], { type: r.type || 'application/octet-stream' })))
  blobUrls.set(k, p)
  p.catch(() => blobUrls.delete(k))
  return p
}

// ---------------------------------------------------------------------------------------
// Markdown: escape everything first, then add a small, closed set of tags back.

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const safeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(u)

function inline(raw) {
  const keep = []
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`
  let s = esc(raw)
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`))
  s = s.replace(/!?\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, text, url) =>
    safeUrl(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`) : text
  )
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<\u0000.,:;!?)\]])/g, (_, pre, url) =>
    pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
  )
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)])
}

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function md(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  return blocks(lines)
}

function blocks(lines) {
  let out = ''
  let i = 0
  const isStart = (l, next) =>
    RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) || RE_LIST.test(l) || RE_QUOTE.test(l) || (l.includes('|') && next != null && RE_TABLE_SEP.test(next))
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(RE_FENCE)
    if (fence) {
      const close = fence[1][0]
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*\\${close}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++])
      i++
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : ''
      out += `<pre${lang}><code>${esc(body.join('\n'))}</code></pre>`
      continue
    }
    const head = line.match(RE_HEAD)
    if (head) {
      const level = Math.min(6, head[1].length + 1)
      out += `<h${level}>${inline(head[2])}</h${level}>`
      i++
      continue
    }
    if (RE_HR.test(line)) {
      out += '<hr>'
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''))
      const head = cells(line)
      const al = (j) => (aligns[j] ? ` style="text-align:${aligns[j]}"` : '')
      let html = `<thead><tr>${head.map((c, j) => `<th${al(j)}>${inline(c)}</th>`).join('')}</tr></thead><tbody>`
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i++])
        html += `<tr>${head.map((_, j) => `<td${al(j)}>${inline(row[j] ?? '')}</td>`).join('')}</tr>`
      }
      out += `<div class="table-wrap"><table>${html}</tbody></table></div>`
      continue
    }
    if (RE_QUOTE.test(line)) {
      const body = []
      while (i < lines.length && RE_QUOTE.test(lines[i])) body.push(lines[i++].match(RE_QUOTE)[1])
      out += `<blockquote>${blocks(body)}</blockquote>`
      continue
    }
    if (RE_LIST.test(line)) {
      const r = list(lines, i)
      out += r.html
      i = r.next
      continue
    }
    const para = [line.trim()]
    i++
    while (i < lines.length && lines[i].trim() && !isStart(lines[i], lines[i + 1])) para.push(lines[i++].trim())
    out += `<p>${inline(para.join('\n')).replace(/\n/g, ' ')}</p>`
  }
  return out
}

/** A list starting at `start`, with nesting by indentation. */
function list(lines, start) {
  const first = lines[start].match(RE_LIST)
  const indent = first[1].length
  const ordered = /\d/.test(first[2])
  const startNum = ordered ? parseInt(first[2], 10) : 1
  let html = ''
  let i = start
  while (i < lines.length) {
    const m = lines[i].match(RE_LIST)
    if (!m || m[1].length < indent) break
    if (m[1].length > indent) {
      // Deeper item with no parent on this level: treat as nested under the previous one.
      const r = list(lines, i)
      html = html.replace(/<\/li>$/, `${r.html}</li>`)
      i = r.next
      continue
    }
    if (/\d/.test(m[2]) !== ordered) break
    let text = m[3]
    i++
    // Continuation lines (indented, not a new item at this level).
    const sub = []
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        const nx = lines[i + 1]
        if (nx && /^\s+/.test(nx) && (nx.match(/^\s*/)[0].length > indent)) {
          sub.push('')
          i++
          continue
        }
        break
      }
      const lm = l.match(RE_LIST)
      if (lm && lm[1].length <= indent) break
      if (!lm && !/^\s/.test(l)) {
        // Lazy continuation of the paragraph.
        if (sub.length === 0) {
          text += ' ' + l.trim()
          i++
          continue
        }
        break
      }
      sub.push(l)
      i++
    }
    let task = ''
    const t = text.match(/^\[([ xX])\]\s+(.*)$/)
    if (t) {
      task = t[1] === ' ' ? '<span class="task" aria-label="to do"></span>' : '<span class="task done" aria-label="done"></span>'
      text = t[2]
    }
    let inner = task + inline(text)
    if (sub.length) {
      const pad = Math.min(...sub.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length))
      inner += blocks(sub.map((l) => l.slice(Math.min(pad, l.match(/^\s*/)[0].length))))
    }
    html += `<li>${inner}</li>`
  }
  const tag = ordered ? 'ol' : 'ul'
  const st = ordered && startNum !== 1 ? ` start="${startNum}"` : ''
  return { html: `<${tag}${st}>${html}</${tag}>`, next: i }
}

// ---------------------------------------------------------------------------------------
// Turns: each `you` starts one. Derived on every render; never stored.

function buildTurns(list) {
  const turns = []
  let cur = null
  for (const ev of list) {
    if (ev.k === 'you' || !cur) {
      cur = { you: ev.k === 'you' ? ev : null, items: [] }
      turns.push(cur)
      if (ev.k === 'you') continue
    }
    cur.items.push(ev)
  }
  return turns
}

/** Titles match the way the desk matches them: quotes, case and spacing do not count. */
const titleKey = (s) =>
  String(s ?? '')
    .replace(/["'`“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

function digest(turn) {
  let act = null
  let steps = null
  let ended = false
  const agents = new Map()
  const flow = []
  const objs = new Map()
  for (const ev of turn.items) {
    switch (ev.k) {
      case 'act':
        act = ev
        break
      case 'steps':
        steps = ev
        break
      case 'agent': {
        const k = String(ev.agentId ?? ev.id)
        const prev = agents.get(k)
        agents.set(k, { label: ev.label || prev?.label || 'Agent', state: ev.state })
        break
      }
      case 'say':
        if (ev.end) ended = true
        if (String(ev.text ?? '').trim()) flow.push({ key: `say:${ev.id}`, ev })
        break
      case 'obj': {
        const key = `obj:${titleKey(ev.title)}`
        if (objs.has(key)) objs.get(key).ev = ev
        else {
          const item = { key, ev }
          objs.set(key, item)
          flow.push(item)
        }
        break
      }
      case 'link':
      case 'media':
      case 'note':
        flow.push({ key: `${ev.k}:${ev.id}`, ev })
        break
    }
  }
  return { act, steps, ended, agents, flow }
}

// ---------------------------------------------------------------------------------------
// Rendering

let frameQueued = false
function schedule() {
  if (frameQueued) return
  frameQueued = true
  requestAnimationFrame(() => {
    frameQueued = false
    render()
  })
}

function render() {
  renderTop()
  renderStage()
  renderComposer()
  if (!$('settings').hidden) renderSettings()
}

function deskLabel() {
  const d = S.roster.find((x) => x.id === S.deskId)
  return S.deskName || d?.name || 'Your computer'
}

function linkState() {
  if (S.status !== 'online') return 'relay'
  if (!S.deskId) {
    const n = S.roster.filter((d) => d.kind === 'desk' && d.online && !d.self).length
    return n > 1 ? 'choose' : 'none'
  }
  return S.deskReady ? 'ok' : 'desk-off'
}

function renderTop() {
  const state = linkState()
  const dot = $('desk-dot')
  dot.className = 'desk-dot ' + (state === 'ok' ? 'on' : state === 'relay' ? 'wait' : 'off')
  $('desk-name').textContent =
    state === 'relay' ? (S.status === 'connecting' ? 'Connecting' : 'Reconnecting') : state === 'none' ? 'No computer online' : state === 'choose' ? 'Choose a computer' : deskLabel()

  const banner = $('banner')
  const msg =
    state === 'relay' && S.status === 'offline'
      ? 'No connection. Retrying by itself.'
      : state === 'desk-off'
        ? `${deskLabel()} is offline. This reconnects by itself when Ember is running again.`
        : state === 'none'
          ? 'No computer is online. Open Ember on your computer and this page connects by itself.'
          : state === 'choose'
            ? 'More than one computer is online. Tap the name above to choose one.'
            : ''
  banner.hidden = !msg
  banner.textContent = msg

  const nav = $('tabs')
  const tabs = [...(S.tabs ?? [])].sort((a, b) => (b.loom ? 1 : 0) - (a.loom ? 1 : 0))
  const want = tabs.map((t) => t.id)
  const have = new Map([...nav.children].map((el) => [el.dataset.id, el]))
  for (const [id, el] of have) if (!want.includes(id)) el.remove()
  tabs.forEach((t, i) => {
    let el = have.get(t.id)
    if (!el) {
      el = document.createElement('button')
      el.type = 'button'
      el.className = 'tab'
      el.dataset.id = t.id
      el.setAttribute('role', 'tab')
      el.innerHTML = '<span class="tab-dot" aria-hidden="true"></span><span class="tab-title"></span>'
      el.addEventListener('click', () => selectTab(t.id))
    }
    if (nav.children[i] !== el) nav.insertBefore(el, nav.children[i] ?? null)
    const title = t.title || basename(t.cwd) || 'Session'
    el.querySelector('.tab-title').textContent = title
    el.title = t.cwd ? `${title} — ${t.cwd}` : title
    el.classList.toggle('is-on', t.id === S.tab)
    el.classList.toggle('is-working', !!t.working)
    el.classList.toggle('is-plain', !t.loom)
    el.setAttribute('aria-selected', String(t.id === S.tab))
    el.setAttribute('aria-label', `${title}${t.working ? ', working' : ''}`)
  })
  nav.setAttribute('role', 'tablist')
  nav.hidden = !tabs.length
  const on = nav.querySelector('.tab.is-on')
  if (on && on.dataset.scrolled !== '1') {
    nav.querySelectorAll('.tab').forEach((t) => (t.dataset.scrolled = ''))
    on.dataset.scrolled = '1'
    on.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }
}

const basename = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

let shownKey = ''
let turnEl = null

function message(kind, title, body) {
  shownKey = `msg:${kind}:${title}`
  turnEl = null
  const stage = $('stage')
  if (stage.dataset.msg === shownKey) return
  stage.dataset.msg = shownKey
  stage.innerHTML =
    kind === 'loading'
      ? '<div class="skeleton" aria-label="Loading"><span></span><span></span><span class="short"></span></div>'
      : `<div class="empty"><h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}</div>`
  renderStrip([], 0)
}

function renderStage() {
  const state = linkState()
  const st = S.tab ? S.events.get(S.tab) : null
  const has = st?.loaded

  if (!has) {
    if (state === 'ok' && S.tabs && !S.tabs.length) return message('empty', 'No sessions open', 'Open a tab in Ember on your computer and it appears here.')
    if (state === 'ok' || state === 'relay') return message('loading')
    if (state === 'choose') return message('empty', 'Choose a computer', 'Tap the name at the top to pick which one to follow.')
    return message('empty', 'Waiting for your computer', 'Keep Ember open on your computer. This page reconnects by itself.')
  }

  const turns = buildTurns(st.list)
  const pending = S.pending.filter((p) => p.tab === S.tab)
  if (!turns.length && !pending.length) return message('empty', 'Nothing here yet', 'Write below to start this session.')

  const last = turns.length - 1
  const idx = S.view == null || S.view > last ? last : Math.max(0, S.view)
  if (S.view != null && S.view >= last) S.view = null
  const turn = turns[idx] ?? { you: null, items: [] }
  const latest = idx === last
  const tab = S.tabs?.find((t) => t.id === S.tab)
  const d = digest(turn)
  const working = latest && !d.ended && !!(turn.you || turn.items.length)

  const wrap = $('stage-wrap')
  const key = `${S.tab}|${turn.you?.id ?? 'pre'}|${idx}`
  const stage = $('stage')
  let fresh = false
  if (key !== shownKey || !turnEl) {
    fresh = true
    shownKey = key
    stage.dataset.msg = ''
    turnEl = buildTurnShell()
    stage.replaceChildren(turnEl)
    wrap.scrollTop = 0
  }
  const stick = !fresh && latest && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120

  updateYou(turn, idx, turns.length)
  updatePlan(d.steps)
  updateAgents(d.agents)
  updateFlow(d.flow)
  updateNow(working ? d.act : null, working, tab ? !!tab.working : true)
  updatePending(latest ? pending : [])

  if (stick) wrap.scrollTop = wrap.scrollHeight
  renderStrip(turns, idx, working)
}

function buildTurnShell() {
  const el = document.createElement('article')
  el.className = 'turn'
  el.innerHTML = `
    <header class="you" hidden><div class="you-meta"></div><div class="you-text"></div></header>
    <section class="plan glass" hidden></section>
    <div class="agents" hidden></div>
    <div class="flow"></div>
    <div class="now" hidden><span class="reel" aria-hidden="true"><i></i><i></i><i></i></span><span class="now-track"></span></div>
    <div class="pending" hidden></div>`
  return el
}

const q = (sel) => turnEl.querySelector(sel)

function when(at) {
  if (at == null) return ''
  const d = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at)
  if (isNaN(d)) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function updateYou(turn, idx, total) {
  const el = q('.you')
  const meta = [total > 1 ? `Turn ${idx + 1} of ${total}` : '', when(turn.you?.at)].filter(Boolean).join(' · ')
  el.hidden = !turn.you && !meta
  setText(el.querySelector('.you-meta'), meta)
  setText(el.querySelector('.you-text'), turn.you ? String(turn.you.text ?? '') : '')
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text
}

const DONE = new Set(['done', 'completed', 'complete', 'ok', 'success'])
const ACTIVE = new Set(['active', 'in_progress', 'in-progress', 'running', 'doing', 'current'])

function updatePlan(steps) {
  const el = q('.plan')
  const list = steps?.steps ?? []
  el.hidden = !list.length
  if (!list.length) return
  if (!el.firstChild) el.innerHTML = '<h3 class="plan-title"></h3><ol class="plan-steps"></ol>'
  const doneCount = list.filter((s) => DONE.has(String(s.status))).length
  setText(el.querySelector('.plan-title'), `${steps.title || 'Plan'}  ${doneCount}/${list.length}`)
  const ol = el.querySelector('.plan-steps')
  while (ol.children.length > list.length) ol.lastChild.remove()
  list.forEach((s, i) => {
    let li = ol.children[i]
    const status = DONE.has(String(s.status)) ? 'done' : ACTIVE.has(String(s.status)) ? 'active' : 'pending'
    if (!li) {
      li = document.createElement('li')
      li.innerHTML =
        '<span class="check" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M4.8 8.3l2.2 2.2 4.2-4.6"/></svg></span><span class="step-text"></span>'
      li.dataset.status = status
      ol.appendChild(li)
    } else if (li.dataset.status !== status) {
      if (status === 'done') {
        li.classList.remove('tick')
        void li.offsetWidth
        li.classList.add('tick')
      }
      li.dataset.status = status
    }
    li.className = `step is-${status}${li.classList.contains('tick') ? ' tick' : ''}`
    setText(li.querySelector('.step-text'), String(s.text ?? ''))
    li.setAttribute('aria-label', `${s.text}: ${status === 'done' ? 'done' : status === 'active' ? 'in progress' : 'to do'}`)
  })
}

function updateAgents(agents) {
  const el = q('.agents')
  el.hidden = !agents.size
  const want = [...agents.keys()]
  const have = new Map([...el.children].map((c) => [c.dataset.id, c]))
  for (const [id, c] of have) if (!want.includes(id)) c.remove()
  want.forEach((id, i) => {
    const a = agents.get(id)
    let pill = have.get(id)
    if (!pill) {
      pill = document.createElement('span')
      pill.className = 'pill'
      pill.dataset.id = id
      pill.innerHTML = '<span class="pill-mark" aria-hidden="true"></span><span class="pill-label"></span>'
    }
    if (el.children[i] !== pill) el.insertBefore(pill, el.children[i] ?? null)
    const done = a.state === 'done'
    pill.classList.toggle('is-done', done)
    pill.querySelector('.pill-mark').innerHTML = done ? '<svg viewBox="0 0 16 16"><path d="M4 8.4l2.6 2.6L12 5.4"/></svg>' : '<span class="spin"></span>'
    setText(pill.querySelector('.pill-label'), a.label)
    pill.setAttribute('aria-label', `${a.label}, ${done ? 'done' : 'running'}`)
  })
}

function updateNow(act, working, live) {
  const el = q('.now')
  el.hidden = !working
  if (!working) return
  el.classList.toggle('is-idle', !live)
  const label = act?.label ? String(act.label) : 'Working'
  const track = el.querySelector('.now-track')
  const cur = track.lastElementChild
  if (cur?.textContent === label) return
  const next = document.createElement('span')
  next.className = 'now-label'
  next.textContent = label
  if (cur) {
    cur.classList.add('out')
    next.classList.add('in')
    setTimeout(() => cur.remove(), 260)
  }
  track.appendChild(next)
}

function updatePending(pending) {
  const el = q('.pending')
  el.hidden = !pending.length
  el.innerHTML = pending.map((p) => `<div class="pending-item"><span class="pending-label">Sent</span>${esc(p.text)}</div>`).join('')
}

function updateFlow(flow) {
  const el = q('.flow')
  const have = new Map([...el.children].map((c) => [c.dataset.k, c]))
  const want = new Set(flow.map((f) => f.key))
  for (const [k, c] of have) if (!want.has(k)) c.remove()
  flow.forEach((item, i) => {
    let node = have.get(item.key)
    if (!node) {
      node = build(item.ev)
      node.dataset.k = item.key
      node.classList.add('enter')
    }
    // Only move when out of place: moving a frame reloads it.
    if (el.children[i] !== node) el.insertBefore(node, el.children[i] ?? null)
    update(node, item.ev)
  })
}

function build(ev) {
  switch (ev.k) {
    case 'say': {
      const d = document.createElement('div')
      d.className = 'say md'
      return d
    }
    case 'note': {
      const d = document.createElement('p')
      d.className = 'note'
      return d
    }
    case 'link':
      return buildLink(ev)
    case 'media':
      return buildMedia(ev)
    case 'obj':
      return buildObj(ev)
  }
  return document.createElement('div')
}

function update(node, ev) {
  if (ev.k === 'say') {
    const text = String(ev.text ?? '')
    if (node.dataset.text !== text) {
      node.dataset.text = text
      node.innerHTML = md(text)
    }
  } else if (ev.k === 'note') setText(node, String(ev.text ?? ''))
  else if (ev.k === 'obj') updateObj(node, ev)
}

// --- link -------------------------------------------------------------------------------

function buildLink(ev) {
  const url = String(ev.url ?? '')
  const ok = /^https?:\/\//i.test(url)
  const a = document.createElement(ok ? 'a' : 'div')
  a.className = 'card glass link-card'
  if (ok) {
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = url
  }
  a.innerHTML = `${ICON.link}<span class="link-text"><span class="link-title"></span><span class="link-host"></span></span>${ok ? ICON.out : ''}`
  a.querySelector('.link-title').textContent = ev.title || host || 'Link'
  a.querySelector('.link-host').textContent = host
  return a
}

// --- media ------------------------------------------------------------------------------

function buildMedia(ev) {
  const card = document.createElement('section')
  card.className = 'card glass media-card'
  const items = Array.isArray(ev.items) ? ev.items : []
  card.innerHTML = `<header class="card-head static">${ICON.image}<span class="card-title"></span></header><div class="media-grid${items.length === 1 ? ' one' : ''}"></div>`
  card.querySelector('.card-title').textContent = ev.title || 'Media'
  const grid = card.querySelector('.media-grid')
  for (const item of items) grid.appendChild(mediaItem(item, ev))
  return card
}

function mediaItem(item, ev) {
  const fig = document.createElement('figure')
  fig.className = 'media-item'
  const kind = String(item.kind ?? '')
  const label = item.caption || item.name || 'File'
  const load = () => {
    fig.innerHTML = '<div class="media-wait shimmer"></div>'
    getBlobUrl(String(item.path), ev.id).then(
      (url) => {
        fig.innerHTML = ''
        if (kind === 'image') {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'media-open'
          btn.setAttribute('aria-label', `Open ${label} full screen`)
          const img = document.createElement('img')
          img.src = url
          img.alt = label
          img.loading = 'lazy'
          btn.appendChild(img)
          btn.addEventListener('click', () => openViewer(label, () => {
            const big = document.createElement('img')
            big.src = url
            big.alt = label
            big.className = 'viewer-img'
            requestAnimationFrame(() => big.parentElement && pinchZoom(big, big.parentElement))
            return big
          }))
          fig.appendChild(btn)
        } else if (kind === 'video') {
          const v = document.createElement('video')
          v.src = url
          v.controls = true
          v.playsInline = true
          v.preload = 'metadata'
          fig.appendChild(v)
        } else {
          const a = document.createElement('a')
          a.className = 'file-row'
          a.href = url
          a.target = '_blank'
          a.rel = 'noopener'
          a.download = item.name || ''
          a.innerHTML = `${ICON.file}<span></span>`
          a.querySelector('span').textContent = item.name || 'Open file'
          fig.appendChild(a)
        }
        if (item.caption) {
          const cap = document.createElement('figcaption')
          cap.textContent = item.caption
          fig.appendChild(cap)
        }
      },
      (err) => failed(fig, err, load)
    )
  }
  load()
  return fig
}

function failed(host, err, retry) {
  host.innerHTML = '<div class="failed"><span></span><button type="button" class="retry">Retry</button></div>'
  host.querySelector('span').textContent = err?.message || 'Could not load.'
  host.querySelector('.retry').addEventListener('click', (e) => {
    e.stopPropagation()
    retry()
  })
}

// --- objects ----------------------------------------------------------------------------

/** Live object frames, for matching `emberDocHeight` messages to their frame. */
const frames = new Set()
/** Last known height per object title, so a re-created card does not jump. */
const heights = new Map()

function buildObj(ev) {
  const card = document.createElement('section')
  card.className = 'card glass obj-card'
  card.innerHTML = `<button type="button" class="card-head obj-head"><span class="obj-icon"></span><span class="card-title"></span><span class="card-kind"></span>${ICON.expand}</button><div class="obj-body"></div>`
  card.querySelector('.obj-head').addEventListener('click', () => {
    const html = card._html
    if (!html) return
    openViewer(card._title, () => {
      const f = makeFrame(card._title)
      f.className = 'viewer-frame'
      f.addEventListener('load', () => f.contentWindow?.postMessage({ emberFit: true }, '*'), { once: true })
      f.srcdoc = html
      f._viewer = true
      return f
    })
  })
  return card
}

function updateObj(card, ev) {
  card._title = String(ev.title || 'Object')
  setText(card.querySelector('.card-title'), card._title)
  setText(card.querySelector('.card-kind'), formatLabel(ev.format))
  const icon = card.querySelector('.obj-icon')
  const want = iconFor(ev.format)
  if (icon.innerHTML !== want) icon.innerHTML = want
  card.querySelector('.obj-head').setAttribute('aria-label', `${card._title}, open full screen`)
  if (card.dataset.ev === String(ev.id)) return
  card.dataset.ev = String(ev.id)
  loadObj(card, ev)
}

function loadObj(card, ev) {
  const body = card.querySelector('.obj-body')
  const evId = String(ev.id)
  if (!card._frame) {
    const h = heights.get(card._title)
    body.innerHTML = `<div class="obj-wait shimmer" style="height:${Math.round(h ?? 180)}px"></div>`
  } else card.classList.add('is-updating')
  getText(String(ev.path), evId).then(
    (html) => {
      if (card.dataset.ev !== evId) return
      card.classList.remove('is-updating')
      card._html = prepDoc(html)
      if (!card._frame || !card._frame.isConnected) {
        const f = makeFrame(card._title)
        f.style.height = `${clampHeight(heights.get(card._title) ?? 180)}px`
        f._title = card._title
        body.replaceChildren(f)
        card._frame = f
      }
      card._frame.srcdoc = card._html
    },
    (err) => {
      if (card.dataset.ev !== evId) return
      card.classList.remove('is-updating')
      card._frame = null
      failed(body, err, () => loadObj(card, ev))
    }
  )
}

function makeFrame(title) {
  const f = document.createElement('iframe')
  // Scripts yes, origin no: a page Claude wrote can run, but cannot read this page's
  // storage — the account key lives there.
  f.setAttribute('sandbox', 'allow-scripts')
  f.setAttribute('referrerpolicy', 'no-referrer')
  f.title = title
  frames.add(f)
  return f
}

const clampHeight = (h) => Math.max(60, Math.min(h, Math.round(window.innerHeight * FRAME_MAX_VH)))

/**
 * Pinch to zoom, drag to move while zoomed, double-tap to zoom in or back out.
 *
 * Self-contained on purpose: it runs in the app (images in the viewer) and is injected as
 * source into every object document (diagrams, pages, tables), which live in sandboxed
 * frames the app cannot reach into. At 1x the page scrolls as usual; zoomed, the gesture
 * is ours.
 */
function pinchZoom(target, surface) {
  var s = 1, tx = 0, ty = 0, start = null, lastTap = 0, tapX = 0, tapY = 0, moved = false
  target.style.transformOrigin = '0 0'
  target.style.willChange = 'transform'
  function clamp() {
    var w = target.offsetWidth, h = target.offsetHeight, W = surface.clientWidth || w, H = surface.clientHeight || h
    var minX = Math.min(0, W - w * s), minY = Math.min(0, H - h * s)
    tx = Math.max(minX, Math.min(0, tx))
    ty = Math.max(minY, Math.min(0, ty))
  }
  function apply(animate) {
    if (s <= 1.01) { s = 1; tx = 0; ty = 0 }
    else clamp()
    target.style.transition = animate ? 'transform 250ms cubic-bezier(0.22,1,0.36,1)' : 'none'
    target.style.transform = s === 1 ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'
    surface.style.touchAction = s > 1 ? 'none' : 'pan-x pan-y'
  }
  function local(t) {
    var r = surface.getBoundingClientRect()
    return { x: t.clientX - r.left, y: t.clientY - r.top }
  }
  function zoomAt(ns, px, py) {
    var cx = (px - tx) / s, cy = (py - ty) / s
    s = Math.max(1, Math.min(6, ns))
    tx = px - cx * s
    ty = py - cy * s
  }
  surface.style.touchAction = 'pan-x pan-y'
  surface.addEventListener('touchstart', function (e) {
    moved = false
    if (e.touches.length === 2) {
      var a = local(e.touches[0]), b = local(e.touches[1])
      start = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s: s, tx: tx, ty: ty }
    } else if (e.touches.length === 1) {
      var p = local(e.touches[0])
      start = { px: p.x, py: p.y, tx: tx, ty: ty }
    }
  }, { passive: true })
  surface.addEventListener('touchmove', function (e) {
    if (!start) return
    if (e.touches.length === 2 && start.d) {
      var a = local(e.touches[0]), b = local(e.touches[1])
      var d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      s = start.s; tx = start.tx; ty = start.ty
      zoomAt(start.s * d / start.d, start.mx, start.my)
      tx += mx - start.mx
      ty += my - start.my
      moved = true
      e.preventDefault()
      apply(false)
    } else if (e.touches.length === 1 && s > 1 && start.px !== undefined) {
      var p = local(e.touches[0])
      tx = start.tx + p.x - start.px
      ty = start.ty + p.y - start.py
      if (Math.abs(p.x - start.px) + Math.abs(p.y - start.py) > 6) moved = true
      e.preventDefault()
      apply(false)
    }
  }, { passive: false })
  surface.addEventListener('touchend', function (e) {
    if (e.touches.length) return
    var t = e.changedTouches[0]
    if (!moved && t) {
      var p = local(t), now = Date.now()
      if (now - lastTap < 300 && Math.abs(p.x - tapX) < 30 && Math.abs(p.y - tapY) < 30) {
        if (s > 1) s = 1
        else zoomAt(2.5, p.x, p.y)
        apply(true)
        lastTap = 0
        e.preventDefault()
      } else {
        lastTap = now; tapX = p.x; tapY = p.y
      }
    }
    start = null
    apply(false)
  }, { passive: false })
}

/** Every object document zooms the same way: the function above, run inside its frame. */
const ZOOM_SHIM = `<script>(${pinchZoom.toString()})(document.body, document.documentElement)</script>`

/** Height reporter for documents that do not carry their own (the phone-target render). */
const HEIGHT_SHIM = `<script>(function(){if(window.parent===window)return;var last=-1;function post(){var d=document.documentElement,b=document.body;var h=Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0));if(Math.abs(h-last)<2)return;last=h;try{parent.postMessage({emberDocHeight:h},'*')}catch(e){}}addEventListener('load',post);try{var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}catch(e){}setTimeout(post,30);setTimeout(post,400);setTimeout(post,1500)})()</script>`

function prepDoc(html) {
  const base = `<base href="${esc(location.origin)}/">`
  let out = String(html)
  // A document rendered for the phone loads mermaid by a relative name; host it from /vendor.
  out = out.replace(/(<script[^>]*\ssrc=["'])mermaid\.min\.js(["'])/i, '$1/vendor/mermaid.min.js$2')
  if (/<head(\s[^>]*)?>/i.test(out)) out = out.replace(/<head(\s[^>]*)?>/i, (h) => h + base)
  else if (/<html(\s[^>]*)?>/i.test(out)) out = out.replace(/<html(\s[^>]*)?>/i, (h) => `${h}<head>${base}</head>`)
  else out = `<head>${base}</head>${out}`
  if (!out.includes('emberDocHeight')) out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${HEIGHT_SHIM}</body>`) : out + HEIGHT_SHIM
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${ZOOM_SHIM}</body>`) : out + ZOOM_SHIM
  return out
}

window.addEventListener('message', (e) => {
  const data = e.data
  if (!data || typeof data !== 'object') return
  let frame = null
  for (const f of frames) {
    if (!f.isConnected) {
      frames.delete(f)
      continue
    }
    if (f.contentWindow === e.source) frame = f
  }
  if (!frame) return
  if (typeof data.emberDocHeight === 'number' && !frame._viewer) {
    const h = Math.ceil(data.emberDocHeight)
    heights.set(frame._title, h)
    frame.style.height = `${clampHeight(h)}px`
    frame.classList.toggle('is-clamped', h > clampHeight(h))
  }
  // An answer from an `ask` card in a document rendered for the phone.
  if (data.__emberPanel && data.kind === 'send' && S.tab) {
    const text = String(data.text ?? '').trim()
    if (text) sendDesk({ t: 'act', tab: S.tab, text, submit: data.submit !== false })
  }
})

window.addEventListener('resize', () => {
  for (const f of frames) if (!f._viewer && f.isConnected) f.style.height = `${clampHeight(heights.get(f._title) ?? 180)}px`
})

function formatLabel(f) {
  const s = String(f ?? '').toLowerCase()
  return { mermaid: 'Diagram', diagram: 'Diagram', html: 'Page', page: 'Page', view: 'View', markdown: 'Note', md: 'Note', table: 'Table', csv: 'Table', pdf: 'PDF', image: 'Image', gallery: 'Images', ask: 'Question', chart: 'Chart' }[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : 'Object')
}

function iconFor(f) {
  const s = String(f ?? '').toLowerCase()
  if (s === 'mermaid' || s === 'diagram') return ICON.diagram
  if (s === 'table' || s === 'csv') return ICON.table
  if (s === 'pdf') return ICON.file
  if (s === 'image' || s === 'gallery') return ICON.image
  if (s === 'chart') return ICON.chart
  return ICON.page
}

const svg = (body) => `<svg class="ic" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
const ICON = {
  diagram: svg('<rect x="2.5" y="3" width="6" height="4.5" rx="1.2"/><rect x="11.5" y="12.5" width="6" height="4.5" rx="1.2"/><path d="M5.5 7.5v3.5a1.5 1.5 0 0 0 1.5 1.5h4.5"/>'),
  page: svg('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M11.5 2.5v4h4M7 10.5h6M7 13.5h4"/>'),
  table: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M2.5 12.3h15M8 8v8.5"/>'),
  file: svg('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M11.5 2.5v4h4"/>'),
  image: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 15l4.5-4.5 3 3 2-2 4.5 4"/>'),
  chart: svg('<path d="M3 16.5h14M5.5 13.5V9M9.5 13.5V5M13.5 13.5v-6"/>'),
  link: svg('<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>'),
  out: svg('<path d="M8 4.5H4.5v11h11V12M11 3.5h5.5V9M16.5 3.5L9 11"/>'),
  expand: svg('<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5L11.5 8.5M3.5 16.5l5-5"/>'),
}

// --- turn strip -------------------------------------------------------------------------

function renderStrip(turns, idx, working) {
  const strip = $('strip')
  const show = turns.length > 1
  strip.hidden = !show
  if (!show) return
  const dots = $('strip-dots')
  while (dots.children.length > turns.length) dots.lastChild.remove()
  for (let i = 0; i < turns.length; i++) {
    let b = dots.children[i]
    if (!b) {
      b = document.createElement('button')
      b.type = 'button'
      b.className = 'dot'
      b.setAttribute('role', 'tab')
      const n = i
      b.addEventListener('click', () => viewTurn(n))
      dots.appendChild(b)
    }
    const on = i === idx
    b.classList.toggle('is-on', on)
    b.classList.toggle('is-live', !!working && i === turns.length - 1)
    b.setAttribute('aria-selected', String(on))
    const text = turns[i].you?.text ? String(turns[i].you.text).slice(0, 60) : 'Start'
    b.setAttribute('aria-label', `Turn ${i + 1}: ${text}`)
  }
  const latest = idx === turns.length - 1
  $('latest-btn').hidden = latest
  const on = dots.children[idx]
  if (on && dots.dataset.on !== String(idx)) {
    dots.dataset.on = String(idx)
    const left = on.offsetLeft - dots.clientWidth / 2 + on.offsetWidth / 2
    dots.scrollTo({ left, behavior: reduced() ? 'auto' : 'smooth' })
  }
}

function viewTurn(i) {
  const st = S.events.get(S.tab)
  const n = st ? buildTurns(st.list).length : 0
  if (!n) return
  const next = Math.max(0, Math.min(n - 1, i))
  S.view = next >= n - 1 ? null : next
  schedule()
}

function currentTurnIndex() {
  const st = S.events.get(S.tab)
  const n = st ? buildTurns(st.list).length : 0
  return { n, i: S.view == null ? n - 1 : S.view }
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------------------------------------------------------------------------------------
// Composer

function renderComposer() {
  const input = $('input')
  const can = S.deskReady && !!S.tab
  $('send').disabled = !can || !input.value.trim()
  input.placeholder = !S.deskReady ? 'Waiting for your computer' : S.tab ? 'Write to the session' : 'No session selected'
  for (const b of document.querySelectorAll('#keys button')) b.disabled = !can
}

function grow() {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.35))}px`
}

function submit() {
  const input = $('input')
  const text = input.value
  if (!text.trim() || !S.deskReady || !S.tab) return
  sendDesk({ t: 'send', tab: S.tab, text })
  const entry = { tab: S.tab, text, at: Date.now() }
  S.pending.push(entry)
  // If the desk never echoes it (a non-Loom tab, a lost frame), stop claiming it is pending.
  setTimeout(() => {
    S.pending = S.pending.filter((p) => p !== entry)
    schedule()
  }, 45_000)
  S.view = null
  input.value = ''
  grow()
  schedule()
  requestAnimationFrame(() => {
    const wrap = $('stage-wrap')
    wrap.scrollTop = wrap.scrollHeight
  })
}

/** Is an on-screen keyboard up? Then Enter is a newline, as every phone chat box does. */
function softKeyboard() {
  const vv = window.visualViewport
  if (!matchMedia('(pointer: coarse)').matches || !vv) return false
  return vv.height < window.innerHeight * 0.82 || screen.height - vv.height > 260
}

function wireComposer() {
  const input = $('input')
  input.addEventListener('input', () => {
    grow()
    renderComposer()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    if (softKeyboard()) return
    e.preventDefault()
    submit()
  })
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault()
    submit()
  })

  const toggle = $('keys-toggle')
  const setKeys = (open) => {
    $('keys').hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.classList.toggle('is-on', open)
    store.set(LS.keys, open ? '1' : null)
  }
  setKeys(store.get(LS.keys) === '1')
  toggle.addEventListener('click', () => setKeys($('keys').hidden))
  for (const b of document.querySelectorAll('#keys button')) {
    b.addEventListener('click', () => {
      if (!S.deskReady || !S.tab) return
      sendDesk({ t: 'key', tab: S.tab, key: b.dataset.key })
      b.classList.remove('sent')
      void b.offsetWidth
      b.classList.add('sent')
      b.addEventListener('animationend', () => b.classList.remove('sent'), { once: true })
    })
  }

  $('latest-btn').addEventListener('click', () => {
    S.view = null
    schedule()
  })

  // Swipe between turns on the stage. Frames swallow their own touches, which is right:
  // a diagram should pan, not flip the turn.
  const wrap = $('stage-wrap')
  let sx = 0
  let sy = 0
  let st = 0
  wrap.addEventListener('touchstart', (e) => {
    const t = e.touches[0]
    sx = t.clientX
    sy = t.clientY
    st = Date.now()
  }, { passive: true })
  wrap.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]
    const dx = t.clientX - sx
    const dy = t.clientY - sy
    if (Date.now() - st > 600 || Math.abs(dx) < 64 || Math.abs(dy) > Math.abs(dx) * 0.6) return
    if (e.target.closest?.('.table-wrap, pre, .tabs')) return
    const { i } = currentTurnIndex()
    viewTurn(dx < 0 ? i + 1 : i - 1)
  }, { passive: true })
}

// ---------------------------------------------------------------------------------------
// Sheets

let lastFocus = null

function openSheet(el) {
  lastFocus = document.activeElement
  $('scrim').hidden = false
  el.hidden = false
  requestAnimationFrame(() => {
    $('scrim').classList.add('is-open')
    el.classList.add('is-open')
    el.querySelector('[data-close]')?.focus()
  })
}

function closeSheet(el) {
  if (el.hidden) return
  el.classList.remove('is-open')
  $('scrim').classList.remove('is-open')
  setTimeout(() => {
    el.hidden = true
    if (el.id === 'viewer') $('viewer-body').replaceChildren()
    if ($('settings').hidden && $('viewer').hidden) $('scrim').hidden = true
  }, reduced() ? 0 : 250)
  lastFocus?.focus?.()
}

function openViewer(title, make) {
  $('viewer-title').textContent = title
  $('viewer-body').replaceChildren(make())
  openSheet($('viewer'))
}

function renderSettings() {
  $('s-device').textContent = `${deviceName()} · ${S.deviceId}`
  $('s-desk').textContent = S.deskId ? `${deskLabel()}${S.deskReady ? '' : ' (offline)'}` : 'None chosen'
  $('s-relay').textContent = [...new Set(S.accounts.map((a) => (a.r || DEFAULT_RELAY).replace(/^https?:\/\//, '')))].join(', ')
  $('s-status').textContent = S.status === 'online' ? 'Connected to relay' : S.status === 'connecting' ? 'Connecting' : 'Offline, retrying'
  const desks = S.roster.filter((d) => d.kind === 'desk' && !d.self)
  const box = $('s-desks')
  box.hidden = false
  box.innerHTML = '<h3>Computers</h3>'
  for (const d of desks) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'desk-choice' + (d.id === S.deskId ? ' is-on' : '')
    b.disabled = !d.online
    b.innerHTML = `<span class="desk-dot ${d.online ? 'on' : 'off'}" aria-hidden="true"></span><span></span>`
    b.lastChild.textContent = `${d.name}${d.online ? '' : ' (offline)'}`
    b.addEventListener('click', () => {
      chooseDesk(d.id, true)
      closeSheet($('settings'))
    })
    box.appendChild(b)
  }
  // Another computer: scan its code too. Each one you scan is added to this list.
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'desk-choice desk-add'
  add.textContent = '+ Add a computer'
  add.addEventListener('click', () => {
    closeSheet($('settings'))
    showJoin(true)
  })
  box.appendChild(add)
}

function wireSheets() {
  const openSettings = () => {
    renderSettings()
    openSheet($('settings'))
  }
  $('settings-btn').addEventListener('click', openSettings)
  $('desk-btn').addEventListener('click', openSettings)
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheet(b.closest('.sheet, .viewer')))
  $('scrim').addEventListener('click', () => {
    closeSheet($('settings'))
    closeSheet($('viewer'))
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    closeSheet($('viewer'))
    closeSheet($('settings'))
  })
  $('join-back')?.addEventListener('click', () => {
    $('join').hidden = true
    $('shell').hidden = false
  })
  $('forget').addEventListener('click', () => {
    const d = splitDesk(S.deskId)
    if (!confirm('Forget this computer? You will need to scan its QR code in Ember again.')) return
    const keep = d ? S.accounts.filter((a) => a.id !== d.acct) : []
    saveAccounts(keep)
    if (!keep.length) for (const k of Object.values(LS)) if (k !== LS.device) store.set(k, null)
    store.set(LS.desk, null)
    store.set(LS.tab, null)
    store.set(LS.key, null)
    store.set(LS.relay, null)
    for (const l of links.values()) l.stop()
    location.replace(location.pathname)
  })
}

// Keep the layout pinned to the visible area when an on-screen keyboard opens.
function wireViewport() {
  const vv = window.visualViewport
  const set = () => document.documentElement.style.setProperty('--vh', `${vv ? vv.height : window.innerHeight}px`)
  set()
  vv?.addEventListener('resize', set)
  window.addEventListener('resize', set)
}

wireViewport()
wireComposer()
wireSheets()
start()
