import type { CanvasFeed, PanelPush } from '@shared/types'

/**
 * The desk's side of Ember on the phone (docs/specs/phone.md).
 *
 * The phone never sees Claude Code's transcript format. This turns each tab's transcript
 * lines and canvas events into the small `Ev` stream the spec defines, keeps the recent
 * stream per tab for a phone that connects late, and answers the phone's requests:
 * watch a tab, type into it, fetch an object's document from the local bridge.
 */

type Json = Record<string, unknown>

export type Ev =
  | { k: 'you'; id: string; text: string; at: number }
  | { k: 'say'; id: string; text: string; at: number; end: boolean }
  | { k: 'act'; id: string; label: string; at: number }
  | { k: 'obj'; id: string; title: string; format: string; path: string; at: number }
  | { k: 'link'; id: string; title: string; url: string; at: number }
  | { k: 'media'; id: string; title: string; items: Array<{ path: string; kind: string; name: string; caption?: string }>; at: number }
  | { k: 'steps'; id: string; title: string; steps: Array<{ text: string; status: string }>; at: number }
  | { k: 'agent'; id: string; agentId: string; label: string; state: 'run' | 'done'; at: number }
  | { k: 'note'; id: string; text: string; at: number }

export interface PhoneTab {
  id: string
  title: string
  cwd: string
  working: boolean
  loom: boolean
  active: boolean
}

export interface PhoneHostHooks {
  /** Send one sealed message to a device on the account. */
  send: (to: string, msg: Json) => void
  tabs: () => PhoneTab[]
  deskName: () => string
  /** Type into a tab's session; submit presses Enter. */
  type: (tabId: string, text: string, submit: boolean) => void
  /** Raw keys into a tab's session. */
  keys: (tabId: string, data: string) => void
}

const KEEP = 1000
const SNAP = 400
const CHUNK = 256 * 1024

/** The keys a phone may press, as the bytes a terminal sends for them. */
const KEYS: Record<string, string> = {
  esc: '\x1b',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  y: 'y',
  n: 'n',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), String(n)])),
}

const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() ?? ''
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A tool call as one short line, the way the desktop's now-line says it. */
function actLabel(name: string, input: Json): string | null {
  // Ember's own canvas tools arrive as objects, steps and media; not as lines.
  if (/^mcp__ember/i.test(name) || name === 'TodoWrite') return null
  switch (name) {
    case 'Read':
      return `Read ${base(input['file_path'])}`
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${base(input['file_path'])}`
    case 'Write':
      return `Write ${base(input['file_path'])}`
    case 'NotebookEdit':
      return `Edit ${base(input['notebook_path'])}`
    case 'Bash':
    case 'PowerShell':
      return clip(String(input['description'] ?? input['command'] ?? 'Run a command'), 80)
    case 'Grep':
      return clip(`Search “${String(input['pattern'] ?? '')}”`, 80)
    case 'Glob':
      return clip(`Find ${String(input['pattern'] ?? '')}`, 80)
    case 'WebFetch':
      try {
        return `Read ${new URL(String(input['url'])).hostname}`
      } catch {
        return 'Read a web page'
      }
    case 'WebSearch':
      return clip(`Search the web: ${String(input['query'] ?? '')}`, 80)
    default: {
      const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/_/g, ' ')
      return clip(short.charAt(0).toUpperCase() + short.slice(1), 60)
    }
  }
}

/** What the user actually typed, or null for the machinery that rides in user lines. */
function userText(content: unknown): string | null {
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const b of content as Json[]) if (b['type'] === 'text') parts.push(String(b['text'] ?? ''))
  }
  const text = parts.join('\n').trim()
  if (!text) return null
  if (/^<(command-|local-command|system-reminder|task-notification|bash-)/.test(text)) return null
  if (text.startsWith('Caveat:')) return null
  return text
}

export class PhoneHost {
  private readonly events = new Map<string, Ev[]>()
  private readonly ids = new Map<string, Set<string>>()
  /** Which tab each phone is watching. */
  private readonly watching = new Map<string, string>()
  /** New events per tab, sent on the next tick. */
  private readonly pending = new Map<string, Ev[]>()
  private flushTimer = 0
  private lastTabs = ''
  /** Agent tool_use ids, so their result can mark them done. */
  private readonly agents = new Map<string, { tab: string; label: string }>()
  private origin = ''
  private readonly unsubs: Array<() => void> = []

  constructor(private readonly hooks: PhoneHostHooks) {
    this.unsubs.push(
      window.ember.canvas.onFeed((f) => this.feed(f)),
      window.ember.panel.onPush((p) => this.push(p)),
      window.ember.canvas.onMedia((m) =>
        this.add(m.tabId, {
          k: 'media',
          id: `m-${m.id}`,
          title: m.title,
          items: m.items.map((i) => ({ path: pathOf(i.src), kind: i.kind, name: i.name, ...(i.caption ? { caption: i.caption } : {}) })),
          at: Date.now(),
        })
      ),
      window.ember.canvas.onSteps((s) => this.add(s.tabId, { k: 'steps', id: `steps-${Date.now()}`, title: s.title, steps: s.steps, at: Date.now() }))
    )
    // Tabs change in many places; a phone hears about it within a couple of seconds.
    const tick = window.setInterval(() => this.tabsChanged(), 2000)
    this.unsubs.push(() => window.clearInterval(tick))
  }

  dispose(): void {
    for (const u of this.unsubs) u()
  }

  /** A phone left the account: stop streaming to it. */
  forget(phoneId: string): void {
    this.watching.delete(phoneId)
  }

  /** A message from a phone. Returns false when it is not one of ours. */
  handle(m: Json, from: string): boolean {
    const t = String(m['t'] ?? '')
    const tab = String(m['tab'] ?? '')
    switch (t) {
      case 'hello':
        this.sendTabs(from)
        return true
      case 'watch': {
        this.watching.set(from, tab)
        this.hooks.send(from, { t: 'snap', tab, events: (this.events.get(tab) ?? []).slice(-SNAP) })
        return true
      }
      case 'send':
        this.hooks.type(tab, String(m['text'] ?? ''), true)
        return true
      case 'act':
        this.hooks.type(tab, String(m['text'] ?? ''), m['submit'] !== false)
        return true
      case 'key': {
        const k = KEYS[String(m['key'] ?? '')]
        if (k) this.hooks.keys(tab, k)
        return true
      }
      case 'get':
        void this.get(from, String(m['id'] ?? ''), String(m['path'] ?? ''))
        return true
      default:
        return false
    }
  }

  // ---------------------------------------------------------------- tabs

  private sendTabs(to: string): void {
    this.hooks.send(to, { t: 'tabs', tabs: this.hooks.tabs(), desk: { name: this.hooks.deskName() } })
  }

  private tabsChanged(): void {
    if (!this.watching.size) return
    const now = JSON.stringify(this.hooks.tabs())
    if (now === this.lastTabs) return
    this.lastTabs = now
    for (const phone of this.watching.keys()) this.sendTabs(phone)
  }

  // ---------------------------------------------------------------- the stream

  private add(tab: string, ev: Ev): void {
    if (!tab) return
    const seen = this.ids.get(tab) ?? new Set<string>()
    this.ids.set(tab, seen)
    // An object pushed again under the same id is an update: send it again.
    if (seen.has(ev.id) && ev.k !== 'obj' && ev.k !== 'steps') return
    seen.add(ev.id)
    const list = this.events.get(tab) ?? []
    list.push(ev)
    if (list.length > KEEP) list.splice(0, list.length - KEEP)
    this.events.set(tab, list)
    const out = this.pending.get(tab) ?? []
    out.push(ev)
    this.pending.set(tab, out)
    if (!this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(), 120)
  }

  private flush(): void {
    this.flushTimer = 0
    for (const [phone, tab] of this.watching) {
      const evs = this.pending.get(tab)
      if (evs?.length) this.hooks.send(phone, { t: 'ev', tab, events: evs })
    }
    this.pending.clear()
  }

  private feed(f: CanvasFeed): void {
    if (f.kind === 'switch') {
      // A new transcript for the tab (/clear, a new session): start its stream afresh.
      if (!f.first) {
        this.events.set(f.tabId, [])
        this.ids.set(f.tabId, new Set())
      }
      return
    }
    for (const line of f.lines) this.line(f.tabId, line)
  }

  private line(tab: string, line: Json): void {
    if (line['isSidechain'] === true || line['isMeta'] === true) return
    const uuid = String(line['uuid'] ?? '')
    const at = Date.parse(String(line['timestamp'] ?? '')) || Date.now()
    const msg = (line['message'] ?? {}) as Json
    if (line['type'] === 'user') {
      const content = msg['content']
      // Results of agent calls end their pills.
      if (Array.isArray(content)) {
        for (const b of content as Json[]) {
          if (b['type'] !== 'tool_result') continue
          const a = this.agents.get(String(b['tool_use_id'] ?? ''))
          if (a) this.add(a.tab, { k: 'agent', id: `agent-${b['tool_use_id']}-done`, agentId: String(b['tool_use_id']), label: a.label, state: 'done', at })
        }
      }
      const text = userText(content)
      if (!text) return
      if (/^\[Request interrupted/.test(text)) {
        this.add(tab, { k: 'note', id: `${uuid}-note`, text: 'Interrupted', at })
        this.add(tab, { k: 'say', id: `${uuid}-end`, text: '', at, end: true })
        return
      }
      this.add(tab, { k: 'you', id: uuid || `you-${at}`, text, at })
      return
    }
    if (line['type'] === 'assistant') {
      const blocks = Array.isArray(msg['content']) ? (msg['content'] as Json[]) : []
      const end = msg['stop_reason'] === 'end_turn'
      blocks.forEach((b, i) => {
        const id = `${uuid}-${i}`
        if (b['type'] === 'text') {
          const text = String(b['text'] ?? '').trim()
          if (text) this.add(tab, { k: 'say', id, text, at, end: end && i === blocks.length - 1 })
        } else if (b['type'] === 'tool_use') {
          const name = String(b['name'] ?? '')
          const input = (b['input'] ?? {}) as Json
          if (name === 'Task' || name === 'Agent') {
            const label = clip(String(input['description'] ?? input['subagent_type'] ?? 'Subagent'), 60)
            this.agents.set(String(b['id']), { tab, label })
            this.add(tab, { k: 'agent', id: `agent-${b['id']}`, agentId: String(b['id']), label, state: 'run', at })
            return
          }
          const label = actLabel(name, input)
          if (label) this.add(tab, { k: 'act', id, label, at })
        }
      })
      // A turn that ended on a tool call with nothing said still ends.
      if (end && !blocks.some((b) => b['type'] === 'text')) this.add(tab, { k: 'say', id: `${uuid}-end`, text: '', at, end: true })
      return
    }
    if (line['type'] === 'system' && line['subtype'] === 'compact_boundary') {
      this.add(tab, { k: 'note', id: uuid || `compact-${at}`, text: 'Conversation compacted', at })
    }
  }

  private push(p: PanelPush): void {
    const at = p.at || Date.now()
    if (p.format === 'url') {
      this.add(p.tabId, { k: 'link', id: p.id, title: p.title, url: p.content, at })
      return
    }
    this.add(p.tabId, { k: 'obj', id: p.id, title: p.title, format: p.format, path: `/doc/${p.id}`, at })
  }

  // ---------------------------------------------------------------- documents and media

  private async get(to: string, id: string, path: string): Promise<void> {
    if (!/^\/(doc|media)\/[A-Za-z0-9._~%-]+(\?.*)?$/.test(path)) {
      this.hooks.send(to, { t: 'err', id, error: 'not allowed' })
      return
    }
    try {
      if (!this.origin) this.origin = await window.ember.panel.origin()
      // Documents take the phone's palette: Ember Night.
      const tone = path.startsWith('/doc/') && !path.includes('?') ? '?target=phone&accent=F2A43A&fg=E8E0D5&bg=16120F' : ''
      const res = await fetch(`${this.origin}${path}${tone}`)
      const type = res.headers.get('content-type') ?? 'application/octet-stream'
      const bytes = new Uint8Array(await res.arrayBuffer())
      const b64 = toB64(bytes)
      const n = Math.max(1, Math.ceil(b64.length / CHUNK))
      for (let i = 0; i < n; i++) {
        this.hooks.send(to, { t: 'got', id, seq: i, last: i === n - 1, status: res.status, type, b64: b64.slice(i * CHUNK, (i + 1) * CHUNK) })
      }
    } catch (err) {
      this.hooks.send(to, { t: 'err', id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function pathOf(src: string): string {
  try {
    const u = new URL(src)
    return u.pathname + u.search
  } catch {
    return src
  }
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
