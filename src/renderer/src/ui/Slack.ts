/**
 * Slack in Ember: not a feed. Each new DM or mention of you is read on the side by a small
 * model first, and only what Ember can act on is shown — work for one of your sessions,
 * new work, a todo, or something worth keeping as a note. Chat, thanks and banter never
 * reach the screen.
 *
 * One card at a time: a newer message takes the card's place, and the ones it covered stay
 * a step away (‹ ›) until dealt with. A reply in a thread a session already took on goes
 * straight to that session. Nothing is typed into a session without a click, apart from
 * those replies.
 *
 * And the sheet that connects it: your own Slack app, made from a manifest, two tokens.
 */
import type { SlackMessage, SlackRoute, SlackStatus } from '@shared/types'

export interface SlackHooks {
  /** The open agent sessions, for the router: their titles, folders and what they are doing. */
  sessions(): Array<{ tabId: string; title: string; folder: string; goal: string; header: string }>
  /** Type a message into a session (queued if it is mid-turn). */
  send(tabId: string, text: string): boolean
  /** Open a new session with a brief; its tab id. */
  newSession(brief: string, folder: string, title: string): Promise<string>
  addTodo(text: string): Promise<void>
  /** A new note with this body; whether it was written. */
  addNote(body: string): Promise<boolean>
  titleOf(tabId: string): string
  toast(text: string): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

function whereOf(m: SlackMessage): string {
  return m.dm ? 'a direct message' : m.channelName ? `#${m.channelName}` : 'Slack'
}

/** What a session is handed: who, where, the words, the link, and what to do with it. */
export function briefFor(m: SlackMessage): string {
  return (
    `New Slack message from ${m.userName} in ${whereOf(m)}: "${m.text.replace(/\s+/g, ' ').trim()}"` +
    (m.permalink ? ` (${m.permalink})` : '') +
    '. Work out what they need and handle it; if it needs a decision or something only I can do, tell me exactly what. ' +
    'Do not reply on Slack unless I ask.'
  )
}

/** A note kept from Slack: a title, who and where, the words, the link. */
export function noteFor(m: SlackMessage, title: string): string {
  const when = new Date(m.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const quote = m.text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  return `# ${title || `Slack: ${m.userName}`}\n\nFrom ${m.userName} in ${whereOf(m)}, ${when}.\n\n${quote}\n${m.permalink ? `\n[Open in Slack](${m.permalink})\n` : ''}`
}

interface Item {
  m: SlackMessage
  r: SlackRoute
}

export class SlackInbox {
  readonly el = el('div', 'ember-slack')
  /** Routed and worth showing, oldest first; the card shows `at` (the newest, unless stepped back). */
  private items: Item[] = []
  private at = -1
  /** Being read by the router, so a reload or a repeat does not route twice. */
  private readonly routing = new Set<string>()
  private card: HTMLElement | null = null
  /** You stepped (‹ ›) to a card: a new arrival does not snatch it away. */
  private stepped = false

  constructor(private readonly hooks: SlackHooks) {
    window.ember.slack.onMessage((m) => void this.arrive(m))
    void window.ember.slack.waiting().then((list) => list.forEach((m) => void this.arrive(m)))
  }

  /**
   * A message came in: a thread a session took on goes straight there; anything else is read
   * first, and shown only if there is something to do with it.
   */
  async arrive(m: SlackMessage): Promise<void> {
    if (this.routing.has(m.id) || this.items.some((x) => x.m.id === m.id)) return
    if (m.tabId && this.hooks.titleOf(m.tabId) && this.hooks.send(m.tabId, briefFor(m))) {
      window.ember.slack.settle(m.id)
      this.hooks.toast(`Slack: ${m.userName}'s reply went to "${this.hooks.titleOf(m.tabId)}"`)
      return
    }
    this.routing.add(m.id)
    const r: SlackRoute = await window.ember.slack
      .route(m, this.hooks.sessions())
      .catch(() => ({ action: 'todo' as const, why: 'Could not sort it; your call', title: m.text.slice(0, 30) }))
    this.routing.delete(m.id)
    if (r.action === 'ignore') {
      // Chat: nothing to do, nothing shown.
      window.ember.slack.settle(m.id)
      return
    }
    this.items.push({ m, r })
    this.items.sort((a, b) => a.m.at - b.m.at)
    // What just came in takes the card, unless you stepped to another one to read it.
    const keep = this.stepped && this.card?.isConnected ? this.card.dataset.id : m.id
    this.at = Math.max(0, this.items.findIndex((x) => x.m.id === keep))
    this.render()
  }

  /** The one card: the item at `at`, built fresh in the same slot. */
  private render(): void {
    if (!this.items.length) {
      this.at = -1
      const old = this.card
      this.card = null
      if (old) {
        old.classList.add('is-leaving')
        window.setTimeout(() => old.remove(), 220)
      }
      return
    }
    this.at = Math.max(0, Math.min(this.at < 0 ? this.items.length - 1 : this.at, this.items.length - 1))
    const { m, r } = this.items[this.at]!
    const card = el('div', 'ember-slack-card')
    card.dataset.id = m.id
    const head = el('div', 'ember-slack-head')
    const who = el('a', 'ember-slack-who', `${m.userName}${m.dm ? '' : m.channelName ? ` · #${m.channelName}` : ''}`)
    if (m.permalink) {
      who.href = m.permalink
      who.target = '_blank'
      who.title = 'Open in Slack'
    }
    const when = el('span', 'ember-slack-when', ago(m.at))
    const close = el('button', 'ember-slack-x', '✕')
    close.title = 'Dismiss'
    close.addEventListener('click', () => this.done(m))
    head.append(el('span', 'ember-slack-src', m.dm ? 'DM' : '@you'), who, when)
    if (this.items.length > 1) head.append(this.stepper())
    head.append(close)
    const text = el('div', 'ember-slack-text', m.text)
    const why = el('div', 'ember-slack-why', this.say(r))
    why.hidden = !why.textContent
    const acts = el('div', 'ember-slack-acts')
    this.renderActs(m, acts, r)
    card.append(head, text, why, acts)
    if (this.card?.isConnected) {
      // Same slot: the new one takes the old one's place, no stacking.
      card.classList.add('is-swap')
      this.card.replaceWith(card)
    } else this.el.replaceChildren(card)
    this.card = card
  }

  /** ‹ 2/3 › — the others still waiting, a step away. */
  private stepper(): HTMLElement {
    const box = el('span', 'ember-slack-step')
    const prev = el('button', 'ember-slack-nav', '‹')
    prev.title = 'Earlier'
    prev.disabled = this.at <= 0
    prev.addEventListener('click', () => {
      this.at--
      this.stepped = true
      this.render()
    })
    const next = el('button', 'ember-slack-nav', '›')
    next.title = 'Newer'
    next.disabled = this.at >= this.items.length - 1
    next.addEventListener('click', () => {
      this.at++
      this.stepped = true
      this.render()
    })
    box.append(prev, el('span', 'ember-slack-count', `${this.at + 1}/${this.items.length}`), next)
    return box
  }

  /** The suggestion, in a line: the session by name, else the model's own reason. */
  private say(r: SlackRoute): string {
    if (r.action === 'session' && r.tabId) return `For "${this.hooks.titleOf(r.tabId)}"${r.why ? ` — ${r.why}` : ''}`
    return r.why || (r.action === 'new' ? 'Looks like new work' : r.action === 'todo' ? 'Can wait: a todo' : r.action === 'note' ? 'Worth keeping' : '')
  }

  /** The ways, the suggested one first and filled. */
  private renderActs(m: SlackMessage, acts: HTMLElement, r: SlackRoute): void {
    acts.replaceChildren()
    const send = r.action === 'session' && r.tabId && this.hooks.titleOf(r.tabId) ? r.tabId : ''
    const items: Array<[key: string, label: string, run: () => void | Promise<void>]> = []
    if (send) items.push(['session', `Send to "${this.hooks.titleOf(send).slice(0, 28)}"`, () => this.toSession(m, send)])
    items.push(['new', 'New session', () => this.toNew(m, r)])
    items.push(['todo', 'Todo', () => this.toTodo(m, r)])
    items.push(['note', 'Note', () => this.toNote(m, r)])
    const first = r.action === 'session' ? (send ? 'session' : 'new') : r.action
    items.sort((a, b) => Number(b[0] === first) - Number(a[0] === first))
    for (const [key, label, run] of items) {
      const b = el('button', `ember-slack-act${key === first ? ' is-primary' : ''}`, label)
      b.addEventListener('click', () => void run())
      acts.appendChild(b)
    }
  }

  private toSession(m: SlackMessage, tabId: string): void {
    if (!this.hooks.send(tabId, briefFor(m))) return this.hooks.toast('That session is gone — pick another way.')
    window.ember.slack.remember(m.channel, m.threadTs, tabId)
    this.hooks.toast(`Sent to "${this.hooks.titleOf(tabId)}"`)
    this.done(m)
  }

  private async toNew(m: SlackMessage, r: SlackRoute): Promise<void> {
    this.done(m)
    const tab = await this.hooks.newSession(briefFor(m), r.folder ?? '', r.title || `Slack: ${m.userName}`)
    if (tab) window.ember.slack.remember(m.channel, m.threadTs, tab)
  }

  private async toTodo(m: SlackMessage, r: SlackRoute): Promise<void> {
    this.done(m)
    const what = r.title && r.action === 'todo' ? r.title : m.text.replace(/\s+/g, ' ').slice(0, 80)
    await this.hooks.addTodo(`${m.userName}: ${what}${m.permalink ? ` [Slack](${m.permalink})` : ''}`)
    this.hooks.toast('Added to your todo list')
  }

  private async toNote(m: SlackMessage, r: SlackRoute): Promise<void> {
    this.done(m)
    const ok = await this.hooks.addNote(noteFor(m, r.action === 'note' ? r.title : ''))
    this.hooks.toast(ok ? 'Kept as a note' : 'Could not write the note')
  }

  private done(m: SlackMessage): void {
    window.ember.slack.settle(m.id)
    const i = this.items.findIndex((x) => x.m.id === m.id)
    if (i < 0) return
    this.items.splice(i, 1)
    this.stepped = false
    // Next up: the newest still waiting.
    this.at = this.items.length - 1
    this.render()
  }
}

/** Connect Slack: make the app from a manifest, paste two tokens. */
export class SlackSheet {
  readonly el = el('div', 'ember-pair ember-slack-sheet')
  private readonly body = el('div', 'ember-pair-body')
  private status: SlackStatus = { state: 'off' }

  constructor() {
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.hide()
    })
    const card = el('div', 'ember-pair-card')
    const head = el('header', 'ember-pair-head')
    head.innerHTML = '<span>Slack</span>'
    const x = el('button', 'ember-pair-x', '✕')
    x.addEventListener('click', () => this.hide())
    head.appendChild(x)
    card.append(head, this.body)
    this.el.appendChild(card)
    window.ember.slack.onStatus((s) => {
      this.status = s
      if (this.el.classList.contains('is-open')) this.render()
    })
    void window.ember.slack.status().then((s) => (this.status = s))
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide()
    })
  }

  show(): void {
    this.el.classList.add('is-open')
    this.render()
  }

  hide(): void {
    this.el.classList.remove('is-open')
  }

  private render(): void {
    const s = this.status
    const on = s.state === 'connected'
    const line = el(
      'div',
      `ember-pair-status${on ? ' is-on' : s.state === 'connecting' ? ' is-wait' : ''}`,
      on ? `Connected${s.team ? ` to ${s.team}` : ''}: only what needs you comes in` : s.state === 'connecting' ? 'Connecting…' : s.state === 'error' ? `Not connected: ${s.error ?? ''}` : 'Not connected'
    )
    this.body.replaceChildren(line)
    if (on) {
      const p = el('p', 'ember-slack-p', 'New DMs and mentions are read first: only the ones with something to do show, one card at a time, with where they should go (one of your sessions, a new session, a todo, or a note). Chat never shows. One click does it. Replies in a thread a session took on go straight to that session. Ember only reads; it never posts.')
      const row = el('div', 'ember-slack-row')
      const off = el('button', 'ember-slack-btn', 'Disconnect')
      off.addEventListener('click', () => void window.ember.slack.disconnect(true))
      row.append(off)
      this.body.append(p, row)
      return
    }
    const steps = el('ol', 'ember-slack-steps')
    const s1 = el('li', '')
    s1.innerHTML = 'Create the app: <b>Create New App → From a manifest</b>, pick your workspace, paste the manifest, <b>Create</b>, then <b>Install to Workspace</b>.'
    const r1 = el('div', 'ember-slack-row')
    const open = el('button', 'ember-slack-btn', 'Open Slack apps')
    open.addEventListener('click', () => window.open('https://api.slack.com/apps?new_app=1', '_blank'))
    const copy = el('button', 'ember-slack-btn', 'Copy the manifest')
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(await window.ember.slack.manifest())
      copy.textContent = 'Copied'
    })
    r1.append(open, copy)
    s1.appendChild(r1)
    const s2 = el('li', '')
    s2.innerHTML = '<b>Basic Information → App-Level Tokens → Generate</b>, scope <code>connections:write</code>. Paste it here (xapp-…):'
    const app = el('input', 'ember-slack-input')
    app.type = 'password'
    app.placeholder = 'xapp-…'
    s2.appendChild(app)
    const s3 = el('li', '')
    s3.innerHTML = '<b>OAuth &amp; Permissions → User OAuth Token</b>. Paste it here (xoxp-…):'
    const user = el('input', 'ember-slack-input')
    user.type = 'password'
    user.placeholder = 'xoxp-…'
    s3.appendChild(user)
    steps.append(s1, s2, s3)
    const go = el('button', 'ember-slack-btn is-primary', 'Connect')
    go.addEventListener('click', async () => {
      go.disabled = true
      go.textContent = 'Connecting…'
      this.status = await window.ember.slack.connect(app.value, user.value)
      this.render()
    })
    const note = el('p', 'ember-slack-p', 'Ember only reads, and only your DMs, mentions of you, and threads a session took on. The tokens are kept encrypted on this machine.')
    this.body.append(steps, go, note)
  }
}
