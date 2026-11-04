import type { HookEvent, SlashCommandInfo } from '@shared/types'
import { Asks } from './Asks'
import { Composer, tuiOnly, type Attachment, type QueuedMessage } from './Composer'
import type { AgentWrapper, WrapperHost, WrapperState } from './AgentWrapper'

/**
 * Claude Code on the canvas: the real TUI in the tab's terminal, driven as the person
 * would drive it, and never shown on the canvas.
 *
 * Typing. Ember's composer sends by typing into Claude Code's prompt: the text as one
 * bracketed paste (newlines stay newlines, nothing submits early), then Enter on its own.
 * Pictures go first, each put on the clipboard and attached with Claude Code's own Alt+V
 * ("[Image #n]"). `!cmd` is `!` (the TUI's bash mode) and then the command. Esc
 * interrupts, Shift+Tab cycles the mode, Ctrl+X Ctrl+S sends a queued message now.
 *
 * Text left in the TUI's prompt (typed in the CLI view) is not sent by surprise and not
 * thrown away: coming back to the canvas, or sending, moves it into the composer and
 * clears the TUI's prompt (Ctrl+C, which Claude Code reads as "clear the input" while
 * there is any). The composer then holds everything that will be sent.
 *
 * Knowing. Claude Code's hooks (resources/hook.mjs, through the bridge) say when a turn
 * starts and ends, which session the tab holds (a `/clear` included), and — the one that
 * waits — every permission request: a tool, AskUserQuestion, ExitPlanMode. Those become
 * Ember's cards, and the card's answer is the hook's decision, which resolves the TUI's
 * own dialog (Claude Code draws it beside the hook; it is simply never shown here).
 * One row of the screen is read as text: the spinner line, for the working line. The
 * screen also says when Claude Code shows something no hook describes (a picker, the
 * trust dialog, /login): the canvas then offers the CLI view instead of guessing.
 */

const RULE = /^\s*[─━]{20,}\s*$/
const PROMPT_LINE = /^\s?[❯>!]\s?/
/** The spinner row, mid-turn: one glyph, a verb with an ellipsis, the details. */
const SPINNER = /^(\S)\s+([A-Z][a-z]+(?:[- ][a-z]+)?…)\s*(.*)$/
/** Lines a dialog draws that the input box never does. */
const DIALOG = /Do you want to|Esc to cancel|Enter to (?:select|confirm)|❯\s*\d+\.\s|^\s*\d+\.\s+(?:Yes|No)\b/i

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

interface Box {
  /** The rows of the prompt (the `❯` line and its continuation lines). */
  top: number
  bottom: number
  /** What the person typed there; '' for an empty prompt (its placeholder is not text). */
  text: string
  images: number
  /** The rows under the box: the mode line and the status line. */
  foot: string[]
}

export class ClaudeTui implements AgentWrapper {
  readonly agent = 'claude'
  readonly state: WrapperState = { phase: 'starting', mode: '', model: '', effort: '', live: null, title: '', sessionId: '' }
  private readonly composer: Composer
  private readonly asks: Asks
  private readonly banner = document.createElement('div')
  private readonly unsubs: Array<() => void> = []
  /** Cards open for permission requests, by the bridge's id for the held hook. */
  private readonly cards = new Map<string, { tool: string; input: string; at: number }>()
  private queue: QueuedMessage[] = []
  private queueSeen = 0
  private commands: SlashCommandInfo[] = []
  private modelList: Array<{ value: string; displayName: string; description: string }> = []
  /** Sends go one after another: each waits for the prompt the one before left. */
  private chain: Promise<void> = Promise.resolve()
  private sending = 0
  /** Hook times: a turn is on while the last prompt is newer than the last stop. */
  private promptAt = 0
  private stopAt = 0
  private box: Box | null = null
  private boxSeen = false
  private noBoxSince = 0
  private spinnerAt = 0
  private elsewhere = false
  private disposed = false
  /** For probes: hook events seen, by name. */
  private readonly counts: Record<string, number> = {}
  private readonly log: string[] = []
  /** For probes: what was typed into the TUI, newest last. */
  private readonly typed: string[] = []

  constructor(private readonly host: WrapperHost) {
    this.asks = new Asks({
      answer: (id, response) => this.answer(id, response),
      setMode: () => {},
      relayout: () => host.relayout(),
      closed: () => {
        if (!this.asks.size && this.state.phase === 'asking') this.set({ phase: this.turnOn ? 'working' : 'idle' })
        requestAnimationFrame(() => {
          if (!this.asks.size || !document.activeElement?.closest('.loom-ask-card')) this.composer.focus()
        })
      },
    })
    host.above.prepend(this.asks.el)
    this.composer = new Composer({
      frame: host.frame,
      above: host.above,
      commands: () => this.commands,
      files: (query) => window.ember.files.search(host.cwd(), query),
      submit: (text, images) => this.submit(text, images),
      cycleMode: () => this.cycleMode(),
      sendNow: () => this.write('\x18\x13'),
      cancel: () => host.toast('Esc stops the turn and gives queued messages back'),
      toast: (t) => host.toast(t),
      relayout: () => host.relayout(),
      queueCancel: false,
    })
    this.banner.className = 'loom-elsewhere'
    this.banner.innerHTML =
      `<span class="loom-elsewhere-dot"></span><span class="loom-elsewhere-text">Claude is showing something in the CLI</span>` +
      `<button type="button" data-open-cli title="Claude Code's own screen (Ctrl+\`)">Open CLI <kbd>Ctrl+\`</kbd></button>`
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
    void this.loadCatalog()
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

  private async loadCatalog(): Promise<void> {
    try {
      const c = await window.ember.claude.catalog(this.host.cwd())
      this.commands = c.commands
      this.modelList = c.models
    } catch {
      /* the menu offers the TUI-only commands alone */
    }
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
    this.set({ phase: 'exited', live: null })
  }

  // ------------------------------------------------------------- the screen

  /** The rows on screen, as text. */
  private rows(): string[] {
    const t = this.host.term
    const buf = t.buffer.active
    const out: string[] = []
    for (let y = 0; y < t.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
    return out
  }

  /**
   * The input box, if it is on screen: a rule, the `❯` line (and its continuation lines),
   * a rule. Its text is only what is drawn at full strength: the placeholder ("Try …")
   * is drawn dim.
   */
  private findBox(rows: string[]): Box | null {
    for (let y = rows.length - 2; y > 0; y--) {
      if (!PROMPT_LINE.test(rows[y]!) || !RULE.test(rows[y - 1]!)) continue
      let end = y
      while (end + 1 < rows.length && !RULE.test(rows[end + 1]!)) end++
      if (end + 1 >= rows.length) return null
      const lines: string[] = []
      const buf = this.host.term.buffer.active
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
        lines.push(r === y ? s.replace(PROMPT_LINE, '') : s.replace(/^\s{0,2}/, ''))
      }
      let text = lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '')
      if (/^Try "/.test(text)) text = ''
      const images = (text.match(/\[Image #\d+\]/g) ?? []).length
      return { top: y, bottom: end, text, images, foot: rows.slice(end + 2).filter((r) => r.trim()) }
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
      const mode = modeOf(box.foot)
      if (mode && mode !== this.state.mode) this.set({ mode })
      // Cards whose dialog has gone from Claude Code's screen were answered there (the CLI view).
      if (this.cards.size && !rows.some((r) => DIALOG.test(r))) {
        for (const [id, c] of this.cards) if (now - c.at > 1500) this.dropCard(id)
      }
    } else if (this.boxSeen && !this.noBoxSince) this.noBoxSince = now
    // The working line: the spinner row just above the box.
    let live: WrapperState['live'] = null
    const end = box ? box.top - 1 : rows.length
    for (let y = end - 1; y >= 0 && y >= end - 16; y--) {
      const m = SPINNER.exec(rows[y]!.trim())
      if (m) {
        live = { glyph: m[1]!, verb: m[2]!, detail: m[3]!.replace(/^\(|\)$/g, '').replace(/\s*·\s*esc to interrupt/i, '') }
        break
      }
    }
    if (live) this.spinnerAt = now
    const was = JSON.stringify(this.state.live)
    if (JSON.stringify(live) !== was) this.set({ live })
    // A turn the hooks started but the screen says is over (an interrupt has no Stop hook).
    if (this.turnOn && !live && box && now - this.spinnerAt > 2000 && now - this.promptAt > 2500 && !this.cards.size) {
      this.stopAt = now
      this.set({ phase: 'idle' })
    } else if (live && this.state.phase === 'idle' && !this.cards.size) this.set({ phase: 'working' })
    // Queued messages leave the screen when Claude takes them.
    if (this.queue.length) {
      if (rows.some((r) => /to send now/i.test(r))) this.queueSeen = now
      else if (now - this.queueSeen > 1500 && now - Math.max(...this.queue.map((q) => Number(q.uuid.split(':')[0]))) > 1500) this.setQueue([])
    }
    // Something on Claude Code's screen no hook describes: offer its own view.
    const away = this.boxSeen && !box && !this.cards.size && !!this.noBoxSince && now - this.noBoxSince > 700 && !this.sending
    if (away !== this.elsewhere) {
      this.elsewhere = away
      this.banner.classList.toggle('is-on', away)
      this.host.relayout()
      this.host.changed()
    }
  }

  get away(): boolean {
    return this.elsewhere
  }

  view(cli: boolean): void {
    if (!cli) void this.pullLeftover()
  }

  /** Text left in the TUI's prompt goes into the composer, and the prompt is cleared. */
  private async pullLeftover(): Promise<void> {
    this.screen()
    const text = this.box?.text ?? ''
    if (!text || this.box?.images) return
    this.write('\x03')
    await sleep(120)
    this.composer.append(text)
  }

  // ------------------------------------------------------------- typing

  private submit(text: string, images: Attachment[]): void {
    if (!text && !images.length) return
    const busy = this.turnOn || this.state.phase === 'working'
    if (busy && !text.startsWith('/') && !text.startsWith('!')) this.setQueue([...this.queue, { uuid: `${Date.now()}:${Math.random()}`, text, images: images.length }])
    this.deliver(text, images)
  }

  /** A message from a canvas action (the answer card, "ask about this"). */
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
    // The prompt must be up (a fresh `claude` takes a moment).
    for (let i = 0; i < 100 && !this.box; i++) {
      await sleep(100)
      this.screen()
    }
    if (!this.box) throw new Error("Claude Code's prompt is not on screen — open the CLI to see why")
    if (this.box.text) {
      // Text in the TUI's prompt that the composer did not put there (typed in the CLI view
      // since, or a message Claude Code gave back after an interrupt). Cleared, never sent
      // along by surprise: a message takes it in front of its own words, which is what the
      // person would have seen in the prompt; a command or `!` leaves it in the composer.
      const left = this.box.text
      const pics = this.box.images
      w('\x03')
      await sleep(150)
      if (!pics && left) {
        if (/^[/!]/.test(text)) this.composer.append(left)
        else text = `${left}\n${text}`
      }
    }
    for (const a of images) {
      const png = await asPng(a)
      if (!(await window.ember.clipboardImage(png))) throw new Error('could not put the picture on the clipboard')
      const had = this.box?.images ?? 0
      w('\x1bv')
      for (let i = 0; i < 40; i++) {
        await sleep(100)
        this.screen()
        if ((this.box?.images ?? 0) > had) break
      }
    }
    if (text.startsWith('!') && !images.length) {
      // Claude Code's bash mode: `!` on an empty prompt, then the command.
      w('!')
      await sleep(150)
      text = text.slice(1).trimStart()
    }
    if (text) {
      // An `@path` at the very end would leave the TUI's file menu open, and Enter would pick from it.
      const tail = /(^|\s)@\S*$/.test(text) ? ' ' : ''
      w(`\x1b[200~${text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n')}${tail}\x1b[201~`)
      await sleep(80)
    }
    w('\r')
    await sleep(60)
    if (tuiOnly(text)) {
      // A picker or a dialog only Claude Code's own screen has: show it.
      await sleep(300)
      this.host.openCli()
    }
  }

  cycleMode(): void {
    this.write('\x1b[Z')
  }

  models(): Array<{ value: string; displayName: string; description: string }> {
    return this.modelList
  }

  setModel(value: string): void {
    if (!/^[\w.:\-[\]]{1,100}$/.test(value)) return
    this.deliver(`/model ${value}`, [])
    this.set({ model: this.modelList.find((m) => m.value === value)?.displayName ?? value })
  }

  /** Esc, innermost first: a menu, a card (no), the turn (Claude Code's own interrupt). */
  escape(): boolean {
    if (this.composer.escape()) return true
    if (this.asks.escape()) return true
    if (!(this.turnOn || this.state.live)) return false
    this.write('\x1b')
    if (this.queue.length) {
      // Claude Code puts what was queued back into its prompt: it comes back into the composer.
      this.setQueue([])
      window.setTimeout(() => void this.pullLeftover(), 600)
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
    if (typeof i['session_title'] === 'string' && i['session_title']) this.set({ title: i['session_title'] })
    if (typeof i['permission_mode'] === 'string' && !this.box) this.set({ mode: i['permission_mode'] })
    const eff = (i['effort'] as { level?: unknown } | undefined)?.level
    if (typeof eff === 'string') this.set({ effort: eff })
    if (typeof i['model'] === 'string' && i['model']) this.set({ model: prettyModel(i['model']) })
    switch (e.event) {
      case 'SessionStart':
        if (this.state.phase === 'exited') this.set({ phase: 'starting' })
        // `/clear`: a new conversation in a new transcript, which Claude Code may not write
        // until the next message. The hook says it at once, so the canvas starts over now.
        if (i['source'] === 'clear') {
          this.closeCards()
          this.setQueue([])
          this.host.cleared()
        }
        return
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
      case 'SessionEnd':
        this.closeCards()
        return
      case 'PermissionRequest':
        if (!e.blocking) return
        this.openCard(e)
        return
    }
  }

  private openCard(e: HookEvent): void {
    const i = e.input
    const tool = String(i['tool_name'] ?? '')
    const input = (i['tool_input'] ?? {}) as Record<string, unknown>
    this.cards.set(e.id, { tool, input: JSON.stringify(input), at: Date.now() })
    this.asks.open(e.id, {
      subtype: 'can_use_tool',
      tool_name: tool,
      input,
      ...(Array.isArray(i['permission_suggestions']) ? { permission_suggestions: i['permission_suggestions'] } : {}),
      ...(i['agent_id'] ? { agent_id: i['agent_id'] } : {}),
    })
    this.set({ phase: 'asking' })
    this.elsewhere = false
    this.banner.classList.remove('is-on')
  }

  /** A card's answer is the hook's decision. */
  private answer(id: string, r: Record<string, unknown>): void {
    if (!this.cards.delete(id)) return
    const allow = r['behavior'] === 'allow'
    const decision: Record<string, unknown> = allow
      ? {
          behavior: 'allow',
          ...(r['updatedInput'] ? { updatedInput: r['updatedInput'] } : {}),
          ...(Array.isArray(r['updatedPermissions']) && r['updatedPermissions'].length ? { updatedPermissions: r['updatedPermissions'] } : {}),
        }
      : { behavior: 'deny', message: String(r['message'] ?? 'The user said no.'), ...(r['interrupt'] === true ? { interrupt: true } : {}) }
    window.ember.hooks.answer(id, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  }

  /** A card no longer needed: its hook goes back with no answer. */
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
        ? 'Starting Claude Code… you can type already'
        : p === 'exited'
          ? 'Claude Code has exited'
          : p === 'working' || p === 'asking'
            ? 'Queue a message for when this turn ends'
            : 'Ask Claude…   / commands   @ files   ! shell'
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
      turnOn: this.turnOn,
      counts: { ...this.counts },
      hooks: [...this.log],
      typed: [...this.typed],
      commands: this.commands.length,
      models: this.modelList.map((m) => m.value),
      menu: this.composer.menuOpen,
      attachments: this.composer.attachmentCount,
      input: this.composer.input.value,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeCards()
    window.ember.hooks.hooked(this.host.tabId, false)
    for (const u of this.unsubs) u()
    this.composer.dispose()
    this.asks.el.remove()
    this.banner.remove()
  }
}

/** The permission mode the TUI's mode line names. */
function modeOf(foot: string[]): string {
  const line = foot.join(' ')
  if (/bypass permissions on/i.test(line)) return 'bypassPermissions'
  if (/accept edits on/i.test(line)) return 'acceptEdits'
  if (/plan mode on/i.test(line)) return 'plan'
  if (/auto mode on/i.test(line)) return 'auto'
  if (/don'?t ask/i.test(line)) return 'dontAsk'
  if (/manual mode on|for shortcuts|shift\+tab/i.test(line)) return 'default'
  return ''
}

/** 'claude-haiku-5-5' → 'Haiku 5.5'. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return id
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
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

