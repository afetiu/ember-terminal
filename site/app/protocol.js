// Copied verbatim from resources/relay/protocol.js — do not edit here; re-copy instead.
/**
 * The wire between Ember on your devices.
 *
 * One file, shared verbatim by every end — the desk imports it from the renderer, and
 * `mobile/sync.mjs` copies it into the phone bundle. Plain ES with no dependencies for
 * exactly that reason: a protocol with two implementations drifts, and the failure mode of
 * drift here is a link that connects and then quietly fails to understand anything.
 *
 * AN ACCOUNT, NOT A PAIR. Every device holds the same account key. The phone does not
 * pair with a laptop; it joins the account, and then sees a roster — personal laptop, work
 * laptop, whichever are running — and picks one. Adding a laptop is a one-time cost on
 * that laptop and changes nothing on the phone. That is the difference from pairing, where
 * every new machine meant a new code and the phone had to be told about it.
 *
 * WHAT THE RELAY IS ALLOWED TO KNOW. The account id it routes by is `SHA-256(key)`, so the
 * key itself never reaches it — and every payload, device names included, is sealed with
 * that key. It sees how many devices exist, which are online, and when. It cannot see what
 * they are called or anything they say. That is a real if small metadata leak, and it is
 * the price of the relay being able to route at all.
 *
 * WHY THE PINGS. Heroku's router closes a connection idle for 55 seconds, and a WebSocket
 * sitting quietly is exactly that. The heartbeat is not liveness decoration; without it the
 * link dies every minute. It doubles as what stops the dyno idling to sleep, since a desk
 * holds its socket open around the clock.
 *
 * WHY THE ENVELOPE. The seal stops the relay reading a message; it does not stop the relay
 * keeping one and handing it back later, and "type this into tab 3" means the same thing an
 * hour on. So every message travels inside an envelope — who sent it, who it is for, when,
 * and its place in the sender's sequence — sealed with it, so the relay cannot edit any of
 * that. A receiver drops a message that is stale, not newer than the last one from that
 * sender, not addressed to it, or claiming a sender other than the one the relay says it
 * came from. A device on an older copy of this file is not understood, and does not
 * understand: both ends are updated together.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

/** base64url, because these travel in QR codes and URLs. */
function toB64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A new account key. Made once, then carried to every device you own. */
export function newAccountKey() {
  return toB64(crypto.getRandomValues(new Uint8Array(32)))
}

/** A stable id for this installation. Cleartext to the relay, because it routes by it. */
export function newDeviceId() {
  return toB64(crypto.getRandomValues(new Uint8Array(8)))
}

/**
 * The account's public name, derived rather than stored.
 *
 * The relay routes by this and never sees the key. Deriving it also means one secret to
 * carry between devices instead of a pair that could be copied out of step.
 */
export async function accountId(key) {
  const hash = await crypto.subtle.digest('SHA-256', fromB64(key))
  return toB64(new Uint8Array(hash).slice(0, 16))
}

export async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Seal one message. A fresh IV every time — reusing one under AES-GCM does not merely
 * weaken it, it hands over the authentication key, and messages here are frequent and
 * structurally similar.
 */
export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)))
  )
  const joined = new Uint8Array(iv.length + ct.length)
  joined.set(iv, 0)
  joined.set(ct, iv.length)
  return toB64(joined)
}

/** Open one message, or null if it was not ours. Never throws. */
export async function open(key, blob) {
  try {
    const raw = fromB64(blob)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12))
    return JSON.parse(dec.decode(plain))
  } catch {
    // Something with the account id but not the key, which is precisely the case the key
    // exists for. Not an error to report.
    return null
  }
}

/** Where the phone app lives. The key rides in the fragment, which never reaches a server. */
export const APP_URL = 'https://ember.deepanswerlabs.com/app/'

/** The account code, as a QR payload and back. One secret, nothing else to mistype. */
export function accountUrl(relay, key, defaultRelay) {
  const r = relay && relay !== defaultRelay ? `&r=${encodeURIComponent(relay)}` : ''
  return `${APP_URL}#k=${key}${r}`
}

/** Either form: the app link (`…/app/#k=…&r=…`) or the older `ember://join?relay=…&key=…`. */
export function parseAccountUrl(text, defaultRelay) {
  try {
    const u = new URL(String(text).trim())
    if (u.protocol === 'ember:') {
      const relay = u.searchParams.get('relay')
      const key = u.searchParams.get('key')
      return relay && key ? { relay, key } : null
    }
    const h = new URLSearchParams(u.hash.replace(/^#/, ''))
    const key = h.get('k')
    const relay = h.get('r') || defaultRelay
    return key && relay ? { relay, key } : null
  } catch {
    return null
  }
}

const PING_MS = 25_000
const MAX_BACKOFF_MS = 10_000
/** How far a message's time may sit from the receiver's clock, either way, before it is refused. */
const MAX_SKEW_MS = 120_000
/** The envelope's shape; see WHY THE ENVELOPE above. */
const ENVELOPE = 2

/**
 * This device's link to the account.
 *
 * One socket, however many devices are on the other end. Messages are addressed, and the
 * roster arrives unasked whenever it changes — which is what lets the phone show "personal
 * laptop, online" without polling anything.
 *
 * It reconnects forever with backoff, because the interesting case is a phone in a car:
 * losing signal in a tunnel is normal operation, not a fault, and the link is expected to
 * come back by itself without anybody pressing anything.
 */
export class AccountLink {
  /**
   * @param {{ relay: string, key: string, deviceId: string, kind: 'desk'|'phone',
   *           name: string,
   *           onMessage: (msg: any, from: string) => void,
   *           onRoster: (devices: Array<{id,kind,online,name,self}>) => void,
   *           onStatus: (s: 'connecting'|'online'|'offline') => void }} opts
   */
  constructor(opts) {
    this.opts = opts
    this.ws = null
    this.key = null
    this.account = ''
    this.closed = false
    this.attempt = 0
    this.timer = null
    this.ping = null
    this.devices = []
    /**
     * Messages queued while the socket was down, as {to, msg}. Sealed when they go, not
     * when they were written, so the envelope's time is the time they actually leave.
     */
    this.outbox = []
    /** This device's place in its own sequence. */
    this.seq = 0
    /** The last sequence number accepted from each sender. */
    this.lastSeq = new Map()
    /** Incoming frames, opened one at a time so they are judged in the order they came. */
    this.inbox = Promise.resolve()
    /** Outgoing messages, sealed and sent one at a time, so they leave in sequence order. */
    this.sending = Promise.resolve()
  }

  /**
   * The next sequence number: one more than the last, and never behind the clock in
   * microseconds, so it keeps rising across a restart of the app without being stored.
   */
  nextSeq() {
    this.seq = Math.max(this.seq + 1, Date.now() * 1000)
    return this.seq
  }

  /** One message to one device, enveloped and sealed, as the frame the relay carries. */
  async frameFor(to, msg) {
    const env = { v: ENVELOPE, from: this.opts.deviceId, to, ts: Date.now(), seq: this.nextSeq(), m: msg }
    return JSON.stringify({ to, e: await seal(this.key, env) })
  }

  /** The message inside an opened envelope, or null if the envelope does not hold up. */
  accept(env, from) {
    if (!env || typeof env !== 'object' || env.v !== ENVELOPE) return null
    if (env.from !== from || env.to !== this.opts.deviceId) return null
    if (typeof env.ts !== 'number' || Math.abs(Date.now() - env.ts) > MAX_SKEW_MS) return null
    if (typeof env.seq !== 'number' || env.seq <= (this.lastSeq.get(from) ?? 0)) return null
    if (!env.m || typeof env.m !== 'object') return null
    this.lastSeq.set(from, env.seq)
    return env.m
  }

  async start() {
    this.closed = false
    this.key = await importKey(this.opts.key)
    this.account = await accountId(this.opts.key)
    this.connect()
  }

  stop() {
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.ping)
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
    this.setRoster([])
  }

  get online() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Just the other devices that can host a conversation, and are up. */
  get desks() {
    return this.devices.filter((d) => d.kind === 'desk' && d.online && !d.self)
  }

  isOnline(deviceId) {
    return this.devices.some((d) => d.id === deviceId && d.online)
  }

  connect() {
    if (this.closed) return
    const base = this.opts.relay.replace(/^http/, 'ws').replace(/\/+$/, '')
    const url =
      `${base}/link?account=${encodeURIComponent(this.account)}` +
      `&device=${encodeURIComponent(this.opts.deviceId)}&kind=${this.opts.kind}`
    this.opts.onStatus('connecting')

    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      return this.retry()
    }
    this.ws = ws

    ws.onopen = async () => {
      this.attempt = 0
      this.opts.onStatus('online')
      clearInterval(this.ping)
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"c":"ping"}')
      }, PING_MS)
      // The name goes up sealed, so the roster the relay keeps is a list of ciphertext it
      // cannot read but can hand to the other devices, which can.
      ws.send(JSON.stringify({ c: 'name', name: await seal(this.key, this.opts.name) }))
      this.sending = this.sending.then(async () => {
        for (const { to, msg } of this.outbox.splice(0)) ws.send(await this.frameFor(to, msg))
      })
    }

    ws.onmessage = (ev) => {
      this.inbox = this.inbox.then(() => this.receive(ev)).catch(() => {
        /* one bad frame must not stop the ones behind it */
      })
    }

    ws.onclose = () => {
      clearInterval(this.ping)
      if (this.ws === ws) this.ws = null
      this.setRoster([])
      this.opts.onStatus('offline')
      this.retry()
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* onclose will follow */
      }
    }
  }

  /** One frame from the relay: the roster, or a message for this device. */
  async receive(ev) {
    let frame
    try {
      frame = JSON.parse(ev.data)
    } catch {
      return
    }

    if (frame.c === 'roster') {
      const named = await Promise.all(
        (frame.devices ?? []).map(async (d) => ({
          id: d.id,
          kind: d.kind,
          online: !!d.online,
          self: d.id === this.opts.deviceId,
          name: d.name ? ((await open(this.key, d.name)) ?? 'Unknown device') : 'Unnamed device',
        }))
      )
      return this.setRoster(named)
    }
    if (frame.c) return
    if (!frame.e || !frame.from) return
    const msg = this.accept(await open(this.key, frame.e), frame.from)
    if (msg) this.opts.onMessage(msg, frame.from)
  }

  setRoster(devices) {
    this.devices = devices
    this.opts.onRoster(devices)
  }

  retry() {
    if (this.closed) return
    clearTimeout(this.timer)
    // Full jitter. Every device reconnects on the same events — a dyno restart, a network
    // change — and in lockstep they would retry in lockstep forever.
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempt++, 5))
    this.timer = setTimeout(() => this.connect(), Math.random() * ceiling + 250)
  }

  /**
   * Send to one device.
   *
   * Queued rather than dropped when the socket is down: on the phone this is a message
   * typed while the signal was gone, and losing it silently is worse than delivering it
   * late. Bounded, so a device that never reconnects does not accumulate a backlog it will
   * one day deliver all at once. Late means within MAX_SKEW_MS of being sealed, which is
   * why the queue holds the message and seals it on the way out.
   */
  send(to, msg) {
    // One at a time: sealing is asynchronous, and two in flight could reach the socket in
    // the opposite order to their sequence numbers, which the receiver would rightly refuse.
    this.sending = this.sending
      .then(async () => {
        if (this.online) this.ws.send(await this.frameFor(to, msg))
        else {
          this.outbox.push({ to, msg })
          if (this.outbox.length > 50) this.outbox.shift()
        }
      })
      .catch(() => {
        /* a socket that died mid-send; the next send or reconnect carries on */
      })
    return this.sending
  }
}
