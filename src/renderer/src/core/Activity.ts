import { AGENTS, agentFromTitle, type AgentId } from '@shared/agents'
export type ActivityState = 'idle' | 'working' | 'attention' | 'exited'

/** Why a session is asking for you. The mascot reacts differently to each. */
export type AttentionKind = 'question' | 'handoff' | 'bell'

/** What a monitor needs from a session, kept narrow to avoid a circular import. */
export interface ActivitySource {
  readonly exited: boolean
  readonly bells: number
  readonly rawTitle: string
  /** An agent CLI the shell announced (OSC 133;E), until its prompt returns. */
  readonly announcedAgent: string | null
  readonly lastOutputAt: number
  readonly workingSince: number
  bufferType(): 'normal' | 'alternate'
  visibleText(): string
  settleCommand(): void
}

export interface ActivitySnapshot {
  state: ActivityState
  /** True while an agent CLI session (Claude Code, Codex, Gemini…) owns the terminal. */
  isClaude: boolean
  /** Which agent, when one does. */
  agent: AgentId | null
  /** True while any full-screen TUI owns the terminal. */
  fullscreenApp: boolean
  /** Set only in the attention state; what kind of attention it wants. */
  attention: AttentionKind | null
  /** Human-readable state. The card shows the mascot, not this — it is the tooltip. */
  label: string
  /** Secondary line: elapsed time while busy. */
  detail: string
}

/**
 * Derives what a tab is *doing* from the terminal stream alone.
 *
 * Process introspection is not viable here: node-pty resolves the shell pid
 * asynchronously, and the ConPTY process-list API has to be forked to a child
 * because it attaches to the console — far too heavy to poll per tab. Everything
 * below instead comes from signals already flowing through the pty, and every rule
 * was checked against a real `claude` session (scripts/probe-activity.mjs).
 *
 * The rules for a Claude session are deliberately *screen-derived* rather than
 * traffic-derived. Output cadence looked like the obvious signal and is in fact
 * useless here, in both directions: an idle Claude Code redraws its prompt every
 * second or so, which reads as permanent work, while a working one goes quiet for
 * five to seven seconds at a time between tool calls, which reads as idle. What it
 * is doing is written on the screen — a spinner with an elapsed time while a turn is
 * in flight, a picker when it is blocked on you — so that is what gets read.
 */
export class ActivityMonitor {
  /** Output within this window means a *shell* tab is actively producing. */
  private static readonly WORKING_WINDOW_MS = 600
  /** How long a screen signal survives a frame that happens to catch a redraw. */
  private static readonly SIGNAL_STICKY_MS = 1200
  /** How long a finished Claude turn keeps waving before it settles into idle. */
  private static readonly HANDOFF_MS = 20_000
  /**
   * How long a BEL keeps claiming you.
   *
   * Shells ring for trivia — PSReadLine dings at a completion with no match, at
   * backspace on an empty line — so a bell that is never acknowledged has to expire
   * on its own. A tab that still genuinely wants you will say so some other way.
   */
  private static readonly BELL_MS = 30_000
  // Claude Code sets the title to "claude", then "✳ Claude Code"; Ember's shims announce
  // every other agent CLI the same way (otherAgentShims in ConPtyHost).
  /**
   * A numbered option line. Codex marks the highlighted row with `›`, Gemini with `●`;
   * Copilot and Gemini draw their pickers inside a box, so a border may come first.
   */
  private static readonly CHOICE_LINE = /^\s*(?:[│┃]\s*)?[❯›▸>●*]?\s*[1-9][.)]\s+\S/
  /** The same line, but carrying the caret a picker uses to mark the highlighted row. */
  private static readonly SELECTED_LINE = /^\s*(?:[│┃]\s*)?[❯›▸>●]\s*[1-9][.)]\s+\S/
  /** The footer Claude Code prints under a dialog it is blocked on. */
  private static readonly CONFIRM_FOOTER = /\benter to confirm\b/i
  /**
   * The spinner Claude Code draws while a turn is in flight:
   *   "✳ Scurrying… (6m 45s · ↓ 20.3k tokens)"
   * The verb rotates and the glyph has changed between releases; what has stayed put
   * is the ellipsis followed by a bracketed elapsed time.
   */
  private static readonly BUSY_SPINNER = /…\s*\((?:\d+m\s*)?\d+s\b/
  /** Same state, said in words — present in builds that show the interrupt hint. */
  private static readonly BUSY_INTERRUPT = /\b(?:esc|ctrl\+c)\s+to\s+(?:interrupt|cancel|stop)\b/i
  /** How much of the screen bottom a live prompt or spinner can be found in. */
  private static readonly TAIL_LINES = 14

  private bellsSeen = 0
  private lastBellAt = -Infinity
  private claudeLatched = false
  private latchedAgent: AgentId | null = null
  private busySince = 0
  private lastBusyAt = -Infinity
  private lastQuestionAt = -Infinity
  private turnEndedAt = -Infinity
  private lastUpdateAt = -1
  private snapshot: ActivitySnapshot = {
    state: 'idle',
    isClaude: false,
    agent: null,
    fullscreenApp: false,
    attention: null,
    label: 'Idle',
    detail: '',
  }

  constructor(private readonly src: ActivitySource) {}

  get current(): ActivitySnapshot {
    return this.snapshot
  }

  /** The user looked at this tab, so any pending attention is resolved. */
  acknowledge(): void {
    this.bellsSeen = this.src.bells
    this.lastBellAt = -Infinity
    this.turnEndedAt = -Infinity
  }

  /** Recompute. Cheap enough to call a few times a second. */
  update(now: number): ActivitySnapshot {
    // A tick asks for the aggregate more than once; recomputing would scan the
    // viewport again and, worse, re-run the transition bookkeeping below.
    if (now === this.lastUpdateAt) return this.snapshot
    this.lastUpdateAt = now

    const src = this.src
    // Claude detection has to latch. It announces itself as "claude" then
    // "✳ Claude Code", but once it is working it rewrites the title to the current
    // task ("Generate long ..."), which matches nothing — so testing the title on
    // every tick made the mascot vanish exactly when the session got interesting.
    // Latch on announcement; release only when the title goes back to being a shell
    // (empty, or the executable path ConPTY restores on exit).
    const title = src.rawTitle.trim()
    const said = src.announcedAgent
    const announced = (said && said in AGENTS ? (said as AgentId) : null) ?? agentFromTitle(title)
    if (announced) {
      this.claudeLatched = true
      this.latchedAgent = announced
    } else if (!title || /\.exe$/i.test(title) || src.exited) {
      this.claudeLatched = false
      this.latchedAgent = null
    }
    const isClaude = this.claudeLatched
    const fullscreenApp = src.bufferType() === 'alternate'

    // A BEL is a CLI saying "look at me". Unlike the screen signals it is an event,
    // so it is remembered — but only briefly, and it is dropped the moment the session
    // gets back to work. That is what stops one stray ding from branding a tab for the
    // rest of its life, which is what the old latch did.
    if (src.bells > this.bellsSeen) {
      this.bellsSeen = src.bells
      this.lastBellAt = now
    }
    const belled = now - this.lastBellAt < ActivityMonitor.BELL_MS

    const wasWorking = this.snapshot.state === 'working'
    let state: ActivityState
    let attention: AttentionKind | null = null

    if (src.exited) {
      state = 'exited'
      this.lastBellAt = -Infinity
    } else if (isClaude) {
      ;[state, attention] = this.claudeState(now, belled)
    } else {
      ;[state, attention] = this.shellState(now, belled)
    }

    if (state === 'working') {
      this.lastBellAt = -Infinity
      this.turnEndedAt = -Infinity
      if (!wasWorking) this.busySince = now
    } else if (wasWorking) {
      // The moment a busy session goes quiet is when the command's outcome is known,
      // and — for Claude — when the answer you were waiting for has landed.
      src.settleCommand()
      this.turnEndedAt = now
    }

    this.snapshot = {
      state,
      isClaude,
      agent: isClaude ? this.latchedAgent : null,
      fullscreenApp,
      attention,
      label: ActivityMonitor.labelFor(state, attention, isClaude),
      detail: state === 'working' ? ActivityMonitor.elapsed(now - this.busySince) : '',
    }
    return this.snapshot
  }

  /**
   * Claude Code, read off the screen.
   *
   * Order matters: a dialog beats the spinner (Claude keeps a spinner on screen while
   * it waits for a permission answer, and the answer is the thing that matters), and
   * the spinner beats everything else.
   */
  private claudeState(now: number, belled: boolean): [ActivityState, AttentionKind | null] {
    const tail = this.tailLines()
    if (ActivityMonitor.looksBusy(tail)) this.lastBusyAt = now
    if (ActivityMonitor.looksLikeQuestion(tail)) this.lastQuestionAt = now

    const sticky = ActivityMonitor.SIGNAL_STICKY_MS
    if (now - this.lastQuestionAt < sticky) return ['attention', 'question']
    if (now - this.lastBusyAt < sticky) return ['working', null]
    if (belled) return ['attention', 'bell']
    // A turn that just finished is the one moment a quiet session is worth looking at.
    if (now - this.turnEndedAt < ActivityMonitor.HANDOFF_MS) return ['attention', 'handoff']
    return ['idle', null]
  }

  /** A plain shell: traffic is the only signal there is, and it is a good one. */
  private shellState(now: number, belled: boolean): [ActivityState, AttentionKind | null] {
    if (now - this.src.lastOutputAt < ActivityMonitor.WORKING_WINDOW_MS) return ['working', null]
    if (belled) return ['attention', 'bell']
    return ['idle', null]
  }

  private tailLines(): string[] {
    return this.src
      .visibleText()
      .split('\n')
      .filter((l) => l.trim())
      .slice(-ActivityMonitor.TAIL_LINES)
  }

  private static looksBusy(tail: string[]): boolean {
    return tail.some((l) => ActivityMonitor.BUSY_SPINNER.test(l) || ActivityMonitor.BUSY_INTERRUPT.test(l))
  }

  /**
   * Is the session showing an interactive picker, as opposed to merely printing a
   * numbered list?
   *
   * The first version just counted numbered lines, which Claude produces constantly —
   * so the state flapped on and off as output scrolled and the chime fired at what
   * felt like random moments. Two extra conditions fix it:
   *
   *   - one of the options must carry a **selection caret** (`❯`, `▸`, `>`), which is
   *     what every terminal picker draws and what a plain list never has;
   *   - the options must be **near the bottom** of the visible text, because a live
   *     prompt is always the last thing on screen.
   *
   * Unlike the first version this is re-derived every tick rather than latched, so the
   * state clears itself the moment the dialog leaves the screen — answering a prompt
   * is enough, and the tab no longer has to be visited to stop claiming it needs you.
   */
  private static looksLikeQuestion(tail: string[]): boolean {
    let options = 0
    let selected = false
    for (const line of tail) {
      if (!ActivityMonitor.CHOICE_LINE.test(line)) continue
      options++
      if (ActivityMonitor.SELECTED_LINE.test(line)) selected = true
    }
    if (options >= 2 && selected) return true
    return options >= 2 && tail.some((l) => ActivityMonitor.CONFIRM_FOOTER.test(l))
  }

  /**
   * Seconds are padded once minutes are showing, so the string stops changing length.
   *
   * Not cosmetic: the card rolls the digits that changed and leaves the rest still, and
   * an unpadded `3m 9s` becoming `3m 10s` moves every character one place left. Padding
   * makes the tick touch one digit, which is the whole point of a counter that reads
   * like a clock. Under a minute it stays unpadded — `07s` looks like a countdown.
   */
  private static elapsed(ms: number): string {
    const secs = Math.max(0, Math.round(ms / 1000))
    return secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
  }

  private static labelFor(state: ActivityState, attention: AttentionKind | null, isClaude: boolean): string {
    switch (state) {
      case 'working':
        return isClaude ? 'Working' : 'Running'
      case 'attention':
        return attention === 'handoff' ? 'Your turn' : 'Needs you'
      case 'exited':
        return 'Exited'
      case 'idle':
      default:
        return isClaude ? 'Waiting' : 'Idle'
    }
  }
}
