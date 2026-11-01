/**
 * The Ember relay, as a Cloudflare Worker: a rendezvous for devices that cannot dial each
 * other (a laptop behind home NAT, a phone behind a carrier's).
 *
 * The same wire as the old Heroku relay (`GET /link?account&device&kind` → WebSocket), so
 * nothing on the devices changes. One Durable Object per account holds that account's
 * sockets, keeps the roster and forwards addressed frames.
 *
 * IT CANNOT READ ANYTHING. The account id is SHA-256 of a key it never receives, and every
 * payload — device names included — is sealed with that key on the devices. It sees how
 * many devices an account has, which are connected, sizes and timing. Nothing that needs
 * the plaintext belongs here: no history, no replay, no notifications.
 *
 * Sockets use the hibernation API, so an idle desk holding its link open all day costs
 * nothing while nobody is talking.
 */

const ID = /^[A-Za-z0-9_-]{16,64}$/
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/
const MAX_FRAME = 512 * 1024

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ ok: true, at: new Date().toISOString() })
    }
    if (url.pathname !== '/link') return new Response('not found', { status: 404 })
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 })
    const account = url.searchParams.get('account') ?? ''
    const device = url.searchParams.get('device') ?? ''
    const kind = url.searchParams.get('kind') ?? ''
    if (!ID.test(account) || !DEVICE.test(device) || (kind !== 'desk' && kind !== 'phone')) {
      return new Response('bad link', { status: 400 })
    }
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account))
    return stub.fetch(req)
  },
}

export class Account {
  constructor(state) {
    this.state = state
    // Answer heartbeats without waking the object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"c":"ping"}', '{"c":"pong"}'))
  }

  async fetch(req) {
    const url = new URL(req.url)
    const device = url.searchParams.get('device')
    const kind = url.searchParams.get('kind')
    // A device reconnecting replaces its old socket, keeping the name it had.
    let name = ''
    for (const ws of this.state.getWebSockets(device)) {
      name = ws.deserializeAttachment()?.name ?? name
      try {
        ws.close(4000, 'replaced')
      } catch {
        /* already gone */
      }
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.state.acceptWebSocket(server, [device])
    server.serializeAttachment({ device, kind, name })
    server.send(this.roster())
    // Tell the others shortly, unless the device names itself first (it does, at once).
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, data) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    if (text.length > MAX_FRAME) return
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const me = ws.deserializeAttachment()
    if (!me) return
    if (frame.c === 'name') {
      ws.serializeAttachment({ ...me, name: String(frame.name ?? '').slice(0, 4096) })
      return this.broadcast()
    }
    if (frame.c === 'ping') return ws.send('{"c":"pong"}')
    if (frame.c) return
    const to = String(frame.to ?? '')
    if (!DEVICE.test(to)) return
    for (const target of this.state.getWebSockets(to)) {
      try {
        target.send(JSON.stringify({ from: me.device, e: frame.e }))
      } catch {
        /* closing */
      }
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close()
    } catch {
      /* gone */
    }
    this.broadcast(ws)
  }

  async webSocketError(ws) {
    this.broadcast(ws)
  }

  roster(except) {
    const devices = []
    for (const ws of this.state.getWebSockets()) {
      if (ws === except || ws.readyState !== 1) continue
      const a = ws.deserializeAttachment()
      if (a) devices.push({ id: a.device, kind: a.kind, name: a.name, online: true })
    }
    return JSON.stringify({ c: 'roster', devices })
  }

  broadcast(except) {
    const payload = this.roster(except)
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue
      try {
        ws.send(payload)
      } catch {
        /* closing */
      }
    }
  }
}
