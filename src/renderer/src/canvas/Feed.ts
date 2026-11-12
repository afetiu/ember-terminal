import { escapeHtml, renderMarkdown } from './markdown'
import { diffLines, fromPatch, tally, type DiffLine } from './diff'
import { answerCard } from './questions'
import { joinsTurn, type PromptKind, type TurnState } from '@shared/turnGroups'

/**
 * The conversation, drawn from the transcript.
 *
 * Every line Claude Code writes to the session's JSONL becomes part of the canvas, in
 * order. Most of what an agent does is noise to the person watching — a dozen reads
 * and searches before anything happens — so the feed is quiet by default: every step of
 * a request folds into one line that counts them, and it opens to the steps. What is
 * meant to be *seen* is shown as itself: the reply as rich text with its diagrams, an
 * edit as a diff, a screenshot as a picture.
 *
 * Nothing here is interactive with Claude Code directly. Buttons and questions go out
 * through `ctx.send`, which types into the real CLI as the user would.
 */

type Json = Record<string, unknown>

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface FeedContext {
  /** Type into the session, as the user. */
  send(text: string, submit: boolean): void
  /** Turn a local image path into something an <img> can load. */
  localImage(path: string): Promise<string | null>
  /** Subagents: started (by its tool call), given an id, finished. */
  agent?: (e: { kind: 'start'; key: string; desc: string; type: string; at: string } | { kind: 'id'; key: string; agentId: string } | { kind: 'end'; key?: string; agentId?: string; ok: boolean; summary: string; at: string }) => void
  /** A call to one of Ember's tools, as the transcript records it — to rebuild the canvas of a resumed session. */
  replay?: (tool: string, input: Json, at: string) => void
  /** Host a mermaid diagram and give back a frame URL. */
  diagram(source: string): Promise<string>
  /** Put a bridge document in a frame that sizes itself to its content. */
  mountFrame(host: HTMLElement, url: string, minHeight: number): HTMLIFrameElement
  /** The todo list changed. */
  todos(list: Todo[]): void
  /** Open a link inline as a browser piece rather than leaving Ember. */
  openInline(url: string): void
  /** Something was added; the view decides whether to follow it. */
  grew(): void
  /** `/clear` started the conversation over: the turns are gone, the view drops what hung on them. */
  cleared?(): void
}

const QUIET = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'WebFetch',
  'NotebookRead',
  'ToolSearch',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'BashOutput',
  'TaskOutput',
])

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
const AGENTS = new Set(['Task', 'Agent'])
const PANEL_PREFIX = 'mcp__ember-panel__'

function base(path: unknown): string {
  const s = String(path ?? '')
  return s.split(/[\\/]/).pop() || s
}

function firstLine(s: string, max = 120): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Strip ANSI escapes — command output in the transcript is what the terminal would have shown. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

/** Text and images out of a tool_result or a user message, whatever shape it came in. */
function partsOf(content: unknown): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const out = { text: '', images: [] as string[] }
  if (!Array.isArray(content)) return out
  const texts: string[] = []
  for (const b of content as Json[]) {
    if (b['type'] === 'text') texts.push(String(b['text'] ?? ''))
    else if (b['type'] === 'image') {
      const src = (b['source'] ?? {}) as Json
      if (src['data']) out.images.push(`data:${String(src['media_type'] ?? 'image/png')};base64,${String(src['data'])}`)
    }
  }
  out.text = texts.join('\n')
  return out
}

/** One quiet tool inside a folded group. */
interface QuietItem {
  id: string
  verb: 'read' | 'search' | 'web' | 'skill' | 'other'
  row: HTMLElement
  out: HTMLElement
}

class QuietGroup {
  readonly el: HTMLElement
  private readonly head: HTMLElement
  private readonly list: HTMLElement
  /** Pictures a quiet tool returned. Outside the fold: an image is never noise. */
  readonly shelf: HTMLElement
  readonly items: QuietItem[] = []
  private pending = 0

  constructor(parent: HTMLElement) {
    this.el = el('div', 'loom-tool loom-quiet')
    this.head = el('button', 'loom-tool-head')
    ;(this.head as HTMLButtonElement).type = 'button'
    this.list = el('div', 'loom-quiet-list')
    this.shelf = el('div', 'loom-shelf')
    this.head.addEventListener('click', () => this.el.classList.toggle('is-open'))
    this.el.append(this.head, this.list)
    parent.append(this.el, this.shelf)
  }

  add(id: string, name: string, input: Json): QuietItem {
    const verb: QuietItem['verb'] =
      name === 'Read' || name === 'NotebookRead'
        ? 'read'
        : name === 'Grep' || name === 'Glob' || name === 'LS'
          ? 'search'
          : name === 'WebSearch' || name === 'WebFetch'
            ? 'web'
            : name === 'Skill'
              ? 'skill'
              : 'other'
    let what = name
    if (name === 'Read') what = `read ${base(input['file_path'])}`
    else if (name === 'NotebookRead') what = `read ${base(input['notebook_path'])}`
    else if (name === 'Grep') what = `searched “${String(input['pattern'] ?? '')}”${input['path'] ? ` in ${base(input['path'])}` : ''}`
    else if (name === 'Glob') what = `listed ${String(input['pattern'] ?? '')}`
    else if (name === 'LS') what = `listed ${base(input['path'])}`
    else if (name === 'WebSearch') what = `searched the web for “${String(input['query'] ?? '')}”`
    else if (name === 'WebFetch') {
      try {
        what = `read ${new URL(String(input['url'] ?? '')).host}`
      } catch {
        what = 'read a page'
      }
    } else if (name === 'Skill') what = `used the ${String(input['skill'] ?? input['command'] ?? '')} skill`
    else if (name === 'ToolSearch') what = 'loaded tools'

    const row = el('div', 'loom-quiet-row')
    const label = el('button', 'loom-quiet-label', escapeHtml(what))
    ;(label as HTMLButtonElement).type = 'button'
    const out = el('pre', 'loom-out')
    out.hidden = true
    label.addEventListener('click', () => {
      if (out.textContent) out.hidden = !out.hidden
    })
    row.append(label, out)
    this.list.appendChild(row)
    const item = { id, verb, row, out }
    this.items.push(item)
    this.pending++
    this.render()
    return item
  }

  done(item: QuietItem, text: string, isError: boolean): void {
    this.pending = Math.max(0, this.pending - 1)
    item.out.textContent = stripAnsi(text).slice(0, 8000)
    if (isError) item.row.classList.add('is-error')
    this.render()
  }

  private render(): void {
    const count = (v: QuietItem['verb']) => this.items.filter((i) => i.verb === v).length
    const parts: string[] = []
    const reads = count('read')
    const searches = count('search')
    const web = count('web')
    const skills = count('skill')
    const other = count('other')
    if (reads) parts.push(`read ${plural(reads, 'file')}`)
    if (searches) parts.push(`searched ${plural(searches, 'time')}`)
    if (web) parts.push(`looked at ${plural(web, 'page')} on the web`)
    if (skills) parts.push(`used ${plural(skills, 'skill')}`)
    if (other) parts.push(plural(other, 'other step'))
    const text = parts.join(' · ')
    this.head.innerHTML =
      `<span class="loom-glyph${this.pending ? ' is-live' : ''}">⏺</span>` +
      `<span class="loom-tool-name">${this.items.length === 1 ? escapeHtml(this.items[0]!.row.querySelector('.loom-quiet-label')?.textContent ?? text) : 'Explored'}</span>` +
      (this.items.length === 1 ? '' : `<span class="loom-tool-arg">${escapeHtml(text)}</span>`) +
      `<span class="loom-chev">›</span>`
  }
}

type StepKind = 'command' | 'read' | 'search' | 'web' | 'edit' | 'agent' | 'other'

/**
 * Every step taken for one request, behind one line that counts them. The canvas shows
 * what was said and what was made; how the agent got there is here, a click away.
 */
class StepFold {
  readonly el: HTMLElement
  /** Where the step rows go. */
  readonly list: HTMLElement
  private readonly head: HTMLElement
  private readonly counts: Record<StepKind, number> = { command: 0, read: 0, search: 0, web: 0, edit: 0, agent: 0, other: 0 }
  private failed = 0

  constructor(parent: HTMLElement) {
    this.el = el('div', 'loom-fold')
    this.head = el('button', 'loom-tool-head')
    ;(this.head as HTMLButtonElement).type = 'button'
    this.list = el('div', 'loom-fold-list')
    this.head.addEventListener('click', () => this.el.classList.toggle('is-open'))
    this.el.append(this.head, this.list)
    parent.appendChild(this.el)
  }

  add(kind: StepKind): void {
    this.counts[kind]++
    this.render()
  }

  fail(): void {
    this.failed++
    this.render()
  }

  private render(): void {
    const c = this.counts
    const parts: string[] = []
    if (c.command) parts.push(`ran ${plural(c.command, 'command')}`)
    if (c.read) parts.push(`read ${plural(c.read, 'file')}`)
    if (c.search) parts.push(`searched ${plural(c.search, 'time')}`)
    if (c.web) parts.push(`looked at ${plural(c.web, 'page')} on the web`)
    if (c.edit) parts.push(`edited ${plural(c.edit, 'time')}`)
    if (c.agent) parts.push(`used ${plural(c.agent, 'agent')}`)
    if (c.other) parts.push(plural(c.other, 'other step'))
    if (this.failed) parts.push(`${this.failed} failed`)
    const total = Object.values(c).reduce((a, b) => a + b, 0)
    this.head.innerHTML =
      `<span class="loom-tool-name">${plural(total, 'step')}</span>` +
      `<span class="loom-tool-arg">${escapeHtml(parts.join(' · '))}</span>` +
      `<span class="loom-chev">›</span>`
  }
}

/** A tool that is not quiet: one line, and a body that opens. */
class ToolView {
  readonly el: HTMLElement
  readonly head: HTMLElement
  readonly body: HTMLElement
  /** Shown under the head even when closed: a failure's last lines, a picture. */
  readonly peek: HTMLElement
  private state: 'live' | 'ok' | 'error' = 'live'

  constructor(
    parent: HTMLElement,
    readonly kind: string,
    readonly name: string
  ) {
    this.el = el('div', `loom-tool is-${kind}`)
    this.head = el('button', 'loom-tool-head')
    ;(this.head as HTMLButtonElement).type = 'button'
    this.body = el('div', 'loom-tool-body')
    this.peek = el('div', 'loom-tool-peek')
    this.head.addEventListener('click', () => {
      if (this.body.childElementCount || this.body.textContent) this.el.classList.toggle('is-open')
    })
    this.el.append(this.head, this.peek, this.body)
    parent.appendChild(this.el)
  }

  setHead(name: string, arg: string, meta = '', extra = ''): void {
    this.head.innerHTML =
      `<span class="loom-glyph"></span>` +
      `<span class="loom-tool-name">${escapeHtml(name)}</span>` +
      (arg ? `<span class="loom-tool-arg">${escapeHtml(arg)}</span>` : '') +
      (extra ? `<span class="loom-tool-extra">${extra}</span>` : '') +
      (meta ? `<span class="loom-tool-meta">${escapeHtml(meta)}</span>` : '') +
      `<span class="loom-chev">›</span>`
    this.paint()
  }

  finish(isError: boolean): void {
    this.state = isError ? 'error' : 'ok'
    this.paint()
  }

  open(on = true): void {
    this.el.classList.toggle('is-open', on)
  }

  private paint(): void {
    this.el.classList.toggle('is-live', this.state === 'live')
    this.el.classList.toggle('is-error', this.state === 'error')
  }
}

/** A diff, as rows with line numbers. Long ones show their start and open on demand. */
function diffBlock(lines: DiffLine[], limit = 18): HTMLElement {
  const wrap = el('div', 'loom-diff')
  const rows = lines.map((l) => {
    const sign = l.kind === ' ' ? '' : l.kind === '-' ? '−' : '+'
    const no = l.kind === '+' ? (l.newNo ?? '') : (l.oldNo ?? '')
    return `<div class="loom-diff-row is-${l.kind === ' ' ? 'ctx' : l.kind === '-' ? 'del' : 'add'}"><span class="no">${no}</span><span class="sg">${sign}</span><span class="tx">${escapeHtml(l.text) || ' '}</span></div>`
  })
  if (rows.length <= limit + 4) {
    wrap.innerHTML = rows.join('')
    return wrap
  }
  wrap.innerHTML = rows.slice(0, limit).join('')
  const more = el('button', 'loom-more', `show all ${rows.length} lines`)
  ;(more as HTMLButtonElement).type = 'button'
  more.addEventListener('click', () => {
    wrap.innerHTML = rows.join('')
  })
  wrap.appendChild(more)
  return wrap
}

export class Feed {
  readonly el: HTMLElement
  private turn: HTMLElement
  private quiet: QuietGroup | null = null
  /** The fold this request's steps go into; a new request or follow-up starts another. */
  private fold: StepFold | null = null
  /** The last slash command, shown as a quiet line until the agent answers it (then it is a turn). */
  private pendingCmd: { note: HTMLElement; label: string; uuid: string } | null = null
  private readonly tools = new Map<string, { view?: ToolView; quiet?: { group: QuietGroup; item: QuietItem }; fold?: StepFold | undefined; name: string; input: Json }>()
  /** Where a piece the session pushes should land: right after the tool call that made it. */
  private readonly anchors: Array<{ name: string; el: HTMLElement; used: boolean }> = []
  private readonly seen = new Set<string>()
  private sessions = 0
  /** `/clear` just ran: what it printed is not worth a line on the empty canvas. */
  private clearedOut = false
  /** The turn on screen, for grouping follow-ups into it (shared/turnGroups.ts); null: none to join. */
  private group: TurnState | null = null
  /** The line being read's uuid: a prompt's handle for "Split" / "Join previous". */
  private uuid = ''
  /** The step the large live line names (the newest tool row), hidden while it is the one in progress. */
  actEl: HTMLElement | null = null

  constructor(private readonly ctx: FeedContext) {
    this.el = el('div', 'loom-flow')
    this.turn = this.newTurn()
    // "Split into its own turn" on a follow-up, "Join previous" on a turn's head.
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.loom-regroup')
      if (!b || !this.el.contains(b)) return
      e.stopPropagation()
      const line = b.closest<HTMLElement>('.loom-follow, .loom-ask')
      if (!line) return
      if (line.classList.contains('loom-follow')) this.split(line)
      else this.joinPrevious(line)
    })
  }

  /** What the session is doing right now, as one sentence: the last step it started. */
  get action(): string {
    return this.act
  }
  private act = ''

  /** When the line being read was written. */
  private at = ''

  get isEmpty(): boolean {
    return !this.el.querySelector(':scope > .loom-turn > *')
  }

  /** Every turn that has something in it, oldest first. */
  turns(): HTMLElement[] {
    const all = Array.from(this.el.querySelectorAll<HTMLElement>(':scope > .loom-turn')).filter((t) => t.childElementCount > 0)
    // A turn holding nothing but slash commands (/rename, /model) asked the agent nothing:
    // it is not a turn to step to. Only when there is nothing else does it count.
    const real = all.filter((t) => Array.from(t.children).some((c) => !(c as HTMLElement).dataset['cmd']))
    return real.length ? real : all
  }

  private newTurn(): HTMLElement {
    const t = el('section', 'loom-turn')
    this.el.appendChild(t)
    this.turn = t
    this.quiet = null
    this.fold = null
    this.act = ''
    this.actEl = null
    this.group = null
    return t
  }

  // -------------------------------------------------------------- turns and follow-ups

  /** Where a prompt goes: true, a follow-up in the turn on screen; false, a new turn (made here). */
  private placePrompt(text: string, kind: PromptKind): boolean {
    const at = Date.parse(this.at)
    const forced = this.uuid ? overrides()[this.uuid] : undefined
    const g = joinsTurn(text, at, kind, this.group)
    const join = !!this.group && (forced === 'split' ? false : forced === 'join' ? true : g.join)
    if (join && this.group) {
      if (Number.isFinite(at)) this.group.lastAt = at
      if (kind === 'prompt') {
        this.group.prompt = text
        this.group.interrupted = false
        this.group.questions = false
      }
      return true
    }
    this.newTurn()
    this.group = { askAt: at, lastAt: at, prompt: text, interrupted: false, questions: false }
    return false
  }

  /** Something happened in the turn (a reply, a step): the clock grouping reads. */
  private touch(): void {
    if (!this.group) return
    const at = Date.parse(this.at)
    if (Number.isFinite(at)) this.group.lastAt = at
  }

  /** Your words inside a turn: one small line, with a way to make it a turn of its own. */
  private followLine(caret: string, text: string, command = false, uuid = this.uuid): HTMLElement {
    this.fold = null
    this.quiet = null
    const f = el('div', `loom-follow${command ? ' is-command' : ''}`)
    f.innerHTML =
      `<span class="loom-caret">${caret}</span><span class="loom-follow-text">${escapeHtml(text)}</span>` +
      (uuid ? `<button type="button" class="loom-regroup" title="Show this as a turn of its own">Split into its own turn</button>` : '')
    if (uuid) f.dataset['uuid'] = uuid
    return f
  }

  /** The head of a turn: what you asked, with "Join previous". */
  private askLine(caret: string, text: string, command = false, uuid = this.uuid): HTMLElement {
    const ask = el('div', `loom-ask${command ? ' is-command' : ''}`)
    ask.innerHTML =
      `<span class="loom-caret">${caret}</span><span class="loom-ask-text">${escapeHtml(text)}</span>` +
      (uuid ? `<button type="button" class="loom-regroup" title="Make this part of the turn before">Join previous</button>` : '')
    if (uuid) ask.dataset['uuid'] = uuid
    return ask
  }

  /** "Split into its own turn": the follow-up and everything after it in its turn move to a new turn. */
  private split(line: HTMLElement): void {
    const turn = line.parentElement
    if (!turn) return
    setOverride(line.dataset['uuid'], 'split')
    const t = el('section', 'loom-turn')
    turn.after(t)
    const text = line.querySelector('.loom-follow-text')?.textContent ?? ''
    const caret = line.querySelector('.loom-caret')?.textContent ?? '❯'
    const ask = this.askLine(caret, text, line.classList.contains('is-command'), line.dataset['uuid'] ?? '')
    line.querySelectorAll('.loom-thumbs').forEach((n) => ask.appendChild(n))
    const moving: Element[] = []
    for (let n: Element | null = line.nextElementSibling; n; n = n.nextElementSibling) {
      if (!n.classList.contains('loom-activity') && !n.classList.contains('loom-board')) moving.push(n)
    }
    line.remove()
    t.append(ask, ...moving)
    if (this.turn === turn) this.turn = t
    this.ctx.grew()
  }

  /** "Join previous": this turn becomes a follow-up of the one before it. */
  private joinPrevious(ask: HTMLElement): void {
    const turn = ask.parentElement
    let prev = turn?.previousElementSibling as HTMLElement | null
    while (prev && prev.classList.contains('loom-turn') && !prev.querySelector(':scope > .loom-ask')) prev = prev.previousElementSibling as HTMLElement | null
    if (!turn || !prev || !prev.classList.contains('loom-turn')) return
    setOverride(ask.dataset['uuid'], 'join')
    const text = ask.querySelector('.loom-ask-text')?.textContent ?? ''
    const caret = ask.querySelector('.loom-caret')?.textContent ?? '❯'
    const f = this.followLine(caret, text, ask.classList.contains('is-command'), ask.dataset['uuid'] ?? '')
    ask.querySelectorAll('.loom-thumbs').forEach((n) => f.appendChild(n))
    ask.replaceWith(f)
    const before = prev.querySelector(':scope > .loom-activity, :scope > .loom-board')
    for (const n of Array.from(turn.children)) {
      if (n.classList.contains('loom-activity')) continue
      prev.insertBefore(n, before)
    }
    turn.remove()
    if (this.turn === turn) this.turn = prev
    this.ctx.grew()
  }

  /**
   * The session in the tab changed (a new `claude`, `/clear`, `/resume`). A fresh one (no
   * conversation from before the switch in its transcript) starts the canvas over, as
   * `/clear` does, whether or not Claude Code writes the command into the log.
   */
  switchSession(first: boolean, fresh = false): void {
    this.sessions++
    if (fresh) {
      this.restart()
      this.clearedOut = false
      return
    }
    // Only a seam between two conversations that both have something on screen: after a
    // `/clear` (recorded at the end of the old log or the top of the new) there is nothing above it.
    if ((!first || this.seen.size) && !this.isEmpty) {
      const div = el('div', 'loom-seam', '<span>new session</span>')
      this.el.appendChild(div)
    }
    this.newTurn()
    this.anchors.length = 0
  }

  /**
   * `/clear` (and its aliases `/reset`, `/new`): Claude Code starts the conversation over in
   * a new transcript, so the canvas starts over too. Everything turn-derived goes; what you
   * pinned lives outside the flow and stays.
   */
  private restart(): void {
    this.el.replaceChildren()
    // Forgotten too, so that `/resume` back into the cleared conversation shows it again.
    this.seen.clear()
    this.tools.clear()
    this.anchors.length = 0
    this.pendingCmd = null
    this.clearedOut = true
    this.newTurn()
    this.ctx.cleared?.()
  }

  add(lines: Json[]): void {
    for (const line of lines) {
      const uuid = String(line['uuid'] ?? '')
      if (uuid) {
        if (this.seen.has(uuid)) continue
        this.seen.add(uuid)
      }
      // Subagents' own steps: their summary arrives as the Task result.
      if (line['isSidechain'] === true) continue
      this.at = String(line['timestamp'] ?? '')
      this.uuid = uuid
      try {
        if (line['type'] === 'user') this.user(line)
        else if (line['type'] === 'assistant') this.assistant(line)
        else if (line['type'] === 'system') this.system(line)
      } catch (err) {
        console.warn('[loom] could not render a transcript line', err)
      }
    }
    this.liveAnswers()
    this.ctx.grew()
  }

  private liveEl: HTMLElement | null = null

  /**
   * The reply as it is being written, for a session the canvas drives itself (native mode):
   * the words so far, at the end of the turn, until the finished block arrives and takes
   * its place. Not a `.loom-say` of the turn — the trail and the stage count those — and
   * '' takes it away.
   */
  live(text: string): void {
    if (!text.trim()) {
      this.liveEl?.remove()
      this.liveEl = null
      return
    }
    if (!this.liveEl || this.liveEl.parentElement !== this.turn) {
      this.liveEl?.remove()
      this.liveEl = el('div', 'loom-writing', '<div class="loom-say is-current"></div>')
      // Above the line that says what is happening now, where the reply will land.
      const activity = this.turn.querySelector(':scope > .loom-activity')
      this.turn.insertBefore(this.liveEl, activity)
    }
    this.liveEl.firstElementChild!.innerHTML = renderMarkdown(text).html
  }

  /** One plain line in the turn from Ember itself: how a turn ended, why the session stopped. */
  notice(text: string, error = false): HTMLElement {
    const n = el('div', `loom-notice${error ? ' is-error' : ''}`, escapeHtml(text))
    const activity = this.turn.querySelector(':scope > .loom-activity')
    this.turn.insertBefore(n, activity)
    this.ctx.grew()
    return n
  }

  /** Where a pushed piece of `tool` should go, or the end of the current turn. */
  slotFor(tool: string): HTMLElement {
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const a = this.anchors[i]!
      // Only this turn's calls. A piece can arrive before its call is in the transcript;
      // an unused slot from an earlier turn would put it on a turn that is not on screen.
      if (!this.turn.contains(a.el)) break
      if (a.name !== tool) continue
      if (a.used) break
      a.used = true
      return a.el
    }
    const host = el('div', 'loom-slot')
    this.turn.appendChild(host)
    this.quiet = null
    return host
  }

  // -------------------------------------------------------------- user

  private user(line: Json): void {
    const msg = (line['message'] ?? {}) as Json
    const content = msg['content']

    if (line['isCompactSummary'] === true) {
      const div = el('details', 'loom-seam loom-compact')
      div.innerHTML = `<summary><span>context compacted</span></summary>`
      const body = el('div', 'loom-say')
      body.innerHTML = renderMarkdown(partsOf(content).text).html
      div.appendChild(body)
      this.el.appendChild(div)
      this.pendingCmd = null
      this.newTurn()
      return
    }

    if (Array.isArray(content)) {
      const results = (content as Json[]).filter((b) => b['type'] === 'tool_result')
      if (results.length) {
        const structured = results.length === 1 ? line['toolUseResult'] : undefined
        for (const r of results) this.result(r, structured)
        return
      }
    }
    if (line['isMeta'] === true) return

    const { text, images } = partsOf(content)
    const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

    // A slash command and what it printed. Most (/rename, /model, /cost) are the CLI's own
    // business and the agent never answers them, so they are a quiet line in the turn
    // already on screen. One the agent does answer (a custom command, a skill) becomes a
    // turn when its answer starts; see promoteCommand.
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(clean)
    if (cmd) {
      if (/^\/(clear|reset|new)$/.test((cmd[1] ?? '').trim())) {
        this.restart()
        return
      }
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(clean)?.[1]?.trim() ?? ''
      const label = `${cmd[1]}${args ? ` ${args}` : ''}`
      const note = el('div', 'loom-note-line is-command', `<span class="loom-caret">❯</span>${escapeHtml(label)}`)
      note.dataset['cmd'] = '1'
      this.turn.appendChild(note)
      this.pendingCmd = { note, label, uuid: this.uuid }
      return
    }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(clean)
    const afterClear = this.clearedOut
    this.clearedOut = false
    if (stdout) {
      if (afterClear) return
      const out = stripAnsi(stdout[1] ?? '').trim()
      if (out) {
        const pre = el('pre', 'loom-note', escapeHtml(out))
        pre.dataset['cmd'] = '1'
        this.turn.appendChild(pre)
      }
      // It printed its own result: the agent is not going to answer it.
      this.pendingCmd = null
      return
    }
    // `!` shell mode inside Claude Code.
    const bashIn = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(clean)
    if (bashIn) {
      this.pendingCmd = null
      const cmdText = bashIn[1] ?? ''
      if (this.placePrompt(cmdText, 'shell')) this.turn.appendChild(this.followLine('!', cmdText, true))
      else this.turn.appendChild(this.askLine('!', cmdText, true))
      return
    }
    const bashOut = /<bash-stdout>([\s\S]*?)<\/bash-stdout>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/.exec(clean)
    if (bashOut) {
      const out = stripAnsi(`${bashOut[1] ?? ''}${bashOut[2] ? `\n${bashOut[2]}` : ''}`).trim()
      if (out) this.turn.appendChild(el('pre', 'loom-note', escapeHtml(out.slice(0, 12000))))
      return
    }
    // A background task reporting in is not something you said: one quiet line, no new turn.
    if (clean.startsWith('<task-notification>')) {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(clean)?.[1]?.trim() ?? 'A background task reported in'
      const taskId = /<task-id>([^<]+)<\/task-id>/.exec(clean)?.[1]?.trim()
      const status = /<status>([^<]+)<\/status>/.exec(clean)?.[1]?.trim() ?? ''
      const result = /<result>([\s\S]*?)<\/result>/.exec(clean)?.[1]?.trim() ?? summary
      if (taskId) this.ctx.agent?.({ kind: 'end', agentId: taskId, ok: !/fail|error|stopped|killed/i.test(status), summary: result.slice(0, 600), at: this.at })
      this.turn.appendChild(el('div', 'loom-note-line', escapeHtml(summary)))
      return
    }
    if (/^\[Request interrupted by user/.test(clean)) {
      this.turn.appendChild(el('div', 'loom-interrupt', 'interrupted'))
      if (this.group) {
        this.group.interrupted = true
        this.touch()
      }
      return
    }
    if (!clean && !images.length) return
    if (clean.startsWith('Caveat: The messages below')) return

    this.pendingCmd = null
    const follow = this.placePrompt(clean, 'prompt')
    const ask = follow ? this.followLine('❯', clean) : this.askLine('❯', clean)
    if (images.length) {
      const thumbs = el('div', 'loom-thumbs')
      for (const src of images) {
        const img = document.createElement('img')
        img.className = 'loom-thumb'
        img.src = src
        img.dataset['zoom'] = '1'
        thumbs.appendChild(img)
      }
      ask.appendChild(thumbs)
    }
    this.turn.appendChild(ask)
  }

  /** The agent is answering the last slash command: it was a real ask after all, so it opens a turn. */
  private promoteCommand(): void {
    const c = this.pendingCmd
    if (!c) return
    this.pendingCmd = null
    c.note.remove()
    // A command the agent answers (a skill, a custom command) is a prompt like any other.
    const saved = this.uuid
    this.uuid = c.uuid
    if (this.placePrompt(c.label, 'prompt')) this.turn.appendChild(this.followLine('❯', c.label, true))
    else this.turn.appendChild(this.askLine('❯', c.label, true))
    this.uuid = saved
  }

  // -------------------------------------------------------------- assistant

  private assistant(line: Json): void {
    const msg = (line['message'] ?? {}) as Json
    const content = msg['content']
    if (!Array.isArray(content)) return
    this.promoteCommand()
    this.touch()
    if (this.group) this.group.interrupted = false
    for (const block of content as Json[]) {
      const type = block['type']
      if (type === 'text') this.say(String(block['text'] ?? ''))
      else if (type === 'tool_use') this.tool(String(block['id'] ?? ''), String(block['name'] ?? ''), (block['input'] ?? {}) as Json)
    }
  }

  private say(text: string): void {
    if (!text.trim() || text.trim() === '(no content)') return
    this.quiet = null
    const r = renderMarkdown(text)
    const div = el('div', 'loom-say', r.html)
    this.turn.appendChild(div)
    this.actEl = null
    this.hydrate(div, r.diagrams, r.images)
    const card = answerCard(div, (line) => this.ctx.send(line, true))
    if (this.group) this.group.questions = !!card
  }

  /**
   * Only the questions the session is waiting on can be answered from the canvas: the
   * reply that ended the latest turn. Once anything follows it — a step, your own words,
   * a new session — its card goes, unless it was the one you answered with, which stays
   * as a record (locked).
   */
  private liveAnswers(): void {
    const live = this.el.lastElementChild === this.turn ? this.turn.lastElementChild : null
    this.el.querySelectorAll<HTMLElement>('.loom-answers').forEach((card) => {
      const on = card.parentElement === live && !card.classList.contains('is-sent')
      card.classList.toggle('is-stale', !on && !card.classList.contains('is-sent'))
      card.inert = !on
    })
  }

  /** Resolve the placeholders markdown left: diagrams to frames, local paths to media. */
  private hydrate(root: HTMLElement, diagrams: string[], images: string[]): void {
    root.querySelectorAll<HTMLElement>('.loom-diagram[data-diagram]').forEach((host) => {
      const src = diagrams[Number(host.dataset['diagram'])]
      if (!src) return
      host.dataset['askLabel'] = 'this diagram'
      host.dataset['source'] = src
      void this.ctx.diagram(src).then((url) => {
        if (url) this.ctx.mountFrame(host, url, 120)
        else host.innerHTML = `<pre class="loom-out">${escapeHtml(src)}</pre>`
      })
    })
    root.querySelectorAll<HTMLImageElement>('img[data-local]').forEach((img) => {
      const path = images[Number(img.dataset['local'])]
      if (!path) return
      void this.ctx.localImage(path).then((src) => {
        if (src) img.src = src
        else img.replaceWith(el('span', 'loom-missing', escapeHtml(`(image not found: ${path})`)))
      })
    })
    root.querySelectorAll<HTMLImageElement>('img').forEach((img) => (img.dataset['zoom'] = '1'))
  }

  /** The fold a step of `kind` goes into, counted. */
  private step(kind: StepKind): HTMLElement {
    if (!this.fold) this.fold = new StepFold(this.turn)
    this.fold.add(kind)
    return this.fold.list
  }

  private tool(id: string, name: string, input: Json): void {
    if (name === 'TodoWrite') {
      const todos = Array.isArray(input['todos']) ? (input['todos'] as Todo[]) : []
      this.ctx.todos(todos)
      return
    }
    if (name.startsWith(PANEL_PREFIX)) {
      this.ctx.replay?.(name.slice(PANEL_PREFIX.length), input, this.at)
      // The piece itself arrives through the bridge; this marks where it belongs.
      const slot = el('div', 'loom-slot')
      this.turn.appendChild(slot)
      this.anchors.push({ name: name.slice(PANEL_PREFIX.length), el: slot, used: false })
      this.quiet = null
      return
    }
    if (QUIET.has(name)) {
      const kind: StepKind =
        name === 'Read' || name === 'NotebookRead' ? 'read' : name === 'Grep' || name === 'Glob' || name === 'LS' ? 'search' : name === 'WebSearch' || name === 'WebFetch' ? 'web' : 'other'
      const list = this.step(kind)
      if (!this.quiet) this.quiet = new QuietGroup(list)
      const item = this.quiet.add(id, name, input)
      this.act = cap(item.row.querySelector('.loom-quiet-label')?.textContent ?? name)
      // One step folded alone says what the live line says; a group of them says more.
      this.actEl = this.quiet.items.length === 1 ? this.quiet.el : null
      this.tools.set(id, { quiet: { group: this.quiet, item }, fold: this.fold ?? undefined, name, input })
      return
    }
    this.quiet = null
    this.actEl = null

    if (EDITS.has(name)) return this.edit(id, name, input)
    if (SHELLS.has(name)) {
      const view = new ToolView(this.step('command'), 'shell', name)
      const command = String(input['command'] ?? '')
      view.setHead('$', firstLine(command, 160), String(input['description'] ?? ''))
      this.act = String(input['description'] ?? '').trim() || `$ ${firstLine(command, 120)}`
      this.actEl = view.el
      this.tools.set(id, { view, fold: this.fold ?? undefined, name, input })
      return
    }
    if (AGENTS.has(name)) {
      const view = new ToolView(this.step('agent'), 'agent', name)
      view.setHead(String(input['subagent_type'] ?? 'agent'), String(input['description'] ?? ''), '')
      this.act = cap(String(input['description'] ?? '').trim() || 'Working with an agent')
      this.ctx.agent?.({ kind: 'start', key: id, desc: String(input['description'] ?? 'agent'), type: String(input['subagent_type'] ?? ''), at: this.at })
      this.tools.set(id, { view, fold: this.fold ?? undefined, name, input })
      return
    }
    if (name === 'ExitPlanMode') {
      const view = new ToolView(this.turn, 'plan', name)
      view.setHead('Plan', '', 'waiting for your approval below')
      this.act = 'A plan is waiting for your approval below'
      const r = renderMarkdown(String(input['plan'] ?? ''))
      const body = el('div', 'loom-say', r.html)
      view.body.appendChild(body)
      this.hydrate(body, r.diagrams, r.images)
      view.open()
      this.tools.set(id, { view, name, input })
      return
    }

    const view = new ToolView(this.step('other'), 'other', name)
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
    const label = mcp ? `${mcp[2]!.replace(/_/g, ' ')}` : name
    const source = mcp ? mcp[1]!.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '').replace(/[-_]/g, ' ') : ''
    const arg = Object.values(input).find((v) => typeof v === 'string' && v.trim()) as string | undefined
    view.setHead(label, arg ? firstLine(arg, 100) : '', source)
    this.act = cap(`${label}${arg ? ` ${firstLine(arg, 80)}` : ''}`)
    this.actEl = view.el
    this.tools.set(id, { view, fold: this.fold ?? undefined, name, input })
  }

  private edit(id: string, name: string, input: Json): void {
    const view = new ToolView(this.step('edit'), 'edit', name)
    const file = String(input['file_path'] ?? input['notebook_path'] ?? '')
    this.act = `${name === 'Write' ? 'Writing' : 'Editing'} ${base(file)}`
    let lines: DiffLine[] = []
    if (name === 'Edit') lines = diffLines(String(input['old_string'] ?? ''), String(input['new_string'] ?? ''))
    else if (name === 'MultiEdit' && Array.isArray(input['edits'])) {
      for (const e of input['edits'] as Json[]) {
        if (lines.length) lines.push({ kind: ' ', text: '⋯' })
        lines.push(...diffLines(String(e['old_string'] ?? ''), String(e['new_string'] ?? '')))
      }
    } else if (name === 'Write') lines = diffLines('', String(input['content'] ?? ''))
    else if (name === 'NotebookEdit') lines = diffLines('', String(input['new_source'] ?? ''))
    this.paintEdit(view, name, file, lines)
    this.tools.set(id, { view, fold: this.fold ?? undefined, name, input })
  }

  private paintEdit(view: ToolView, name: string, file: string, lines: DiffLine[]): void {
    const { added, removed } = tally(lines)
    const counts = `${added ? `<span class="add">+${added}</span>` : ''}${removed ? `<span class="del">−${removed}</span>` : ''}`
    const verb = name === 'Write' ? (removed ? 'Rewrote' : 'Created') : 'Edited'
    view.setHead(verb, base(file), file.length > base(file).length ? file : '', counts)
    view.head.title = file
    view.body.replaceChildren(diffBlock(lines, name === 'Write' ? 14 : 18))
    // Small edits are the point of watching; they stay open. A new file starts folded.
    view.open(name !== 'Write' && lines.length <= 40)
  }

  // -------------------------------------------------------------- results

  private result(block: Json, structured: unknown): void {
    const id = String(block['tool_use_id'] ?? '')
    const entry = this.tools.get(id)
    if (!entry) return
    const isError = block['is_error'] === true
    if (isError) entry.fold?.fail()
    const { text, images } = partsOf(block['content'])
    const s = (structured && typeof structured === 'object' ? structured : {}) as Json

    if (entry.quiet) {
      entry.quiet.group.done(entry.quiet.item, text, isError)
      // Images Claude reads (screenshots it takes to see the screen) are its own looking,
      // not something to show: they stay out of the canvas. Shown images come from show_media.
      void images
      return
    }
    const view = entry.view
    if (!view) return
    view.finish(isError)

    if (EDITS.has(entry.name)) {
      if (isError) {
        view.peek.innerHTML = `<div class="loom-peek-line is-error">${escapeHtml(firstLine(stripAnsi(text), 200))}</div>`
        view.open(false)
        return
      }
      const patch = fromPatch(s['structuredPatch'])
      if (patch) this.paintEdit(view, entry.name, String(entry.input['file_path'] ?? ''), patch)
      return
    }

    if (SHELLS.has(entry.name)) {
      const stdout = typeof s['stdout'] === 'string' ? (s['stdout'] as string) : text
      const stderr = typeof s['stderr'] === 'string' ? (s['stderr'] as string) : ''
      const out = stripAnsi(`${stdout}${stderr ? `\n${stderr}` : ''}`).replace(/\s+$/, '')
      if (out) {
        const pre = el('pre', 'loom-out')
        pre.textContent = out
        view.body.appendChild(pre)
      }
      const tail = out.split('\n').filter((l) => l.trim())
      if (isError || s['interrupted'] === true) {
        view.peek.innerHTML = tail
          .slice(-4)
          .map((l) => `<div class="loom-peek-line is-error">${escapeHtml(l.slice(0, 240))}</div>`)
          .join('')
      } else if (tail.length) {
        view.peek.innerHTML = `<div class="loom-peek-line">${escapeHtml(tail[tail.length - 1]!.slice(0, 200))}</div>`
      }
      void images
      return
    }

    if (AGENTS.has(entry.name)) {
      // A background agent answers at once with its id; one that ran in the turn answers with its result.
      const launched = /agentId:\s*([a-z0-9]+)/i.exec(text)
      if (launched && /background|launched|async/i.test(text)) this.ctx.agent?.({ kind: 'id', key: id, agentId: launched[1]! })
      else {
        if (launched) this.ctx.agent?.({ kind: 'id', key: id, agentId: launched[1]! })
        this.ctx.agent?.({ kind: 'end', key: id, ok: !isError, summary: text.slice(0, 600), at: this.at })
      }
      const r = renderMarkdown(text)
      const body = el('div', 'loom-say', r.html)
      view.body.appendChild(body)
      this.hydrate(body, r.diagrams, r.images)
      return
    }

    // Any other tool: words fold away, pictures are shown.
    if (text.trim()) {
      const pre = el('pre', 'loom-out')
      pre.textContent = stripAnsi(text).slice(0, 12000)
      view.body.appendChild(pre)
    }
    if (isError) view.peek.innerHTML = `<div class="loom-peek-line is-error">${escapeHtml(firstLine(stripAnsi(text), 200))}</div>`
    void images
  }



  // -------------------------------------------------------------- system

  private system(line: Json): void {
    const subtype = String(line['subtype'] ?? '')
    if (subtype === 'compact_boundary') {
      this.el.appendChild(el('div', 'loom-seam', '<span>context compacted</span>'))
      this.newTurn()
      return
    }
    // A slash command and what it printed, as 2.1.3xx writes them: a system line holding the
    // same <command-name> / <local-command-stdout> a user line used to.
    if (subtype === 'local_command' && typeof line['text'] === 'string') {
      this.user({ ...line, type: 'user', message: { role: 'user', content: line['text'] } })
      return
    }
    const text = stripAnsi(String(line['text'] ?? '')).trim()
    if (!text || text.length > 600) return
    // Hook chatter and the like: quiet, but there.
    if (/hook|statusline|^\s*$/i.test(subtype)) return
    this.turn.appendChild(el('div', 'loom-note-line', escapeHtml(firstLine(text, 300))))
  }
}

/** The turns you split or joined by hand, by prompt uuid: kept, so a reload groups them the same. */
const OVERRIDES = 'ember.turnOverrides'
let overrideCache: Record<string, 'split' | 'join'> | null = null
function overrides(): Record<string, 'split' | 'join'> {
  if (overrideCache) return overrideCache
  try {
    overrideCache = JSON.parse(localStorage.getItem(OVERRIDES) ?? '{}') as Record<string, 'split' | 'join'>
  } catch {
    overrideCache = {}
  }
  return overrideCache
}
function setOverride(uuid: string | undefined, how: 'split' | 'join'): void {
  if (!uuid) return
  const all = overrides()
  delete all[uuid]
  all[uuid] = how
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete all[k]
  try {
    localStorage.setItem(OVERRIDES, JSON.stringify(all))
  } catch {
    /* kept for this run only */
  }
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
