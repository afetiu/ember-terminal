import type { HookEvent, SlashCommandInfo } from '@shared/types'
import { Asks } from './Asks'
import { Composer, tuiOnly, type Attachment, type QueuedMessage } from './Composer'
import type { AgentWrapper, WrapperHost, WrapperState } from './AgentWrapper'

/**
 * Codex CLI on the canvas: the real Codex TUI in the tab's terminal, driven as the person
 * would drive it, and never shown on the canvas. ClaudeTui's twin; what differs is Codex.
 *
 * The conversation. Codex writes it down as it goes, in its rollout log
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Main finds the tab's log and reads it
 * through the Codex adapter (src/main/providers/logs.ts) into the canvas's feed; nothing
 * here touches it.
 *
 * Typing. The composer sends by typing into Codex's prompt: the text as one bracketed
 * paste (newlines stay newlines), then Enter — or Tab while a turn runs, which is Codex's
 * "queue for when this turn ends" (Enter mid-turn would steer the running turn instead).
 * Pictures go first, each put on the clipboard and attached with Codex's own Ctrl+V
 * ("[Image #n]"). `!cmd` is typed as it is: Codex reads a leading `!` as a shell command.
 * Esc interrupts; Shift+Tab cycles Codex's mode (default, plan).
 *
 * Knowing. Codex has hooks in Claude Code's shape, and the shim hands it Ember's
 * (resources/hook.mjs): UserPromptSubmit and Stop say when a turn starts and ends, and a
 * PermissionRequest — every approval Codex would ask for — becomes Ember's card. The card's
 * answer is the hook's decision; Codex asks in its own screen only when no hook decided.
 * Codex runs a hook only once the person has trusted it (its "Hooks need review" screen),
 * so until then, and for anything else only its screen has (a picker, the folder-trust
 * question, an approval no hook was asked about), the canvas says "Codex is showing
 * something in the CLI" with Open CLI — it never crops the screen into the canvas.
 *
 * The screen is read as text for three things only: whether the prompt is up (and what
 * the person left in it), the working line ("• Working (12s • esc to interrupt)"), and the
 * status line under the prompt (model, effort, context left).
 */

/** The prompt line: `›` and what is typed (the placeholder is drawn dim). */
const PROMPT = /^›(?:\s|$)/
/** The lines Codex draws under its prompt: model and folder, hints, context left. */
const FOOT = /·|for shortcuts|esc to interrupt|context left|⚠|tab to queue|to edit|shift\+tab|plan mode|ctrl\+c/i
/** The working line: a bullet, what it is doing, and its timer with the interrupt hint. */
const WORKING = /^(\S)\s+(.+?)\s+\(([^()]*?)\s*•\s*esc to interrupt\)\s*$/
/** An approval Codex is asking in its own screen. */
const APPROVAL = /Would you like to (?:run|make|apply|allow|grant)|Press enter to confirm or esc to cancel|Yes, proceed \(y\)/i
/** Hook trust, the first time Ember's hooks (or any new hook) are seen. */
const HOOK_REVIEW = /Hooks need review/i
/** The key hints under a dialog's choices. */
const DIALOG_KEYS = /enter (?:to )?(?:confirm|continue|select)|esc (?:to )?(?:skip|quit|cancel|close)|press enter/i
/** A screen of numbered choices: a dialog, a picker. */
const DIALOG = /^\s*›?\s*\d+\.\s|enter (?:to )?(?:confirm|continue|select)|esc (?:to )?(?:skip|quit|cancel|close)/i
/** The placeholders Codex shows in an empty prompt, should a terminal not draw them dim. */
const PLACEHOLDER = /^(?:Ask Codex to do anything|Implement \{feature\}|Find and fix a bug in @filename|Explain this codebase|Summarize recent commits|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills)$/

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/**
 * Codex's slash commands, as its own `/` menu lists them (0.156). The ones whose answer
 * is a picker or a page only its screen has are in CODEX_TUI_ONLY and open the CLI view.
 */
const CODEX_COMMANDS: SlashCommandInfo[] = [
  ['new', 'start a new chat during a conversation'],
  ['clear', 'clear the terminal and start a new chat'],
  ['compact', 'summarize conversation to prevent hitting the context limit'],
  ['init', 'create an AGENTS.md file with instructions for Codex'],
  ['plan', 'switch to Plan mode'],
  ['goal', 'set or view the goal for a long-running task', '<goal>'],
  ['rename', 'rename the current thread', '<name>'],
  ['mention', 'mention a file', '<path>'],
  ['fast', '2x speed, increased usage'],
  ['side', 'start a side conversation in an ephemeral fork', '<message>'],
  ['cd', 'change the current working directory', '<dir>'],
  ['export', 'export the conversation as markdown'],
  ['quit', 'exit Codex'],
].map(([name, description, argumentHint]) => ({ name: name!, description: description!, argumentHint: argumentHint ?? '' }))

export const CODEX_TUI_ONLY: Record<string, { description: string; args?: boolean }> = {
  model: { description: 'choose what model and reasoning effort to use' },
  permissions: { description: 'choose what Codex is allowed to do' },
  review: { description: 'review my current changes and find issues' },
  resume: { description: 'resume a saved chat' },
  fork: { description: 'fork the current chat' },
  status: { description: 'show current session configuration and token usage' },
  diff: { description: 'show git diff (including untracked files)' },
  mcp: { description: 'list configured MCP tools' },
  skills: { description: 'use skills to improve how Codex performs specific tasks' },
  hooks: { description: 'view and manage lifecycle hooks' },
  memories: { description: 'configure memory use and generation' },
  approve: { description: 'approve one retry of a recent auto-review denial' },
  experimental: { description: 'toggle experimental features' },
  keymap: { description: 'remap TUI shortcuts' },
  statusline: { description: 'configure which items appear in the status line' },
  theme: { description: 'choose a syntax highlighting theme' },
  agents: { description: 'open the agent command center' },
  ps: { description: 'list background terminals' },
  usage: { description: 'view account usage' },
  feedback: { description: 'send logs to maintainers' },
  logout: { description: 'log out of Codex' },
  vim: { description: 'toggle Vim mode for the composer' },
  copy: { description: 'copy the last response or part of it' },
}

interface Box {
  top: number
  bottom: number
  /** What the person typed there; '' for an empty prompt. */
  text: string
  images: number
  /** The rows under the prompt: the status line, hints. */
  foot: string[]
}

export class CodexTui implements AgentWrapper {
  readonly agent = 'codex'
  readonly state: WrapperState = { phase: 'starting', mode: 'default', model: '', effort: '', live: null, title: '', sessionId: '' }
  private readonly composer: Composer
  private readonly asks: Asks
  private readonly banner = document.createElement('div')
  private readonly bannerText: HTMLElement
  private readonly unsubs: Array<() => void> = []
  /** Cards open for approvals, by the bridge's id for the held hook. */
  private readonly cards = new Map<string, { tool: string; at: number }>()
  private queue: QueuedMessage[] = []
  private queueSeen = 0
  private chain: Promise<void> = Promise.resolve()
  private sending = 0
  /** Hook times: a turn is on while the last prompt is newer than the last stop. */
  private promptAt = 0
  private stopAt = 0
  private box: Box | null = null
  private boxSeen = false
  private noBoxSince = 0
  private recheck = 0
  private workingAt = 0
  private elsewhere = ''
  /** Codex's own screen is asking for an approval (no hook was, or none could be). */
  private screenAsks = false
  /** The last Ctrl+C typed: a second one soon after would quit Codex. */
  private ctrlCAt = 0
  private disposed = false
  private readonly counts: Record<string, number> = {}
  private readonly log: string[] = []
  private readonly typed: string[] = []

  constructor(private readonly host: WrapperHost) {
    this.asks = new Asks({
      answer: (id, response) => this.answer(id, response),
      setMode: () => {},
      who: 'Codex',
      relayout: () => host.relayout(),
      closed: () => {
        if (!this.asks.size && this.state.phase === 'asking') this.set({ phase: this.busyNow ? 'working' : 'idle' })
        requestAnimationFrame(() => {
          if (!this.asks.size || !document.activeElement?.closest('.loom-ask-card')) this.composer.focus()
        })
      },
    })
    host.above.prepend(this.asks.el)
    this.composer = new Composer({
      frame: host.frame,
      above: host.above,
      commands: () => CODEX_COMMANDS,
      tuiOnly: CODEX_TUI_ONLY,
      files: (query) => window.ember.files.search(host.cwd(), query),
      submit: (text, images) => this.submit(text, images),
      cycleMode: () => this.cycleMode(),
      sendNow: () => host.toast('Codex sends queued messages when the turn ends (Alt+↑ in the CLI edits the last one)'),
      cancel: () => host.toast('Esc stops the turn'),
      toast: (t) => host.toast(t),
      relayout: () => host.relayout(),
      queueCancel: false,
    })
    this.banner.className = 'loom-elsewhere'
    this.banner.innerHTML =
      `<span class="loom-elsewhere-dot"></span><span class="loom-elsewhere-text">Codex is showing something in the CLI</span>` +
      `<button type="button" data-open-cli title="Codex's own screen (Ctrl+\`)">Open CLI <kbd>Ctrl+\`</kbd></button>`
    this.bannerText = this.banner.querySelector('.loom-elsewhere-text')!
    this.banner.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-open-cli]')) host.openCli()
    })
    host.above.appendChild(this.banner)
    this.unsubs.push(
      window.ember.hooks.onEvent((e) => e.tabId === host.tabId && this.hook(e)),
      window.ember.hooks.onGone((e) => {
        if (e.tabId !== host.tabId || !this.cards.has(e.id)) return
        this.cards.delete(e.id)
        this.asks.close(e.id)
      })
    )
    this.started()
    this.placeholder()
  }

  get input(): HTMLTextAreaElement {
    return this.composer.input
  }

  get busy(): boolean {
    return !!this.composer.menuOpen || this.asks.size > 0 || this.queue.length > 0
  }

  private get turnOn(): boolean {
    return this.promptAt > this.stopAt
  }

  /** A turn is running, by the hooks or by the working line on screen. */
  private get busyNow(): boolean {
    return this.turnOn || !!this.state.live
  }

  started(): void {
    window.ember.hooks.hooked(this.host.tabId, true)
    this.boxSeen = false
    this.set({ phase: 'starting' })
  }

  ended(): void {
    window.ember.hooks.hooked(this.host.tabId, false)
    this.closeCards()
    this.setQueue([])
    this.promptAt = this.stopAt = 0
    this.setElsewhere('')
    this.set({ phase: 'exited', live: null })
  }

  // ------------------------------------------------------------- the screen

  private rows(): string[] {
    const t = this.host.term
    const buf = t.buffer.active
    const out: string[] = []
    for (let y = 0; y < t.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out
  }

  /**
   * The prompt, if it is up: the last `›` line near the bottom with only Codex's status
   * lines under it (the same `›` marks the person's earlier messages higher up). Its text
   * is what is drawn at full strength: the placeholder is dim.
   */
  private findBox(rows: string[]): Box | null {
    let last = rows.length - 1
    while (last > 0 && !rows[last]!.trim()) last--
    for (let y = last; y >= Math.max(0, last - 12); y--) {
      if (!PROMPT.test(rows[y]!)) continue
      let end = y
      while (end + 1 <= last && rows[end + 1]!.trim() && /^\s{2}\S/.test(rows[end + 1]!) && !FOOT.test(rows[end + 1]!)) end++
      const foot = rows.slice(end + 1, last + 1).filter((r) => r.trim())
      if (foot.length > 3 || !foot.every((r) => FOOT.test(r) || r.trim().length < 3)) return null
      // A list of choices with its key hints ("› 1. Review hooks … enter confirm · esc skip")
      // is a dialog drawn with the same `›`, not the prompt.
      if (foot.some((r) => DIALOG_KEYS.test(r))) return null
      const buf = this.host.term.buffer.active
      const lines: string[] = []
      for (let r = y; r <= end; r++) {
        const line = buf.getLine(buf.viewportY + r)
        if (!line) continue
        let s = ''
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x)
          if (!c) continue
          const ch = c.getChars()
          s += ch && (c.isDim() || c.isItalic()) ? ' ' : ch || ' '
        }
        lines.push(r === y ? s.replace(/^›\s?/, '') : s.replace(/^\s{0,2}/, ''))
      }
      let text = lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '')
      if (PLACEHOLDER.test(text.trim())) text = ''
      const images = (text.match(/\[Image #\d+\]/g) ?? []).length
      return { top: y, bottom: end, text, images, foot }
    }
    return null
  }

  screen(): void {
    if (this.disposed) return
    const rows = this.rows()
    const box = this.findBox(rows)
    this.box = box
    const now = Date.now()
    if (box) {
      this.noBoxSince = 0
      if (!this.boxSeen) {
        this.boxSeen = true
        if (this.state.phase === 'starting') this.set({ phase: this.turnOn ? 'working' : 'idle' })
      }
      this.readFoot(box.foot)
    } else if (!this.noBoxSince) this.noBoxSince = now
    // The working line, above the prompt (and above any queued messages).
    let live: WrapperState['live'] = null
    const end = box ? box.top : rows.length
    for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
      const m = WORKING.exec(rows[y]!.trim())
      if (m) {
        live = { glyph: '✻', verb: m[2]!.endsWith('…') ? m[2]! : `${m[2]!}…`, detail: m[3]!.trim() }
        break
      }
    }
    if (live) this.workingAt = now
    if (JSON.stringify(live) !== JSON.stringify(this.state.live)) this.set({ live })
    // An approval in Codex's own screen: no hook took it (not trusted yet, or the card was dropped).
    const asking = !box && !this.cards.size && rows.some((r) => APPROVAL.test(r))
    if (asking !== this.screenAsks) {
      this.screenAsks = asking
      if (asking) this.set({ phase: 'asking' })
      else if (this.state.phase === 'asking' && !this.cards.size) this.set({ phase: this.busyNow ? 'working' : 'idle' })
    }
    // A turn the hooks started that the screen says is over (an interrupt runs no Stop hook).
    if (this.turnOn && !live && box && now - this.workingAt > 2000 && now - this.promptAt > 2500 && !this.cards.size) {
      this.stopAt = now
      this.set({ phase: 'idle' })
    } else if (live && this.state.phase === 'idle' && !this.cards.size) this.set({ phase: 'working' })
    else if (!live && !this.turnOn && box && this.state.phase === 'working' && now - this.workingAt > 1500) this.set({ phase: 'idle' })
    // Queued messages leave the screen when Codex takes them.
    if (this.queue.length) {
      if (rows.some((r) => /Queued follow-up/i.test(r))) this.queueSeen = now
      else if (now - this.queueSeen > 1500 && now - Math.max(...this.queue.map((q) => Number(q.uuid.split(':')[0]))) > 1500) this.setQueue([])
    }
    // Something only Codex's screen has: say so, and offer it.
    let away = ''
    if (!box && !this.cards.size && !this.sending && this.noBoxSince && now - this.noBoxSince > 700) {
      if (asking) away = 'Codex is asking for your approval in the CLI'
      else if (rows.some((r) => HOOK_REVIEW.test(r))) away = 'Codex asks you to review hooks in the CLI — trusting Ember’s lets its approvals show here'
      else if (this.boxSeen || rows.some((r) => DIALOG.test(r))) away = 'Codex is showing something in the CLI'
    }
    this.setElsewhere(away)
    // What is decided by time (the prompt gone long enough, the working line gone, the
    // queue taken) needs another look, and a still screen draws nothing that would ask.
    const waiting = (!box && !this.elsewhere) || (this.state.phase === 'working' && !live) || this.queue.length > 0
    window.clearTimeout(this.recheck)
    if (waiting && this.state.phase !== 'exited') this.recheck = window.setTimeout(() => this.screen(), 800)
  }

  /** The status line: "GPT-6-Astra high · ~\repo", "100% context left", "Plan mode". */
  private readFoot(foot: string[]): void {
    const patch: Partial<WrapperState> = {}
    for (const raw of foot) {
      const r = raw.trim()
      const ctx = /(\d{1,3})% context left/i.exec(r)
      if (ctx) patch.context = Math.max(0, Math.min(100, 100 - Number(ctx[1])))
      if (/plan mode/i.test(r)) patch.mode = 'plan'
      const first = r.split(/\s+·\s+/)[0]!.replace(/\s{2,}.*$/, '').trim()
      if (r.includes(' · ') && !/tab to queue|esc to|for shortcuts|context left|to edit/i.test(first)) {
        const m = /^(.+?)(?:\s+(minimal|low|medium|high|xhigh|default|none))?$/i.exec(first)
        if (m) {
          patch.model = m[1]!
          patch.effort = m[2] && m[2].toLowerCase() !== 'default' ? m[2] : ''
        }
        if (!/plan mode/i.test(foot.join(' '))) patch.mode = 'default'
      }
    }
    if (Object.keys(patch).length) this.set(patch)
  }

  private setElsewhere(text: string): void {
    if (text === this.elsewhere) return
    this.elsewhere = text
    if (text) this.bannerText.textContent = text
    this.banner.classList.toggle('is-on', !!text)
    this.host.relayout()
    this.host.changed()
  }

  view(cli: boolean): void {
    if (!cli) void this.pullLeftover()
  }

  /** Text left in Codex's prompt goes into the composer, and the prompt is cleared. */
  private async pullLeftover(): Promise<void> {
    this.screen()
    const text = this.box?.text ?? ''
    if (!text || this.box?.images) return
    if (!(await this.clearPrompt())) return
    this.composer.append(text)
  }

  /**
   * Ctrl+C: Codex clears a prompt that has text in it. Never twice within a few seconds,
   * which Codex would read as "quit".
   */
  private async clearPrompt(): Promise<boolean> {
    if (Date.now() - this.ctrlCAt < 3000) return false
    this.ctrlCAt = Date.now()
    this.write('\x03')
    await sleep(150)
    this.screen()
    return !this.box?.text
  }

  // ------------------------------------------------------------- typing

  private submit(text: string, images: Attachment[]): void {
    if (!text && !images.length) return
    if (this.busyNow && !text.startsWith('/') && !text.startsWith('!')) this.setQueue([...this.queue, { uuid: `${Date.now()}:${Math.random()}`, text, images: images.length }])
    this.deliver(text, images)
  }

  send(text: string): void {
    this.submit(text, [])
  }

  put(text: string): void {
    this.composer.append(text)
  }

  dropFiles(files: File[]): void {
    void this.composer.addFiles(files, (f) => window.ember.platform.pathForFile(f))
  }

  private deliver(text: string, images: Attachment[]): void {
    this.sending++
    this.chain = this.chain
      .then(() => this.type(text, images))
      .catch((err) => this.host.toast(`Could not send: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.sending--
      })
  }

  private write(d: string): void {
    this.typed.push(`${Date.now() % 100000}:${JSON.stringify(d.length > 60 ? `${d.slice(0, 57)}…` : d)}`)
    if (this.typed.length > 40) this.typed.shift()
    this.host.write(d)
  }

  private async type(text: string, images: Attachment[]): Promise<void> {
    const w = (d: string) => this.write(d)
    // The prompt must be up. While Codex shows something of its own (a dialog, a picker:
    // the banner says so) the message waits for it, as long as that takes.
    let told = false
    for (let i = 0; !this.box && !this.disposed && (i < 150 || (this.elsewhere && i < 6000)); i++) {
      if (this.elsewhere && !told) {
        told = true
        this.host.toast('Sent when Codex’s prompt is back — it is showing something in the CLI')
      }
      await sleep(100)
      this.screen()
    }
    if (!this.box) throw new Error("Codex's prompt is not on screen — open the CLI to see why")
    if (this.box.text) {
      // Left in Codex's prompt (typed in the CLI view): cleared, and put in front of this
      // message, which is what the person would have seen there. A command keeps it in the composer.
      const left = this.box.text
      const pics = this.box.images
      if (!(await this.clearPrompt())) throw new Error("Codex's prompt has text in it — open the CLI to see it")
      if (!pics && left) {
        if (/^[/!]/.test(text)) this.composer.append(left)
        else text = `${left}\n${text}`
      }
    }
    for (const a of images) {
      const png = await asPng(a)
      if (!(await window.ember.clipboardImage(png))) throw new Error('could not put the picture on the clipboard')
      const had = this.box?.images ?? 0
      w('\x16')
      for (let i = 0; i < 40; i++) {
        await sleep(100)
        this.screen()
        if ((this.box?.images ?? 0) > had) break
      }
    }
    if (text) {
      // An `@path` at the very end would leave Codex's file menu open, and Enter would pick from it.
      const tail = /(^|\s)@\S*$/.test(text) ? ' ' : ''
      w(`\x1b[200~${text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n')}${tail}\x1b[201~`)
      // Codex takes keys that come right behind a paste as more of the paste (an Enter
      // would be a newline), so the paste has to have landed first.
      for (let i = 0; i < 20; i++) {
        await sleep(50)
        this.screen()
        if (this.box?.text) break
      }
      await sleep(150)
    }
    // Mid-turn, Tab queues it for when the turn ends; Enter would steer the running turn.
    const queue = this.busyNow && !/^[/!]/.test(text)
    const key = queue ? '\t' : '\r'
    w(key)
    // Still in the prompt a moment later: the key was read as part of the paste. Once more.
    const head = text.split('\n')[0]!.slice(0, 40)
    for (let i = 0; i < 12; i++) {
      await sleep(100)
      this.screen()
      if (!this.box || !this.box.text) break
      if (i === 11 && head && this.box.text.startsWith(head)) w(key)
    }
    if (tuiOnly(text, CODEX_TUI_ONLY)) {
      await sleep(300)
      this.host.openCli()
    }
  }

  cycleMode(): void {
    this.write('\x1b[Z')
  }

  models(): Array<{ value: string; displayName: string; description: string }> {
    return []
  }

  setModel(value: string): void {
    if (!/^[\w.:\-[\]]{1,100}$/.test(value)) return
    this.deliver(`/model ${value}`, [])
  }

  escape(): boolean {
    if (this.composer.escape()) return true
    if (this.asks.escape()) return true
    if (!this.busyNow) return false
    this.write('\x1b')
    if (this.queue.length) {
      // Codex puts what was queued back into its prompt: it comes back into the composer.
      this.setQueue([])
      window.setTimeout(() => void this.pullLeftover(), 800)
    }
    return true
  }

  private setQueue(q: QueuedMessage[]): void {
    this.queue = q
    if (q.length) this.queueSeen = Date.now()
    this.composer.setQueue(q)
  }

  // ------------------------------------------------------------- hooks

  private hook(e: HookEvent): void {
    this.counts[e.event] = (this.counts[e.event] ?? 0) + 1
    this.log.push(`${e.event}${e.blocking ? '*' : ''}`)
    if (this.log.length > 60) this.log.shift()
    const i = e.input
    if (typeof i['session_id'] === 'string' && i['session_id'] !== this.state.sessionId) this.set({ sessionId: i['session_id'] })
    if (typeof i['model'] === 'string' && i['model'] && !this.state.model) this.set({ model: i['model'] })
    switch (e.event) {
      case 'UserPromptSubmit': {
        this.promptAt = Math.max(this.promptAt, e.at)
        const p = String(i['prompt'] ?? '')
        if (this.queue.length) this.setQueue(this.queue.filter((q) => !p.includes(q.text.trim())))
        if (this.turnOn && !this.cards.size) this.set({ phase: 'working' })
        return
      }
      case 'Stop':
        this.stopAt = Math.max(this.stopAt, e.at)
        if (!this.turnOn) {
          this.closeCards()
          this.set({ phase: 'idle', live: null })
        }
        return
      case 'PermissionRequest':
        if (e.blocking) this.openCard(e)
        return
    }
  }

  private openCard(e: HookEvent): void {
    const i = e.input
    // Codex names a shell command `Bash` and an edit `apply_patch`, with `tool_input.command`.
    const tool = String(i['tool_name'] ?? '')
    const raw = (i['tool_input'] ?? {}) as Record<string, unknown>
    const input: Record<string, unknown> =
      tool === 'apply_patch' ? { description: String(raw['description'] ?? 'Apply a patch'), command: String(raw['command'] ?? '') } : raw
    this.cards.set(e.id, { tool, at: Date.now() })
    this.asks.open(e.id, { subtype: 'can_use_tool', tool_name: tool === 'apply_patch' ? 'Edit' : tool, input })
    this.set({ phase: 'asking' })
    this.setElsewhere('')
  }

  /**
   * A card's answer is the hook's decision: allow, or deny with a message. Codex refuses
   * (fails closed on) updatedInput, updatedPermissions and interrupt, so they never go.
   */
  private answer(id: string, r: Record<string, unknown>): void {
    if (!this.cards.delete(id)) return
    const decision = r['behavior'] === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: String(r['message'] ?? 'The user said no.') }
    window.ember.hooks.answer(id, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  }

  private dropCard(id: string): void {
    this.cards.delete(id)
    window.ember.hooks.answer(id, null)
    this.asks.close(id)
  }

  private closeCards(): void {
    for (const id of [...this.cards.keys()]) this.dropCard(id)
  }

  // ------------------------------------------------------------- state

  private set(patch: Partial<WrapperState>): void {
    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      if ((this.state as unknown as Record<string, unknown>)[k] !== v) {
        ;(this.state as unknown as Record<string, unknown>)[k] = v
        changed = true
      }
    }
    if (!changed) return
    if ('phase' in patch) this.placeholder()
    this.host.changed()
  }

  private placeholder(): void {
    const p = this.state.phase
    this.composer.input.placeholder =
      p === 'starting'
        ? 'starting… you can type already'
        : p === 'exited'
          ? 'exited'
          : p === 'working' || p === 'asking'
            ? 'queue a message for when this turn ends'
            : 'type a message   / commands   @ files   ! shell'
  }

  get away(): boolean {
    return !!this.elsewhere
  }

  debug(): Record<string, unknown> {
    return {
      ...this.state,
      box: this.box ? { text: this.box.text, images: this.box.images, foot: this.box.foot } : null,
      boxSeen: this.boxSeen,
      cards: [...this.cards.values()].map((c) => c.tool),
      askKinds: this.asks.kinds(),
      queue: this.queue.map((q) => q.text),
      elsewhere: this.elsewhere,
      screenAsks: this.screenAsks,
      turnOn: this.turnOn,
      counts: { ...this.counts },
      hooks: [...this.log],
      typed: [...this.typed],
      menu: this.composer.menuOpen,
      attachments: this.composer.attachmentCount,
      input: this.composer.input.value,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.clearTimeout(this.recheck)
    this.closeCards()
    window.ember.hooks.hooked(this.host.tabId, false)
    for (const u of this.unsubs) u()
    this.composer.dispose()
    this.asks.el.remove()
    this.banner.remove()
  }
}

/** An attachment as a PNG or JPEG data URL: what the clipboard takes. */
async function asPng(a: Attachment): Promise<string> {
  if (a.image.mediaType === 'image/png' || a.image.mediaType === 'image/jpeg') return `data:${a.image.mediaType};base64,${a.image.data}`
  const blob = await (await fetch(a.url)).blob()
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return c.toDataURL('image/png')
}
