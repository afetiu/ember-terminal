/**
 * Slack, live: new direct messages and @-mentions of you arrive in Ember as they are sent,
 * so a session can take them on without a link being copied across.
 *
 * Your own Slack app in Socket Mode: Ember opens the connection itself (no public URL, no
 * server), with two tokens you paste once — the app-level token (xapp-, connections:write)
 * that opens the socket, and your user token (xoxp-) that the app was installed with. The
 * app subscribes to message events *on behalf of you*, so Ember sees what you see: your
 * DMs, group DMs, and the channels you are in, of which it keeps only the messages that
 * mention you — and replies in threads a session already took on.
 *
 * Read-only: Ember never posts, reacts or marks anything read. Tokens are kept encrypted
 * with the OS (Electron safeStorage) in ~/.ember/slack.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { CONFIG_DIR } from './config.js'
import type { SlackMessage, SlackStatus } from '../shared/types.js'
import { parseRoute, wantSlackEvent } from '../shared/slackFilter.js'

const STORE = join(CONFIG_DIR, 'slack.json')
const THREADS = join(CONFIG_DIR, 'slack-threads.json')

/** The app to create: paste into "Create New App → From an app manifest". */
export const SLACK_MANIFEST = {
  display_information: { name: 'Ember', description: 'Brings your Slack DMs and mentions into Ember sessions.' },
  oauth_config: {
    scopes: {
      user: ['channels:history', 'groups:history', 'im:history', 'mpim:history', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read'],
    },
  },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}

interface Tokens {
  app: string
  user: string
}

function seal(s: string): string {
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : `raw:${s}`
}
function unseal(s: string | undefined): string {
  if (!s) return ''
  if (s.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'))
    } catch {
      return ''
    }
  }
  return s.startsWith('raw:') ? s.slice(4) : ''
}

function loadTokens(): Tokens | null {
  try {
    const j = JSON.parse(readFileSync(STORE, 'utf8')) as { app?: string; user?: string }
    const t = { app: unseal(j.app), user: unseal(j.user) }
    return t.app && t.user ? t : null
  } catch {
    return null
  }
}

function saveTokens(t: Tokens | null): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(t ? { app: seal(t.app), user: seal(t.user) } : {}, null, 1), 'utf8')
}

/** Threads a session took on: `channel:threadTs` → the tab handling it. */
function loadThreads(): Record<string, string> {
  try {
    return existsSync(THREADS) ? (JSON.parse(readFileSync(THREADS, 'utf8')) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function api(method: string, token: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const j = (await res.json()) as Record<string, unknown>
  if (!j['ok']) throw new Error(String(j['error'] ?? `HTTP ${res.status}`))
  return j
}

export class SlackLink {
  private tokens: Tokens | null = loadTokens()
  private ws: WebSocket | null = null
  private me = ''
  private team = ''
  private state: SlackStatus = { state: 'off' }
  private retry = 0
  private retryTimer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly names = new Map<string, string>()
  private readonly channels = new Map<string, { name: string; dm: boolean }>()
  private threads = loadThreads()
  private readonly seen = new Set<string>()
  /** Messages not yet acted on, so a reloaded window gets them back. */
  private pending: SlackMessage[] = []

  constructor(
    private readonly emit: {
      message: (m: SlackMessage) => void
      status: (s: SlackStatus) => void
    }
  ) {}

  start(): void {
    if (this.tokens) void this.connect()
  }

  get status(): SlackStatus {
    return this.state
  }

  get waiting(): SlackMessage[] {
    return this.pending
  }

  private set(s: SlackStatus): void {
    this.state = s
    this.emit.status(s)
  }

  /** Check the tokens, keep them, and connect. */
  async setTokens(app: string, user: string): Promise<SlackStatus> {
    app = app.trim()
    user = user.trim()
    if (!/^xapp-/.test(app)) return { state: 'error', error: 'The app-level token starts with xapp-' }
    if (!/^xoxp-/.test(user)) return { state: 'error', error: 'The user token starts with xoxp-' }
    try {
      await api('auth.test', user)
    } catch (err) {
      return { state: 'error', error: `The user token did not work: ${(err as Error).message}` }
    }
    this.tokens = { app, user }
    saveTokens(this.tokens)
    this.stopped = false
    await this.connect()
    return this.state
  }

  disconnect(forget: boolean): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
    if (forget) {
      this.tokens = null
      saveTokens(null)
    }
    this.set({ state: 'off' })
  }

  /** A session took this thread on: its later replies go straight there. */
  remember(channel: string, threadTs: string, tabId: string): void {
    this.threads[`${channel}:${threadTs}`] = tabId
    const keys = Object.keys(this.threads)
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete this.threads[k]
    try {
      writeFileSync(THREADS, JSON.stringify(this.threads), 'utf8')
    } catch {
      /* kept for this run */
    }
  }

  /** Done with it (sent, made a todo, ignored): it leaves the waiting list. */
  settle(id: string): void {
    this.pending = this.pending.filter((m) => m.id !== id)
  }

  private async connect(): Promise<void> {
    const t = this.tokens
    if (!t || this.stopped) return
    this.set({ state: 'connecting' })
    try {
      const who = await api('auth.test', t.user)
      this.me = String(who['user_id'] ?? '')
      this.team = String(who['team'] ?? '')
      const open = await api('apps.connections.open', t.app)
      const url = String(open['url'] ?? '')
      if (!url) throw new Error('no socket URL')
      const ws = new WebSocket(url)
      this.ws = ws
      ws.addEventListener('message', (e) => void this.onFrame(ws, String(e.data)))
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return
        this.ws = null
        this.again()
      })
      ws.addEventListener('error', () => ws.close())
    } catch (err) {
      this.set({ state: 'error', error: (err as Error).message })
      this.again()
    }
  }

  /** Back off and reconnect: 2s, 4s… up to a minute. Slack also asks for this now and then. */
  private again(): void {
    if (this.stopped || !this.tokens) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const ms = Math.min(60_000, 2000 * 2 ** this.retry++)
    this.retryTimer = setTimeout(() => void this.connect(), ms)
  }

  private async onFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>
    try {
      f = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (f['envelope_id']) ws.send(JSON.stringify({ envelope_id: f['envelope_id'] }))
    if (f['type'] === 'hello') {
      this.retry = 0
      this.set({ state: 'connected', team: this.team })
      return
    }
    if (f['type'] === 'disconnect') {
      // Slack rotates sockets: open a new one, then let this one go.
      this.ws = null
      void this.connect()
      setTimeout(() => ws.close(), 5000)
      return
    }
    if (f['type'] !== 'events_api') return
    const ev = ((f['payload'] as Record<string, unknown>)?.['event'] ?? {}) as Record<string, unknown>
    try {
      await this.onMessage(ev)
    } catch (err) {
      console.error(`[ember] slack message: ${(err as Error).message}`)
    }
  }

  private async onMessage(ev: Record<string, unknown>): Promise<void> {
    const want = wantSlackEvent(ev, this.me, this.threads)
    if (!want) return
    const user = String(ev['user'] ?? '')
    const channel = String(ev['channel'] ?? '')
    const ts = String(ev['ts'] ?? '')
    const key = `${channel}:${ts}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 2000) this.seen.clear()
    const text = String(ev['text'] ?? '')
    const threadTs = String(ev['thread_ts'] ?? ts)
    const dm = want.dm
    const tab = want.tab
    const [userName, where, permalink] = await Promise.all([this.userName(user), this.channelOf(channel), this.permalink(channel, ts)])
    const m: SlackMessage = {
      id: key,
      channel,
      channelName: where.name,
      dm: dm || where.dm,
      user,
      userName,
      text: await this.plain(text),
      ts,
      threadTs,
      permalink,
      tabId: tab,
      at: Math.round(Number(ts) * 1000) || Date.now(),
    }
    this.pending = [...this.pending.filter((x) => x.id !== m.id), m].slice(-50)
    this.emit.message(m)
  }

  /** `<@U123>` and `<#C123|name>` as names, links as their text. */
  private async plain(text: string): Promise<string> {
    let out = text
    for (const id of new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]!))) {
      const name = id === this.me ? 'you' : await this.userName(id)
      out = out.split(`<@${id}>`).join(`@${name}`)
    }
    return out
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  }

  private async userName(id: string): Promise<string> {
    const hit = this.names.get(id)
    if (hit) return hit
    try {
      const j = await api('users.info', this.tokens!.user, { user: id })
      const u = (j['user'] ?? {}) as Record<string, unknown>
      const p = (u['profile'] ?? {}) as Record<string, unknown>
      const name = String(p['display_name'] || p['real_name'] || u['name'] || id)
      this.names.set(id, name)
      return name
    } catch {
      return id
    }
  }

  private async channelOf(id: string): Promise<{ name: string; dm: boolean }> {
    const hit = this.channels.get(id)
    if (hit) return hit
    try {
      const j = await api('conversations.info', this.tokens!.user, { channel: id })
      const c = (j['channel'] ?? {}) as Record<string, unknown>
      const v = { name: c['is_im'] ? '' : String(c['name'] ?? ''), dm: !!(c['is_im'] || c['is_mpim']) }
      this.channels.set(id, v)
      return v
    } catch {
      return { name: '', dm: id.startsWith('D') }
    }
  }

  private async permalink(channel: string, ts: string): Promise<string> {
    try {
      const j = await api('chat.getPermalink', this.tokens!.user, { channel, message_ts: ts })
      return String(j['permalink'] ?? '')
    } catch {
      return ''
    }
  }
}

/**
 * Where a message should go, decided on the side by a small model: a session, a new one, a
 * todo, a note, or nowhere. Most Slack is chat; only what Ember can act on gets through.
 */
export async function routeSlack(m: SlackMessage, sessions: Array<{ tabId: string; title: string; folder: string; goal: string; header: string }>): Promise<{
  action: 'session' | 'new' | 'todo' | 'note' | 'ignore'
  tabId?: string
  why: string
  title: string
  folder?: string
}> {
  const list = sessions.map((s, i) => `${i + 1}. "${s.title}" in ${s.folder || '(no folder)'}${s.goal ? ` — working on: ${s.goal}` : ''}${s.header ? ` — ${s.header}` : ''}`)
  const prompt = [
    'A Slack message has arrived for the person, a software developer working with coding agents. Most Slack is chat that needs nothing.',
    'Decide whether it is worth interrupting them, and where it goes. Reply with ONLY a JSON object, no prose:',
    '{"action": "session" | "new" | "todo" | "note" | "ignore", "session": <number or null>, "why": "...", "title": "..."}',
    '',
    '- session: it is about the same work as one of the open agent sessions listed below. Give its number.',
    '  Only when it clearly is the same topic; a loose match is not.',
    '- new: it asks for concrete work an agent can do now (a bug, an error, a change, a review, a deploy, something to look into), and no session fits.',
    '- todo: it asks the person for something specific that can wait, or that is not agent work (a call, a reply, a decision, a meeting).',
    '- note: nothing is asked, but it carries something worth keeping: a decision, a spec, credentials location, an address, a date, a link to remember.',
    '- ignore: everything else. Greetings, small talk, jokes, thanks, "ok", reactions, banter, gossip, lunch, FYI with nothing to keep, automated noise.',
    '  When in doubt between ignore and anything else, choose ignore.',
    'why: at most 10 plain words, for the person; never a session number. title: 2 to 5 words naming the work, for a new session, the todo or the note.',
    '',
    'Open sessions:',
    ...(list.length ? list : ['(none)']),
    '',
    `From ${m.userName}${m.dm ? ' (direct message)' : m.channelName ? ` in #${m.channelName}` : ''}:`,
    m.text.slice(0, 3000),
  ].join('\n')
  const { runAgent } = await import('./agents.js')
  const out = await runAgent(prompt, { timeoutMs: 60_000, model: 'haiku' }).done
  return parseRoute(out.ok ? out.text : '', m, sessions)
}
